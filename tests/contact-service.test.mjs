/**
 * tests/contact-service.test.mjs
 *
 * Unit tests for src/lib/contact-service.mjs.
 * Uses injected stubs for db, mailer, and rateLimiter — no network or disk.
 * Run with: node --experimental-sqlite --test tests/contact-service.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { processContact } from '../src/lib/contact-service.mjs';
import { createRateLimiter } from '../src/lib/rate-limit.mjs';

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  name:    'Alice',
  email:   'alice@example.com',
  message: 'Hello there',
};

const INVALID_INPUT = {
  name:    '',
  email:   'not-an-email',
  message: '',
};

/** Stub rateLimiter that always allows. */
function allowedLimiter() {
  return { check: () => ({ allowed: true, retryAfterSeconds: 0 }) };
}

/** Stub rateLimiter that always rejects. */
function rejectedLimiter(retryAfterSeconds = 1800) {
  return { check: () => ({ allowed: false, retryAfterSeconds }) };
}

/** Stub mailer that is configured and succeeds. */
function successMailer() {
  return {
    status: () => 'configured',
    send:   async () => {},
  };
}

/** Stub mailer that is configured but throws on send. */
function failingMailer(reason = 'SMTP timeout') {
  return {
    status: () => 'configured',
    send:   async () => { throw new Error(reason); },
  };
}

/** Stub mailer that is disabled. */
function disabledMailer() {
  return {
    status: () => 'disabled',
    send:   async () => { throw new Error('disabled'); },
  };
}

/** Stub db that works correctly. Tracks calls. */
function happyDb() {
  let nextId = 1;
  const calls = { inserts: [], markSent: [], markFailed: [] };
  return {
    insertMessage: (msg) => {
      calls.inserts.push(msg);
      return nextId++;
    },
    markSent:   (id) => calls.markSent.push(id),
    markFailed: (id, reason) => calls.markFailed.push({ id, reason }),
    _calls: calls,
  };
}

/** Stub db that throws on insert. */
function brokenDb() {
  return {
    insertMessage: () => { throw new Error('disk full'); },
    markSent:   () => {},
    markFailed: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processContact', () => {
  test('400 — validation failure (no write, no send)', async () => {
    const db = happyDb();
    const mailer = successMailer();
    const rateLimiter = allowedLimiter();

    const result = await processContact(INVALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });

    assert.equal(result.status, 400);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, 'validation');
    assert.ok(result.payload.errors, 'should have errors field');
    // No DB writes
    assert.equal(db._calls.inserts.length, 0);
    assert.equal(db._calls.markSent.length, 0);
    assert.equal(db._calls.markFailed.length, 0);
  });

  test('429 — rate limited (no write, no send)', async () => {
    const db = happyDb();
    const mailer = successMailer();
    const rateLimiter = rejectedLimiter(1800);

    const result = await processContact(VALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });

    assert.equal(result.status, 429);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, 'rate_limited');
    assert.equal(result.payload.retryAfterSeconds, 1800);
    // No DB writes
    assert.equal(db._calls.inserts.length, 0);
  });

  test('503 — mailer disabled (no write, no send)', async () => {
    const db = happyDb();
    const mailer = disabledMailer();
    const rateLimiter = allowedLimiter();

    const result = await processContact(VALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });

    assert.equal(result.status, 503);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, 'disabled');
    assert.ok(result.payload.contactEmail);
    // No DB writes
    assert.equal(db._calls.inserts.length, 0);
  });

  test('500 — DB insert fails (no send attempted)', async () => {
    const db = brokenDb();
    const mailerWithSpy = successMailer();
    let sendCalled = false;
    const mailer = {
      status: () => 'configured',
      send: async () => { sendCalled = true; },
    };
    const rateLimiter = allowedLimiter();

    const result = await processContact(VALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });

    assert.equal(result.status, 500);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, 'storage');
    // No send should have been attempted
    assert.equal(sendCalled, false);
  });

  test('200 — successful send (one row marked sent)', async () => {
    const db = happyDb();
    const mailer = successMailer();
    const rateLimiter = allowedLimiter();

    const result = await processContact(VALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.status, 'sent');
    assert.equal(typeof result.payload.id, 'number');
    // One insert, one markSent, no markFailed
    assert.equal(db._calls.inserts.length, 1);
    assert.equal(db._calls.markSent.length, 1);
    assert.equal(db._calls.markFailed.length, 0);
    assert.equal(db._calls.markSent[0], result.payload.id);
  });

  test('502 — send fails (one row marked failed)', async () => {
    const db = happyDb();
    const mailer = failingMailer('Connection refused');
    const rateLimiter = allowedLimiter();

    const result = await processContact(VALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });

    assert.equal(result.status, 502);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, 'delivery_failed');
    assert.equal(typeof result.payload.id, 'number');
    assert.ok(result.payload.contactEmail);
    // One insert, no markSent, one markFailed
    assert.equal(db._calls.inserts.length, 1);
    assert.equal(db._calls.markSent.length, 0);
    assert.equal(db._calls.markFailed.length, 1);
    assert.equal(db._calls.markFailed[0].id, result.payload.id);
    assert.ok(db._calls.markFailed[0].reason.length > 0);
  });

  test('ordering: limiter is called once for invalid input and response is 400', async () => {
    const checkCalls = [];
    const rateLimiter = {
      check: (key) => {
        checkCalls.push(key);
        return { allowed: false, retryAfterSeconds: 60 };
      },
    };
    const db = happyDb();
    const mailer = successMailer();

    const result = await processContact(INVALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });
    assert.equal(result.status, 400);
    assert.equal(checkCalls.length, 1, 'rate limiter should be called exactly once');
    assert.equal(checkCalls[0], '1.2.3.4');
  });

  test('ordering: rate limiting counts invalid attempts (real rateLimiter)', async () => {
    const rateLimiter = createRateLimiter({ limit: 2, windowMs: 3_600_000 });
    const db = happyDb();
    const mailer = successMailer();

    // Two invalid submissions return 400
    const res1 = await processContact(INVALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });
    assert.equal(res1.status, 400);

    const res2 = await processContact(INVALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });
    assert.equal(res2.status, 400);

    // Valid third submission returns 429 with retryAfterSeconds > 0 and no db write
    const res3 = await processContact(VALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });
    assert.equal(res3.status, 429);
    assert.equal(res3.payload.ok, false);
    assert.equal(res3.payload.error, 'rate_limited');
    assert.ok(res3.payload.retryAfterSeconds > 0, 'retryAfterSeconds should be > 0');
    assert.equal(db._calls.inserts.length, 0, 'no db write on 429');
  });

  test('ordering: rate-limit happens before enabled check', async () => {
    const mailerStatusCalls = [];
    const mailer = {
      status: () => { mailerStatusCalls.push(true); return 'disabled'; },
      send: async () => {},
    };
    const rateLimiter = rejectedLimiter();
    const db = happyDb();

    // Rate limited — mailer.status should NOT be called
    await processContact(VALID_INPUT, '1.2.3.4', { db, mailer, rateLimiter });
    assert.equal(mailerStatusCalls.length, 0, 'mailer.status should not be called when rate-limited');
  });
});
