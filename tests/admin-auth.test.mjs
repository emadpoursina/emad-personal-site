/**
 * tests/admin-auth.test.mjs
 *
 * Unit tests for admin authentication primitives (src/lib/admin-auth.mjs).
 * Uses a temporary DATA_DIR, env.reset(), and db.close() per test.
 * Run with: node --experimental-sqlite --test tests/admin-auth.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  verifyPassword,
  createSession,
  getSessionFromRequest,
  destroySession,
  isSecureRequest,
  buildSessionCookie,
  clearSessionCookie,
  isSameOrigin,
  getLockout,
  recordLoginFailure,
  clearLoginFailures,
  resetLoginFailures,
} from '../src/lib/admin-auth.mjs';

import * as db from '../src/lib/db.mjs';
import * as env from '../src/lib/env.mjs';

let tempDir;

/**
 * Builds a valid scrypt password hash using crypto.scryptSync with valid parameters.
 *
 * @param {string} password
 * @param {object} [options]
 * @returns {string}
 */
function buildTestHash(password, { N = 16384, r = 8, p = 1, saltBytes = 16, keyBytes = 64 } = {}) {
  const salt = crypto.randomBytes(saltBytes);
  const derivedKey = crypto.scryptSync(password, salt, keyBytes, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'admin-auth-test-'));
  process.env.DATA_DIR = tempDir;
  env.reset();
  db.close();
  resetLoginFailures();
});

afterEach(() => {
  db.close();
  env.reset();
  resetLoginFailures();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// 1. Password Verification
// ---------------------------------------------------------------------------

describe('verifyPassword', () => {
  test('valid hash verifies correct password and rejects wrong password', async () => {
    const password = 'correct-horse-battery-staple';
    const storedHash = buildTestHash(password);

    const match = await verifyPassword(password, storedHash);
    assert.equal(match, true);

    const mismatch = await verifyPassword('incorrect-password', storedHash);
    assert.equal(mismatch, false);
  });

  test('malformed hash forms fail closed with at most one warning', async () => {
    const validSaltB64 = crypto.randomBytes(16).toString('base64');
    const validHashB64 = crypto.randomBytes(64).toString('base64');

    const malformedHashes = [
      '',                                                  // empty
      'not-scrypt',                                        // not formatted
      'bcrypt$16384$8$1$' + validSaltB64 + '$' + validHashB64, // wrong scheme
      'scrypt$16384$8$1$' + validSaltB64,                  // missing parts (5 parts)
      'scrypt$16384$8$1$' + validSaltB64 + '$' + validHashB64 + '$extra', // extra parts (7 parts)
      'scrypt$1000$8$1$' + validSaltB64 + '$' + validHashB64, // N not power of two
      'scrypt$1$8$1$' + validSaltB64 + '$' + validHashB64,    // N < 2
      'scrypt$2097152$8$1$' + validSaltB64 + '$' + validHashB64, // N > 2^20 (1048576)
      'scrypt$16384$0$1$' + validSaltB64 + '$' + validHashB64,  // r < 1
      'scrypt$16384$17$1$' + validSaltB64 + '$' + validHashB64, // r > 16
      'scrypt$16384$8$0$' + validSaltB64 + '$' + validHashB64,  // p < 1
      'scrypt$16384$8$17$' + validSaltB64 + '$' + validHashB64, // p > 16
      'scrypt$16384$8$1$not-valid-base64!$' + validHashB64,    // invalid salt base64
      'scrypt$16384$8$1$' + validSaltB64 + '$not-valid-base64!', // invalid hash base64
      null,                                                // null
      undefined,                                           // undefined
    ];

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.join(' '));
    };

    try {
      for (const badHash of malformedHashes) {
        const result = await verifyPassword('test-password', badHash);
        assert.equal(result, false, `Expected false for malformed hash: ${badHash}`);
      }
    } finally {
      console.warn = originalWarn;
    }

    // At most ONE warning per process, with no password or hash leaked
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('test-password'));
    assert.ok(!warnings[0].includes('scrypt'));
    assert.ok(warnings[0].includes('Admin password hash'));
  });

  test('non-string password fails closed without warning', async () => {
    const storedHash = buildTestHash('valid-pass');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.join(' '));
    };

    try {
      const r1 = await verifyPassword(null, storedHash);
      assert.equal(r1, false);
      const r2 = await verifyPassword(undefined, storedHash);
      assert.equal(r2, false);
      const r3 = await verifyPassword(12345, storedHash);
      assert.equal(r3, false);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Cookie Building and Clearing
// ---------------------------------------------------------------------------

describe('cookie primitives', () => {
  const sampleId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  test('buildSessionCookie without secure', () => {
    const cookie = buildSessionCookie(sampleId, { secure: false });
    assert.equal(
      cookie,
      `admin_session=${sampleId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`
    );
  });

  test('buildSessionCookie with secure', () => {
    const cookie = buildSessionCookie(sampleId, { secure: true });
    assert.equal(
      cookie,
      `admin_session=${sampleId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800; Secure`
    );
  });

  test('clearSessionCookie without secure', () => {
    const cookie = clearSessionCookie({ secure: false });
    assert.equal(
      cookie,
      'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    );
  });

  test('clearSessionCookie with secure', () => {
    const cookie = clearSessionCookie({ secure: true });
    assert.equal(
      cookie,
      'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure'
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Session Management with SQLite
// ---------------------------------------------------------------------------

describe('session lifecycle in SQLite', () => {
  test('session creation expiry is exactly 8h and stores in database', () => {
    const fixedNow = 1_700_000_000_000;
    const { id, expiresAt } = createSession(db, { now: fixedNow });

    assert.equal(typeof id, 'string');
    assert.equal(id.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(id));

    const expectedExpiry = new Date(fixedNow + 8 * 60 * 60 * 1000).toISOString();
    assert.equal(expiresAt, expectedExpiry);

    // Verify written to database
    const row = db.getSession(id);
    assert.ok(row);
    assert.equal(row.id, id);
    assert.equal(row.expires_at, expectedExpiry);
  });

  test('getSessionFromRequest returns row when valid and unexpired', () => {
    const fixedNow = 1_700_000_000_000;
    const { id, expiresAt } = createSession(db, { now: fixedNow });

    const req = new Request('http://localhost:4321/admin', {
      headers: {
        cookie: `theme=dark; admin_session=${id}; other=123`,
      },
    });

    const session = getSessionFromRequest(req, db, { now: fixedNow + 1000 });
    assert.ok(session);
    assert.equal(session.id, id);
    assert.equal(session.expires_at, expiresAt);
  });

  test('getSessionFromRequest returns null when cookie is missing or malformed', () => {
    const fixedNow = 1_700_000_000_000;
    const { id } = createSession(db, { now: fixedNow });

    // No cookie header
    const reqNoCookie = new Request('http://localhost:4321/admin');
    assert.equal(getSessionFromRequest(reqNoCookie, db), null);

    // Other cookie only
    const reqOther = new Request('http://localhost:4321/admin', {
      headers: { cookie: 'foo=bar' },
    });
    assert.equal(getSessionFromRequest(reqOther, db), null);

    // Malformed session id (too short, non-hex, etc.)
    const badIds = ['short', '0123456789abcdef', 'z'.repeat(64), id + 'a', id.slice(0, 63)];
    for (const badId of badIds) {
      const reqBad = new Request('http://localhost:4321/admin', {
        headers: { cookie: `admin_session=${badId}` },
      });
      assert.equal(getSessionFromRequest(reqBad, db), null);
    }

    // 64-hex id that does not exist in DB
    const nonExistent = 'a'.repeat(64);
    const reqNonExistent = new Request('http://localhost:4321/admin', {
      headers: { cookie: `admin_session=${nonExistent}` },
    });
    assert.equal(getSessionFromRequest(reqNonExistent, db), null);
  });

  test('expired row returns null and row is physically deleted', () => {
    const fixedNow = 1_700_000_000_000;
    const { id } = createSession(db, { now: fixedNow });

    // Exactly at expiry (expires_at <= now)
    const expiryMs = fixedNow + 8 * 60 * 60 * 1000;
    const reqAtExpiry = new Request('http://localhost:4321/admin', {
      headers: { cookie: `admin_session=${id}` },
    });

    const session = getSessionFromRequest(reqAtExpiry, db, { now: expiryMs });
    assert.equal(session, null);

    // Row should be deleted from SQLite
    assert.equal(db.getSession(id), null);
  });

  test('revocation via destroySession returns null on subsequent lookup', () => {
    const fixedNow = 1_700_000_000_000;
    const { id } = createSession(db, { now: fixedNow });

    const req = new Request('http://localhost:4321/admin', {
      headers: { cookie: `admin_session=${id}` },
    });

    // Valid before revocation
    assert.ok(getSessionFromRequest(req, db, { now: fixedNow + 1000 }));

    // Revoke
    destroySession(db, id);

    // Invalid after revocation
    assert.equal(getSessionFromRequest(req, db, { now: fixedNow + 1000 }), null);
    assert.equal(db.getSession(id), null);
  });
});

// ---------------------------------------------------------------------------
// 4. Secure Request Detection
// ---------------------------------------------------------------------------

describe('isSecureRequest', () => {
  test('returns true for native https protocol', () => {
    const req = new Request('https://example.com/admin');
    assert.equal(isSecureRequest(req), true);
  });

  test('returns false for plain http protocol when TRUST_PROXY is 0', () => {
    process.env.TRUST_PROXY = '0';
    env.reset();

    const req1 = new Request('http://example.com/admin');
    assert.equal(isSecureRequest(req1), false);

    const req2 = new Request('http://example.com/admin', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(isSecureRequest(req2), false);
  });

  test('recognizes X-Forwarded-Proto https when TRUST_PROXY is 1', () => {
    process.env.TRUST_PROXY = '1';
    env.reset();

    const reqHttps = new Request('http://example.com/admin', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(isSecureRequest(reqHttps), true);

    // Case-insensitive
    const reqUpper = new Request('http://example.com/admin', {
      headers: { 'x-forwarded-proto': 'HTTPS' },
    });
    assert.equal(isSecureRequest(reqUpper), true);

    // Multiple values in header: first value takes precedence
    const reqMultiFirstHttps = new Request('http://example.com/admin', {
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    assert.equal(isSecureRequest(reqMultiFirstHttps), true);

    const reqMultiFirstHttp = new Request('http://example.com/admin', {
      headers: { 'x-forwarded-proto': 'http, https' },
    });
    assert.equal(isSecureRequest(reqMultiFirstHttp), false);
  });
});

// ---------------------------------------------------------------------------
// 5. Same-Origin Check
// ---------------------------------------------------------------------------

describe('isSameOrigin', () => {
  const targetUrl = 'http://127.0.0.1:4321/api/admin/settings';

  test('returns false when neither Origin nor Referer is present', () => {
    const req = new Request(targetUrl, { method: 'POST' });
    assert.equal(isSameOrigin(req), false);
  });

  test('returns true when Origin matches request URL origin', () => {
    const req = new Request(targetUrl, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });
    assert.equal(isSameOrigin(req), true);
  });

  test('returns false when Origin mismatches even if Referer matches', () => {
    const req = new Request(targetUrl, {
      method: 'POST',
      headers: {
        origin: 'http://attacker.com',
        referer: 'http://127.0.0.1:4321/admin',
      },
    });
    assert.equal(isSameOrigin(req), false);
  });

  test('returns true when Referer matches and Origin is absent', () => {
    const req = new Request(targetUrl, {
      method: 'POST',
      headers: { referer: 'http://127.0.0.1:4321/admin' },
    });
    assert.equal(isSameOrigin(req), true);
  });

  test('returns false when Referer mismatches and Origin is absent', () => {
    const req = new Request(targetUrl, {
      method: 'POST',
      headers: { referer: 'http://attacker.com/admin' },
    });
    assert.equal(isSameOrigin(req), false);
  });

  test('returns false when Origin is malformed', () => {
    const req = new Request(targetUrl, {
      method: 'POST',
      headers: { origin: 'not-a-valid-url' },
    });
    assert.equal(isSameOrigin(req), false);
  });

  test('returns false when Referer is malformed (and Origin is absent)', () => {
    const req = new Request(targetUrl, {
      method: 'POST',
      headers: { referer: 'not-a-valid-url' },
    });
    assert.equal(isSameOrigin(req), false);
  });
});

// ---------------------------------------------------------------------------
// 6. Lockout and Login Failure Tracking
// ---------------------------------------------------------------------------

describe('lockout tracking', () => {
  const ip1 = '192.168.1.100';
  const ip2 = '10.0.0.50';

  test('lockout five failures in window -> blocked with Retry-After ~900', () => {
    const t0 = 1_000_000;

    // Failures 1 through 4: not blocked
    for (let i = 1; i <= 4; i++) {
      const state = recordLoginFailure(ip1, { now: t0 + i * 1000 });
      assert.deepEqual(state, { blocked: false, retryAfterSeconds: 0 });
      assert.deepEqual(getLockout(ip1, { now: t0 + i * 1000 }), {
        blocked: false,
        retryAfterSeconds: 0,
      });
    }

    // 5th failure: triggers lockout
    const fifthNow = t0 + 5000;
    const fifthState = recordLoginFailure(ip1, { now: fifthNow });
    assert.equal(fifthState.blocked, true);
    assert.equal(fifthState.retryAfterSeconds, 900);

    const lockStatus = getLockout(ip1, { now: fifthNow });
    assert.equal(lockStatus.blocked, true);
    assert.equal(lockStatus.retryAfterSeconds, 900);
  });

  test('a blocked IP stays blocked and recording while blocked is a no-op', () => {
    const t0 = 1_000_000;
    for (let i = 1; i <= 5; i++) {
      recordLoginFailure(ip1, { now: t0 });
    }

    // 6th attempt 10 seconds later
    const sixthNow = t0 + 10_000;
    const sixthState = recordLoginFailure(ip1, { now: sixthNow });
    assert.equal(sixthState.blocked, true);
    assert.equal(sixthState.retryAfterSeconds, 890);

    const queryState = getLockout(ip1, { now: sixthNow });
    assert.equal(queryState.blocked, true);
    assert.equal(queryState.retryAfterSeconds, 890);
  });

  test('per-IP isolation: blocking ip1 does not affect ip2', () => {
    const t0 = 1_000_000;
    for (let i = 1; i <= 5; i++) {
      recordLoginFailure(ip1, { now: t0 });
    }

    assert.equal(getLockout(ip1, { now: t0 }).blocked, true);
    assert.equal(getLockout(ip2, { now: t0 }).blocked, false);
    assert.equal(getLockout(ip2, { now: t0 }).retryAfterSeconds, 0);
  });

  test('successful-login clear removes failure record', () => {
    const t0 = 1_000_000;
    for (let i = 1; i <= 3; i++) {
      recordLoginFailure(ip1, { now: t0 });
    }

    clearLoginFailures(ip1);
    assert.deepEqual(getLockout(ip1, { now: t0 }), {
      blocked: false,
      retryAfterSeconds: 0,
    });

    // 4 more failures now do not reach the 5-failure threshold
    for (let i = 1; i <= 4; i++) {
      const state = recordLoginFailure(ip1, { now: t0 + 1000 });
      assert.equal(state.blocked, false);
    }
  });

  test('failures pruned outside the 15-minute window', () => {
    const t0 = 1_000_000;

    // 4 failures at t0
    for (let i = 1; i <= 4; i++) {
      recordLoginFailure(ip1, { now: t0 });
    }

    // 16 minutes later (window is 15 min = 900,000 ms)
    const t1 = t0 + 16 * 60 * 1000;

    // 5th failure at t1: the earlier 4 failures are older than 15 min and pruned
    const state = recordLoginFailure(ip1, { now: t1 });
    assert.equal(state.blocked, false);
    assert.equal(state.retryAfterSeconds, 0);

    const status = getLockout(ip1, { now: t1 });
    assert.equal(status.blocked, false);
    assert.equal(status.retryAfterSeconds, 0);
  });
});
