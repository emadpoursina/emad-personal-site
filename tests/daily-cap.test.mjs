/**
 * tests/daily-cap.test.mjs
 *
 * Unit tests for src/lib/daily-cap.mjs.
 * Covers:
 * - allow/block boundary: cap 3 -> counts 1,2,3 allowed true and 4,5 allowed false; result passed through unchanged.
 * - event-once: several over-cap calls with a fake db return exactly one insert call and exactly one daily_cap warning.
 * - the first allow at count<=cap writes no event and logs nothing.
 * - UTC rollover: utcDayKey across UTC midnight and numeric timestamps; new day starts at zero and is allowed.
 * - write failure: when db.insertCapEvent throws, consumeDaily returns {allowed:false} and emits one warning line naming day and feature.
 * - privacy: captured warn output never contains an IP-like string, job description, Dear Hiring Manager, or backend engineer.
 * - invalid feature throws TypeError.
 *
 * Run with: node --experimental-sqlite --test tests/daily-cap.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { utcDayKey, consumeDaily } from '../src/lib/daily-cap.mjs';

/**
 * Creates an in-memory fake database stub.
 *
 * @param {object} [opts]
 * @param {number} [opts.initialCount=0]
 * @param {boolean} [opts.throwOnInsert=false]
 * @param {boolean} [opts.throwOnGet=false]
 */
function createFakeDb({
  initialCount = 0,
  throwOnInsert = false,
  throwOnGet = false,
} = {}) {
  let count = initialCount;
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
      count += 1;
      return { count, allowed: count <= cap };
    },
    getCapEvent(day, feature) {
      getCalls.push({ day, feature });
      if (throwOnGet) {
        throw new Error('SQLite disk I/O error on getCapEvent');
      }
      const key = `${day}:${feature}`;
      return events.get(key) || null;
    },
    insertCapEvent(day, feature) {
      insertCalls.push({ day, feature });
      if (throwOnInsert) {
        throw new Error('SQLite disk I/O error on insertCapEvent');
      }
      const key = `${day}:${feature}`;
      if (!events.has(key)) {
        events.set(key, { day, feature, created_at: new Date().toISOString() });
      }
    },
  };
}

describe('utcDayKey', () => {
  test('formats Date across UTC midnight: 23:59:59Z vs 00:00:00Z', () => {
    const d1 = new Date('2026-11-09T23:59:59Z');
    const d2 = new Date('2026-11-10T00:00:00Z');
    assert.equal(utcDayKey(d1), '2026-11-09');
    assert.equal(utcDayKey(d2), '2026-11-10');
  });

  test('accepts ISO string representations', () => {
    assert.equal(utcDayKey('2026-11-09T23:59:59Z'), '2026-11-09');
    assert.equal(utcDayKey('2026-11-10T00:00:00Z'), '2026-11-10');
  });

  test('accepts a numeric timestamp', () => {
    const ts1 = new Date('2026-11-09T23:59:59Z').getTime();
    const ts2 = new Date('2026-11-10T00:00:00Z').getTime();
    assert.equal(utcDayKey(ts1), '2026-11-09');
    assert.equal(utcDayKey(ts2), '2026-11-10');
  });

  test('defaults to current UTC date when called with no arguments', () => {
    const expected = new Date().toISOString().slice(0, 10);
    assert.equal(utcDayKey(), expected);
  });
});

describe('consumeDaily — allow/block boundary', () => {
  test('cap 3 -> counts 1,2,3 allowed true and 4,5 allowed false; result is passed through unchanged', () => {
    const fakeDb = createFakeDb();
    const day = '2026-11-09';
    const cap = 3;

    const r1 = consumeDaily(fakeDb, day, cap, 'ask');
    assert.deepEqual(r1, { count: 1, allowed: true });

    const r2 = consumeDaily(fakeDb, day, cap, 'ask');
    assert.deepEqual(r2, { count: 2, allowed: true });

    const r3 = consumeDaily(fakeDb, day, cap, 'ask');
    assert.deepEqual(r3, { count: 3, allowed: true });

    const r4 = consumeDaily(fakeDb, day, cap, 'ask');
    assert.deepEqual(r4, { count: 4, allowed: false });

    const r5 = consumeDaily(fakeDb, day, cap, 'ask');
    assert.deepEqual(r5, { count: 5, allowed: false });

    // Verify calls passed through to db.consumeDailyAsk
    assert.equal(fakeDb.consumeCalls.length, 5);
    for (const call of fakeDb.consumeCalls) {
      assert.equal(call.day, day);
      assert.equal(call.cap, cap);
    }
  });
});

describe('consumeDaily — first allow', () => {
  test('the first allow at count<=cap writes no event and logs nothing', () => {
    const fakeDb = createFakeDb({ initialCount: 0 });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);

    try {
      const res = consumeDaily(fakeDb, '2026-11-09', 3, 'ask');
      assert.deepEqual(res, { count: 1, allowed: true });
      assert.equal(fakeDb.getCalls.length, 0, 'Must not check cap events when allowed');
      assert.equal(fakeDb.insertCalls.length, 0, 'Must not insert cap event when allowed');
      assert.equal(warnings.length, 0, 'Must not log warnings when allowed');
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('consumeDaily — event-once semantics', () => {
  test('several over-cap calls with a fake db that stores the event return exactly one insert call and exactly one daily_cap warning with JSON payload', () => {
    const fakeDb = createFakeDb({ initialCount: 3 });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

    const day = '2026-11-09';
    const feature = 'cover_letter';

    try {
      // Over cap calls (count 4, 5, 6)
      const r1 = consumeDaily(fakeDb, day, 3, feature);
      assert.equal(r1.allowed, false);

      const r2 = consumeDaily(fakeDb, day, 3, feature);
      assert.equal(r2.allowed, false);

      const r3 = consumeDaily(fakeDb, day, 3, feature);
      assert.equal(r3.allowed, false);

      // Verify db.insertCapEvent called exactly once
      assert.equal(fakeDb.insertCalls.length, 1);
      assert.deepEqual(fakeDb.insertCalls[0], { day, feature });

      // Verify exactly one warning emitted
      assert.equal(warnings.length, 1);
      const parsed = JSON.parse(warnings[0]);
      assert.deepEqual(parsed, {
        event: 'daily_cap',
        day,
        feature,
      });
    } finally {
      console.warn = origWarn;
    }
  });

  test('events are tracked independently per feature on the same day', () => {
    const fakeDb = createFakeDb({ initialCount: 10 });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

    const day = '2026-11-09';

    try {
      // 1. 'ask' hits cap
      consumeDaily(fakeDb, day, 10, 'ask');
      consumeDaily(fakeDb, day, 10, 'ask');
      assert.equal(fakeDb.insertCalls.length, 1);
      assert.deepEqual(fakeDb.insertCalls[0], { day, feature: 'ask' });

      // 2. 'cover_letter' hits cap on the same day
      consumeDaily(fakeDb, day, 10, 'cover_letter');
      consumeDaily(fakeDb, day, 10, 'cover_letter');
      assert.equal(fakeDb.insertCalls.length, 2);
      assert.deepEqual(fakeDb.insertCalls[1], { day, feature: 'cover_letter' });

      // Verify both events logged exactly once each
      assert.equal(warnings.length, 2);
      assert.deepEqual(JSON.parse(warnings[0]), { event: 'daily_cap', day, feature: 'ask' });
      assert.deepEqual(JSON.parse(warnings[1]), { event: 'daily_cap', day, feature: 'cover_letter' });
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('consumeDaily — UTC rollover', () => {
  test('utcDayKey for 2026-11-09T23:59:59Z is 2026-11-09 and for 2026-11-10T00:00:00Z is 2026-11-10; new day with fake db starts at zero and is allowed', () => {
    const d1 = '2026-11-09T23:59:59Z';
    const d2 = '2026-11-10T00:00:00Z';
    const day1 = utcDayKey(d1);
    const day2 = utcDayKey(d2);

    assert.equal(day1, '2026-11-09');
    assert.equal(day2, '2026-11-10');

    // Fake db with per-day counts mimicking SQLite ask_daily_counters
    const dayCounts = new Map();
    const multiDayDb = {
      consumeDailyAsk(day, cap) {
        const current = (dayCounts.get(day) || 0) + 1;
        dayCounts.set(day, current);
        return { count: current, allowed: current <= cap };
      },
      getCapEvent() {
        return null;
      },
      insertCapEvent() {},
    };

    const cap = 2;

    // Day 1: exhaust cap (2 allowed, 3rd blocked)
    const d1r1 = consumeDaily(multiDayDb, day1, cap, 'ask');
    assert.deepEqual(d1r1, { count: 1, allowed: true });

    const d1r2 = consumeDaily(multiDayDb, day1, cap, 'ask');
    assert.deepEqual(d1r2, { count: 2, allowed: true });

    const d1r3 = consumeDaily(multiDayDb, day1, cap, 'ask');
    assert.deepEqual(d1r3, { count: 3, allowed: false });

    // Day 2 (rollover): fresh counter starts at 1 (from zero) and is allowed
    const d2r1 = consumeDaily(multiDayDb, day2, cap, 'ask');
    assert.deepEqual(d2r1, { count: 1, allowed: true });
  });
});

describe('consumeDaily — write failure', () => {
  test('when db.insertCapEvent throws, consumeDaily still returns {allowed:false} and emits exactly one warning line naming the day and feature, not throwing', () => {
    const failingDb = createFakeDb({ initialCount: 5, throwOnInsert: true });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

    const day = '2026-11-09';
    const feature = 'cover_letter';

    try {
      let result;
      assert.doesNotThrow(() => {
        result = consumeDaily(failingDb, day, 5, feature);
      });

      assert.ok(result);
      assert.equal(result.allowed, false);
      assert.equal(result.count, 6);

      // Emits exactly one warning line naming day and feature
      assert.equal(warnings.length, 1);
      const warningLine = warnings[0];
      assert.ok(
        warningLine.includes(day),
        `Warning line must name the day (${day}): "${warningLine}"`
      );
      assert.ok(
        warningLine.includes(feature),
        `Warning line must name the feature (${feature}): "${warningLine}"`
      );
    } finally {
      console.warn = origWarn;
    }
  });

  test('when db.getCapEvent throws, consumeDaily still returns {allowed:false} and emits exactly one warning line naming the day and feature, not throwing', () => {
    const failingDb = createFakeDb({ initialCount: 5, throwOnGet: true });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

    const day = '2026-11-09';
    const feature = 'ask';

    try {
      let result;
      assert.doesNotThrow(() => {
        result = consumeDaily(failingDb, day, 5, feature);
      });

      assert.ok(result);
      assert.equal(result.allowed, false);
      assert.equal(result.count, 6);

      assert.equal(warnings.length, 1);
      const warningLine = warnings[0];
      assert.ok(warningLine.includes(day));
      assert.ok(warningLine.includes(feature));
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('consumeDaily — privacy', () => {
  test('the captured warn output never contains an IP-like string, job description, Dear Hiring Manager, or backend engineer', () => {
    const fakeDb = createFakeDb({ initialCount: 1 });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

    const sensitiveStrings = [
      '203.0.113.9',
      'job description',
      'Dear Hiring Manager',
      'backend engineer',
    ];

    try {
      // 1. Allowed call
      consumeDaily(fakeDb, '2026-11-09', 1, 'ask');

      // 2. Over cap call
      consumeDaily(fakeDb, '2026-11-09', 1, 'ask');

      // 3. Repeated over cap call
      consumeDaily(fakeDb, '2026-11-09', 1, 'ask');

      // 4. Over cap call on write-failure db
      const failingDb = createFakeDb({ initialCount: 5, throwOnInsert: true });
      consumeDaily(failingDb, '2026-11-09', 1, 'cover_letter');

      // Check all emitted warnings
      for (const warning of warnings) {
        for (const needle of sensitiveStrings) {
          assert.equal(
            warning.includes(needle),
            false,
            `Warning must not contain sensitive string "${needle}": ${warning}`
          );
        }
      }
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('consumeDaily — feature validation', () => {
  test('invalid feature throws TypeError', () => {
    const fakeDb = createFakeDb();
    const day = '2026-11-09';
    const cap = 10;

    const invalidFeatures = [
      undefined,
      null,
      '',
      'invalid',
      'ASK',
      'COVER_LETTER',
      'admin',
      123,
      {},
      [],
    ];

    for (const invalid of invalidFeatures) {
      assert.throws(
        () => consumeDaily(fakeDb, day, cap, invalid),
        TypeError,
        `Expected TypeError for feature: ${JSON.stringify(invalid)}`
      );
    }
  });

  test('valid features (ask, cover_letter) do not throw TypeError', () => {
    const fakeDb = createFakeDb();
    const day = '2026-11-09';
    const cap = 10;

    assert.doesNotThrow(() => {
      consumeDaily(fakeDb, day, cap, 'ask');
    });

    assert.doesNotThrow(() => {
      consumeDaily(fakeDb, day, cap, 'cover_letter');
    });
  });
});
