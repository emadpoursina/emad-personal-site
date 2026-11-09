/**
 * tests/cover-letter-limits.test.mjs
 *
 * Unit tests for src/lib/cover-letter-limits.mjs.
 * Covers:
 * - Window: 10 calls allowed, 11th blocked, retryAfterSeconds is an integer 1..3600
 * - Separate state from the ask limiter
 * - Rate-limit event payload: exact JSON payload and no IP or job description
 * - consumeDaily delegation to shared daily-cap module with feature 'cover_letter'
 * - Next UTC day counter starts at zero
 * - Database error propagation
 *
 * Run with: node --experimental-sqlite --test tests/cover-letter-limits.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COVER_LETTER_RATE_LIMIT,
  checkPerIp,
  consumeDaily,
} from '../src/lib/cover-letter-limits.mjs';
import { checkPerIp as askCheckPerIp } from '../src/lib/ask-limits.mjs';

/**
 * Generates a unique client identifier for hermetic tests.
 *
 * @param {string} [prefix='client']
 * @returns {string}
 */
function uniqueKey(prefix = 'client') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Creates an in-memory fake database stub tracking calls and cap events.
 *
 * @returns {object}
 */
function createFakeDb() {
  /** @type {Map<string, number>} */
  const dayCounts = new Map();
  /** @type {Array<{ day: string, cap: number }>} */
  const consumeCalls = [];
  /** @type {Array<{ day: string, feature: string }>} */
  const getCalls = [];
  /** @type {Array<{ day: string, feature: string }>} */
  const insertCalls = [];
  /** @type {Map<string, { day: string, feature: string, created_at: string }>} */
  const events = new Map();

  return {
    consumeCalls,
    getCalls,
    insertCalls,
    events,
    consumeDailyAsk(day, cap) {
      consumeCalls.push({ day, cap });
      const current = (dayCounts.get(day) || 0) + 1;
      dayCounts.set(day, current);
      return { count: current, allowed: current <= cap };
    },
    getCapEvent(day, feature) {
      getCalls.push({ day, feature });
      const key = `${day}:${feature}`;
      return events.get(key) || null;
    },
    insertCapEvent(day, feature) {
      insertCalls.push({ day, feature });
      const key = `${day}:${feature}`;
      if (!events.has(key)) {
        events.set(key, { day, feature, created_at: new Date().toISOString() });
      }
    },
  };
}

describe('DEFAULT_COVER_LETTER_RATE_LIMIT', () => {
  test('exports DEFAULT_COVER_LETTER_RATE_LIMIT as 10', () => {
    assert.equal(DEFAULT_COVER_LETTER_RATE_LIMIT, 10);
  });
});

describe('checkPerIp', () => {
  test('window: 10 calls allowed, 11th blocked, retryAfterSeconds is an integer 1..3600', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const key = uniqueKey('window');

      for (let i = 1; i <= 10; i++) {
        const res = checkPerIp(key);
        assert.equal(res.allowed, true, `call ${i} should be allowed`);
        assert.equal(res.retryAfterSeconds, 0);
      }

      const res11 = checkPerIp(key);
      assert.equal(res11.allowed, false, '11th call should be blocked');
      assert.equal(typeof res11.retryAfterSeconds, 'number');
      assert.ok(Number.isInteger(res11.retryAfterSeconds));
      assert.ok(res11.retryAfterSeconds >= 1, 'retryAfterSeconds must be >= 1');
      assert.ok(res11.retryAfterSeconds <= 3600, 'retryAfterSeconds must be <= 3600');
    } finally {
      console.warn = origWarn;
    }
  });

  test('separate state from the ask limiter: exhaust 10 cover-letter attempts for key K, then askCheckPerIp(K, 10) is allowed; the cover-letter 11th for K is blocked', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const key = uniqueKey('sep-state');

      // Exhaust 10 cover-letter attempts
      for (let i = 1; i <= 10; i++) {
        const res = checkPerIp(key);
        assert.equal(res.allowed, true);
      }

      // Assert askCheckPerIp(key, 10) is allowed (state is separate)
      const askRes = askCheckPerIp(key, 10);
      assert.equal(askRes.allowed, true, 'askCheckPerIp should be allowed for key K');

      // The cover-letter 11th for key K is blocked
      const clRes11 = checkPerIp(key);
      assert.equal(clRes11.allowed, false, '11th cover-letter call should be blocked');
    } finally {
      console.warn = origWarn;
    }
  });

  test('rate-limit event payload: on the blocked 11th call capture console.warn and assert exactly one JSON line deepEqual { event: "cover_letter_rate_limited" }, and the raw line contains neither key nor a job-description marker', () => {
    const key = uniqueKey('client-ip-secret-192.168.1.100');
    const jobMarker = 'job-description-marker-senior-backend-engineer';
    /** @type {string[]} */
    const captured = [];
    const origWarn = console.warn;
    console.warn = (msg) => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };

    try {
      for (let i = 1; i <= 10; i++) {
        const res = checkPerIp(key);
        assert.equal(res.allowed, true);
      }
      assert.equal(captured.length, 0, 'No warning emitted when calls are allowed');

      const blocked = checkPerIp(key);
      assert.equal(blocked.allowed, false);

      assert.equal(captured.length, 1, 'Exactly one warning emitted on blocked call');
      const rawLine = captured[0];
      const payload = JSON.parse(rawLine);
      assert.deepEqual(payload, { event: 'cover_letter_rate_limited' });
      assert.equal(rawLine.includes(key), false, 'Raw log line must not contain key');
      assert.equal(rawLine.includes(jobMarker), false, 'Raw log line must not contain job description marker');
      assert.equal(rawLine.includes('jobDescription'), false, 'Raw log line must not contain jobDescription');
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('consumeDaily delegation', () => {
  test('fake db exposing consumeDailyAsk(day,cap), getCapEvent(day,feature), insertCapEvent(day,feature); cap 2; first two allowed, third allowed:false; getCapEvent/insertCapEvent called with ("2026-11-09","cover_letter"); after several over-cap calls there is exactly one insert and exactly one console line deepEqual { event: "daily_cap", day: "2026-11-09", feature: "cover_letter" }', () => {
    const fakeDb = createFakeDb();
    const day = '2026-11-09';
    const cap = 2;
    /** @type {string[]} */
    const captured = [];
    const origWarn = console.warn;
    console.warn = (msg) => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };

    try {
      // First two calls allowed
      const r1 = consumeDaily(fakeDb, day, cap);
      assert.deepEqual(r1, { count: 1, allowed: true });

      const r2 = consumeDaily(fakeDb, day, cap);
      assert.deepEqual(r2, { count: 2, allowed: true });

      // Third call allowed:false
      const r3 = consumeDaily(fakeDb, day, cap);
      assert.deepEqual(r3, { count: 3, allowed: false });

      // Several over-cap calls
      const r4 = consumeDaily(fakeDb, day, cap);
      assert.deepEqual(r4, { count: 4, allowed: false });

      const r5 = consumeDaily(fakeDb, day, cap);
      assert.deepEqual(r5, { count: 5, allowed: false });

      // Verify getCapEvent called with ('2026-11-09', 'cover_letter')
      assert.ok(fakeDb.getCalls.length >= 1);
      for (const call of fakeDb.getCalls) {
        assert.deepEqual(call, { day, feature: 'cover_letter' });
      }

      // Verify insertCapEvent called exactly once with ('2026-11-09', 'cover_letter')
      assert.equal(fakeDb.insertCalls.length, 1);
      assert.deepEqual(fakeDb.insertCalls[0], { day, feature: 'cover_letter' });

      // Verify exactly one console line deepEqual { event: 'daily_cap', day: '2026-11-09', feature: 'cover_letter' }
      assert.equal(captured.length, 1);
      const parsed = JSON.parse(captured[0]);
      assert.deepEqual(parsed, {
        event: 'daily_cap',
        day: '2026-11-09',
        feature: 'cover_letter',
      });
    } finally {
      console.warn = origWarn;
    }
  });

  test('next UTC day starts at zero: same fake db counts per day; consumeDaily on "2026-11-10" returns {count:1, allowed:true} and writes no event for that day', () => {
    const fakeDb = createFakeDb();
    const day1 = '2026-11-09';
    const day2 = '2026-11-10';
    const cap = 2;

    const origWarn = console.warn;
    /** @type {string[]} */
    const captured = [];
    console.warn = (msg) => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };

    try {
      // Day 1 exhausts cap
      consumeDaily(fakeDb, day1, cap);
      consumeDaily(fakeDb, day1, cap);
      const blockedDay1 = consumeDaily(fakeDb, day1, cap);
      assert.equal(blockedDay1.allowed, false);

      const insertsBeforeDay2 = fakeDb.insertCalls.length;
      const warnsBeforeDay2 = captured.length;

      // Next UTC day
      const day2Res = consumeDaily(fakeDb, day2, cap);
      assert.deepEqual(day2Res, { count: 1, allowed: true });

      // Writes no event for that day
      assert.equal(fakeDb.insertCalls.length, insertsBeforeDay2);
      assert.equal(captured.length, warnsBeforeDay2);
    } finally {
      console.warn = origWarn;
    }
  });

  test('error propagation: a fake db whose consumeDailyAsk throws makes consumeDaily throw the same error', () => {
    const expectedErr = new Error('SQLite disk I/O error');
    const throwingDb = {
      consumeDailyAsk() {
        throw expectedErr;
      },
      getCapEvent() {},
      insertCapEvent() {},
    };

    assert.throws(
      () => consumeDaily(throwingDb, '2026-11-09', 10),
      (err) => err === expectedErr
    );
  });
});
