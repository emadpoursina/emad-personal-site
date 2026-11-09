/**
 * src/lib/ask-limits.mjs
 *
 * Rate limiting and daily cap enforcement for the ask assistant.
 * - Sliding-window per-IP limiter using createRateLimiter.
 * - Atomic daily cap delegation to db.consumeDailyAsk.
 * - Privacy-preserving event logging (no IP or question text in logs).
 */

import { createRateLimiter } from './rate-limit.mjs';

/**
 * Default requests allowed per IP per 1-hour sliding window.
 */
export const DEFAULT_ASK_RATE_LIMIT = 10;

/**
 * Normalizes a limit value to a positive integer >= 1, falling back to DEFAULT_ASK_RATE_LIMIT.
 *
 * @param {unknown} limit
 * @returns {number}
 */
function normalizeLimit(limit) {
  if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1) {
    return limit;
  }
  return DEFAULT_ASK_RATE_LIMIT;
}

/**
 * Returns the UTC date key `YYYY-MM-DD` for a given timestamp or date.
 *
 * @param {Date | string | number} [now=new Date()]
 * @returns {string} UTC date key `YYYY-MM-DD`
 */
export function utcDayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString().slice(0, 10);
}

/** @type {ReturnType<typeof createRateLimiter> | null} */
let currentLimiter = null;

/** @type {number | null} */
let currentBuiltLimit = null;

/**
 * Checks sliding-window per-IP rate limit for the given key.
 * Recreates the rate limiter instance when the effective limit changes.
 *
 * @param {string} key
 * @param {number} [limit]
 * @returns {{ allowed: boolean; retryAfterSeconds: number }}
 */
export function checkPerIp(key, limit) {
  const effectiveLimit = normalizeLimit(limit);

  if (!currentLimiter || currentBuiltLimit !== effectiveLimit) {
    currentLimiter = createRateLimiter({ windowMs: 3_600_000, limit: effectiveLimit });
    currentBuiltLimit = effectiveLimit;
  }

  const result = currentLimiter.check(key);
  if (!result.allowed) {
    console.warn(JSON.stringify({ event: 'ask_rate_limited', day: utcDayKey(new Date()) }));
  }
  return result;
}

/**
 * Delegates atomic daily counter consumption to db.consumeDailyAsk and logs when the cap is reached.
 *
 * @param {object} db - Database module or stub providing consumeDailyAsk(day, cap)
 * @param {string} day - UTC date key `YYYY-MM-DD`
 * @param {number} cap - Daily maximum allowed
 * @returns {{ count: number; allowed: boolean }}
 */
export function consumeDaily(db, day, cap) {
  const result = db.consumeDailyAsk(day, cap);
  if (result.allowed === false) {
    console.warn(JSON.stringify({ event: 'ask_daily_cap', day }));
  }
  return result;
}
