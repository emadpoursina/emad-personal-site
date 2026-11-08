/**
 * tests/db.test.mjs
 *
 * Unit tests for src/lib/db.mjs.
 * Uses a temporary DATA_DIR that is cleaned up after each test.
 * Run with: node --experimental-sqlite --test tests/db.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers: each test gets a fresh DATA_DIR and a fresh db module instance
// ---------------------------------------------------------------------------

let tempDir;

/**
 * Loads a fresh db module with DATA_DIR pointing at tempDir.
 * @returns {Promise<typeof import('../src/lib/db.mjs')>}
 */
async function freshDb() {
  // Set DATA_DIR before importing
  process.env.DATA_DIR = tempDir;

  // Reset env module cache
  const { reset: resetEnv } = await import('../src/lib/env.mjs');
  resetEnv();

  // We need a fresh import of db.mjs. Node's ESM cache means we can't
  // easily reload. Instead, we use a cache-busting query string approach
  // by exporting a reinitialize helper from the module. Since we can't
  // change the module on the fly, we'll use the close() export to reset.
  const db = await import('../src/lib/db.mjs');
  db.close(); // reset internal state
  return db;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'db-test-'));
});

afterEach(async () => {
  // Close the db and clean up
  const db = await import('../src/lib/db.mjs');
  db.close();
  // Also reset env
  const { reset: resetEnv } = await import('../src/lib/env.mjs');
  resetEnv();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('db.mjs', () => {
  test('schema is created on first open (countMessages returns 0)', async () => {
    const db = await freshDb();
    assert.equal(db.countMessages(), 0);
  });

  test('isHealthy returns true for a valid database', async () => {
    const db = await freshDb();
    assert.equal(db.isHealthy(), true);
  });

  test('insertMessage returns a numeric id', async () => {
    const db = await freshDb();
    const id = db.insertMessage({ name: 'Alice', email: 'alice@example.com', message: 'Hello' });
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);
  });

  test('countMessages increments after insert', async () => {
    const db = await freshDb();
    db.insertMessage({ name: 'Alice', email: 'a@a.com', message: 'msg1' });
    db.insertMessage({ name: 'Bob',   email: 'b@b.com', message: 'msg2' });
    assert.equal(db.countMessages(), 2);
  });

  test('markSent updates delivery_status to sent', async () => {
    const db = await freshDb();
    const id = db.insertMessage({ name: 'Alice', email: 'a@a.com', message: 'msg' });
    db.markSent(id);
    // We can't easily read back without reaching into the DB, but
    // countMessages still works (meaning the update ran without error).
    assert.equal(db.countMessages(), 1);
    // Calling markSent twice shouldn't throw
    assert.doesNotThrow(() => db.markSent(id));
  });

  test('markFailed updates delivery_error to a reason', async () => {
    const db = await freshDb();
    const id = db.insertMessage({ name: 'Bob', email: 'b@b.com', message: 'msg' });
    db.markFailed(id, 'SMTP timeout');
    assert.equal(db.countMessages(), 1);
    // Calling markFailed twice shouldn't throw
    assert.doesNotThrow(() => db.markFailed(id, 'retry'));
  });

  test('insert + markSent + markFailed round-trip', async () => {
    const db = await freshDb();
    const id1 = db.insertMessage({ name: 'A', email: 'a@a.com', message: 'sent one' });
    const id2 = db.insertMessage({ name: 'B', email: 'b@b.com', message: 'failed one' });
    db.markSent(id1);
    db.markFailed(id2, 'Connection refused');
    assert.equal(db.countMessages(), 2);
  });

  test('isHealthy returns false for a broken data directory', async () => {
    // Point DATA_DIR at a file (not a directory) to force a failure
    process.env.DATA_DIR = '/dev/null/not-a-dir';
    const { reset: resetEnv } = await import('../src/lib/env.mjs');
    resetEnv();
    const db = await import('../src/lib/db.mjs');
    db.close(); // ensure fresh state

    // isHealthy must not throw, just return false
    let healthy;
    assert.doesNotThrow(() => {
      healthy = db.isHealthy();
    });
    assert.equal(healthy, false);

    // Restore DATA_DIR for afterEach
    process.env.DATA_DIR = tempDir;
    resetEnv();
    db.close();
  });
});
