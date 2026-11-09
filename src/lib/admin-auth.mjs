/**
 * src/lib/admin-auth.mjs
 *
 * Admin authentication primitives for Phase 3 US3.
 * - Password verification using scrypt with timing-safe comparison.
 * - Session creation, retrieval, and destruction via SQLite.
 * - Cookie building and clearing for admin sessions.
 * - Same-origin request validation.
 * - In-memory per-IP login failure tracking and lockout.
 */

import crypto from 'node:crypto';
import util from 'node:util';
import { getConfig } from './env.mjs';

const scryptAsync = util.promisify(crypto.scrypt);

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_TTL_SECONDS = 28800; // 8 hours
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MAX_FAILURES = 5;

// Module-level state for warnings and login failures
let _hashWarned = false;

/** @type {Map<string, { failures: number[]; blockedUntil: number | null }>} */
const _loginFailures = new Map();

/**
 * Emits a console.warn at most once per process for missing/malformed hash.
 * Never includes hash or password in the message.
 */
function warnInvalidHash() {
  if (!_hashWarned) {
    _hashWarned = true;
    console.warn('[admin-auth] Admin password hash is invalid, malformed, or missing.');
  }
}

/**
 * Validates whether a string is strictly canonical base64.
 * @param {unknown} str
 * @returns {boolean}
 */
function isStrictBase64(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str)) {
    return false;
  }
  try {
    return Buffer.from(str, 'base64').toString('base64') === str;
  } catch {
    return false;
  }
}

/**
 * Reads a header value from a Request or mock object.
 * @param {any} request
 * @param {string} name
 * @returns {string | null}
 */
function getHeader(request, name) {
  if (!request?.headers) return null;
  if (typeof request.headers.get === 'function') {
    return request.headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(request.headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

/**
 * Parses the Cookie header and returns key-value pairs.
 * @param {string | null} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return {};
  const cookies = {};
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    cookies[key] = val;
  }
  return cookies;
}

/**
 * Verifies a password against a stored scrypt hash string.
 * Format: scrypt$N$r$p$salt-b64$hash-b64
 *
 * @param {string} password
 * @param {string} storedHash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string') {
    return false;
  }

  if (typeof storedHash !== 'string' || !storedHash) {
    warnInvalidHash();
    return false;
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    warnInvalidHash();
    return false;
  }

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;

  // N: integer, power of two, >= 2, <= 2^20 (1048576)
  if (!/^[1-9]\d*$/.test(nStr)) {
    warnInvalidHash();
    return false;
  }
  const N = Number(nStr);
  if (!Number.isSafeInteger(N) || N < 2 || N > 1048576 || (N & (N - 1)) !== 0) {
    warnInvalidHash();
    return false;
  }

  // r: integer, 1 to 16
  if (!/^[1-9]\d*$/.test(rStr)) {
    warnInvalidHash();
    return false;
  }
  const r = Number(rStr);
  if (!Number.isSafeInteger(r) || r < 1 || r > 16) {
    warnInvalidHash();
    return false;
  }

  // p: integer, 1 to 16
  if (!/^[1-9]\d*$/.test(pStr)) {
    warnInvalidHash();
    return false;
  }
  const p = Number(pStr);
  if (!Number.isSafeInteger(p) || p < 1 || p > 16) {
    warnInvalidHash();
    return false;
  }

  // salt and hash: strict base64
  if (!isStrictBase64(saltB64) || !isStrictBase64(hashB64)) {
    warnInvalidHash();
    return false;
  }

  const saltBuf = Buffer.from(saltB64, 'base64');
  const hashBuf = Buffer.from(hashB64, 'base64');

  if (saltBuf.length === 0 || hashBuf.length === 0) {
    warnInvalidHash();
    return false;
  }

  try {
    const derivedKey = await scryptAsync(password, saltBuf, hashBuf.length, {
      N,
      r,
      p,
      maxmem: Math.max(32 * 1024 * 1024, 128 * N * r * 2),
    });

    if (derivedKey.length !== hashBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(derivedKey, hashBuf);
  } catch {
    warnInvalidHash();
    return false;
  }
}

/**
 * Creates an admin session, storing it in SQLite and returning its details.
 *
 * @param {{ createSession: (id: string, expiresAt: string) => void }} database
 * @param {{ now?: number | (() => number) }} [options]
 * @returns {{ id: string; expiresAt: string }}
 */
export function createSession(database, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();
  database.createSession(id, expiresAt);
  return { id, expiresAt };
}

/**
 * Retrieves an active admin session from a request's Cookie header.
 * Deletes the session if expired.
 *
 * @param {any} request
 * @param {{ getSession: (id: string) => { id: string; created_at: string; expires_at: string } | null; deleteSession: (id: string) => void }} database
 * @param {{ now?: number | (() => number) }} [options]
 * @returns {{ id: string; created_at: string; expires_at: string } | null}
 */
export function getSessionFromRequest(request, database, { now = Date.now } = {}) {
  const cookieHeader = getHeader(request, 'cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookies = parseCookies(cookieHeader);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId || typeof sessionId !== 'string') {
    return null;
  }

  // 32 random bytes hex (64 chars)
  if (!/^[0-9a-fA-F]{64}$/.test(sessionId)) {
    return null;
  }

  const row = database.getSession(sessionId);
  if (!row) {
    return null;
  }

  const nowMs = typeof now === 'function' ? now() : now;
  const expiresAtMs = Date.parse(row.expires_at);

  if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
    database.deleteSession(sessionId);
    return null;
  }

  return row;
}

/**
 * Destroys an admin session by deleting it from the database.
 *
 * @param {{ deleteSession: (id: string) => void }} database
 * @param {string} id
 */
export function destroySession(database, id) {
  return database.deleteSession(id);
}

/**
 * Determines whether a request is considered secure (HTTPS).
 *
 * @param {any} request
 * @returns {boolean}
 */
export function isSecureRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.protocol === 'https:') {
      return true;
    }
  } catch {
    // Malformed request URL
  }

  try {
    const conf = getConfig();
    if (conf?.TRUST_PROXY === 1) {
      const xfp = getHeader(request, 'x-forwarded-proto');
      if (xfp && typeof xfp === 'string') {
        const first = xfp.split(',')[0].trim().toLowerCase();
        if (first === 'https') {
          return true;
        }
      }
    }
  } catch {
    // Config read error
  }

  return false;
}

/**
 * Builds the Set-Cookie string for an admin session.
 *
 * @param {string} id
 * @param {{ secure?: boolean }} [options]
 * @returns {string}
 */
export function buildSessionCookie(id, { secure = false } = {}) {
  let cookie = `admin_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
  if (secure) {
    cookie += '; Secure';
  }
  return cookie;
}

/**
 * Builds the Set-Cookie string to clear an admin session.
 *
 * @param {{ secure?: boolean }} [options]
 * @returns {string}
 */
export function clearSessionCookie({ secure = false } = {}) {
  let cookie = 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  if (secure) {
    cookie += '; Secure';
  }
  return cookie;
}

/**
 * Validates that the request is same-origin.
 *
 * @param {any} request
 * @returns {boolean}
 */
export function isSameOrigin(request) {
  let targetOrigin;
  try {
    targetOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }

  const originHeader = getHeader(request, 'origin');
  if (originHeader !== null && originHeader !== undefined) {
    try {
      const originUrl = new URL(originHeader);
      return originUrl.origin === targetOrigin;
    } catch {
      return false;
    }
  }

  const refererHeader = getHeader(request, 'referer');
  if (refererHeader !== null && refererHeader !== undefined) {
    try {
      const refererUrl = new URL(refererHeader);
      return refererUrl.origin === targetOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Returns the lockout status for an IP address.
 *
 * @param {string} ip
 * @param {{ now?: number | (() => number) }} [options]
 * @returns {{ blocked: boolean; retryAfterSeconds: number }}
 */
export function getLockout(ip, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const entry = _loginFailures.get(ip);
  if (!entry) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  if (entry.blockedUntil !== null && entry.blockedUntil > nowMs) {
    const remainingMs = entry.blockedUntil - nowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return { blocked: true, retryAfterSeconds };
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

/**
 * Records a failed login attempt for an IP.
 *
 * @param {string} ip
 * @param {{ now?: number | (() => number) }} [options]
 * @returns {{ blocked: boolean; retryAfterSeconds: number }}
 */
export function recordLoginFailure(ip, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  let entry = _loginFailures.get(ip);

  // While blocked, recording is a no-op and the call returns the blocked state.
  if (entry && entry.blockedUntil !== null && entry.blockedUntil > nowMs) {
    return getLockout(ip, { now: nowMs });
  }

  const cutoff = nowMs - LOCKOUT_WINDOW_MS;
  const failures = (entry ? entry.failures : []).filter((t) => t > cutoff);
  failures.push(nowMs);

  let blockedUntil = null;
  if (failures.length >= LOCKOUT_MAX_FAILURES) {
    blockedUntil = nowMs + LOCKOUT_WINDOW_MS;
  }

  _loginFailures.set(ip, { failures, blockedUntil });
  return getLockout(ip, { now: nowMs });
}

/**
 * Clears the login failure record for an IP address.
 *
 * @param {string} ip
 */
export function clearLoginFailures(ip) {
  _loginFailures.delete(ip);
}

/**
 * Resets the entire login failure map. Intended for tests only.
 */
export function resetLoginFailures() {
  _loginFailures.clear();
}
