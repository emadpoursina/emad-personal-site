#!/usr/bin/env node
/**
 * scripts/db-count.mjs
 *
 * Dependency-free script: open ${DATA_DIR:-./data}/site.sqlite with
 * node:sqlite DatabaseSync, print the integer SELECT COUNT(*) FROM contact_messages,
 * and exit 0. If the file/table is missing, print 0 and exit 0.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || './data';
const dbPath = path.join(dataDir, 'site.sqlite');

if (!fs.existsSync(dbPath)) {
  console.log(0);
  process.exit(0);
}

let db = null;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT COUNT(*) FROM contact_messages').get();
  const count = row ? Object.values(row)[0] : 0;
  console.log(typeof count === 'number' ? count : 0);
} catch {
  console.log(0);
} finally {
  if (db) {
    try {
      db.close();
    } catch {}
  }
}
process.exit(0);
