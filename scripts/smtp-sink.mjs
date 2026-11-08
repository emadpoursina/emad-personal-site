#!/usr/bin/env node
/**
 * scripts/smtp-sink.mjs
 *
 * Dependency-free SMTP sink server.
 * - Accepts EHLO/HELO, MAIL FROM, RCPT TO, DATA, QUIT, RSET, NOOP.
 * - Accepts AUTH PLAIN and AUTH LOGIN (accepts any credentials).
 * - Records one JSON line per message to .evidence/smtp-sink.jsonl.
 * - Prints each received message to stdout.
 * - Dot-unstuffs the DATA body per RFC 5321.
 *
 * Usage:
 *   node scripts/smtp-sink.mjs --port 2525
 *   node scripts/smtp-sink.mjs --port 2525 --self-test
 *
 * --self-test: starts the sink on an ephemeral port, sends one message via
 *   nodemailer, asserts the sink recorded one recipient and body, then exits 0.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.evidence');
const SINK_LOG = path.join(EVIDENCE_DIR, 'smtp-sink.jsonl');

/** Ensure .evidence/ directory exists */
function ensureEvidenceDir() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
}

/**
 * Appends a message record to .evidence/smtp-sink.jsonl.
 * @param {object} record
 */
function appendRecord(record) {
  ensureEvidenceDir();
  fs.appendFileSync(SINK_LOG, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Creates an SMTP sink server.
 * @returns {net.Server}
 */
function createSinkServer() {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');

    // Per-connection state
    let envelope = { from: '', recipients: [] };
    let inData = false;
    let dataLines = [];
    let buffer = '';

    function send(line) {
      socket.write(line + '\r\n');
    }

    function resetEnvelope() {
      envelope = { from: '', recipients: [] };
      inData = false;
      dataLines = [];
    }

    send('220 smtp-sink ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? ''; // keep incomplete line in buffer

      for (const line of lines) {
        if (inData) {
          if (line === '.') {
            // End of DATA
            inData = false;

            // Dot-unstuff: lines starting with '..' → '.'
            const body = dataLines
              .map((l) => (l.startsWith('..') ? l.slice(1) : l))
              .join('\n');

            // Extract subject from headers
            let subject = '';
            const subjectMatch = body.match(/^Subject:\s*(.+)$/im);
            if (subjectMatch) subject = subjectMatch[1].trim();

            // Split headers and body at the blank line
            const blankIndex = body.indexOf('\n\n');
            const bodyText = blankIndex !== -1 ? body.slice(blankIndex + 2) : body;

            const record = {
              timestamp: new Date().toISOString(),
              from: envelope.from,
              recipients: [...envelope.recipients],
              subject,
              body: bodyText,
            };

            appendRecord(record);
            console.log('[smtp-sink] received:', JSON.stringify(record));

            resetEnvelope();
            send('250 Ok: message accepted');
          } else {
            dataLines.push(line);
          }
          continue;
        }

        const upper = line.toUpperCase().trimStart();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          send('250-smtp-sink');
          send('250-AUTH PLAIN LOGIN');
          send('250 Ok');
        } else if (upper.startsWith('AUTH PLAIN')) {
          // Accept any credentials
          if (upper === 'AUTH PLAIN') {
            send('334 '); // challenge
          } else {
            send('235 2.7.0 Authentication successful');
          }
        } else if (upper.startsWith('AUTH LOGIN')) {
          // Multi-step AUTH LOGIN: send challenges, accept anything
          send('334 VXNlcm5hbWU6'); // "Username:"
        } else if (upper === '334' || (upper.length > 0 && !upper.includes(' ') && inData === false && envelope.from === '' && envelope.recipients.length === 0)) {
          // Handle AUTH LOGIN steps: client sends base64 username, then password
          // Detect if we're in an AUTH LOGIN exchange by checking if the previous
          // response was a 334 challenge. We simplify: if we get a bare line with
          // no recognized SMTP verb, treat it as an AUTH step and accept it.
          // This is a sink — we accept all credentials.
          if (upper === '334') {
            send('235 2.7.0 Authentication successful');
          }
          // If it looks like a base64 credential response:
          else if (/^[A-Za-z0-9+/]+=*$/.test(line.trim()) && line.trim().length > 0) {
            send('235 2.7.0 Authentication successful');
          }
        } else if (upper.startsWith('MAIL FROM:')) {
          envelope.from = line.slice(10).trim();
          send('250 Ok');
        } else if (upper.startsWith('RCPT TO:')) {
          envelope.recipients.push(line.slice(8).trim());
          send('250 Ok');
        } else if (upper === 'DATA') {
          inData = true;
          dataLines = [];
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'RSET') {
          resetEnvelope();
          send('250 Ok');
        } else if (upper === 'NOOP') {
          send('250 Ok');
        } else if (upper === 'QUIT') {
          send('221 Bye');
          socket.end();
        } else {
          // Unknown command — still respond 250 for AUTH LOGIN steps
          // that arrive as bare base64 data
          if (/^[A-Za-z0-9+/]+=*$/.test(line.trim()) && line.trim().length >= 4) {
            send('235 2.7.0 Authentication successful');
          } else {
            send('500 Command not recognized');
          }
        }
      }
    });

    socket.on('error', (err) => {
      console.error('[smtp-sink] socket error:', err.message);
    });
  });

  return server;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
async function runSelfTest(port) {
  console.log(`[smtp-sink] self-test: starting sink on port ${port}…`);

  // Import nodemailer (available as a project dependency)
  const nodemailer = (await import('nodemailer')).default;

  // Start sink
  const server = createSinkServer();
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(undefined));
    server.once('error', reject);
  });

  const actualPort = /** @type {net.AddressInfo} */ (server.address()).port;
  console.log(`[smtp-sink] self-test: sink listening on port ${actualPort}`);

  // Clear any previous log entries for this test
  const before = fs.existsSync(SINK_LOG)
    ? fs.readFileSync(SINK_LOG, 'utf8').split('\n').filter(Boolean).length
    : 0;

  // Send one test message
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: actualPort,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 5000,
    socketTimeout: 10000,
  });

  await transport.sendMail({
    from: 'test@example.com',
    to: 'recipient@example.com',
    subject: 'Self-test message',
    text: 'This is a self-test body.',
  });

  // Allow the server a moment to process
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Read what was recorded
  const lines = fs.existsSync(SINK_LOG)
    ? fs.readFileSync(SINK_LOG, 'utf8').split('\n').filter(Boolean)
    : [];

  const after = lines.length;
  if (after <= before) {
    console.error('[smtp-sink] self-test FAILED: no message was recorded in the sink log');
    server.close();
    process.exit(1);
  }

  const lastRecord = JSON.parse(lines[after - 1]);

  // Assert recipient
  const hasRecipient = lastRecord.recipients.some(
    (r) => r.includes('recipient@example.com')
  );
  if (!hasRecipient) {
    console.error(
      `[smtp-sink] self-test FAILED: expected recipient "recipient@example.com", got:`,
      lastRecord.recipients
    );
    server.close();
    process.exit(1);
  }

  // Assert body contains our text
  if (!lastRecord.body.includes('This is a self-test body.')) {
    console.error(
      `[smtp-sink] self-test FAILED: body did not contain expected text. Got:`,
      lastRecord.body
    );
    server.close();
    process.exit(1);
  }

  console.log(
    `[smtp-sink] self-test PASSED: recorded 1 message, recipient=${lastRecord.recipients[0]}, body ok`
  );

  server.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let port = 0; // 0 = ephemeral
let selfTest = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
  if (args[i] === '--self-test') {
    selfTest = true;
  }
}

if (selfTest) {
  runSelfTest(port).catch((err) => {
    console.error('[smtp-sink] self-test error:', err);
    process.exit(1);
  });
} else {
  if (!port) {
    console.error('Usage: node scripts/smtp-sink.mjs --port <port> [--self-test]');
    process.exit(1);
  }

  ensureEvidenceDir();
  const server = createSinkServer();
  server.listen(port, '0.0.0.0', () => {
    const addr = /** @type {net.AddressInfo} */ (server.address());
    console.log(`[smtp-sink] listening on port ${addr.port}`);
    console.log(`[smtp-sink] logging to ${SINK_LOG}`);
  });

  server.on('error', (err) => {
    console.error('[smtp-sink] server error:', err);
    process.exit(1);
  });
}
