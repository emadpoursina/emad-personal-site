#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_LETTER = 'Dear Hiring Manager,\n\nI build and run production Node.js services end to end.\n\nRequires employer-sponsored work authorization.\n\nBest regards, Emad Poursina';

export function createGeneratorStubServer(options = {}) {
  const { logPath = null, delayMs = 0, letter = null, status = null } = options;
  const cannedLetter = letter !== null && letter !== undefined ? letter : DEFAULT_LETTER;

  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
      return res.end(JSON.stringify({ error: `Method ${req.method} not allowed` }));
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
      }
    });

    req.on('end', async () => {
      let body;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        body = JSON.parse(raw);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid JSON body' }));
      }

      const authHeader = req.headers.authorization;
      const authorizationPresent = typeof authHeader === 'string' && authHeader.trim().length > 0;
      let authorizationScheme = null;
      let keyLength = 0;
      let keyLast4 = '';

      if (authorizationPresent) {
        const trimmedAuth = authHeader.trim();
        const spaceIdx = trimmedAuth.indexOf(' ');
        if (spaceIdx === -1) {
          authorizationScheme = trimmedAuth;
        } else {
          authorizationScheme = trimmedAuth.slice(0, spaceIdx);
          const token = trimmedAuth.slice(spaceIdx + 1).trim();
          keyLength = token.length;
          keyLast4 = token.length >= 4 ? token.slice(-4) : token;
        }
      }

      if (logPath) {
        try {
          const resolvedPath = path.resolve(logPath);
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          const record = {
            requestId: crypto.randomBytes(4).toString('hex'),
            receivedAt: new Date().toISOString(),
            method: req.method,
            path: req.url || '/',
            authorizationPresent,
            authorizationScheme,
            keyLength,
            keyLast4,
            body,
          };
          fs.appendFileSync(resolvedPath, JSON.stringify(record) + '\n', 'utf8');
        } catch (err) {
          console.error('[generator-stub] log write error:', err.message);
        }
      }

      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      if (status !== null && status !== undefined && Number.isFinite(status) && status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'stub failure' }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ letter: cannedLetter }));
    });
  });
}

async function runSelfTest(options = {}) {
  const { letter = null } = options;
  const expectedLetter = letter !== null && letter !== undefined ? letter : DEFAULT_LETTER;
  const testToken = 'test-generator-key-1234';
  const tempLogPath = path.join(os.tmpdir(), `generator-stub-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const server = createGeneratorStubServer({ logPath: tempLogPath, delayMs: 0, letter });

  try {
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve(undefined));
      server.once('error', reject);
    });

    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : null;
    const res = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ job_description: 'self test' }),
    });

    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
    const data = await res.json();
    if (data?.letter !== expectedLetter) throw new Error(`Letter mismatch`);

    if (!fs.existsSync(tempLogPath)) throw new Error('Temp log file missing');
    const rawLog = fs.readFileSync(tempLogPath, 'utf8');
    const lines = rawLog.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length !== 1) throw new Error(`Expected 1 log line, got ${lines.length}`);
    if (rawLog.includes(testToken)) throw new Error('Log leaked full token!');

    const record = JSON.parse(lines[0]);
    if (!record.authorizationPresent || record.authorizationScheme !== 'Bearer' || record.keyLength !== testToken.length || record.keyLast4 !== '1234' || record.body?.job_description !== 'self test') {
      throw new Error(`Log record assertion failed: ${JSON.stringify(record)}`);
    }

    const statusServer = createGeneratorStubServer({ status: 500 });
    try {
      await new Promise((resolve, reject) => {
        statusServer.listen(0, '127.0.0.1', () => resolve(undefined));
        statusServer.once('error', reject);
      });
      const sPort = statusServer.address().port;
      const sRes = await fetch(`http://127.0.0.1:${sPort}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true }),
      });
      if (sRes.status !== 500) throw new Error(`Expected status 500, got ${sRes.status}`);
      const sData = await sRes.json();
      if (sData?.error !== 'stub failure') throw new Error(`Expected error "stub failure", got "${sData?.error}"`);
    } finally {
      await new Promise((resolve) => statusServer.close(resolve));
    }

    console.log('[generator-stub] self-test PASSED: letter ok, log ok, status failure ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      if (fs.existsSync(tempLogPath)) fs.unlinkSync(tempLogPath);
    } catch {
      // ignore
    }
  }
}

function parseArgs(argv) {
  let port = null, logPath = null, delayMs = 0, letter = null, status = null, selfTest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && i + 1 < argv.length) port = parseInt(argv[++i], 10);
    else if (a.startsWith('--port=')) port = parseInt(a.slice(7), 10);
    else if (a === '--log' && i + 1 < argv.length) logPath = argv[++i];
    else if (a.startsWith('--log=')) logPath = a.slice(6);
    else if (a === '--delay-ms' && i + 1 < argv.length) delayMs = parseInt(argv[++i], 10);
    else if (a.startsWith('--delay-ms=')) delayMs = parseInt(a.slice(11), 10);
    else if (a === '--letter' && i + 1 < argv.length) letter = argv[++i];
    else if (a.startsWith('--letter=')) letter = a.slice(9);
    else if (a === '--status' && i + 1 < argv.length) status = parseInt(argv[++i], 10);
    else if (a.startsWith('--status=')) status = parseInt(a.slice(9), 10);
    else if (a === '--self-test') selfTest = true;
  }
  return { port, logPath, delayMs, letter, status, selfTest };
}

let isMain = false;
try {
  isMain = process.argv[1] && (
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  );
} catch {
  isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}

if (isMain) {
  const { port, logPath, delayMs, letter, status, selfTest } = parseArgs(process.argv.slice(2));
  if (selfTest) {
    runSelfTest({ letter })
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[generator-stub] self-test FAILED:', err.message);
        process.exit(1);
      });
  } else {
    if (port === null || isNaN(port)) {
      console.error('Usage: node scripts/generator-stub.mjs --port <n> [--log <path>] [--delay-ms <n>] [--letter <text>] [--status <n>] [--self-test]');
      process.exit(1);
    }
    const server = createGeneratorStubServer({ logPath, delayMs, letter, status });
    server.listen(port, '0.0.0.0', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      console.log(`[generator-stub] listening on port ${actualPort}`);
      if (logPath) console.log(`[generator-stub] logging to ${logPath}`);
    });
    server.on('error', (err) => {
      console.error('[generator-stub] server error:', err.message);
      process.exit(1);
    });
    const shutdown = () => { server.close(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
