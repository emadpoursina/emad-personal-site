/**
 * src/lib/db.mjs
 *
 * SQLite database layer using node:sqlite DatabaseSync.
 * - Opens lazily on first use so a broken DB never crashes server boot.
 * - Applies schema version 1 and 2 on open.
 * - Exports:
 *     contact: insertMessage, markSent, markFailed, countMessages
 *     settings: getSetting, getAllSettings, setSetting, deleteSetting, applySettings
 *     sessions: createSession, getSession, deleteSession, deleteExpiredSessions
 *     questions: insertQuestion, countQuestions
 *     counters: consumeDailyAsk
 *     lifecycle: isHealthy, close
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './env.mjs';

/** @type {DatabaseSync | null} */
let _db = null;

/** @type {boolean | null} */
let _healthy = null;

/** @type {string | null} */
let _errorReason = null;

// Schema version this code expects.
const SCHEMA_VERSION = 2;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS contact_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    name            TEXT    NOT NULL,
    email           TEXT    NOT NULL,
    message         TEXT    NOT NULL,
    delivery_status TEXT    NOT NULL CHECK (delivery_status IN ('sent','failed')),
    delivery_error  TEXT
  );
`.trim();

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
    ON contact_messages (created_at DESC);
`.trim();

const SCHEMA_V2_SQL = `
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
`.trim();

const UPSERT_SETTING_SQL = `
INSERT INTO settings (key, value, updated_at)
VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`.trim();

const CONSUME_DAILY_ASK_SQL = `
INSERT INTO ask_daily_counters (day, count, updated_at)
VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(day) DO UPDATE SET
  count = count + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
RETURNING count;
`.trim();

/**
 * Opens (or returns) the database, applying the schema if needed.
 * Returns null and sets _healthy=false when opening fails.
 * @returns {DatabaseSync | null}
 */
function getDb() {
  if (_db !== null) return _db;
  if (_healthy === false) return null;

  try {
    const dir = dataDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const dbPath = join(dir, 'site.sqlite');
    const db = new DatabaseSync(dbPath);

    // Read user_version pragma
    const { user_version: version } =
      /** @type {{ user_version: number }} */ (
        db.prepare('PRAGMA user_version').get()
      );

    if (version < 1) {
      // Apply schema version 1
      db.exec(CREATE_TABLE_SQL);
      db.exec(CREATE_INDEX_SQL);
    }
    if (version < 2) {
      // Apply schema version 2
      db.exec(SCHEMA_V2_SQL);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }

    _db = db;
    _healthy = true;
    return _db;
  } catch (err) {
    _healthy = false;
    _errorReason = err instanceof Error ? err.message : String(err);
    console.error('[db] Failed to open database:', _errorReason);
    return null;
  }
}

/**
 * Inserts a new contact message with delivery_status='failed' and
 * delivery_error='pending'. Returns the numeric row id.
 *
 * @param {{ name: string; email: string; message: string }} msg
 * @returns {number}
 * @throws {Error} when the database is unavailable or the insert fails.
 */
export function insertMessage({ name, email, message }) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const stmt = db.prepare(
    `INSERT INTO contact_messages (name, email, message, delivery_status, delivery_error)
     VALUES (?, ?, ?, 'failed', 'pending')`
  );
  const result = stmt.run(name, email, message);
  return /** @type {number} */ (result.lastInsertRowid);
}

/**
 * Marks a message as successfully sent.
 * @param {number} id
 */
export function markSent(id) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  db.prepare(
    `UPDATE contact_messages SET delivery_status = 'sent', delivery_error = NULL WHERE id = ?`
  ).run(id);
}

/**
 * Marks a message as failed with a short reason.
 * @param {number} id
 * @param {string} reason
 */
export function markFailed(id, reason) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  db.prepare(
    `UPDATE contact_messages SET delivery_status = 'failed', delivery_error = ? WHERE id = ?`
  ).run(reason, id);
}

/**
 * Returns the total number of rows in contact_messages.
 * @returns {number}
 */
export function countMessages() {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const row = /** @type {{ n: number }} */ (
    db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get()
  );
  return row.n;
}

// ---------------------------------------------------------------------------
// Settings accessors
// ---------------------------------------------------------------------------

/**
 * Returns the string value for a setting key, or null if not found.
 * @param {string} key
 * @returns {string | null}
 */
export function getSetting(key) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const row = /** @type {{ value: string } | undefined} */ (
    db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  );
  return row ? row.value : null;
}

/**
 * Returns a plain object mapping all keys to their string values.
 * @returns {Record<string, string>}
 */
export function getAllSettings() {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const rows = /** @type {Array<{ key: string; value: string }>} */ (
    db.prepare('SELECT key, value FROM settings').all()
  );
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Upserts a setting, refreshing updated_at.
 * @param {string} key
 * @param {string} value
 */
export function setSetting(key, value) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  db.prepare(UPSERT_SETTING_SQL).run(key, value);
}

/**
 * Deletes a setting row by key.
 * @param {string} key
 */
export function deleteSetting(key) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/**
 * Applies a batch of setting upserts and deletes within a single transaction.
 * Rolls back and rethrows on any error.
 * @param {Record<string, string>} sets
 * @param {string[]} [deletes]
 */
export function applySettings(sets, deletes = []) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  db.exec('BEGIN');
  try {
    if (sets) {
      const upsertStmt = db.prepare(UPSERT_SETTING_SQL);
      for (const [key, value] of Object.entries(sets)) {
        upsertStmt.run(key, value);
      }
    }
    if (deletes && deletes.length > 0) {
      const deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?');
      for (const key of deletes) {
        deleteStmt.run(key);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admin session accessors
// ---------------------------------------------------------------------------

/**
 * Inserts an admin session row.
 * @param {string} id
 * @param {string} expiresAt - ISO-8601 UTC timestamp
 */
export function createSession(id, expiresAt) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  db.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)').run(id, expiresAt);
}

/**
 * Retrieves an admin session by id without expiry filtering.
 * @param {string} id
 * @returns {{ id: string; created_at: string; expires_at: string } | null}
 */
export function getSession(id) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const row = /** @type {{ id: string; created_at: string; expires_at: string } | undefined} */ (
    db.prepare('SELECT id, created_at, expires_at FROM admin_sessions WHERE id = ?').get(id)
  );
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/**
 * Deletes an admin session by id.
 * @param {string} id
 */
export function deleteSession(id) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(id);
}

/**
 * Deletes admin sessions where expires_at <= nowIso.
 * @param {string} nowIso - ISO-8601 UTC timestamp
 * @returns {number} number of deleted sessions
 */
export function deleteExpiredSessions(nowIso) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const result = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(nowIso);
  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// Ask question log accessors
// ---------------------------------------------------------------------------

/**
 * Inserts an ask question log row and returns the numeric row id.
 * @param {string} question
 * @returns {number}
 */
export function insertQuestion(question) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const result = db.prepare('INSERT INTO ask_questions (question) VALUES (?)').run(question);
  return Number(result.lastInsertRowid);
}

/**
 * Returns the total number of rows in ask_questions.
 * @returns {number}
 */
export function countQuestions() {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const row = /** @type {{ n: number }} */ (
    db.prepare('SELECT COUNT(*) AS n FROM ask_questions').get()
  );
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// Ask daily counter accessors
// ---------------------------------------------------------------------------

/**
 * Atomically consumes one daily ask slot and returns { count, allowed }.
 * @param {string} day - UTC date string 'YYYY-MM-DD'
 * @param {number} cap - daily maximum allowed
 * @returns {{ count: number; allowed: boolean }}
 */
export function consumeDailyAsk(day, cap) {
  const db = getDb();
  if (!db) throw new Error('Database is not available');

  const row = /** @type {{ count: number }} */ (
    db.prepare(CONSUME_DAILY_ASK_SQL).get(day)
  );
  const count = Number(row.count);
  return {
    count,
    allowed: count <= cap,
  };
}

// ---------------------------------------------------------------------------
// Database health and connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Returns true when the database can be opened and queried, false otherwise.
 * Never throws.
 * @returns {boolean}
 */
export function isHealthy() {
  try {
    const db = getDb();
    if (!db) return false;
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes the database connection. Intended for use in tests.
 */
export function close() {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore close errors
    }
    _db = null;
  }
  _healthy = null;
  _errorReason = null;
}
