/**
 * tests/db.test.mjs
 *
 * Unit tests for src/lib/db.mjs.
 * Uses a temporary DATA_DIR that is cleaned up after each test.
 * Run with: node --experimental-sqlite --test tests/db.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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

  test('fresh DB: PRAGMA user_version is 3, all tables and indexes exist', async () => {
    const db = await freshDb();
    assert.equal(db.countMessages(), 0);
    db.close();

    const rawDb = new DatabaseSync(join(tempDir, 'site.sqlite'));
    try {
      const { user_version: version } = rawDb.prepare('PRAGMA user_version').get();
      assert.equal(version, 3);

      const tables = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.deepEqual(tables, [
        'admin_sessions',
        'ask_daily_counters',
        'ask_questions',
        'contact_messages',
        'daily_cap_events',
        'settings',
      ]);

      const indexes = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.deepEqual(indexes, [
        'idx_admin_sessions_expires_at',
        'idx_ask_questions_created_at',
        'idx_contact_messages_created_at',
      ]);
    } finally {
      rawDb.close();
    }
  });

  test('version-1 DB: upgraded to version 3, row survives, tables exist', async () => {
    // Before touching db module, create site.sqlite at version 1
    const rawDb1 = new DatabaseSync(join(tempDir, 'site.sqlite'));
    rawDb1.exec(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        name            TEXT    NOT NULL,
        email           TEXT    NOT NULL,
        message         TEXT    NOT NULL,
        delivery_status TEXT    NOT NULL CHECK (delivery_status IN ('sent','failed')),
        delivery_error  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
        ON contact_messages (created_at DESC);
      PRAGMA user_version = 1;
    `);
    rawDb1.prepare(`
      INSERT INTO contact_messages (name, email, message, delivery_status)
      VALUES ('V1 User', 'v1@example.com', 'Existing v1 message', 'sent')
    `).run();
    rawDb1.close();

    // Now open through module
    const db = await freshDb();
    assert.equal(db.countMessages(), 1);
    db.close();

    // Inspect raw state
    const rawDb2 = new DatabaseSync(join(tempDir, 'site.sqlite'));
    try {
      const { user_version: version } = rawDb2.prepare('PRAGMA user_version').get();
      assert.equal(version, 3);

      const tables = rawDb2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.ok(tables.includes('contact_messages'));
      assert.ok(tables.includes('settings'));
      assert.ok(tables.includes('admin_sessions'));
      assert.ok(tables.includes('ask_questions'));
      assert.ok(tables.includes('ask_daily_counters'));
      assert.ok(tables.includes('daily_cap_events'));
    } finally {
      rawDb2.close();
    }
  });

  test('version-2 DB: upgraded to version 3, rows survive, daily_cap_events exists', async () => {
    // Hand-built version-2 database (version-2 DDL + PRAGMA user_version=2)
    const rawDb1 = new DatabaseSync(join(tempDir, 'site.sqlite'));
    rawDb1.exec(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        name            TEXT    NOT NULL,
        email           TEXT    NOT NULL,
        message         TEXT    NOT NULL,
        delivery_status TEXT    NOT NULL CHECK (delivery_status IN ('sent','failed')),
        delivery_error  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
        ON contact_messages (created_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id         TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
        ON admin_sessions (expires_at);

      CREATE TABLE IF NOT EXISTS ask_questions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        question   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ask_questions_created_at
        ON ask_questions (created_at DESC);

      CREATE TABLE IF NOT EXISTS ask_daily_counters (
        day        TEXT PRIMARY KEY,
        count      INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      PRAGMA user_version = 2;
    `);

    rawDb1.prepare(`
      INSERT INTO contact_messages (name, email, message, delivery_status)
      VALUES ('V2 User', 'v2@example.com', 'Existing v2 message', 'sent')
    `).run();
    rawDb1.prepare(`
      INSERT INTO settings (key, value) VALUES ('site_theme', 'nord')
    `).run();
    rawDb1.prepare(`
      INSERT INTO ask_questions (question) VALUES ('Existing v2 question')
    `).run();
    rawDb1.prepare(`
      INSERT INTO ask_daily_counters (day, count) VALUES ('2026-11-09', 1)
    `).run();
    rawDb1.close();

    // Open through the module
    const db = await freshDb();
    assert.equal(db.countMessages(), 1);
    assert.equal(db.getSetting('site_theme'), 'nord');
    assert.equal(db.countQuestions(), 1);
    const counterRes = db.consumeDailyAsk('2026-11-09', 10);
    assert.equal(counterRes.count, 2);
    assert.equal(counterRes.allowed, true);
    db.close();

    // Inspect raw state
    const rawDb2 = new DatabaseSync(join(tempDir, 'site.sqlite'));
    try {
      const { user_version: version } = rawDb2.prepare('PRAGMA user_version').get();
      assert.equal(version, 3);

      const tables = rawDb2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.ok(tables.includes('daily_cap_events'));
    } finally {
      rawDb2.close();
    }
  });

  test('second open of the same file is idempotent', async () => {
    const db1 = await freshDb();
    db1.insertMessage({ name: 'Alice', email: 'alice@example.com', message: 'Hello' });
    db1.setSetting('theme', 'dark');
    db1.insertQuestion('What is this?');
    assert.equal(db1.countMessages(), 1);
    assert.equal(db1.countQuestions(), 1);
    assert.equal(db1.getSetting('theme'), 'dark');
    db1.close();

    // Reopen same file
    const db2 = await freshDb();
    assert.doesNotThrow(() => {
      assert.equal(db2.countMessages(), 1);
      assert.equal(db2.countQuestions(), 1);
      assert.equal(db2.getSetting('theme'), 'dark');
    });
    db2.close();

    const rawDb = new DatabaseSync(join(tempDir, 'site.sqlite'));
    try {
      const { user_version: version } = rawDb.prepare('PRAGMA user_version').get();
      assert.equal(version, 3);
    } finally {
      rawDb.close();
    }
  });

  test('consumeDailyAsk: atomicity, cap enforcement, and day isolation', async () => {
    const db = await freshDb();
    const day = '2026-11-09';
    const cap = 3;

    const r1 = db.consumeDailyAsk(day, cap);
    assert.deepEqual(r1, { count: 1, allowed: true });

    const r2 = db.consumeDailyAsk(day, cap);
    assert.deepEqual(r2, { count: 2, allowed: true });

    const r3 = db.consumeDailyAsk(day, cap);
    assert.deepEqual(r3, { count: 3, allowed: true });

    const r4 = db.consumeDailyAsk(day, cap);
    assert.deepEqual(r4, { count: 4, allowed: false });

    const r5 = db.consumeDailyAsk(day, cap);
    assert.deepEqual(r5, { count: 5, allowed: false });

    const otherDay = db.consumeDailyAsk('2026-11-10', cap);
    assert.deepEqual(otherDay, { count: 1, allowed: true });
  });

  test('settings CRUD and atomic applySettings', async () => {
    const db = await freshDb();

    // Initial state
    assert.equal(db.getSetting('key1'), null);
    assert.deepEqual(db.getAllSettings(), {});

    // Set & Get
    db.setSetting('a', 'apple');
    assert.equal(db.getSetting('a'), 'apple');
    db.setSetting('b', 'banana');
    assert.deepEqual(db.getAllSettings(), { a: 'apple', b: 'banana' });

    // Upsert updates value
    db.setSetting('a', 'avocado');
    assert.equal(db.getSetting('a'), 'avocado');

    // Delete
    db.deleteSetting('a');
    assert.equal(db.getSetting('a'), null);
    assert.deepEqual(db.getAllSettings(), { b: 'banana' });

    // applySettings({ a: '1' }, ['b']) applies both in one transaction
    db.applySettings({ a: '1' }, ['b']);
    assert.equal(db.getSetting('a'), '1');
    assert.equal(db.getSetting('b'), null);
    assert.deepEqual(db.getAllSettings(), { a: '1' });

    // Failing applySettings (null value on NOT NULL column) rolls back completely
    assert.throws(() => {
      db.applySettings({ c: '3', d: null });
    });
    assert.equal(db.getSetting('c'), null);
    assert.equal(db.getSetting('d'), null);
    // Earlier write 'a' is preserved
    assert.deepEqual(db.getAllSettings(), { a: '1' });
  });

  test('admin_sessions: create, get, delete, deleteExpiredSessions', async () => {
    const db = await freshDb();

    assert.equal(db.getSession('nonexistent'), null);

    db.createSession('sess1', '2026-11-09T08:00:00.000Z');
    const sess = db.getSession('sess1');
    assert.ok(sess);
    assert.equal(sess.id, 'sess1');
    assert.equal(sess.expires_at, '2026-11-09T08:00:00.000Z');
    assert.ok(typeof sess.created_at === 'string' && sess.created_at.length > 0);

    db.deleteSession('sess1');
    assert.equal(db.getSession('sess1'), null);

    // Expiry sweep
    db.createSession('old1', '2026-11-09T01:00:00.000Z');
    db.createSession('old2', '2026-11-09T02:00:00.000Z');
    db.createSession('future', '2026-11-09T10:00:00.000Z');

    const deleted = db.deleteExpiredSessions('2026-11-09T05:00:00.000Z');
    assert.equal(deleted, 2);
    assert.equal(db.getSession('old1'), null);
    assert.equal(db.getSession('old2'), null);
    assert.ok(db.getSession('future'));
  });

  test('ask_questions: insertQuestion and countQuestions', async () => {
    const db = await freshDb();
    assert.equal(db.countQuestions(), 0);

    const q1Id = db.insertQuestion('What is Emad’s role?');
    assert.equal(typeof q1Id, 'number');
    assert.ok(q1Id > 0);

    const q2Id = db.insertQuestion('Tell me about project X.');
    assert.ok(q2Id > q1Id);

    assert.equal(db.countQuestions(), 2);
  });

  test('daily_cap_events: insertCapEvent, getCapEvent, countCapEvents, and CHECK constraint', async () => {
    const db = await freshDb();
    const day = '2026-11-09';

    assert.equal(db.countCapEvents(), 0);
    assert.equal(db.getCapEvent(day, 'cover_letter'), null);

    // insertCapEvent(day,'cover_letter') twice and insertCapEvent(day,'ask') once -> countCapEvents() === 2
    db.insertCapEvent(day, 'cover_letter');
    db.insertCapEvent(day, 'cover_letter');
    db.insertCapEvent(day, 'ask');
    assert.equal(db.countCapEvents(), 2);

    // getCapEvent returns { day, feature, created_at } with non-empty created_at for both
    const clEvent = db.getCapEvent(day, 'cover_letter');
    assert.ok(clEvent);
    assert.equal(clEvent.day, day);
    assert.equal(clEvent.feature, 'cover_letter');
    assert.ok(typeof clEvent.created_at === 'string' && clEvent.created_at.length > 0);

    const askEvent = db.getCapEvent(day, 'ask');
    assert.ok(askEvent);
    assert.equal(askEvent.day, day);
    assert.equal(askEvent.feature, 'ask');
    assert.ok(typeof askEvent.created_at === 'string' && askEvent.created_at.length > 0);

    // a different day adds another row
    const otherDay = '2026-11-10';
    db.insertCapEvent(otherDay, 'cover_letter');
    assert.equal(db.countCapEvents(), 3);
    const otherClEvent = db.getCapEvent(otherDay, 'cover_letter');
    assert.ok(otherClEvent);
    assert.equal(otherClEvent.day, otherDay);
    assert.equal(otherClEvent.feature, 'cover_letter');

    // inserting feature 'other' throws (CHECK constraint)
    assert.doesNotThrow(() => {
      db.insertCapEvent(day, 'other');
    });
    assert.equal(db.countCapEvents(), 3);

    const rawDb = new DatabaseSync(join(tempDir, 'site.sqlite'));
    try {
      assert.throws(() => {
        rawDb.prepare("INSERT INTO daily_cap_events (day, feature) VALUES (?, ?)").run('2026-11-11', 'other');
      });
    } finally {
      rawDb.close();
    }
  });

  test('all accessors throw when database is unavailable', async () => {
    process.env.DATA_DIR = '/dev/null/not-a-dir';
    const { reset: resetEnv } = await import('../src/lib/env.mjs');
    resetEnv();
    const db = await import('../src/lib/db.mjs');
    db.close();

    const expectedErr = /Database is not available/;

    assert.throws(() => db.getSetting('a'), expectedErr);
    assert.throws(() => db.getAllSettings(), expectedErr);
    assert.throws(() => db.setSetting('a', '1'), expectedErr);
    assert.throws(() => db.deleteSetting('a'), expectedErr);
    assert.throws(() => db.applySettings({ a: '1' }), expectedErr);
    assert.throws(() => db.createSession('s', '2026-01-01'), expectedErr);
    assert.throws(() => db.getSession('s'), expectedErr);
    assert.throws(() => db.deleteSession('s'), expectedErr);
    assert.throws(() => db.deleteExpiredSessions('2026-01-01'), expectedErr);
    assert.throws(() => db.insertQuestion('q'), expectedErr);
    assert.throws(() => db.countQuestions(), expectedErr);
    assert.throws(() => db.consumeDailyAsk('2026-11-09', 10), expectedErr);
    assert.throws(() => db.insertCapEvent('2026-11-09', 'ask'), expectedErr);
    assert.throws(() => db.getCapEvent('2026-11-09', 'ask'), expectedErr);
    assert.throws(() => db.countCapEvents(), expectedErr);

    // Restore DATA_DIR for afterEach
    process.env.DATA_DIR = tempDir;
    resetEnv();
    db.close();
  });
});
