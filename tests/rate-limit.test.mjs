/**
 * tests/rate-limit.test.mjs
 *
 * Unit tests for src/lib/rate-limit.mjs.
 * Run with: node --experimental-sqlite --test tests/rate-limit.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/lib/rate-limit.mjs';

describe('createRateLimiter', () => {
  test('allows requests up to the limit', () => {
    const rl = createRateLimiter({ windowMs: 3_600_000, limit: 3 });
    const r1 = rl.check('client1');
    const r2 = rl.check('client1');
    const r3 = rl.check('client1');
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, true);
  });

  test('rejects the request beyond the limit', () => {
    const rl = createRateLimiter({ windowMs: 3_600_000, limit: 2 });
    rl.check('client2');
    rl.check('client2');
    const result = rl.check('client2'); // 3rd — over limit
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfterSeconds > 0, 'retryAfterSeconds should be positive');
  });

  test('every attempt counts including rejected ones', () => {
    const rl = createRateLimiter({ windowMs: 3_600_000, limit: 1 });
    const r1 = rl.check('client3'); // 1st: allowed
    const r2 = rl.check('client3'); // 2nd: rejected
    const r3 = rl.check('client3'); // 3rd: rejected — still counts
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
    assert.equal(r3.allowed, false);
  });

  test('different client keys are tracked independently', () => {
    const rl = createRateLimiter({ windowMs: 3_600_000, limit: 1 });
    const a = rl.check('clientA');
    const b = rl.check('clientB');
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);

    const a2 = rl.check('clientA'); // over limit for A
    const b2 = rl.check('clientB'); // over limit for B
    assert.equal(a2.allowed, false);
    assert.equal(b2.allowed, false);
  });

  test('old timestamps outside the window are pruned', async () => {
    // Use a very small window (100 ms) so we can wait it out
    const rl = createRateLimiter({ windowMs: 100, limit: 1 });

    rl.check('client4'); // 1st — fills the slot
    const r2 = rl.check('client4'); // 2nd — rejected
    assert.equal(r2.allowed, false);

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 150));

    const r3 = rl.check('client4'); // window expired; should be allowed
    assert.equal(r3.allowed, true);
  });

  test('retryAfterSeconds is a positive integer', () => {
    const rl = createRateLimiter({ windowMs: 3_600_000, limit: 1 });
    rl.check('client5'); // fills slot
    const { retryAfterSeconds } = rl.check('client5'); // rejected
    assert.equal(typeof retryAfterSeconds, 'number');
    assert.ok(Number.isInteger(retryAfterSeconds));
    assert.ok(retryAfterSeconds > 0);
  });

  test('retryAfterSeconds is 0 for allowed requests', () => {
    const rl = createRateLimiter({ windowMs: 3_600_000, limit: 5 });
    const { allowed, retryAfterSeconds } = rl.check('client6');
    assert.equal(allowed, true);
    assert.equal(retryAfterSeconds, 0);
  });
});
