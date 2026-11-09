/**
 * tests/ask-api.integration.test.mjs
 *
 * Hermetic live-server integration tests for POST /api/ask (T012).
 * Exercises all normative scenarios using ephemeral ports and child processes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createAiStubServer } from '../scripts/ai-stub.mjs';
import { utcDayKey, consumeDaily } from '../src/lib/ask-limits.mjs';
import { getRateLimiter } from '../src/lib/rate-limit.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_PATH = path.join(ROOT, 'content', 'profile.json');
const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));

const HREF_REGEX = /^\/(about(#(summary|experience|skills|education|languages))?|contact|case-studies\/[a-z0-9-]+)$/;

/**
 * Array to capture all response raw texts across every request made in the suite.
 */
const allCapturedBodies = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds a free TCP port via net.listen(0).
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

/**
 * Starts an AI stub server on a free port with a temporary log file.
 * @param {object} [options]
 * @param {number} [options.delayMs]
 * @param {string|null} [options.answer]
 * @returns {Promise<{ server: import('node:http').Server, port: number, logPath: string, close: () => Promise<void> }>}
 */
async function startStub(options = {}) {
  const logPath = path.join(
    os.tmpdir(),
    `ai-stub-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );

  const server = createAiStubServer({
    logPath,
    delayMs: options.delayMs ?? 0,
    answer: options.answer ?? null,
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
    server.once('error', reject);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  return {
    server,
    port,
    logPath,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        if (existsSync(logPath)) {
          unlinkSync(logPath);
        }
      } catch {
        // ignore log cleanup failure
      }
    },
  };
}

/**
 * Polls GET /healthz on the target port until HTTP 200 or timeout.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForHealthz(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for GET /healthz on port ${port}`);
}

/**
 * Gracefully terminates a child process (SIGTERM then SIGKILL).
 * @param {import('node:child_process').ChildProcess | null} proc
 * @returns {Promise<void>}
 */
async function stopChild(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    const done = () => resolve(undefined);
    proc.once('exit', done);
    try {
      proc.kill('SIGTERM');
    } catch {
      resolve(undefined);
      return;
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already exited
      }
      resolve(undefined);
    }, 2000);
  });
}

/**
 * Deletes a temporary DATA_DIR with retry logic.
 * @param {string | null} dir
 */
function cleanDataDir(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      const start = Date.now();
      while (Date.now() - start < 50) {
        // spin wait
      }
    }
  }
}

/**
 * Spawns a new server instance with fresh DATA_DIR and env overrides.
 * @param {Record<string, string>} [envOverrides]
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {boolean} [options.cleanup]
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, dataDir: string, baseUrl: string, stop: () => Promise<void> }>}
 */
async function startServer(envOverrides = {}, options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'ask-api-test-'));
  const port = await getFreePort();

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    ...envOverrides,
  };

  const child = spawn(process.execPath, ['--experimental-sqlite', 'dist/server/entry.mjs'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealthz(port);
  } catch (err) {
    await stopChild(child);
    if (options.cleanup !== false) {
      cleanDataDir(dataDir);
    }
    throw err;
  }

  return {
    child,
    port,
    dataDir,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await stopChild(child);
      if (options.cleanup !== false) {
        cleanDataDir(dataDir);
      }
    },
  };
}

/**
 * Reads and parses JSONL lines from a file path.
 * @param {string} logPath
 * @returns {Array<{ model?: string, messages?: Array<{ role: string, content: string }> }>}
 */
function readStubLogRecords(logPath) {
  if (!logPath || !existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Sends an HTTP request, collects the raw body, and returns response details.
 * @param {string} baseUrl
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {string} [options.path]
 * @param {Record<string, string>} [options.headers]
 * @param {unknown} [options.body]
 * @returns {Promise<{ res: Response, status: number, headers: Headers, body: any, rawText: string }>}
 */
async function sendRequest(baseUrl, options = {}) {
  const {
    method = 'POST',
    path = '/api/ask',
    headers = { 'Content-Type': 'application/json' },
    body = undefined,
  } = options;

  let requestBody;
  if (body !== undefined) {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: requestBody,
  });

  const rawText = await res.text();
  allCapturedBodies.push(rawText);

  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = null;
  }

  return { res, status: res.status, headers: res.headers, body: json, rawText };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('POST /api/ask Integration Tests', () => {
  test('1. Configured success', async () => {
    const stub = await startStub({ answer: 'Grounded answer from stub.' });
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
      });

      const { status, headers, body } = await sendRequest(server.baseUrl, {
        body: { question: "What is Emad's Node.js experience?" },
      });

      assert.equal(status, 200);
      assert.equal(body?.ok, true);
      assert.equal(body?.answer, 'Grounded answer from stub.');
      assert.equal(body?.disclaimer, 'AI assistant. The CV and case studies are the source of record.');
      assert.equal(body?.model, 'stub-model');

      assert.ok(Array.isArray(body?.sources) && body.sources.length > 0);
      for (const src of body.sources) {
        assert.match(src.href, HREF_REGEX);
      }
      assert.ok(
        body.sources.some((s) => s.href === '/about#skills'),
        'sources must include /about#skills'
      );

      assert.match(headers.get('cache-control') || '', /no-store/i);
      assert.equal(headers.get('x-content-type-options'), 'nosniff');

      const records = readStubLogRecords(stub.logPath);
      assert.equal(records.length, 1);
      assert.equal(records[0].model, 'stub-model');
      assert.equal(records[0].messages?.[0]?.role, 'system');
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('2. Validation', async () => {
    const stub = await startStub();
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
      });

      // 2a. Empty question
      {
        const { status, body } = await sendRequest(server.baseUrl, {
          body: { question: '' },
        });
        assert.equal(status, 400);
        assert.equal(body?.ok, false);
        assert.equal(body?.error, 'validation');
        assert.equal(body?.message, 'Question is required.');
        assert.ok(body?.errors?.question);
        assert.equal(readStubLogRecords(stub.logPath).length, 0);
      }

      // 2b. Whitespace question
      {
        const { status, body } = await sendRequest(server.baseUrl, {
          body: { question: '   \n\t  ' },
        });
        assert.equal(status, 400);
        assert.equal(body?.ok, false);
        assert.equal(body?.error, 'validation');
        assert.equal(body?.message, 'Question is required.');
        assert.ok(body?.errors?.question);
        assert.equal(readStubLogRecords(stub.logPath).length, 0);
      }

      // 2c. 1001-char question
      {
        const { status, body } = await sendRequest(server.baseUrl, {
          body: { question: 'x'.repeat(1001) },
        });
        assert.equal(status, 400);
        assert.equal(body?.ok, false);
        assert.equal(body?.error, 'validation');
        assert.equal(body?.message, 'Question must be 1,000 characters or fewer.');
        assert.ok(body?.errors?.question);
        assert.equal(readStubLogRecords(stub.logPath).length, 0);
      }

      // 2d. text/plain content type
      {
        // Cross-site form-like POSTs are rejected by Astro's origin check (403); a same-origin client reaches the route's 415 path.
        const { status, body } = await sendRequest(server.baseUrl, {
          headers: {
            'Content-Type': 'text/plain',
            Origin: server.baseUrl,
          },
          body: '{"question":"What is Emad\'s Node.js experience?"}',
        });
        assert.equal(status, 415);
        assert.equal(body?.ok, false);
        assert.equal(body?.error, 'unsupported_media_type');
        assert.equal(body?.message, 'Send application/json.');
        assert.equal(readStubLogRecords(stub.logPath).length, 0);
      }

      // 2e. Malformed JSON body
      {
        const { status, body } = await sendRequest(server.baseUrl, {
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        });
        assert.equal(status, 400);
        assert.equal(body?.ok, false);
        assert.equal(body?.error, 'validation');
        assert.equal(body?.message, 'Question is required.');
        assert.ok(body?.errors?.question);
        assert.equal(readStubLogRecords(stub.logPath).length, 0);
      }

      // 2f. JSON array body
      {
        const { status, body } = await sendRequest(server.baseUrl, {
          headers: { 'Content-Type': 'application/json' },
          body: '["What is Emad\'s Node.js experience?"]',
        });
        assert.equal(status, 400);
        assert.equal(body?.ok, false);
        assert.equal(body?.error, 'validation');
        assert.equal(body?.message, 'Question is required.');
        assert.ok(body?.errors?.question);
        assert.equal(readStubLogRecords(stub.logPath).length, 0);
      }
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('3. Unconfigured', async () => {
    const stub = await startStub();
    let server = null;
    try {
      // Boot server with AI_BASE_URL, AI_MODEL, AI_API_KEY explicitly unset/empty
      server = await startServer({
        AI_BASE_URL: '',
        AI_MODEL: '',
        AI_API_KEY: '',
      });

      const { status, body } = await sendRequest(server.baseUrl, {
        body: { question: "What is Emad's Node.js experience?" },
      });

      assert.equal(status, 503);
      assert.deepEqual(body, {
        ok: false,
        error: 'unconfigured',
        message: 'The assistant is unavailable right now',
      });
      assert.equal(readStubLogRecords(stub.logPath).length, 0);
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('4. Provider down', async () => {
    const freePort = await getFreePort();
    const badBaseUrl = `http://127.0.0.1:${freePort}/v1`;
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: badBaseUrl,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-down-456',
      });

      const { status, body, rawText } = await sendRequest(server.baseUrl, {
        body: { question: "What is Emad's Node.js experience?" },
      });

      assert.equal(status, 502);
      assert.equal(body?.ok, false);
      assert.equal(body?.error, 'provider_error');
      assert.equal(
        body?.message,
        'The assistant could not answer right now. Please try again later or use the contact form.'
      );

      assert.ok(!rawText.includes('ECONNREFUSED'), 'Body must not contain ECONNREFUSED');
      assert.ok(!rawText.includes(badBaseUrl), 'Body must not contain base URL');
      assert.ok(!rawText.includes(String(freePort)), 'Body must not contain port');
      assert.ok(!rawText.includes('test-key-down-456'), 'Body must not contain API key');
    } finally {
      if (server) await server.stop();
    }
  });

  test('5. Timeout', async () => {
    const stub = await startStub({ delayMs: 800 });
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'timeout-secret-key-789',
        AI_TIMEOUT_MS: '100',
      });

      const { status, body, rawText } = await sendRequest(server.baseUrl, {
        body: { question: "What is Emad's Node.js experience?" },
      });

      assert.equal(status, 504);
      assert.equal(body?.ok, false);
      assert.equal(body?.error, 'timeout');
      assert.equal(
        body?.message,
        'The assistant took too long to answer. Please try again or use the contact form.'
      );
      assert.ok(!rawText.includes('timeout-secret-key-789'), 'Body must not contain API key');
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('6. Policy: salary', async () => {
    const stub = await startStub({ answer: 'Stub answer that should not be seen.' });
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
      });

      const { status, body } = await sendRequest(server.baseUrl, {
        body: { question: 'What is your expected salary?' },
      });

      assert.equal(status, 200);
      assert.equal(body?.ok, true);
      assert.equal(body?.answer, profile.assistantPolicy.salary);
      assert.ok(!/\d/.test(body?.answer || ''), 'Salary answer must not contain digits');
      assert.deepEqual(body?.sources, [{ label: 'Contact', href: '/contact' }]);
      assert.equal(body?.disclaimer, 'AI assistant. The CV and case studies are the source of record.');
      assert.equal(readStubLogRecords(stub.logPath).length, 0);
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('7. notAvailable passthrough', async () => {
    const notAvailableAnswer = profile.assistantPolicy.notAvailable;
    const stub = await startStub({ answer: notAvailableAnswer });
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
      });

      const { status, body } = await sendRequest(server.baseUrl, {
        body: { question: 'Does Emad have experience with Ruby on Rails?' },
      });

      assert.equal(status, 200);
      assert.equal(body?.ok, true);
      assert.equal(body?.answer, notAvailableAnswer);
      assert.equal(body?.disclaimer, 'AI assistant. The CV and case studies are the source of record.');

      assert.ok(Array.isArray(body?.sources) && body.sources.length > 0);
      for (const src of body.sources) {
        assert.match(src.href, HREF_REGEX);
      }
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('8. Method: GET /api/ask', async () => {
    let server = null;
    try {
      server = await startServer();

      const { status, headers, body } = await sendRequest(server.baseUrl, {
        method: 'GET',
        headers: {},
      });

      assert.equal(status, 405);
      assert.equal(headers.get('allow'), 'POST');
      assert.deepEqual(body, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Use POST.',
      });
    } finally {
      if (server) await server.stop();
    }
  });

  test('9. No-secret probes', async () => {
    const secretApiKey = 'super-secret-key-xyz';
    const secretEncKey = '0'.repeat(64);
    const secretAdminHash = 'scrypt$16384$8$1$deadbeef$deadbeef';
    const secretSmtpPass = 'smtp-secret-value';

    const stub = await startStub({ answer: 'Stub answer for secret probe.' });
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: secretApiKey,
        ENCRYPTION_KEY: secretEncKey,
        ADMIN_PASSWORD_HASH: secretAdminHash,
        SMTP_PASS: secretSmtpPass,
      });

      // Probe various routes and responses on this server instance
      await sendRequest(server.baseUrl, {
        body: { question: "What is Emad's background?" },
      });
      await sendRequest(server.baseUrl, {
        body: { question: 'What is your expected salary?' },
      });
      await sendRequest(server.baseUrl, {
        body: { question: '' },
      });
      await sendRequest(server.baseUrl, {
        method: 'GET',
        headers: {},
      });
      await sendRequest(server.baseUrl, {
        headers: { 'Content-Type': 'text/plain' },
        body: 'plain text',
      });

      // Across every response body captured in the entire suite, assert none contains secrets
      const forbiddenTokens = [
        secretApiKey,
        secretEncKey,
        secretAdminHash,
        secretSmtpPass,
        'Bearer',
        'APPROVED PROFILE CONTEXT',
      ];

      assert.ok(allCapturedBodies.length > 0, 'Must have captured response bodies');

      for (const token of forbiddenTokens) {
        for (const raw of allCapturedBodies) {
          assert.ok(
            !raw.includes(token),
            `Response body leaked forbidden token "${token}":\n${raw}`
          );
        }
      }
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('10. Per-IP window: 11th request 429 rate_limited with Retry-After', async () => {
    const stub = await startStub();
    let server = null;
    try {
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
      });

      for (let i = 1; i <= 10; i++) {
        const { status, body } = await sendRequest(server.baseUrl, {
          body: { question: `Distinct question ${i} about Emad's background?` },
        });
        assert.equal(status, 200, `Request ${i} should return 200`);
        assert.equal(body?.ok, true);
      }

      const res11 = await sendRequest(server.baseUrl, {
        body: { question: 'Distinct question 11 about Emad?' },
      });

      assert.equal(res11.status, 429);
      assert.equal(res11.body?.error, 'rate_limited');
      assert.equal(
        res11.body?.message,
        'Too many questions from this address. Please try again later.'
      );
      assert.ok(
        Number.isInteger(res11.body?.retryAfterSeconds) &&
          res11.body.retryAfterSeconds >= 1 &&
          res11.body.retryAfterSeconds <= 3600,
        `retryAfterSeconds must be an integer 1..3600, got ${res11.body?.retryAfterSeconds}`
      );
      assert.equal(res11.headers.get('retry-after'), String(res11.body.retryAfterSeconds));

      const records = readStubLogRecords(stub.logPath);
      assert.equal(records.length, 10, 'Stub log must have exactly 10 records');
    } finally {
      if (server) await server.stop();
      await stub.close();
    }
  });

  test('11. Daily cap 3, restart persists, questions logged', async () => {
    const stub = await startStub();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ask-api-cap-'));
    let server = null;
    let db = null;
    try {
      const env = {
        AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
        ASK_DAILY_CAP: '3',
        ASK_RATE_LIMIT_PER_HOUR: '100',
      };

      server = await startServer(env, { dataDir, cleanup: false });

      const sentQuestions = [
        "Question 1: What is Emad's background in TypeScript?",
        "Question 2: What is Emad's experience with Docker?",
        "Question 3: What education does Emad have?",
        "Question 4: What open source work has Emad done?",
        "Question 5: What leadership experience does Emad have?",
      ];

      for (let i = 0; i < 3; i++) {
        const { status, body } = await sendRequest(server.baseUrl, {
          body: { question: sentQuestions[i] },
        });
        assert.equal(status, 200);
        assert.equal(body?.answer, 'This is a canned AI stub answer.');
      }
      assert.equal(readStubLogRecords(stub.logPath).length, 3);

      const res4 = await sendRequest(server.baseUrl, {
        body: { question: sentQuestions[3] },
      });
      assert.equal(res4.status, 429);
      assert.equal(res4.body?.error, 'daily_cap');
      assert.equal(
        res4.body?.message,
        'The assistant is paused for today. Please try again tomorrow or use the contact form.'
      );
      assert.equal(res4.headers.get('retry-after'), null);
      assert.equal(readStubLogRecords(stub.logPath).length, 3);

      await server.stop();
      server = null;

      server = await startServer(env, { dataDir, cleanup: false });

      const res5 = await sendRequest(server.baseUrl, {
        body: { question: sentQuestions[4] },
      });
      assert.equal(res5.status, 429);
      assert.equal(res5.body?.error, 'daily_cap');
      assert.equal(
        res5.body?.message,
        'The assistant is paused for today. Please try again tomorrow or use the contact form.'
      );
      assert.equal(readStubLogRecords(stub.logPath).length, 3);

      await server.stop();
      server = null;

      db = new DatabaseSync(path.join(dataDir, 'site.sqlite'), { readOnly: true });

      const rows = db.prepare('SELECT question FROM ask_questions').all();
      assert.ok(rows.length >= 4, `ask_questions must have at least 4 rows, found ${rows.length}`);
      const storedQuestions = rows.map((r) => r.question);
      for (const q of sentQuestions) {
        assert.ok(storedQuestions.includes(q), `Expected question "${q}" to be present in ask_questions`);
      }

      const countRow = db.prepare('SELECT SUM(count) AS total FROM ask_daily_counters').get();
      assert.ok(
        Number(countRow.total) >= 4,
        `Expected SUM(count) over ask_daily_counters to be >= 4, got ${countRow?.total}`
      );
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
      if (server) {
        try {
          await server.stop();
        } catch {
          // ignore
        }
      }
      await stub.close();
      cleanDataDir(dataDir);
    }
  });

  test('12. UTC rollover unit check', () => {
    assert.equal(utcDayKey(new Date('2026-11-09T23:59:59.999Z')), '2026-11-09');
    assert.equal(utcDayKey(new Date('2026-11-10T00:00:00.000Z')), '2026-11-10');

    const counts = new Map();
    const fakeDb = {
      consumeDailyAsk(day, cap) {
        const next = (counts.get(day) ?? 0) + 1;
        counts.set(day, next);
        return { count: next, allowed: next <= cap };
      },
    };

    const first = consumeDaily(fakeDb, '2026-11-09', 1);
    assert.equal(first.count, 1);
    assert.equal(first.allowed, true);

    const second = consumeDaily(fakeDb, '2026-11-09', 1);
    assert.equal(second.count, 2);
    assert.equal(second.allowed, false);

    const third = consumeDaily(fakeDb, '2026-11-10', 1);
    assert.deepEqual(third, { count: 1, allowed: true });
  });

  test('13. Contact limiter regression', () => {
    const limiter = getRateLimiter();
    const uniqueKey = `test-contact-unique-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (let i = 1; i <= 5; i++) {
      const res = limiter.check(uniqueKey);
      assert.equal(res.allowed, true, `Check ${i} must be allowed`);
    }

    const sixth = limiter.check(uniqueKey);
    assert.equal(sixth.allowed, false, '6th check must be blocked');
  });
});
