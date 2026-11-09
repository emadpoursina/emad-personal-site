/**
 * tests/cover-letter-api.integration.test.mjs
 *
 * Hermetic live-server integration tests for POST /api/cover-letter.
 * Part 1 — page and success (T018).
 * Part 2 — unconfigured, validation, media type, method (T019).
 * Part 3 — generator errors, timeout, fallback, leaks (T020).
 * Part 4 — admin endpoint switch without restart (T021).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createAiStubServer } from '../scripts/ai-stub.mjs';
import { createGeneratorStubServer } from '../scripts/generator-stub.mjs';
import {
  buildGeneralLetter,
  loadCoverLetter,
  REQUIRED_AUTHORIZATION,
  SIGNOFF,
} from '../src/lib/cover-letter.mjs';
import { consumeDaily as consumeCoverLetterDaily } from '../src/lib/cover-letter-limits.mjs';
import { utcDayKey } from '../src/lib/daily-cap.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'server', 'entry.mjs');

const letterDoc = loadCoverLetter();
const GENERAL_LETTER = buildGeneralLetter(letterDoc);
const API_KEY = 'test-generator-key-9f3c2a7d';

const capturedBodies = [];

/**
 * Generates an scrypt password hash matching the contract format:
 * scrypt$16384$8$1$<salt-b64>$<hash-b64>
 * @param {string} password
 * @returns {string}
 */
function generatePasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
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
 * Starts a generator stub server on an ephemeral port.
 * @param {object} [options]
 * @param {string|null} [options.letter]
 * @param {number|null} [options.status]
 * @param {number} [options.delayMs]
 * @returns {Promise<{ server: import('node:http').Server, port: number, logPath: string, close: () => Promise<void> }>}
 */
async function startStub(options = {}) {
  const { letter = null, status = null, delayMs = 0 } = options;
  const random = Math.random().toString(36).slice(2);
  const logPath = path.join(
    os.tmpdir(),
    `generator-stub-test-${Date.now()}-${random}.jsonl`
  );

  const server = createGeneratorStubServer({ logPath, letter, status, delayMs });

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
 * Starts an AI stub server on an ephemeral port.
 * @param {object} [options]
 * @param {string|null} [options.answer]
 * @param {number} [options.delayMs]
 * @returns {Promise<{ server: import('node:http').Server, port: number, logPath: string, close: () => Promise<void> }>}
 */
async function startAiStub(options = {}) {
  const { answer = null, delayMs = 0 } = options;
  const random = Math.random().toString(36).slice(2);
  const logPath = path.join(
    os.tmpdir(),
    `ai-stub-test-${Date.now()}-${random}.jsonl`
  );

  const server = createAiStubServer({ logPath, answer, delayMs });

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
 * Reads and parses JSONL lines from a file path.
 * @param {string} logPath
 * @returns {Array<any>}
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
 * Spawns a new server instance with fresh DATA_DIR and env overrides.
 * @param {Record<string, string>} [envOverrides]
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {boolean} [options.cleanup]
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, dataDir: string, baseUrl: string, output: () => string, stop: () => Promise<void> }>}
 */
async function startServer(envOverrides = {}, options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'cover-letter-api-test-'));
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

  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout?.on('data', (c) => stdoutChunks.push(c));
  child.stderr?.on('data', (c) => stderrChunks.push(c));

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
    output() {
      return (
        Buffer.concat(stdoutChunks).toString('utf8') +
        Buffer.concat(stderrChunks).toString('utf8')
      );
    },
    async stop() {
      await stopChild(child);
      if (options.cleanup !== false) {
        cleanDataDir(dataDir);
      }
    },
  };
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
    path = '/api/cover-letter',
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
  capturedBodies.push(rawText);

  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = null;
  }

  return { res, status: res.status, headers: res.headers, body: json, rawText };
}

/**
 * Starts a stub and a configured server pointing to it.
 * @param {string|null} [letter]
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{ stub: Awaited<ReturnType<typeof startStub>>, server: Awaited<ReturnType<typeof startServer>> }>}
 */
async function configured(letter = null, extraEnv = {}) {
  const stub = await startStub({ letter });
  let server;
  try {
    server = await startServer({
      GENERATOR_ENDPOINT: `http://127.0.0.1:${stub.port}/generate`,
      GENERATOR_API_KEY: API_KEY,
      ...extraEnv,
    });
  } catch (err) {
    await stub.close();
    throw err;
  }
  return { stub, server };
}

/**
 * Extracts visible text from HTML by stripping scripts/styles, stripping tags,
 * decoding basic HTML entities, and collapsing whitespace.
 * @param {string} html
 * @returns {string}
 */
function visibleText(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Part 1 — page and success (T018)
// ---------------------------------------------------------------------------

describe('POST /api/cover-letter integration', () => {
  test('1. Configured page renders the form and a 1,000-character submission succeeds', async () => {
    const { stub, server } = await configured();
    try {
      const jobDescription = ('We are hiring a senior backend engineer to own our Node.js services. ').repeat(40).slice(0, 1000);
      assert.equal(jobDescription.length, 1000);

      const pageRes = await sendRequest(server.baseUrl, {
        method: 'GET',
        path: '/cover-letter',
        headers: {},
      });
      assert.equal(pageRes.status, 200);
      assert.ok(pageRes.rawText.includes('<form'));
      assert.ok(pageRes.rawText.includes('id="jobDescription"'));
      assert.ok(pageRes.rawText.includes('name="jobDescription"'));
      assert.ok(pageRes.rawText.includes('maxlength="8000"'));
      assert.ok(pageRes.rawText.includes('role="status"'));
      assert.ok(pageRes.rawText.includes('aria-live="polite"'));
      assert.ok(pageRes.rawText.includes('role="alert"'));
      assert.ok(pageRes.rawText.includes('aria-describedby="jobDescription-hint"'));

      const postRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription },
      });
      assert.equal(postRes.status, 200);
      assert.equal(postRes.body?.ok, true);
      assert.equal(typeof postRes.body?.letter, 'string');
      assert.ok(postRes.body.letter.length > 0);
      assert.ok(postRes.body.letter.includes(REQUIRED_AUTHORIZATION));
      assert.ok(postRes.body.letter.includes(SIGNOFF));
      assert.deepEqual(postRes.body?.appended, { authorization: false, signoff: false });

      const records = readStubLogRecords(stub.logPath);
      assert.equal(records.length, 1);
      assert.equal(records[0].body?.job_description, jobDescription);
      assert.equal(records[0].authorizationPresent, true);
      assert.equal(records[0].authorizationScheme, 'Bearer');
      assert.equal(records[0].keyLength, API_KEY.length);
      assert.equal(records[0].keyLast4, API_KEY.slice(-4));
      const stubLogContent = readFileSync(stub.logPath, 'utf8');
      assert.ok(!stubLogContent.includes(API_KEY));
    } finally {
      if (server) await server.stop();
      if (stub) await stub.close();
    }
  });

  test('2. Missing required lines are appended without rewriting the letter', async () => {
    // Case A: missing authorization line
    const withoutAuth = 'Dear Hiring Manager,\n\nI build reliable backend services.\n\nBest regards, Emad Poursina';
    let stubA = null;
    let serverA = null;
    try {
      const resA = await configured(withoutAuth);
      stubA = resA.stub;
      serverA = resA.server;

      const postResA = await sendRequest(serverA.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Role A ' + 'x'.repeat(200) },
      });
      assert.equal(postResA.status, 200);
      assert.equal(postResA.body?.letter, withoutAuth + '\n\n' + REQUIRED_AUTHORIZATION);
      assert.ok(postResA.body?.letter.startsWith(withoutAuth));
      const authOccurrences = postResA.body.letter.split(REQUIRED_AUTHORIZATION).length - 1;
      assert.equal(authOccurrences, 1);
      assert.deepEqual(postResA.body?.appended, { authorization: true, signoff: false });
    } finally {
      if (serverA) await serverA.stop();
      if (stubA) await stubA.close();
    }

    // Case B: missing signoff line
    const withoutSignoff = 'Dear Hiring Manager,\n\nI build reliable backend services.\n\nRequires employer-sponsored work authorization.';
    let stubB = null;
    let serverB = null;
    try {
      const resB = await configured(withoutSignoff);
      stubB = resB.stub;
      serverB = resB.server;

      const postResB = await sendRequest(serverB.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Role B ' + 'x'.repeat(200) },
      });
      assert.equal(postResB.status, 200);
      assert.equal(postResB.body?.letter, withoutSignoff + '\n\n' + SIGNOFF);
      assert.ok(postResB.body?.letter.startsWith(withoutSignoff));
      assert.deepEqual(postResB.body?.appended, { authorization: false, signoff: true });
    } finally {
      if (serverB) await serverB.stop();
      if (stubB) await stubB.close();
    }
  });

  test('3. Unconfigured page and request handling', async () => {
    let stub = null;
    let server = null;
    let stub2 = null;
    let server2 = null;

    try {
      stub = await startStub();
      server = await startServer({
        GENERATOR_ENDPOINT: '',
        GENERATOR_API_KEY: '',
      });

      // GET /cover-letter -> 200; no /<form\b/i match; visible text contains letterDoc.greeting, every letterDoc.paragraphs entry, REQUIRED_AUTHORIZATION, SIGNOFF; raw body includes both letterDoc.links hrefs.
      const pageRes = await sendRequest(server.baseUrl, {
        method: 'GET',
        path: '/cover-letter',
        headers: {},
      });
      assert.equal(pageRes.status, 200);
      assert.ok(!/<form\b/i.test(pageRes.rawText));

      const pageText = visibleText(pageRes.rawText);
      assert.ok(pageText.includes(letterDoc.greeting));
      for (const p of letterDoc.paragraphs) {
        assert.ok(pageText.includes(p));
      }
      assert.ok(pageText.includes(REQUIRED_AUTHORIZATION));
      assert.ok(pageText.includes(SIGNOFF));

      for (const link of letterDoc.links) {
        assert.ok(pageRes.rawText.includes(link.href));
      }

      // POST {jobDescription:'Senior backend engineer role'} -> 503; deepEqual body {ok:false, error:'unconfigured', message:'The cover-letter generator is unavailable right now'}; readStubLogRecords(stub.logPath).length === 0.
      const unconfRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Senior backend engineer role' },
      });
      assert.equal(unconfRes.status, 503);
      assert.deepEqual(unconfRes.body, {
        ok: false,
        error: 'unconfigured',
        message: 'The cover-letter generator is unavailable right now',
      });
      assert.equal(readStubLogRecords(stub.logPath).length, 0);

      // Validation 400 cases
      const validationCases = [
        {
          body: { jobDescription: '' },
          expectedMessage: 'Job description is required.',
        },
        {
          body: { jobDescription: '   \n\t  ' },
          expectedMessage: 'Job description is required.',
        },
        {
          body: { jobDescription: 123 },
          expectedMessage: 'Job description is required.',
        },
        {
          rawBody: JSON.stringify(['x']),
          headers: { 'Content-Type': 'application/json' },
          expectedMessage: 'Job description is required.',
        },
        {
          rawBody: '{"jobDescription":',
          headers: { 'Content-Type': 'application/json' },
          expectedMessage: 'Job description is required.',
        },
        {
          body: { jobDescription: 'x'.repeat(8001) },
          expectedMessage: 'Job description must be 8,000 characters or fewer.',
        },
      ];

      for (const tc of validationCases) {
        const valRes = await sendRequest(server.baseUrl, {
          method: 'POST',
          path: '/api/cover-letter',
          headers: tc.headers || { 'Content-Type': 'application/json' },
          body: tc.rawBody !== undefined ? tc.rawBody : tc.body,
        });
        assert.equal(valRes.status, 400);
        assert.equal(valRes.body?.ok, false);
        assert.equal(valRes.body?.error, 'validation');
        assert.equal(valRes.body?.message, tc.expectedMessage);
        assert.equal(valRes.body?.errors?.jobDescription, tc.expectedMessage);
        assert.equal(readStubLogRecords(stub.logPath).length, 0);
      }

      // text/plain: headers {'Content-Type':'text/plain', Origin: server.baseUrl}, body 'x' -> 415 deepEqual {ok:false, error:'unsupported_media_type', message:'Send application/json.'}; stub log 0.
      const mediaRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        headers: { 'Content-Type': 'text/plain', Origin: server.baseUrl },
        body: 'x',
      });
      assert.equal(mediaRes.status, 415);
      assert.deepEqual(mediaRes.body, {
        ok: false,
        error: 'unsupported_media_type',
        message: 'Send application/json.',
      });
      assert.equal(readStubLogRecords(stub.logPath).length, 0);

      // GET /api/cover-letter with headers {} -> 405, headers.get('allow') === 'POST', deepEqual body {ok:false, error:'method_not_allowed', message:'Use POST.'}; stub log 0.
      const getRes = await sendRequest(server.baseUrl, {
        method: 'GET',
        path: '/api/cover-letter',
        headers: {},
      });
      assert.equal(getRes.status, 405);
      assert.equal(getRes.headers.get('allow'), 'POST');
      assert.deepEqual(getRes.body, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Use POST.',
      });
      assert.equal(readStubLogRecords(stub.logPath).length, 0);

      // Exactly 8,000 on a configured server: const {stub: stub2, server: server2} = await configured(); POST {jobDescription:'x'.repeat(8000)} -> 200; readStubLogRecords(stub2.logPath).length === 1.
      const conf2 = await configured();
      stub2 = conf2.stub;
      server2 = conf2.server;

      const okRes = await sendRequest(server2.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'x'.repeat(8000) },
      });
      assert.equal(okRes.status, 200);
      assert.equal(readStubLogRecords(stub2.logPath).length, 1);
    } finally {
      if (server) await server.stop();
      if (server2) await server2.stop();
      if (stub) await stub.close();
      if (stub2) await stub2.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Part 3 — generator errors, timeout, fallback, leaks (T020)
  // ---------------------------------------------------------------------------

  test('4. Generator failures and timeouts fall back without leaking', async () => {
    const jobDescription = 'UNIQUE-JOB-DESCRIPTION-MARKER-6d1f ' + 'z'.repeat(300);

    const assertNoLeaks = (server, rawText, scenarioMarker) => {
      const markers = [API_KEY, jobDescription];
      if (scenarioMarker) markers.push(scenarioMarker);

      // Check SQLite DB
      const dbPath = path.join(server.dataDir, 'site.sqlite');
      if (existsSync(dbPath)) {
        const raw = readFileSync(dbPath).toString('latin1');
        for (const m of markers) {
          assert.ok(!raw.includes(m), `SQLite database contains leak marker: ${m}`);
        }
      }

      // Check server logs
      const logs = server.output();
      for (const m of markers) {
        assert.ok(!logs.includes(m), `Server logs contain leak marker: ${m}`);
      }

      // Check response rawText
      for (const m of markers) {
        assert.ok(!rawText.includes(m), `Response raw text contains leak marker: ${m}`);
      }
    };

    const expectedGeneratorErrorMessage =
      'The cover-letter generator could not produce a letter right now. The general cover letter is available below.';
    const expectedGeneratorTimeoutMessage =
      'The cover-letter generator took too long. The general cover letter is available below.';

    // Scenario 1 (stub 500)
    let stub1 = null;
    let server1 = null;
    try {
      stub1 = await startStub({ status: 500 });
      server1 = await startServer({
        GENERATOR_ENDPOINT: `http://127.0.0.1:${stub1.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
      });

      const res1 = await sendRequest(server1.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription },
      });

      assert.equal(res1.status, 502);
      assert.equal(res1.body?.ok, false);
      assert.equal(res1.body?.error, 'generator_error');
      assert.equal(res1.body?.message, expectedGeneratorErrorMessage);
      assert.equal(res1.body?.fallback, true);
      assert.equal(res1.body?.generalLetter, GENERAL_LETTER);

      assertNoLeaks(server1, res1.rawText, 'stub failure');
    } finally {
      if (server1) await server1.stop();
      if (stub1) await stub1.close();
    }

    // Scenario 2 (invalid JSON)
    let rawHttpServer2 = null;
    let server2 = null;
    try {
      rawHttpServer2 = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('not json');
        });
      });

      await new Promise((resolve, reject) => {
        rawHttpServer2.listen(0, '127.0.0.1', () => resolve(undefined));
        rawHttpServer2.once('error', reject);
      });

      const rawAddr = rawHttpServer2.address();
      const rawPort = typeof rawAddr === 'object' && rawAddr !== null ? rawAddr.port : 0;

      server2 = await startServer({
        GENERATOR_ENDPOINT: `http://127.0.0.1:${rawPort}/generate`,
        GENERATOR_API_KEY: API_KEY,
      });

      const res2 = await sendRequest(server2.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription },
      });

      assert.equal(res2.status, 502);
      assert.equal(res2.body?.ok, false);
      assert.equal(res2.body?.error, 'generator_error');
      assert.equal(res2.body?.message, expectedGeneratorErrorMessage);
      assert.equal(res2.body?.fallback, true);
      assert.equal(res2.body?.generalLetter, GENERAL_LETTER);

      assertNoLeaks(server2, res2.rawText, 'not json');
    } finally {
      if (server2) await server2.stop();
      if (rawHttpServer2) {
        await new Promise((resolve) => rawHttpServer2.close(resolve));
      }
    }

    // Scenario 3 (empty letter)
    let stub3 = null;
    let server3 = null;
    try {
      stub3 = await startStub({ letter: '' });
      server3 = await startServer({
        GENERATOR_ENDPOINT: `http://127.0.0.1:${stub3.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
      });

      const res3 = await sendRequest(server3.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription },
      });

      assert.equal(res3.status, 502);
      assert.equal(res3.body?.ok, false);
      assert.equal(res3.body?.error, 'generator_error');
      assert.equal(res3.body?.message, expectedGeneratorErrorMessage);
      assert.equal(res3.body?.fallback, true);
      assert.equal(res3.body?.generalLetter, GENERAL_LETTER);

      assertNoLeaks(server3, res3.rawText);
    } finally {
      if (server3) await server3.stop();
      if (stub3) await stub3.close();
    }

    // Scenario 4 (13,000-character letter)
    let stub4 = null;
    let server4 = null;
    try {
      stub4 = await startStub({ letter: 'q'.repeat(13000) });
      server4 = await startServer({
        GENERATOR_ENDPOINT: `http://127.0.0.1:${stub4.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
      });

      const res4 = await sendRequest(server4.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription },
      });

      assert.equal(res4.status, 502);
      assert.equal(res4.body?.ok, false);
      assert.equal(res4.body?.error, 'generator_error');
      assert.equal(res4.body?.message, expectedGeneratorErrorMessage);
      assert.equal(res4.body?.fallback, true);
      assert.equal(res4.body?.generalLetter, GENERAL_LETTER);

      assertNoLeaks(server4, res4.rawText, 'q'.repeat(50));
    } finally {
      if (server4) await server4.stop();
      if (stub4) await stub4.close();
    }

    // Scenario 5 (timeout)
    let stub5 = null;
    let server5 = null;
    try {
      stub5 = await startStub({ delayMs: 800 });
      server5 = await startServer({
        GENERATOR_ENDPOINT: `http://127.0.0.1:${stub5.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
        GENERATOR_TIMEOUT_MS: '100',
      });

      const res5 = await sendRequest(server5.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription },
      });

      assert.equal(res5.status, 504);
      assert.equal(res5.body?.ok, false);
      assert.equal(res5.body?.error, 'generator_timeout');
      assert.equal(res5.body?.message, expectedGeneratorTimeoutMessage);
      assert.equal(res5.body?.fallback, true);
      assert.equal(res5.body?.generalLetter, GENERAL_LETTER);

      assertNoLeaks(server5, res5.rawText);
    } finally {
      if (server5) await server5.stop();
      if (stub5) await stub5.close();
    }
  });

  // -------------------------------------------------------------------------
  // Part 4 — admin endpoint switch without restart (T021)
  // -------------------------------------------------------------------------

  test('5. Admin save switches the endpoint with no restart and never exposes the key', async () => {
    const stubA = await startStub();
    const stubB = await startStub({
      letter:
        'Dear Hiring Manager,\n\nStub B tailored letter.\n\nRequires employer-sponsored work authorization.\n\nBest regards, Emad Poursina',
    });

    const password = 'admin-test-password-123';
    const passwordHash = generatePasswordHash(password);
    const encryptionKey = crypto.randomBytes(32).toString('base64');

    let server = null;
    try {
      server = await startServer({
        GENERATOR_ENDPOINT: `http://127.0.0.1:${stubA.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
        ADMIN_PASSWORD_HASH: passwordHash,
        ENCRYPTION_KEY: encryptionKey,
      });

      // First POST /api/cover-letter {jobDescription:'Admin switch request one'} -> 200
      const firstRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Admin switch request one' },
      });
      assert.equal(firstRes.status, 200);
      assert.equal(firstRes.body?.ok, true);
      assert.equal(readStubLogRecords(stubA.logPath).length, 1);

      // Login: POST /api/admin/login
      const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: {
          Origin: server.baseUrl,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });
      assert.equal(loginRes.status, 200);

      const setCookies =
        typeof loginRes.headers.getSetCookie === 'function'
          ? loginRes.headers.getSetCookie()
          : [loginRes.headers.get('set-cookie')].filter(Boolean);
      const sessionEntry = setCookies.find((c) => c.startsWith('admin_session='));
      assert.ok(sessionEntry, 'expected admin_session cookie in login response');
      const cookieHeader = sessionEntry.split(';')[0];

      // POST /api/admin/settings
      const settingsRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/admin/settings',
        headers: {
          Cookie: cookieHeader,
          Origin: server.baseUrl,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: { generatorEndpoint: `http://127.0.0.1:${stubB.port}/generate` },
      });
      assert.equal(settingsRes.status, 200);
      assert.equal(settingsRes.body?.ok, true);
      assert.ok(
        !settingsRes.rawText.includes(API_KEY),
        'admin settings response must not expose API key'
      );

      // GET /admin with Cookie -> 200; rawText does not include API_KEY; rawText includes 'noindex'
      const adminRes = await sendRequest(server.baseUrl, {
        method: 'GET',
        path: '/admin',
        headers: {
          Cookie: cookieHeader,
        },
      });
      assert.equal(adminRes.status, 200);
      assert.ok(
        !adminRes.rawText.includes(API_KEY),
        '/admin HTML must not expose API key'
      );
      assert.ok(
        adminRes.rawText.includes('noindex'),
        '/admin HTML must include noindex'
      );

      // GET /cover-letter -> 200; rawText includes 'maxlength="8000"'; rawText does not include API_KEY
      const coverLetterPageRes = await sendRequest(server.baseUrl, {
        method: 'GET',
        path: '/cover-letter',
        headers: {},
      });
      assert.equal(coverLetterPageRes.status, 200);
      assert.ok(
        coverLetterPageRes.rawText.includes('maxlength="8000"'),
        '/cover-letter page must include maxlength="8000"'
      );
      assert.ok(
        !coverLetterPageRes.rawText.includes(API_KEY),
        '/cover-letter page must not expose API key'
      );

      // Second POST /api/cover-letter {jobDescription:'Admin switch request two'} -> 200
      const secondRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Admin switch request two' },
      });
      assert.equal(secondRes.status, 200);
      assert.equal(secondRes.body?.ok, true);
      assert.ok(
        typeof secondRes.body?.letter === 'string' &&
          secondRes.body.letter.includes('Stub B tailored letter.'),
        'second letter must contain Stub B tailored letter'
      );
      assert.equal(readStubLogRecords(stubB.logPath).length, 1);
      assert.equal(readStubLogRecords(stubA.logPath).length, 1);
    } finally {
      if (server) await server.stop();
      await Promise.all([stubA.close(), stubB.close()]);
    }
  });

  test('6. Per-IP window blocks the 11th request and leaves the assistant untouched', async () => {
    let server = null;
    let genStub = null;
    let aiStub = null;

    try {
      genStub = await startStub({
        letter: 'Tailored letter for rate limit testing. Emad has extensive TypeScript experience.',
      });
      aiStub = await startAiStub({
        answer: 'Emad has extensive experience building services with Node.js and TypeScript.',
      });

      server = await startServer({
        GENERATOR_ENDPOINT: `http://127.0.0.1:${genStub.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
        AI_BASE_URL: `http://127.0.0.1:${aiStub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
      });

      // Send 11 POST /api/cover-letter requests from the same IP (no X-Forwarded-For)
      for (let i = 1; i <= 10; i++) {
        const res = await sendRequest(server.baseUrl, {
          method: 'POST',
          path: '/api/cover-letter',
          body: { jobDescription: `Rate limit request ${i}` },
        });
        assert.equal(res.status, 200, `request ${i} should return 200`);
        assert.equal(res.body?.ok, true, `request ${i} should have ok:true`);
      }

      const eleventhRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Rate limit request 11' },
      });
      assert.equal(eleventhRes.status, 429, '11th request must be 429');
      assert.equal(eleventhRes.body?.error, 'rate_limited');
      assert.equal(
        eleventhRes.body?.message,
        'Too many cover-letter requests from this address. Please try again later.'
      );
      assert.ok(
        Number.isInteger(eleventhRes.body?.retryAfterSeconds),
        'retryAfterSeconds must be an integer'
      );
      assert.ok(
        eleventhRes.body.retryAfterSeconds >= 1 && eleventhRes.body.retryAfterSeconds <= 3600,
        'retryAfterSeconds must be between 1 and 3600'
      );
      assert.equal(
        eleventhRes.headers.get('retry-after'),
        String(eleventhRes.body.retryAfterSeconds),
        'retry-after header must match retryAfterSeconds'
      );

      // Assert readStubLogRecords(genStub.logPath).length === 10 after the 11th
      assert.equal(
        readStubLogRecords(genStub.logPath).length,
        10,
        'generator stub must have recorded exactly 10 requests'
      );

      // POST /api/ask {question:'What has Emad built with Node.js?'} on the same server
      const askRes = await sendRequest(server.baseUrl, {
        method: 'POST',
        path: '/api/ask',
        body: { question: 'What has Emad built with Node.js?' },
      });
      assert.equal(askRes.status, 200, 'assistant request must succeed with 200');
      assert.equal(
        readStubLogRecords(aiStub.logPath).length,
        1,
        'assistant stub must have recorded exactly 1 request'
      );

      // GET /cover-letter and assert served HTML includes literals
      const coverLetterPageRes = await sendRequest(server.baseUrl, {
        method: 'GET',
        path: '/cover-letter',
        headers: {},
      });
      assert.ok(
        coverLetterPageRes.rawText.includes(
          'Too many cover-letter requests from this address. Please try again in '
        ),
        'served HTML must include rate limit message snippet'
      );
      assert.ok(
        coverLetterPageRes.rawText.includes('retryAfterSeconds'),
        'served HTML must include retryAfterSeconds'
      );
    } finally {
      if (server) await server.stop();
      const cleanups = [];
      if (genStub) cleanups.push(genStub.close());
      if (aiStub) cleanups.push(aiStub.close());
      await Promise.all(cleanups);
    }
  });

  test('7. Shared cap counts assistant and cover-letter, survives restart, resets next UTC day', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cover-letter-shared-cap-'));
    let genStub = null;
    let aiStub = null;
    let serverA = null;
    let serverB = null;

    try {
      genStub = await startStub({ letter: 'Cover letter body.' });
      aiStub = await startAiStub({ answer: 'Emad has extensive experience.' });

      const env = {
        ASK_DAILY_CAP: '3',
        GENERATOR_ENDPOINT: `http://127.0.0.1:${genStub.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
        AI_BASE_URL: `http://127.0.0.1:${aiStub.port}/v1`,
        AI_MODEL: 'stub-model',
        AI_API_KEY: 'test-key-123',
      };

      serverA = await startServer(env, { dataDir, cleanup: false });

      // POST /api/ask {question:'What has Emad built with Node.js?'} -> 200
      const askRes1 = await sendRequest(serverA.baseUrl, {
        method: 'POST',
        path: '/api/ask',
        body: { question: 'What has Emad built with Node.js?' },
      });
      assert.equal(askRes1.status, 200, 'first ask request must return 200');

      // second question 'Which databases has Emad used?' -> 200
      const askRes2 = await sendRequest(serverA.baseUrl, {
        method: 'POST',
        path: '/api/ask',
        body: { question: 'Which databases has Emad used?' },
      });
      assert.equal(askRes2.status, 200, 'second ask request must return 200');

      // POST /api/cover-letter {jobDescription:'Backend engineer.'} -> 200
      const clRes1 = await sendRequest(serverA.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Backend engineer.' },
      });
      assert.equal(clRes1.status, 200, 'first cover-letter request must return 200');

      // second identical -> 429, body.error==='daily_cap', body.message==='The cover-letter generator is paused for today. Please try again tomorrow or use the general cover letter.'
      const clRes2 = await sendRequest(serverA.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Backend engineer.' },
      });
      assert.equal(clRes2.status, 429, 'second cover-letter request must return 429');
      assert.equal(clRes2.body?.error, 'daily_cap');
      assert.equal(
        clRes2.body?.message,
        'The cover-letter generator is paused for today. Please try again tomorrow or use the general cover letter.'
      );

      // assert readStubLogRecords(aiStub.logPath).length === 2 and readStubLogRecords(genStub.logPath).length === 1
      assert.equal(
        readStubLogRecords(aiStub.logPath).length,
        2,
        'assistant stub should have recorded exactly 2 requests'
      );
      assert.equal(
        readStubLogRecords(genStub.logPath).length,
        1,
        'generator stub should have recorded exactly 1 request'
      );

      // Stop server A, start server B on the SAME dataDir (cleanup:false) with the same env/stubs
      await serverA.stop();
      serverA = null;

      serverB = await startServer(env, { dataDir, cleanup: false });

      // POST /api/cover-letter -> 429 daily_cap; assert genStub log still 1 (no new external call)
      const clRes3 = await sendRequest(serverB.baseUrl, {
        method: 'POST',
        path: '/api/cover-letter',
        body: { jobDescription: 'Backend engineer.' },
      });
      assert.equal(clRes3.status, 429, 'cover-letter request on server B must return 429');
      assert.equal(clRes3.body?.error, 'daily_cap');
      assert.equal(
        readStubLogRecords(genStub.logPath).length,
        1,
        'generator stub should still have recorded exactly 1 request'
      );

      // Optionally also POST /api/ask -> 429 daily_cap and aiStub still 2
      const askRes3 = await sendRequest(serverB.baseUrl, {
        method: 'POST',
        path: '/api/ask',
        body: { question: 'What has Emad built with React?' },
      });
      assert.equal(askRes3.status, 429, 'ask request on server B must return 429');
      assert.equal(askRes3.body?.error, 'daily_cap');
      assert.equal(
        readStubLogRecords(aiStub.logPath).length,
        2,
        'assistant stub should still have recorded exactly 2 requests'
      );

      // Unit rollover check in the same test (injected clock): fake db with consumeDailyAsk(day,cap) counting per day, getCapEvent(day,feature), insertCapEvent(day,feature); day1 = utcDayKey(new Date('2026-11-09T23:59:59.999Z')) === '2026-11-09', day2 = utcDayKey(new Date('2026-11-10T00:00:00.000Z')) === '2026-11-10'; consumeCoverLetterDaily(fakeDb, day1, 1) -> allowed true; again -> allowed false; then day2 -> deepEqual {count:1,allowed:true}; assert no cap event was inserted for day2. Silence console.warn around it.
      const dayCounts = new Map();
      const capEvents = [];
      const fakeDb = {
        consumeDailyAsk(day, cap) {
          const current = dayCounts.get(day) ?? 0;
          if (current >= cap) {
            return { count: current, allowed: false };
          }
          const next = current + 1;
          dayCounts.set(day, next);
          return { count: next, allowed: true };
        },
        getCapEvent(day, feature) {
          return capEvents.find((e) => e.day === day && e.feature === feature) ?? null;
        },
        insertCapEvent(day, feature) {
          const ev = { day, feature, created_at: new Date().toISOString() };
          capEvents.push(ev);
          return ev;
        },
      };

      const day1 = utcDayKey(new Date('2026-11-09T23:59:59.999Z'));
      assert.equal(day1, '2026-11-09');
      const day2 = utcDayKey(new Date('2026-11-10T00:00:00.000Z'));
      assert.equal(day2, '2026-11-10');

      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        const resDay1First = consumeCoverLetterDaily(fakeDb, day1, 1);
        assert.equal(resDay1First.allowed, true);
        const resDay1Second = consumeCoverLetterDaily(fakeDb, day1, 1);
        assert.equal(resDay1Second.allowed, false);

        const resDay2 = consumeCoverLetterDaily(fakeDb, day2, 1);
        assert.deepEqual(resDay2, { count: 1, allowed: true });
        assert.equal(
          fakeDb.getCapEvent(day2, 'cover_letter'),
          null,
          'no cap event was inserted for day2'
        );
      } finally {
        console.warn = originalWarn;
      }
    } finally {
      if (serverA) await serverA.stop();
      if (serverB) await serverB.stop();
      const cleanups = [];
      if (genStub) cleanups.push(genStub.close());
      if (aiStub) cleanups.push(aiStub.close());
      await Promise.all(cleanups);
      cleanDataDir(dataDir);
    }
  });

  test('8. Over-cap requests write one bounded event row and leak no content or client IP', async () => {
    const jobDescription = 'UNIQUE-JOB-DESCRIPTION-MARKER-8a1c ' + 'z'.repeat(200);
    const letterMarker = 'UNIQUE-GENERATED-LETTER-MARKER-8a1c';
    const clientIp = '203.0.113.77';

    let stub = null;
    let server = null;
    try {
      stub = await startStub({
        letter: `Dear Hiring Manager,\n\n${letterMarker}\n\nRequires employer-sponsored work authorization.\n\nBest regards, Emad Poursina`,
      });

      server = await startServer({
        ASK_DAILY_CAP: '1',
        TRUST_PROXY: '1',
        GENERATOR_ENDPOINT: `http://127.0.0.1:${stub.port}/generate`,
        GENERATOR_API_KEY: API_KEY,
      });

      // Send 4 POST /api/cover-letter requests with headers and body
      for (let i = 1; i <= 4; i++) {
        const res = await sendRequest(server.baseUrl, {
          method: 'POST',
          path: '/api/cover-letter',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': clientIp,
          },
          body: { jobDescription },
        });

        if (i === 1) {
          assert.equal(res.status, 200, 'first request must be 200');
          assert.equal(res.body?.ok, true);
        } else {
          assert.equal(res.status, 429, `request ${i} must be 429`);
          assert.equal(res.body?.error, 'daily_cap');
        }
      }

      // Open the database
      const dbPath = path.join(server.dataDir, 'site.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        const today = new Date().toISOString().slice(0, 10);
        const rows = db
          .prepare("SELECT day, feature FROM daily_cap_events WHERE day = ? AND feature = 'cover_letter'")
          .all(today);
        assert.equal(rows.length, 1, 'must have exactly one bounded event row');

        const tableInfo = db.prepare('PRAGMA table_info(daily_cap_events)').all();
        const columnNames = tableInfo.map((col) => col.name);
        assert.deepEqual(
          columnNames,
          ['day', 'feature', 'created_at'],
          'column names must be exactly day, feature, created_at'
        );
      } finally {
        db.close();
      }

      // Read the SQLite bytes
      const files = readdirSync(server.dataDir).filter((name) => name.startsWith('site.sqlite'));
      for (const file of files) {
        const fullPath = path.join(server.dataDir, file);
        const content = readFileSync(fullPath).toString('latin1');
        assert.ok(
          !content.includes(jobDescription),
          `SQLite file ${file} must not contain jobDescription`
        );
        assert.ok(
          !content.includes(letterMarker),
          `SQLite file ${file} must not contain letterMarker`
        );
      }

      // Assert server.output() does not contain clientIp, jobDescription, or letterMarker
      const logs = server.output();
      assert.ok(!logs.includes(clientIp), 'server logs must not contain clientIp');
      assert.ok(!logs.includes(jobDescription), 'server logs must not contain jobDescription');
      assert.ok(!logs.includes(letterMarker), 'server logs must not contain letterMarker');
    } finally {
      if (server) await server.stop();
      if (stub) await stub.close();
    }
  });
});
