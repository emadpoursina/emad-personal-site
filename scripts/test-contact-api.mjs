#!/usr/bin/env node
/**
 * scripts/test-contact-api.mjs
 *
 * End-to-end proof for the contact API (F6 AC1–AC5).
 * Exercises two standalone server instances built from dist/server/entry.mjs:
 *   Instance A: SMTP connected to smtp-sink. Tests valid send, validations, rate limiting.
 *   Instance B: SMTP pointed to a closed port. Tests delivery failure (502) and failed row.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'server', 'entry.mjs');
const SINK_SCRIPT = path.join(ROOT, 'scripts', 'smtp-sink.mjs');
const SINK_LOG = path.join(ROOT, '.evidence', 'smtp-sink.jsonl');

// Check entry existence
if (!fs.existsSync(ENTRY)) {
  console.error('run npm run build first');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

async function pollTcp(port, host = '127.0.0.1', timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ port, host }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for TCP connect to ${host}:${port}`);
}

async function waitForHealthz(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for GET /healthz on port ${port}`);
}

function killProc(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGTERM');
  } catch {}
}

// ---------------------------------------------------------------------------
// Main test flow
// ---------------------------------------------------------------------------

let tmpDirA = null;
let tmpDirB = null;
let sinkProc = null;
let serverProcA = null;
let serverProcB = null;
let dbA = null;
let dbB = null;

async function run() {
  tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-test-a-'));
  tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-test-b-'));

  // 1. Allocate ports for Instance A and sink
  const sinkPort = await getFreePort();
  const serverPortA = await getFreePort();

  // Start smtp-sink
  sinkProc = spawn(process.execPath, [SINK_SCRIPT, '--port', String(sinkPort)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await pollTcp(sinkPort);

  // Snapshot sink log lines count before send
  const sinkLinesBefore = fs.existsSync(SINK_LOG)
    ? fs.readFileSync(SINK_LOG, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;

  // Start Instance A
  serverProcA = spawn(
    process.execPath,
    ['--experimental-sqlite', 'dist/server/entry.mjs'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(serverPortA),
        HOST: '127.0.0.1',
        DATA_DIR: tmpDirA,
        CONTACT_TO: 'emad.poursina.work@gmail.com',
        CONTACT_RATE_LIMIT_PER_HOUR: '5',
        TRUST_PROXY: '0',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(sinkPort),
        SMTP_SECURE: 'false',
        SMTP_USER: 'test',
        SMTP_PASS: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  await waitForHealthz(serverPortA);

  const contactUrlA = `http://127.0.0.1:${serverPortA}/api/contact`;
  const formBody = 'name=Ada+Lovelace&email=ada%40example.com&message=Hello+from+the+integration+test.';

  // --- Cross-site guard assertion (rejected by Astro middleware before contact service) ---
  const resCsrf = await fetch(contactUrlA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'http://evil.example',
      'Accept': 'application/json',
    },
    body: formBody,
  });
  if (resCsrf.status !== 403) {
    throw new Error(`Cross-site guard: expected status 403, got ${resCsrf.status}`);
  }

  // Verify SQLite row count is still 0 before valid submission
  dbA = new DatabaseSync(path.join(tmpDirA, 'site.sqlite'));
  const countBefore = dbA.prepare('SELECT COUNT(*) as c FROM contact_messages').get().c;
  if (countBefore !== 0) {
    throw new Error(`Cross-site guard: expected 0 rows before valid submission, got ${countBefore}`);
  }

  // --- Request 1: Valid submission (native no-JS form POST) ---
  const res1 = await fetch(contactUrlA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': `http://127.0.0.1:${serverPortA}`,
      'Accept': 'application/json',
    },
    body: formBody,
  });

  if (res1.status !== 200) {
    throw new Error(`Request 1: expected status 200, got ${res1.status}`);
  }
  const json1 = await res1.json();
  if (!json1.ok || json1.status !== 'sent') {
    throw new Error(`Request 1: expected {ok:true, status:'sent'}, got ${JSON.stringify(json1)}`);
  }

  // Verify sink log
  const sinkStartWait = Date.now();
  let lastSinkRecord = null;
  while (Date.now() - sinkStartWait < 5000) {
    if (fs.existsSync(SINK_LOG)) {
      const lines = fs.readFileSync(SINK_LOG, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > sinkLinesBefore) {
        lastSinkRecord = JSON.parse(lines[lines.length - 1]);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!lastSinkRecord) {
    throw new Error('Sink: message was not recorded in .evidence/smtp-sink.jsonl');
  }
  const recipientOk = lastSinkRecord.recipients.some((r) =>
    r.includes('emad.poursina.work@gmail.com')
  );
  if (!recipientOk) {
    throw new Error(`Sink: expected recipient emad.poursina.work@gmail.com, got ${JSON.stringify(lastSinkRecord.recipients)}`);
  }
  if (lastSinkRecord.subject !== 'Contact form: Ada Lovelace') {
    throw new Error(`Sink: expected subject 'Contact form: Ada Lovelace', got '${lastSinkRecord.subject}'`);
  }
  if (
    !lastSinkRecord.body.includes('Ada Lovelace') ||
    !lastSinkRecord.body.includes('ada@example.com') ||
    !lastSinkRecord.body.includes('Hello from the integration test.')
  ) {
    throw new Error(`Sink: body missing name, email, or message. Got: ${lastSinkRecord.body}`);
  }

  // Verify SQLite for Instance A
  const rows1 = dbA.prepare('SELECT * FROM contact_messages').all();
  if (rows1.length !== 1) {
    throw new Error(`Instance A: expected exactly 1 row after request 1, got ${rows1.length}`);
  }
  if (rows1[0].delivery_status !== 'sent') {
    throw new Error(`Instance A: expected delivery_status='sent', got '${rows1[0].delivery_status}'`);
  }
  const sent = rows1.filter((r) => r.delivery_status === 'sent').length;

  // --- Request 2: Malformed email ---
  const res2 = await fetch(contactUrlA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'not-an-email',
      message: 'Hello from the integration test.',
    }),
  });
  if (res2.status !== 400) {
    throw new Error(`Request 2: expected status 400, got ${res2.status}`);
  }
  const json2 = await res2.json();
  if (!json2.errors || !json2.errors.email) {
    throw new Error(`Request 2: expected errors.email, got ${JSON.stringify(json2)}`);
  }
  const countAfter2 = dbA.prepare('SELECT COUNT(*) as c FROM contact_messages').get().c;
  if (countAfter2 !== 1) {
    throw new Error(`Request 2: row count should still be 1, got ${countAfter2}`);
  }

  // --- Request 3: Empty/whitespace message ---
  const res3 = await fetch(contactUrlA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: '   ',
    }),
  });
  if (res3.status !== 400) {
    throw new Error(`Request 3: expected status 400, got ${res3.status}`);
  }
  const json3 = await res3.json();
  if (!json3.errors || !json3.errors.message) {
    throw new Error(`Request 3: expected errors.message, got ${JSON.stringify(json3)}`);
  }
  const countAfter3 = dbA.prepare('SELECT COUNT(*) as c FROM contact_messages').get().c;
  if (countAfter3 !== 1) {
    throw new Error(`Request 3: row count should still be 1, got ${countAfter3}`);
  }

  // --- Request 4: Message of 5,001 characters ---
  const res4 = await fetch(contactUrlA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'a'.repeat(5001),
    }),
  });
  if (res4.status !== 400) {
    throw new Error(`Request 4: expected status 400, got ${res4.status}`);
  }
  const json4 = await res4.json();
  if (!json4.errors || !json4.errors.message) {
    throw new Error(`Request 4: expected errors.message, got ${JSON.stringify(json4)}`);
  }
  const countAfter4 = dbA.prepare('SELECT COUNT(*) as c FROM contact_messages').get().c;
  if (countAfter4 !== 1) {
    throw new Error(`Request 4: row count should still be 1, got ${countAfter4}`);
  }

  // --- Request 5: Header-injection attempt via CR/LF in the name (critic W2) ---
  // Still the 5th POST, so the rate-limit quota math below is unchanged.
  const res5 = await fetch(contactUrlA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: 'Ada Lovelace\r\nBcc: evil@example.com',
      email: 'ada@example.com',
      message: 'Fifth attempt message.',
    }),
  });
  if (res5.status !== 400) {
    throw new Error(`Request 5 (CRLF name): expected status 400, got ${res5.status}`);
  }
  const json5 = await res5.json();
  if (!json5.errors || !json5.errors.name) {
    throw new Error(`Request 5 (CRLF name): expected errors.name, got ${JSON.stringify(json5)}`);
  }
  const countAfter5 = dbA.prepare('SELECT COUNT(*) as c FROM contact_messages').get().c;
  if (countAfter5 !== 1) {
    throw new Error(`Request 5: row count should still be 1, got ${countAfter5}`);
  }
  const invalid = countAfter5 - 1; // 0 rows written for invalid submissions

  // --- Request 6: 6th POST from same IP (rate limited) ---
  const res6 = await fetch(contactUrlA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Rate limit test.',
    }),
  });
  if (res6.status !== 429) {
    throw new Error(`Request 6: expected status 429, got ${res6.status}`);
  }
  const rate_limited = res6.status;
  const retryAfterHeader = res6.headers.get('retry-after');
  if (!retryAfterHeader) {
    throw new Error('Request 6: expected Retry-After header');
  }
  const json6 = await res6.json();
  if (json6.error !== 'rate_limited') {
    throw new Error(`Request 6: expected error:'rate_limited', got '${json6.error}'`);
  }
  const rows = dbA.prepare('SELECT COUNT(*) as c FROM contact_messages').get().c;
  if (rows !== 1) {
    throw new Error(`Request 6: row count should still be 1, got ${rows}`);
  }

  // Close dbA and terminate Instance A + sink
  dbA.close();
  dbA = null;
  killProc(serverProcA);
  serverProcA = null;
  killProc(sinkProc);
  sinkProc = null;

  // --- Instance B: Delivery Failure on closed port ---
  const closedPort = await getFreePort();
  const serverPortB = await getFreePort();

  serverProcB = spawn(
    process.execPath,
    ['--experimental-sqlite', 'dist/server/entry.mjs'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(serverPortB),
        HOST: '127.0.0.1',
        DATA_DIR: tmpDirB,
        CONTACT_TO: 'emad.poursina.work@gmail.com',
        CONTACT_RATE_LIMIT_PER_HOUR: '5',
        TRUST_PROXY: '0',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(closedPort),
        SMTP_SECURE: 'false',
        SMTP_USER: 'test',
        SMTP_PASS: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  await waitForHealthz(serverPortB);

  const contactUrlB = `http://127.0.0.1:${serverPortB}/api/contact`;
  const resB = await fetch(contactUrlB, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Message destined to fail delivery.',
    }),
  });

  if (resB.status !== 502) {
    throw new Error(`Instance B: expected status 502, got ${resB.status}`);
  }
  const jsonB = await resB.json();
  if (jsonB.error !== 'delivery_failed') {
    throw new Error(`Instance B: expected error:'delivery_failed', got '${jsonB.error}'`);
  }
  if (jsonB.contactEmail !== 'emad.poursina.work@gmail.com') {
    throw new Error(`Instance B: expected contactEmail:'emad.poursina.work@gmail.com', got '${jsonB.contactEmail}'`);
  }

  dbB = new DatabaseSync(path.join(tmpDirB, 'site.sqlite'));
  const rowsB = dbB.prepare('SELECT * FROM contact_messages').all();
  if (rowsB.length !== 1) {
    throw new Error(`Instance B: expected exactly 1 row, got ${rowsB.length}`);
  }
  if (rowsB[0].delivery_status !== 'failed') {
    throw new Error(`Instance B: expected delivery_status='failed', got '${rowsB[0].delivery_status}'`);
  }
  const failed_row = rowsB.filter((r) => r.delivery_status === 'failed').length;

  dbB.close();
  dbB = null;
  killProc(serverProcB);
  serverProcB = null;

  // Print exact required line
  console.log(`sent=${sent} rows=${rows} invalid=${invalid} rate_limited=${rate_limited} failed_row=${failed_row}`);
}

run()
  .catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (dbA) {
      try { dbA.close(); } catch {}
    }
    if (dbB) {
      try { dbB.close(); } catch {}
    }
    killProc(serverProcA);
    killProc(serverProcB);
    killProc(sinkProc);

    if (tmpDirA && fs.existsSync(tmpDirA)) {
      try { fs.rmSync(tmpDirA, { recursive: true, force: true }); } catch {}
    }
    if (tmpDirB && fs.existsSync(tmpDirB)) {
      try { fs.rmSync(tmpDirB, { recursive: true, force: true }); } catch {}
    }
  });
