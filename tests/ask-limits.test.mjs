/**
 * tests/ask-limits.test.mjs
 *
 * Unit tests for src/lib/ask-limits.mjs.
 * Covers:
 * - 10 allowed, 11th blocked under limit of 10 with retryAfterSeconds in 1..3600
 * - Limit change recreates limiter with fresh state (increasing and lowering)
 * - Retry seconds: positive integer <= 3600 on blocked calls
 * - utcDayKey across UTC midnight and numeric timestamps
 * - Cap boundary and atomic delegation in consumeDaily
 * - Privacy-preserving logging for rate-limit and daily-cap events
 *
 * Run with: node --experimental-sqlite --test tests/ask-limits.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASK_RATE_LIMIT,
  utcDayKey,
  checkPerIp,
  consumeDaily,
} from '../src/lib/ask-limits.mjs';

describe('DEFAULT_ASK_RATE_LIMIT', () => {
  test('is exported as 10', () => {
    assert.equal(DEFAULT_ASK_RATE_LIMIT, 10);
  });
});

describe('utcDayKey', () => {
  test('formats Date across UTC midnight: 23:59:59.999Z vs 00:00:00.000Z', () => {
    const d1 = new Date('2026-11-09T23:59:59.999Z');
    const d2 = new Date('2026-11-10T00:00:00.000Z');
    assert.equal(utcDayKey(d1), '2026-11-09');
    assert.equal(utcDayKey(d2), '2026-11-10');
  });

  test('accepts ISO string representations', () => {
    assert.equal(utcDayKey('2026-11-09T23:59:59.999Z'), '2026-11-09');
    assert.equal(utcDayKey('2026-11-10T00:00:00.000Z'), '2026-11-10');
  });

  test('accepts a numeric timestamp', () => {
    const ts1 = new Date('2026-11-09T23:59:59.999Z').getTime();
    const ts2 = new Date('2026-11-10T00:00:00.000Z').getTime();
    assert.equal(utcDayKey(ts1), '2026-11-09');
    assert.equal(utcDayKey(ts2), '2026-11-10');
  });

  test('defaults to current UTC date when called with no arguments', () => {
    const expected = new Date().toISOString().slice(0, 10);
    assert.equal(utcDayKey(), expected);
  });
});

describe('checkPerIp', () => {
  const origWarn = console.warn;
  before(() => {
    console.warn = () => {};
  });
  after(() => {
    console.warn = origWarn;
  });

  test('10 allowed, 11th blocked under a limit of 10 with retryAfterSeconds in 1..3600', () => {
    const key = 'test-ip-limit-10';

    for (let i = 1; i <= 10; i++) {
      const res = checkPerIp(key, 10);
      assert.equal(res.allowed, true, `attempt ${i} should be allowed`);
      assert.equal(res.retryAfterSeconds, 0);
    }

    const res11 = checkPerIp(key, 10);
    assert.equal(res11.allowed, false, '11th attempt should be blocked');
    assert.equal(typeof res11.retryAfterSeconds, 'number');
    assert.ok(Number.isInteger(res11.retryAfterSeconds));
    assert.ok(res11.retryAfterSeconds >= 1, 'retryAfterSeconds must be >= 1');
    assert.ok(res11.retryAfterSeconds <= 3600, 'retryAfterSeconds must be <= 3600');
  });

  test('normalizes missing, non-integer, or <1 limits to DEFAULT_ASK_RATE_LIMIT (10)', () => {
    const keyMissing = 'test-ip-norm-missing';
    // Omitted limit -> normalized to 10
    for (let i = 1; i <= 10; i++) {
      const res = checkPerIp(keyMissing);
      assert.equal(res.allowed, true);
    }
    const blockedMissing = checkPerIp(keyMissing);
    assert.equal(blockedMissing.allowed, false);

    const keyNonInt = 'test-ip-norm-non-int';
    // String or float limit -> normalized to 10 (does not recreate limiter since effective is 10)
    for (let i = 1; i <= 10; i++) {
      const res = checkPerIp(keyNonInt, 'invalid-limit');
      assert.equal(res.allowed, true);
    }
    const blockedNonInt = checkPerIp(keyNonInt, 3.14);
    assert.equal(blockedNonInt.allowed, false);

    const keyUnderOne = 'test-ip-norm-under-one';
    // 0 or negative -> normalized to 10
    for (let i = 1; i <= 10; i++) {
      const res = checkPerIp(keyUnderOne, 0);
      assert.equal(res.allowed, true);
    }
    const blockedUnderOne = checkPerIp(keyUnderOne, -5);
    assert.equal(blockedUnderOne.allowed, false);
  });

  test('limit change recreates the limiter: exhausting limit 3, raising to 5 resets state, lowering back to 3 resets state', () => {
    const key = 'test-ip-limit-change';

    // 1. Exhaust limit 3
    for (let i = 1; i <= 3; i++) {
      const res = checkPerIp(key, 3);
      assert.equal(res.allowed, true, `limit 3, call ${i} allowed`);
    }
    const blockedAt3 = checkPerIp(key, 3);
    assert.equal(blockedAt3.allowed, false, '4th call at limit 3 must be blocked');

    // 2. Switch limit to 5: must recreate limiter with fresh state
    for (let i = 1; i <= 5; i++) {
      const res = checkPerIp(key, 5);
      assert.equal(res.allowed, true, `limit 5, call ${i} allowed with fresh state`);
    }
    const blockedAt5 = checkPerIp(key, 5);
    assert.equal(blockedAt5.allowed, false, '6th call at limit 5 must be blocked');

    // 3. Lower back to limit 3: lowering must also recreate limiter with fresh state
    for (let i = 1; i <= 3; i++) {
      const res = checkPerIp(key, 3);
      assert.equal(res.allowed, true, `lowered limit 3, call ${i} allowed with fresh state`);
    }
    const blockedLowered = checkPerIp(key, 3);
    assert.equal(blockedLowered.allowed, false, '4th call at lowered limit 3 must be blocked');
  });

  test('retry seconds is a positive integer <= 3600 on the blocked call', () => {
    const key = 'test-ip-retry-seconds';
    const first = checkPerIp(key, 1);
    assert.equal(first.allowed, true);

    const blocked = checkPerIp(key, 1);
    assert.equal(blocked.allowed, false);
    assert.equal(typeof blocked.retryAfterSeconds, 'number');
    assert.ok(Number.isInteger(blocked.retryAfterSeconds));
    assert.ok(blocked.retryAfterSeconds >= 1);
    assert.ok(blocked.retryAfterSeconds <= 3600);
  });
});

describe('consumeDaily', () => {
  const origWarn = console.warn;
  before(() => {
    console.warn = () => {};
  });
  after(() => {
    console.warn = origWarn;
  });

  test('cap boundary and atomic delegation: returns unchanged object and passes (day, cap) to db', () => {
    const recordedCalls = [];
    let count = 0;
    const events = new Map();
    const stubDb = {
      consumeDailyAsk(day, cap) {
        recordedCalls.push({ day, cap });
        count += 1;
        return { count, allowed: count <= cap };
      },
      getCapEvent(day, feature) {
        return events.get(`${day}:${feature}`) || null;
      },
      insertCapEvent(day, feature) {
        events.set(`${day}:${feature}`, { day, feature });
      },
    };

    const day = '2026-11-09';
    const cap = 3;

    // Calls 1, 2, 3 should be allowed
    const r1 = consumeDaily(stubDb, day, cap);
    assert.deepEqual(r1, { count: 1, allowed: true });

    const r2 = consumeDaily(stubDb, day, cap);
    assert.deepEqual(r2, { count: 2, allowed: true });

    const r3 = consumeDaily(stubDb, day, cap);
    assert.deepEqual(r3, { count: 3, allowed: true });

    // Call 4 is over cap -> not allowed
    const r4 = consumeDaily(stubDb, day, cap);
    assert.deepEqual(r4, { count: 4, allowed: false });

    // Verify stubDb received exact arguments
    assert.equal(recordedCalls.length, 4);
    for (const call of recordedCalls) {
      assert.equal(call.day, day);
      assert.equal(call.cap, cap);
    }
  });

  test('propagates database errors directly', () => {
    const failingDb = {
      consumeDailyAsk() {
        throw new Error('SQLite disk I/O error');
      },
      getCapEvent() {
        return null;
      },
      insertCapEvent() {},
    };

    assert.throws(
      () => consumeDaily(failingDb, '2026-11-09', 10),
      /SQLite disk I\/O error/
    );
  });
});

describe('logging and privacy', () => {
  test('captures console.warn on rate-limit block and daily-cap block with expected payload and without IP or question', () => {
    const clientKey = 'client-secret-192.168.10.42';
    const questionText = 'What was Emad salary expectation at his last role?';
    const testDay = '2026-11-09';

    /** @type {string[]} */
    const captured = [];
    const origWarn = console.warn;
    console.warn = (msg) => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };

    try {
      // 1. Trigger rate-limit block
      const r1 = checkPerIp(clientKey, 1);
      assert.equal(r1.allowed, true);
      assert.equal(captured.length, 0, 'No warning when allowed');

      const r2 = checkPerIp(clientKey, 1);
      assert.equal(r2.allowed, false);
      assert.equal(captured.length, 1, 'One warning logged when rate limited');

      // 2. Trigger daily-cap block
      const events = new Map();
      const capDb = {
        consumeDailyAsk(day, cap) {
          return { count: 11, allowed: false };
        },
        getCapEvent(day, feature) {
          return events.get(`${day}:${feature}`) || null;
        },
        insertCapEvent(day, feature) {
          events.set(`${day}:${feature}`, { day, feature });
        },
      };
      const capRes = consumeDaily(capDb, testDay, 10);
      assert.equal(capRes.allowed, false);
      assert.equal(captured.length, 2, 'One warning logged when daily cap hit');
    } finally {
      console.warn = origWarn;
    }

    // Verify rate-limited log entry
    const rateLimitRaw = captured[0];
    const rateLimitPayload = JSON.parse(rateLimitRaw);
    assert.deepEqual(rateLimitPayload, {
      event: 'ask_rate_limited',
      day: utcDayKey(new Date()),
    });
    assert.equal(rateLimitRaw.includes(clientKey), false, 'Must not include client IP/key');
    assert.equal(rateLimitRaw.includes(questionText), false, 'Must not include question text');

    // Verify daily-cap log entry
    const capRaw = captured[1];
    const capPayload = JSON.parse(capRaw);
    assert.deepEqual(capPayload, { event: 'daily_cap', day: testDay, feature: 'ask' });
    assert.equal(capRaw.includes(clientKey), false, 'Must not include client IP/key');
    assert.equal(capRaw.includes(questionText), false, 'Must not include question text');
  });

  test('several over-cap calls produce exactly one insertCapEvent call and one daily_cap line, and a new UTC day key writes no event', () => {
    let insertCalls = 0;
    const events = new Map();
    const fakeDb = {
      consumeDailyAsk(day, cap) {
        return { count: 11, allowed: false };
      },
      getCapEvent(day, feature) {
        return events.get(`${day}:${feature}`) || null;
      },
      insertCapEvent(day, feature) {
        insertCalls += 1;
        events.set(`${day}:${feature}`, { day, feature });
      },
    };

    /** @type {string[]} */
    const captured = [];
    const origWarn = console.warn;
    console.warn = (msg) => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };

    try {
      const day = '2026-11-09';
      // First over-cap call
      const res1 = consumeDaily(fakeDb, day, 10);
      assert.equal(res1.allowed, false);
      assert.equal(insertCalls, 1);
      assert.equal(captured.length, 1);
      assert.deepEqual(JSON.parse(captured[0]), { event: 'daily_cap', day, feature: 'ask' });

      // Repeated over-cap calls on same day
      const res2 = consumeDaily(fakeDb, day, 10);
      assert.equal(res2.allowed, false);
      const res3 = consumeDaily(fakeDb, day, 10);
      assert.equal(res3.allowed, false);

      assert.equal(insertCalls, 1, 'Must have exactly one insertCapEvent call');
      assert.equal(captured.length, 1, 'Must have exactly one daily_cap warning line');

      // A new UTC day key with an allowed call writes no event
      const nextDayDb = {
        consumeDailyAsk(d, cap) {
          return { count: 1, allowed: true };
        },
        getCapEvent(d, feature) {
          return events.get(`${d}:${feature}`) || null;
        },
        insertCapEvent(d, feature) {
          insertCalls += 1;
          events.set(`${d}:${feature}`, { day: d, feature });
        },
      };

      const nextDayRes = consumeDaily(nextDayDb, '2026-11-10', 10);
      assert.equal(nextDayRes.allowed, true);
      assert.equal(insertCalls, 1, 'Allowed call on new day must not insert cap event');
      assert.equal(captured.length, 1, 'Allowed call on new day must not log warning');
    } finally {
      console.warn = origWarn;
    }
  });
});
