/**
 * src/lib/env.mjs
 *
 * Parses and caches configuration from process.env on first use.
 * Exports smtpStatus(), clientKey(request), and reset() for tests.
 * Logs exactly one warning per disabled feature; never logs secret values.
 */

/** @type {Record<string, unknown> | null} */
let _config = null;

/** Set of features whose "disabled" warning has already been emitted. */
const _warned = new Set();

/**
 * Emits a console.warn once per feature key.
 * @param {string} key
 * @param {string} message
 */
function warnOnce(key, message) {
  if (!_warned.has(key)) {
    _warned.add(key);
    console.warn(`[env] ${message}`);
  }
}

/**
 * Returns the parsed, cached configuration object.
 * @returns {Record<string, unknown>}
 */
function config() {
  if (_config !== null) return _config;

  const smtpHost = process.env.SMTP_HOST ?? '';
  const smtpUser = process.env.SMTP_USER ?? '';
  const smtpPass = process.env.SMTP_PASS ?? '';

  _config = {
    PORT:                        parseInt(process.env.PORT ?? '4321', 10),
    HOST:                        process.env.HOST ?? '0.0.0.0',
    DATA_DIR:                    process.env.DATA_DIR ?? './data',
    CONTACT_TO:                  process.env.CONTACT_TO ?? 'emad.poursina.work@gmail.com',
    CONTACT_RATE_LIMIT_PER_HOUR: parseInt(process.env.CONTACT_RATE_LIMIT_PER_HOUR ?? '5', 10),
    TRUST_PROXY:                 (process.env.TRUST_PROXY ?? '0') === '1' ? 1 : 0,
    SMTP_HOST:                   smtpHost,
    SMTP_PORT:                   parseInt(process.env.SMTP_PORT ?? '587', 10),
    SMTP_SECURE:                 (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    SMTP_USER:                   smtpUser,
    SMTP_PASS:                   smtpPass,
    SMTP_FROM:                   process.env.SMTP_FROM ?? 'Emad Poursina <emad.poursina.work@gmail.com>',
  };

  // Warn once when SMTP is not fully configured
  if (!smtpHost || !smtpUser || !smtpPass) {
    warnOnce('smtp', 'Contact email delivery is disabled (SMTP_HOST, SMTP_USER, SMTP_PASS required).');
  }

  return _config;
}

/**
 * Returns 'configured' when SMTP_HOST, SMTP_USER, and SMTP_PASS are all non-empty;
 * otherwise 'disabled'.
 * @returns {'configured' | 'disabled'}
 */
export function smtpStatus() {
  const c = config();
  if (c.SMTP_HOST && c.SMTP_USER && c.SMTP_PASS) return 'configured';
  return 'disabled';
}

/**
 * Returns the client key (IP) for rate-limiting.
 * Uses the socket remote address unless TRUST_PROXY=1, in which case
 * the first X-Forwarded-For entry is used (and only then).
 *
 * @param {Request} request - The incoming Request object.
 * @returns {string}
 */
export function clientKey(request) {
  const c = config();
  if (c.TRUST_PROXY === 1) {
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }

  // Fall back to the socket address stored by the adapter.
  // Astro's Node adapter exposes it via Astro.clientAddress; in lib code
  // we extract it from the forwarded header only when trusted, otherwise
  // we use whatever the adapter passed. For pure unit tests, callers may
  // pass a request with a custom header; return 'unknown' as a safe default
  // when nothing else is available.
  const socketAddr = /** @type {any} */ (request).socket?.remoteAddress
    ?? /** @type {any} */ (request).connection?.remoteAddress
    ?? 'unknown';

  return socketAddr;
}

/**
 * Returns the DATA_DIR path.
 * @returns {string}
 */
export function dataDir() {
  return /** @type {string} */ (config().DATA_DIR);
}

/**
 * Returns the full config object (for modules that need multiple fields).
 * @returns {Record<string, unknown>}
 */
export function getConfig() {
  return config();
}

/**
 * Resets the cached configuration.
 * Intended for use in tests only — allows overriding process.env between cases.
 */
export function reset() {
  _config = null;
  _warned.clear();
}
