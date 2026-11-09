/**
 * tests/admin-api.integration.test.mjs
 *
 * Hermetic live-server integration tests for admin authentication and session lifecycle (T030).
 * Exercises rows 1-8 and 19-20 of the admin test matrix using ephemeral ports and child processes.
 * Designed with reusable helpers for T031/T032 settings and model-switch test suites.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'server', 'entry.mjs');
const STUB_SCRIPT = path.join(ROOT, 'scripts', 'ai-stub.mjs');

export const DEFAULT_ADMIN_PASSWORD = 'correct-horse-battery-staple-123';

export const SETTINGS_FIELDS_NAMES = Object.freeze([
  'aiBaseUrl',
  'aiModel',
  'aiApiKey',
  'askDailyCap',
  'askRateLimitPerHour',
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUser',
  'smtpPass',
  'smtpFrom',
  'generatorEndpoint',
]);

// ---------------------------------------------------------------------------
// Reusable Helpers
// ---------------------------------------------------------------------------

/**
 * Finds a free TCP port on 127.0.0.1 via net.listen(0).
 * @returns {Promise<number>}
 */
export function getFreePort() {
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
export async function waitForHealthz(port, timeoutMs = 15000) {
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
 * Waits for a TCP port on 127.0.0.1 to accept connections.
 * @param {number} port
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<void>}
 */
export function waitForPort(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      const socket = net.connect({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`timed out waiting for port ${port}`));
        } else {
          setTimeout(tryConnect, 50);
        }
      });
    }
    tryConnect();
  });
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
 * Generates an scrypt password hash matching the contract format:
 * scrypt$16384$8$1$<salt-b64>$<hash-b64>
 * @param {string} password
 * @returns {string}
 */
export function generatePasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Generates a random 32-byte base64 encryption key.
 * @returns {string}
 */
export function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('base64');
}

/** @type {any} Active server instance for stopServer() convenience */
let activeServer = null;

/**
 * Spawns a new server instance with a fresh temp DATA_DIR and env overrides.
 * @param {Record<string, string>} [extraEnv]
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {string} [options.password]
 * @param {string} [options.passwordHash]
 * @param {string} [options.encryptionKey]
 * @param {boolean} [options.cleanup]
 * @returns {Promise<{
 *   child: import('node:child_process').ChildProcess,
 *   port: number,
 *   baseUrl: string,
 *   dataDir: string,
 *   password: string,
 *   passwordHash: string,
 *   encryptionKey: string,
 *   stop: () => Promise<void>
 * }>}
 */
export async function startServer(extraEnv = {}, options = {}) {
  const port = await getFreePort();
  const dataDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'admin-api-test-'));
  const password = options.password ?? DEFAULT_ADMIN_PASSWORD;
  const passwordHash = options.passwordHash ?? generatePasswordHash(password);
  const encryptionKey = options.encryptionKey ?? generateEncryptionKey();

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    ADMIN_PASSWORD_HASH: passwordHash,
    ENCRYPTION_KEY: encryptionKey,
    CONTACT_RATE_LIMIT_PER_HOUR: '5',
    ...extraEnv,
  };

  const child = spawn(process.execPath, ['--experimental-sqlite', ENTRY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serverInstance = {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    password,
    passwordHash,
    encryptionKey,
    async stop() {
      await stopChild(child);
      if (options.cleanup !== false) {
        cleanDataDir(dataDir);
      }
      if (activeServer === serverInstance) {
        activeServer = null;
      }
    },
  };

  try {
    await waitForHealthz(port);
  } catch (err) {
    await serverInstance.stop();
    throw err;
  }

  activeServer = serverInstance;
  return serverInstance;
}

/**
 * Stops a server instance and cleans up its data directory.
 * Defaults to the most recently created active server if omitted.
 * @param {any} [serverToStop]
 * @returns {Promise<void>}
 */
export async function stopServer(serverToStop = activeServer) {
  if (serverToStop && typeof serverToStop.stop === 'function') {
    await serverToStop.stop();
  }
}

/**
 * Extracts a cookie value (name=value) from Response headers using res.headers.getSetCookie().
 * @param {Response | { headers: Headers }} res
 * @param {string} [cookieName='admin_session']
 * @returns {string | null} e.g. "admin_session=abc..." or null
 */
export function cookieFrom(res, cookieName = 'admin_session') {
  if (!res) return null;
  const headers = res.headers ?? res;
  const setCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (typeof headers.get === 'function' ? [headers.get('set-cookie')].filter(Boolean) : []);

  for (const cookieStr of setCookies) {
    const match = cookieStr.match(new RegExp(`(?:^|;\\s*)(${cookieName}=[^;]*)`));
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Performs a GET request to http://127.0.0.1:${port}${path}.
 * @param {number} port
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
export async function get(port, path, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });
}

/**
 * Performs a POST form request with application/x-www-form-urlencoded.
 * @param {number} port
 * @param {string} path
 * @param {string | Record<string, unknown> | URLSearchParams} [body]
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
export async function postForm(port, path, body = {}, headers = {}) {
  let formBody = '';
  if (typeof body === 'string') {
    formBody = body;
  } else if (body instanceof URLSearchParams) {
    formBody = body.toString();
  } else if (body && typeof body === 'object') {
    formBody = new URLSearchParams(body).toString();
  }

  const reqHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: `http://127.0.0.1:${port}`,
    ...headers,
  };
  if (reqHeaders.Origin === null || reqHeaders.Origin === undefined) {
    delete reqHeaders.Origin;
  }

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: reqHeaders,
    body: formBody,
    redirect: 'manual',
  });
}

/**
 * Performs a POST JSON request with application/json.
 * @param {number} port
 * @param {string} path
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
export async function postJson(port, path, body = {}, headers = {}) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: `http://127.0.0.1:${port}`,
    ...headers,
  };
  if (reqHeaders.Origin === null || reqHeaders.Origin === undefined) {
    delete reqHeaders.Origin;
  }

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: reqHeaders,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
}

/**
 * Logs in via form POST to /api/admin/login.
 * @param {number} port
 * @param {string} password
 * @param {object} [options]
 * @param {string | null} [options.origin]
 * @returns {Promise<Response>}
 */
export async function formLogin(port, password, { origin } = {}) {
  const originHeader = origin !== undefined ? origin : `http://127.0.0.1:${port}`;
  const headers = {};
  if (originHeader !== null) {
    headers.Origin = originHeader;
  }
  return postForm(port, '/api/admin/login', { password }, headers);
}

/**
 * Logs in via JSON POST to /api/admin/login.
 * @param {number} port
 * @param {string} password
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
export async function jsonLogin(port, password, headers = {}) {
  return postJson(port, '/api/admin/login', { password }, {
    Origin: `http://127.0.0.1:${port}`,
    ...headers,
  });
}

// Global safety cleanup on process exit
process.on('exit', () => {
  if (activeServer?.child && !activeServer.child.killed) {
    try {
      activeServer.child.kill('SIGKILL');
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// Integration Test Suite: Rows 1-8, 19-20 of Admin Matrix
// ---------------------------------------------------------------------------

describe('Admin API Integration Tests (Authentication & Session Lifecycle)', () => {
  // Matrix Row 1
  test('1. GET /admin with no cookie -> exactly 401, HTML, noindex, link to login, no settings', async () => {
    const server = await startServer();
    try {
      const res = await get(server.port, '/admin');
      assert.equal(res.status, 401);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      assert.match(res.headers.get('cache-control') || '', /no-store/i);

      const html = await res.text();
      assert.match(html, /noindex/);
      assert.ok(html.includes('/admin/login'), 'must contain link to /admin/login');
      assert.ok(!html.includes('Admin settings'), 'must not contain Admin settings heading');
      assert.ok(!html.includes('••••'), 'must not contain masked secret placeholder');
      assert.ok(!html.includes('v1:'), 'must not contain v1:');
      assert.ok(!/[0-9a-fA-F]{64}/.test(html), 'must not contain session id');

      for (const field of SETTINGS_FIELDS_NAMES) {
        assert.ok(!html.includes(field), `must not contain setting key ${field}`);
      }
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 2
  test('2. POST /api/admin/settings with no cookie (valid Origin) -> 401 JSON unauthorized, no setting keys/values', async () => {
    const server = await startServer();
    try {
      const res = await postForm(
        server.port,
        '/api/admin/settings',
        { aiModel: 'test-model' },
        { Origin: `http://127.0.0.1:${server.port}` }
      );
      assert.equal(res.status, 401);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      assert.match(res.headers.get('cache-control') || '', /no-store/i);

      const text = await res.text();
      const body = JSON.parse(text);
      assert.deepEqual(body, { ok: false, error: 'unauthorized' });

      for (const field of SETTINGS_FIELDS_NAMES) {
        assert.ok(!text.includes(field), `must not contain setting key ${field}`);
      }

      // Also verify GET /api/admin/settings with no cookie
      const getRes = await get(server.port, '/api/admin/settings');
      assert.equal(getRes.status, 401);
      const getJson = await getRes.json();
      assert.deepEqual(getJson, { ok: false, error: 'unauthorized' });
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 3
  test('3. GET /admin/login -> 200, noindex, one password input, form action /api/admin/login, no settings values', async () => {
    const server = await startServer();
    try {
      const res = await get(server.port, '/admin/login');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);

      const html = await res.text();
      assert.match(html, /noindex/);
      assert.match(html, /<form[^>]+action=["']\/api\/admin\/login["']/i);

      const pwdCount = (html.match(/type=["']password["']/gi) || []).length;
      assert.equal(pwdCount, 1, 'must contain exactly one password input');

      for (const field of SETTINGS_FIELDS_NAMES) {
        assert.ok(!html.includes(field), `must not contain setting key ${field}`);
      }
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 5 (Form flow)
  test('4. Correct password via urlencoded form -> 303 Location: /admin, Set-Cookie attributes, no Secure on plain HTTP', async () => {
    const server = await startServer();
    try {
      const res = await formLogin(server.port, server.password, {
        origin: `http://127.0.0.1:${server.port}`,
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/admin');

      const setCookies = res.headers.getSetCookie();
      assert.ok(setCookies.length > 0, 'Set-Cookie header must be present');

      const sessionCookie = setCookies.find((c) => c.startsWith('admin_session='));
      assert.ok(sessionCookie, 'admin_session Set-Cookie must be present');
      assert.match(sessionCookie, /admin_session=[0-9a-fA-F]{64}/);
      assert.ok(sessionCookie.includes('HttpOnly'), 'must include HttpOnly');
      assert.ok(sessionCookie.includes('SameSite=Strict'), 'must include SameSite=Strict');
      assert.ok(sessionCookie.includes('Path=/'), 'must include Path=/');
      assert.ok(sessionCookie.includes('Max-Age=28800'), 'must include Max-Age=28800');
      assert.ok(!sessionCookie.includes('Secure'), 'must NOT include Secure on plain HTTP');

      const cookieVal = cookieFrom(res);
      assert.match(cookieVal || '', /^admin_session=[0-9a-fA-F]{64}$/);
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 5 (JSON flow)
  test('5. Correct password via JSON (Accept: application/json) -> 200 {ok:true,expiresAt:<ISO 8h ahead>} + cookie', async () => {
    const server = await startServer();
    try {
      const res = await jsonLogin(server.port, server.password);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/json/);

      const body = await res.json();
      assert.equal(body?.ok, true);
      assert.ok(typeof body?.expiresAt === 'string', 'expiresAt must be a string');

      const expiresMs = new Date(body.expiresAt).getTime();
      assert.ok(!Number.isNaN(expiresMs), 'expiresAt must be a valid ISO date');
      const diffHours = (expiresMs - Date.now()) / (1000 * 60 * 60);
      assert.ok(
        diffHours >= 7.9 && diffHours <= 8.1,
        `expiresAt must be ~8 hours ahead, got ${diffHours.toFixed(2)}h`
      );

      const setCookies = res.headers.getSetCookie();
      const sessionCookie = setCookies.find((c) => c.startsWith('admin_session='));
      assert.ok(sessionCookie, 'admin_session Set-Cookie must be present');
      assert.ok(sessionCookie.includes('HttpOnly'));
      assert.ok(sessionCookie.includes('SameSite=Strict'));
      assert.ok(sessionCookie.includes('Path=/'));
      assert.ok(sessionCookie.includes('Max-Age=28800'));
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 4 (Single failure)
  test('6. Wrong password -> 401 {ok:false,error:invalid_credentials} and no Set-Cookie', async () => {
    const server = await startServer();
    try {
      const res = await jsonLogin(server.port, 'completely-wrong-password');
      assert.equal(res.status, 401);
      assert.match(res.headers.get('content-type') || '', /application\/json/);

      const body = await res.json();
      assert.deepEqual(body, {
        ok: false,
        error: 'invalid_credentials',
        message: 'Incorrect password.',
      });
      assert.equal(res.headers.getSetCookie().length, 0, 'must have no Set-Cookie');

      const resForm = await formLogin(server.port, 'wrong-password-form');
      assert.equal(resForm.status, 401);
      const formBody = await resForm.json();
      assert.deepEqual(formBody, {
        ok: false,
        error: 'invalid_credentials',
        message: 'Incorrect password.',
      });
      assert.equal(resForm.headers.getSetCookie().length, 0, 'form login must have no Set-Cookie');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 4 (Lockout threshold)
  test('7. Five wrong passwords -> five 401s; sixth attempt with CORRECT password -> 429 locked, Retry-After present, no Set-Cookie', async () => {
    const server = await startServer();
    try {
      for (let i = 1; i <= 5; i++) {
        const res = await jsonLogin(server.port, `wrong-attempt-${i}`);
        assert.equal(res.status, 401, `attempt ${i} must return 401`);
        const body = await res.json();
        assert.equal(body?.error, 'invalid_credentials');
        assert.equal(res.headers.getSetCookie().length, 0);
      }

      // Sixth attempt with the CORRECT password must be blocked by in-memory lockout
      const res6 = await jsonLogin(server.port, server.password);
      assert.equal(res6.status, 429, 'sixth attempt must return 429 locked');
      assert.match(res6.headers.get('content-type') || '', /application\/json/);

      const body6 = await res6.json();
      assert.equal(body6?.ok, false);
      assert.equal(body6?.error, 'locked');
      assert.equal(body6?.message, 'Too many failed attempts. Try again later.');
      assert.ok(
        Number.isInteger(body6?.retryAfterSeconds) &&
          body6.retryAfterSeconds > 0 &&
          body6.retryAfterSeconds <= 900,
        `retryAfterSeconds must be between 1 and 900, got ${body6?.retryAfterSeconds}`
      );
      assert.equal(res6.headers.get('retry-after'), String(body6.retryAfterSeconds));
      assert.equal(res6.headers.getSetCookie().length, 0, 'must not set cookie on 429 locked');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 7
  test('8. Expired session row in SQLite -> 401 and row deleted', async () => {
    const server = await startServer();
    try {
      const expiredId = crypto.randomBytes(32).toString('hex');
      const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();

      const dbPath = path.join(server.dataDir, 'site.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)').run(
          expiredId,
          pastIso
        );
      } finally {
        db.close();
      }

      const res = await get(server.port, '/admin', {
        Cookie: `admin_session=${expiredId}`,
      });
      assert.equal(res.status, 401);

      const verifyDb = new DatabaseSync(dbPath);
      try {
        const row = verifyDb.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(expiredId);
        assert.equal(row, undefined, 'expired session row must be deleted from DB');
      } finally {
        verifyDb.close();
      }
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 8 & 19
  test('9. Logout: log in, POST /api/admin/logout with cookie -> 303 Location: /admin/login, Max-Age=0 cookie, session deleted, old cookie 401, logout without cookie 401', async () => {
    const server = await startServer();
    try {
      // 1. Log in
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie, 'cookie must be set on login');
      const sessionId = cookie.replace(/^admin_session=/, '');

      const dbPath = path.join(server.dataDir, 'site.sqlite');
      let db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(sessionId);
        assert.ok(row, 'session row must exist in DB before logout');
      } finally {
        db.close();
      }

      // 2. Logout with cookie
      const logoutRes = await postForm(
        server.port,
        '/api/admin/logout',
        {},
        { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}` }
      );
      assert.equal(logoutRes.status, 303);
      assert.equal(logoutRes.headers.get('location'), '/admin/login');

      const setCookies = logoutRes.headers.getSetCookie();
      const clearCookie = setCookies.find((c) => c.startsWith('admin_session='));
      assert.ok(clearCookie, 'Set-Cookie clearing session must be present');
      assert.ok(clearCookie.includes('Max-Age=0'), 'Set-Cookie must have Max-Age=0');

      // 3. GET /admin with old cookie
      const adminRes = await get(server.port, '/admin', { Cookie: cookie });
      assert.equal(adminRes.status, 401);

      // 4. Check DB row is gone
      db = new DatabaseSync(dbPath);
      try {
        const rowAfter = db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(sessionId);
        assert.equal(rowAfter, undefined, 'session row must be deleted after logout');
      } finally {
        db.close();
      }

      // 5. Logout without a cookie -> 401
      const noCookieRes = await postForm(
        server.port,
        '/api/admin/logout',
        {},
        { Origin: `http://127.0.0.1:${server.port}` }
      );
      assert.equal(noCookieRes.status, 401);
      const noCookieBody = await noCookieRes.json();
      assert.deepEqual(noCookieBody, { ok: false, error: 'unauthorized' });
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 6 & 20
  test('10. Authenticated GET /admin -> 200, noindex, <h1>Admin settings</h1>, form action /api/admin/settings, separate logout form, only masked secrets', async () => {
    const customAiKey = 'secret-ai-api-key-test-value-1234';
    const customSmtpPass = 'secret-smtp-password-test-value-5678';
    const server = await startServer({
      AI_API_KEY: customAiKey,
      SMTP_PASS: customSmtpPass,
    });
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      const res = await get(server.port, '/admin', { Cookie: cookie });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      assert.match(res.headers.get('cache-control') || '', /no-store/i);

      const html = await res.text();
      assert.match(html, /noindex/);
      assert.match(html, /<h1>Admin settings<\/h1>/);
      assert.match(html, /<form[^>]+action=["']\/api\/admin\/settings["']/i);
      assert.match(html, /<form[^>]+action=["']\/api\/admin\/logout["']/i);

      // Masked placeholders present
      assert.ok(html.includes('••••1234'), 'must contain masked AI key placeholder');
      assert.ok(html.includes('••••5678'), 'must contain masked SMTP pass placeholder');

      // No full secrets
      assert.ok(!html.includes(customAiKey), 'must not contain full AI key');
      assert.ok(!html.includes(customSmtpPass), 'must not contain full SMTP pass');
      assert.ok(!html.includes(server.password), 'must not contain admin password');
      assert.ok(!html.includes(server.passwordHash), 'must not contain admin password hash');
      assert.ok(!html.includes(server.encryptionKey), 'must not contain encryption key');

      // No v1: envelope
      assert.ok(!html.includes('v1:'), 'must not contain v1: envelope');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 1-2 & Invariant Verification
  test('11. Every 401 response body (HTML and JSON) contains no setting value and no secret', async () => {
    const aiKey = 'super-secret-ai-token-probe-777';
    const smtpPass = 'super-secret-smtp-pass-probe-888';
    const server = await startServer({
      AI_API_KEY: aiKey,
      SMTP_PASS: smtpPass,
    });
    try {
      const forbiddenTokens = [
        server.password,
        server.passwordHash,
        server.encryptionKey,
        aiKey,
        smtpPass,
        'v1:',
        '••••',
        'anthropic/claude-haiku-5.5',
        'openrouter.ai',
        ...SETTINGS_FIELDS_NAMES,
      ];

      const responses = await Promise.all([
        get(server.port, '/admin'),
        get(server.port, '/admin/unauthorized-catchall'),
        postForm(server.port, '/api/admin/settings', { aiModel: 'test' }),
        postForm(server.port, '/api/admin/logout', {}),
        get(server.port, '/api/admin/settings'),
        get(server.port, '/api/admin/unauthorized-catchall'),
        jsonLogin(server.port, 'wrong-password'),
        get(server.port, '/admin', { Cookie: `admin_session=${'c'.repeat(64)}` }),
      ]);

      for (let i = 0; i < responses.length; i++) {
        const res = responses[i];
        assert.equal(res.status, 401, `response ${i} must have status 401`);
        const text = await res.text();

        for (const token of forbiddenTokens) {
          assert.ok(
            !text.includes(token),
            `401 response ${i} leaked token "${token}":\n${text}`
          );
        }

        assert.ok(
          !/[0-9a-fA-F]{64}/.test(text),
          `401 response ${i} leaked session id:\n${text}`
        );
      }
    } finally {
      await stopServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration Test Suite: Rows 9-16, 20 of Admin Matrix (Settings & Encryption)
// ---------------------------------------------------------------------------

describe('Admin API Integration Tests (Settings & Encryption Matrix - Rows 9-16, 20)', () => {
  // Matrix Row 9 (Form save redirect)
  test('12. Valid form save (login first, valid Origin) -> 303 Location: /admin?saved=1', async () => {
    const server = await startServer();
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie, 'login must produce cookie');

      const res = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
          aiModel: 'model-x',
          aiApiKey: 'test-api-key-7890',
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );

      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/admin?saved=1');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 9 & 20 (Authenticated GET /admin after save)
  test('13. Authenticated GET /admin afterwards -> 200; page shows ••••7890; full key never appears; noindex; Using: admin hint; no v1: envelope', async () => {
    const server = await startServer();
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      const secretKey = 'test-api-key-7890';
      const saveRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
          aiModel: 'model-x',
          aiApiKey: secretKey,
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );
      assert.equal(saveRes.status, 303);

      const res = await get(server.port, '/admin', { Cookie: cookie });
      assert.equal(res.status, 200);

      const html = await res.text();
      assert.ok(html.includes('••••7890'), 'page must display masked key placeholder ••••7890');
      assert.ok(!html.includes(secretKey), 'full API key must never appear in HTML');
      assert.match(html, /noindex/, 'page must contain noindex');
      assert.ok(html.includes('Using: admin'), 'page must contain "Using: admin" hint for overridden fields');
      assert.ok(!html.includes('v1:'), 'v1: envelope must not appear in HTML');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 14 (Encrypted at rest: raw DB envelope and file bytes check)
  test('14. Raw DB: settings has ai.apiKey and smtp.pass matching /^v1:/; plaintext absent in SQLite file bytes while v1: present', async () => {
    const server = await startServer();
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      const aiSecret = 'test-api-key-7890';
      const smtpSecret = 'test-smtp-pass-5432';

      // 1. Save AI key
      const saveAiRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
          aiModel: 'model-x',
          aiApiKey: aiSecret,
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );
      assert.equal(saveAiRes.status, 303);

      // 2. Later save SMTP pass
      const saveSmtpRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          smtpPass: smtpSecret,
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );
      assert.equal(saveSmtpRes.status, 303);

      // 3. Inspect raw DB via DatabaseSync
      const dbPath = path.join(server.dataDir, 'site.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        const aiRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.apiKey');
        assert.ok(aiRow, 'ai.apiKey row must exist');
        assert.match(aiRow.value, /^v1:/, 'ai.apiKey row must match /^v1:/');

        const smtpRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp.pass');
        assert.ok(smtpRow, 'smtp.pass row must exist');
        assert.match(smtpRow.value, /^v1:/, 'smtp.pass row must match /^v1:/');
      } finally {
        db.close();
      }

      // 4. Read raw SQLite file bytes
      const fileBytes = readFileSync(dbPath);
      assert.ok(!fileBytes.includes(Buffer.from(aiSecret)), 'test-api-key-7890 must not appear in SQLite file bytes');
      assert.ok(!fileBytes.includes(Buffer.from(smtpSecret)), 'smtp pass must not appear in SQLite file bytes');
      assert.ok(fileBytes.includes(Buffer.from('v1:')), 'v1: envelope must appear in SQLite file bytes');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 10 (Blank secret keeps stored envelope byte-identical)
  test('15. Blank secret keeps the envelope byte-identical: read ai.apiKey raw, submit form with aiApiKey="" and changed aiModel -> 303; ai.apiKey identical; ai.model changed', async () => {
    const server = await startServer();
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      // Initial save
      const initialRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiModel: 'model-original',
          aiApiKey: 'initial-api-secret-key-1234',
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );
      assert.equal(initialRes.status, 303);

      const dbPath = path.join(server.dataDir, 'site.sqlite');
      let db = new DatabaseSync(dbPath);
      let initialKeyRow;
      try {
        initialKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.apiKey');
        assert.ok(initialKeyRow, 'ai.apiKey row must exist');
        assert.match(initialKeyRow.value, /^v1:/);
      } finally {
        db.close();
      }

      const initialEnvelope = initialKeyRow.value;

      // Submit form with aiApiKey='' and changed aiModel
      const updateRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiModel: 'model-updated',
          aiApiKey: '',
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );
      assert.equal(updateRes.status, 303);

      db = new DatabaseSync(dbPath);
      try {
        const updatedKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.apiKey');
        const updatedModelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.model');
        assert.ok(updatedKeyRow, 'ai.apiKey row must still exist');
        assert.equal(updatedKeyRow.value, initialEnvelope, 'ai.apiKey value must be exactly the same string');
        assert.ok(updatedModelRow, 'ai.model row must exist');
        assert.equal(updatedModelRow.value, 'model-updated', 'ai.model must be updated');
      } finally {
        db.close();
      }
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 11 & 12 (Invalid fields validation and transaction rollback)
  test('16. Invalid fields (one form POST with aiBaseUrl=http://example.com, askDailyCap=0, smtpPort=70000, smtpFrom=not-an-address) -> 400 with error texts and no DB writes', async () => {
    const server = await startServer();
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      const dbPath = path.join(server.dataDir, 'site.sqlite');
      let db = new DatabaseSync(dbPath);
      const rowsBefore = db.prepare('SELECT * FROM settings').all();
      db.close();

      const res = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiBaseUrl: 'http://example.com',
          askDailyCap: '0',
          smtpPort: '70000',
          smtpFrom: 'not-an-address',
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );

      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /text\/html/);

      const html = await res.text();
      assert.ok(html.includes('Enter an HTTPS base URL'), 'must contain HTTPS base URL error text');
      assert.ok(html.includes('Daily cap must be'), 'must contain Daily cap error text');
      assert.ok(html.includes('Port must be'), 'must contain Port error text');
      assert.ok(html.includes('Enter a valid from address'), 'must contain from address error text');

      db = new DatabaseSync(dbPath);
      try {
        const rowsAfter = db.prepare('SELECT * FROM settings').all();
        assert.deepEqual(rowsAfter, rowsBefore, 'DB rows must remain unchanged (nothing written)');
      } finally {
        db.close();
      }
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 9 (JSON save and masked response)
  test('17. JSON save with Accept: application/json and valid body -> 200 {ok:true,settings:...} with apiKeyMasked and no full secret', async () => {
    const server = await startServer();
    try {
      const loginRes = await jsonLogin(server.port, server.password);
      assert.equal(loginRes.status, 200);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      const secretKey = 'test-json-api-secret-key-4321';
      const res = await postJson(
        server.port,
        '/api/admin/settings',
        {
          aiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
          aiModel: 'model-json-x',
          aiApiKey: secretKey,
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/json/);

      const body = await res.json();
      assert.equal(body?.ok, true);
      assert.ok(body?.settings && typeof body.settings === 'object', 'response must have settings object');
      assert.equal(body.settings.apiKeyMasked, '••••4321', 'apiKeyMasked must be mask only');

      const rawJson = JSON.stringify(body);
      assert.ok(!rawJson.includes(secretKey), 'full secret must not appear in JSON response');
      assert.ok(!rawJson.includes('v1:'), 'v1: envelope must not appear in JSON response');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 13 (Cross-origin POST blocked)
  test('18. Cross-origin POST (valid session, Origin: http://evil.example) -> 403; no write (settings row unchanged)', async () => {
    const server = await startServer();
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      // Pre-seed a known row to verify unchanged
      const setupRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiModel: 'safe-model-value',
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );
      assert.equal(setupRes.status, 303);

      const dbPath = path.join(server.dataDir, 'site.sqlite');
      let db = new DatabaseSync(dbPath);
      const rowsBefore = db.prepare('SELECT * FROM settings ORDER BY key ASC').all();
      db.close();

      // Attempt cross-origin form POST
      const evilRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiModel: 'evil-compromised-model',
        },
        {
          Cookie: cookie,
          Origin: 'http://evil.example',
        }
      );
      assert.equal(evilRes.status, 403);

      db = new DatabaseSync(dbPath);
      try {
        const rowsAfter = db.prepare('SELECT * FROM settings ORDER BY key ASC').all();
        assert.deepEqual(rowsAfter, rowsBefore, 'settings rows must remain unchanged');
        const modelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.model');
        assert.equal(modelRow?.value, 'safe-model-value');
      } finally {
        db.close();
      }
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 15 (Missing ENCRYPTION_KEY fails closed on save)
  test('19. Missing ENCRYPTION_KEY: login works, save aiApiKey -> 400 with errors.aiApiKey === "Secret storage is unavailable.", no ai.apiKey row, plaintext not in DB bytes', async () => {
    const server = await startServer({ ENCRYPTION_KEY: '' }, { encryptionKey: '' });
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303, 'login must still work with empty ENCRYPTION_KEY');
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      const probeSecret = 'no-key-secret-1234';
      const res = await postJson(
        server.port,
        '/api/admin/settings',
        {
          aiApiKey: probeSecret,
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body?.ok, false);
      assert.equal(body?.error, 'validation');
      assert.equal(body?.errors?.aiApiKey, 'Secret storage is unavailable.');

      const dbPath = path.join(server.dataDir, 'site.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare('SELECT * FROM settings WHERE key = ?').get('ai.apiKey');
        assert.equal(row, undefined, 'no ai.apiKey row should be written');
      } finally {
        db.close();
      }

      const fileBytes = readFileSync(dbPath);
      assert.ok(!fileBytes.includes(Buffer.from(probeSecret)), 'plaintext must not be in SQLite file bytes');
    } finally {
      await stopServer(server);
    }
  });

  // Matrix Row 17 & Masking (Save all SMTP fields in one valid form request)
  test('20. Save smtpHost/smtpPort/smtpSecure/smtpUser/smtpPass/smtpFrom in one valid form request -> 303; raw rows exist with smtp.pass a v1: envelope; page shows smtp pass mask only', async () => {
    const server = await startServer();
    try {
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie);

      const smtpSecretPass = 'smtp-secret-password-5678';
      const res = await postForm(
        server.port,
        '/api/admin/settings',
        {
          smtpHost: 'smtp.mailgun.org',
          smtpPort: '587',
          smtpSecure: 'on',
          smtpUser: 'postmaster@example.com',
          smtpPass: smtpSecretPass,
          smtpFrom: 'Emad Poursina <emad.poursina.work@gmail.com>',
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );

      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/admin?saved=1');

      const dbPath = path.join(server.dataDir, 'site.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        const hostRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp.host');
        const portRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp.port');
        const secureRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp.secure');
        const userRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp.user');
        const fromRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp.from');
        const passRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp.pass');

        assert.equal(hostRow?.value, 'smtp.mailgun.org');
        assert.equal(portRow?.value, '587');
        assert.equal(secureRow?.value, 'true');
        assert.equal(userRow?.value, 'postmaster@example.com');
        assert.equal(fromRow?.value, 'Emad Poursina <emad.poursina.work@gmail.com>');
        assert.ok(passRow, 'smtp.pass row must exist');
        assert.match(passRow.value, /^v1:/, 'smtp.pass must be a v1: envelope');
      } finally {
        db.close();
      }

      // Authenticated GET /admin shows mask only
      const pageRes = await get(server.port, '/admin', { Cookie: cookie });
      assert.equal(pageRes.status, 200);

      const html = await pageRes.text();
      assert.ok(html.includes('••••5678'), 'page must display smtp pass mask ••••5678');
      assert.ok(!html.includes(smtpSecretPass), 'page must never contain full SMTP pass');
      assert.ok(!html.includes('v1:'), 'page must not contain v1: envelope');
    } finally {
      await stopServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration Test Suite: Model Switch Proof (T032)
// ---------------------------------------------------------------------------

describe('Admin API Integration Tests (Model Switch Proof - T032)', () => {
  test('21. Admin save changes AI base URL and model for next ask with no server restart', async () => {
    const portA = await getFreePort();
    const portB = await getFreePort();
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'admin-model-switch-'));
    const logA = path.join(tmpDir, 'stub-a.jsonl');
    const logB = path.join(tmpDir, 'stub-b.jsonl');

    let stubA = null;
    let stubB = null;
    let server = null;

    try {
      // 1. Allocate two ports; spawn stub A: node scripts/ai-stub.mjs --port <portA> --log <tmp>/stub-a.jsonl;
      //    spawn stub B with a separate log; wait for both TCP ports.
      stubA = spawn(
        process.execPath,
        [STUB_SCRIPT, '--port', String(portA), '--log', logA],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      stubA.stdout?.resume();
      stubA.stderr?.resume();

      stubB = spawn(
        process.execPath,
        [STUB_SCRIPT, '--port', String(portB), '--log', logB],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      stubB.stdout?.resume();
      stubB.stderr?.resume();

      await Promise.all([waitForPort(portA), waitForPort(portB)]);

      // 2. Start the server with AI_BASE_URL=http://127.0.0.1:<portA>/v1, AI_MODEL=model-a,
      //    AI_API_KEY=local-test-key, plus the usual admin hash/key.
      server = await startServer({
        AI_BASE_URL: `http://127.0.0.1:${portA}/v1`,
        AI_MODEL: 'model-a',
        AI_API_KEY: 'local-test-key',
      });
      const initialPid = server.child.pid;
      assert.ok(initialPid, 'server process must have a PID');
      assert.equal(server.child.exitCode, null, 'server process must be running');

      // 3. POST /api/ask JSON {"question":"What backend stack does Emad use?"} -> 200;
      //    json.model === 'model-a'; stub A's log has exactly one record and its model is 'model-a'.
      const askRes1 = await postJson(server.port, '/api/ask', {
        question: 'What backend stack does Emad use?',
      });
      assert.equal(askRes1.status, 200);
      const askJson1 = await askRes1.json();
      assert.equal(askJson1.ok, true);
      assert.equal(askJson1.model, 'model-a');

      assert.ok(existsSync(logA), 'stub A log must exist');
      const logALines1 = readFileSync(logA, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      assert.equal(logALines1.length, 1, 'stub A log must have exactly 1 record');
      const logARecord1 = JSON.parse(logALines1[0]);
      assert.equal(logARecord1.model, 'model-a');

      // 4. Log in via the form (matching Origin) and capture the session cookie.
      const loginRes = await formLogin(server.port, server.password);
      assert.equal(loginRes.status, 303);
      const cookie = cookieFrom(loginRes);
      assert.ok(cookie, 'must obtain session cookie');

      // 5. POST /api/admin/settings form with the cookie + matching Origin:
      //    aiBaseUrl=http://127.0.0.1:<portB>/v1&aiModel=model-b&aiApiKey= (blank key keeps the env key) -> 303 Location: /admin?saved=1.
      const saveRes = await postForm(
        server.port,
        '/api/admin/settings',
        {
          aiBaseUrl: `http://127.0.0.1:${portB}/v1`,
          aiModel: 'model-b',
          aiApiKey: '',
        },
        {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${server.port}`,
        }
      );
      assert.equal(saveRes.status, 303);
      assert.equal(saveRes.headers.get('location'), '/admin?saved=1');

      // 6. POST /api/ask again -> 200; json.model === 'model-b';
      //    stub B's log has exactly one record with model === 'model-b'; stub A's log line count is unchanged.
      const askRes2 = await postJson(server.port, '/api/ask', {
        question: 'What backend stack does Emad use?',
      });
      assert.equal(askRes2.status, 200);
      const askJson2 = await askRes2.json();
      assert.equal(askJson2.ok, true);
      assert.equal(askJson2.model, 'model-b');

      assert.ok(existsSync(logB), 'stub B log must exist');
      const logBLines = readFileSync(logB, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      assert.equal(logBLines.length, 1, 'stub B log must have exactly 1 record');
      const logBRecord = JSON.parse(logBLines[0]);
      assert.equal(logBRecord.model, 'model-b');

      const logALines2 = readFileSync(logA, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      assert.equal(logALines2.length, 1, 'stub A log line count must be unchanged');

      // 7. The same server process must serve both asks (no restart between steps 3 and 6).
      assert.equal(server.child.pid, initialPid, 'server process PID must remain identical');
      assert.equal(server.child.exitCode, null, 'server process must not have exited or restarted');
    } finally {
      // Kill both stub processes and the server in finally
      await Promise.allSettled([
        stopChild(stubA),
        stopChild(stubB),
        stopServer(server),
      ]);
      cleanDataDir(tmpDir);
    }
  });
});

