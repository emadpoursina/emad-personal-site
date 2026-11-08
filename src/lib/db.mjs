/**
 * src/lib/db.mjs
 *
 * SQLite database layer using node:sqlite DatabaseSync.
 * - Opens lazily on first use so a broken DB never crashes server boot.
 * - Applies schema version 1 on open (contact_messages table + index).
 * - Exports: insertMessage, markSent, markFailed, countMessages, isHealthy, close.
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
const SCHEMA_VERSION = 1;

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

    if (version < SCHEMA_VERSION) {
      // Apply schema version 1
      db.exec(CREATE_TABLE_SQL);
      db.exec(CREATE_INDEX_SQL);
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
