/**
 * src/lib/cover-letter-limits.mjs
 *
 * Rate limiting and daily cap enforcement for the cover letter generator.
 * - Sliding-window per-IP limiter using createRateLimiter.
 * - Atomic daily cap delegation to shared daily-cap module.
 * - Privacy-preserving event logging (no IP or job description in logs).
 */

import { createRateLimiter } from './rate-limit.mjs';
import { consumeDaily as consumeSharedDaily } from './daily-cap.mjs';

/**
 * Default requests allowed per IP per 1-hour sliding window.
 */
export const DEFAULT_COVER_LETTER_RATE_LIMIT = 10;

const limiter = createRateLimiter({
  windowMs: 3_600_000,
  limit: DEFAULT_COVER_LETTER_RATE_LIMIT,
});

/**
 * Checks sliding-window per-IP rate limit for the given key.
 * Logs a warning event without IP or request content if blocked.
 *
 * @param {string} key - Client identifier (typically IP).
 * @returns {{ allowed: boolean; retryAfterSeconds: number }}
 */
export function checkPerIp(key) {
  const result = limiter.check(key);
  if (!result.allowed) {
    console.warn(JSON.stringify({ event: 'cover_letter_rate_limited' }));
  }
  return result;
}

/**
 * Delegates atomic daily counter consumption to consumeSharedDaily for the 'cover_letter' feature.
 *
 * @param {object} db - Database module or stub providing consumeDailyAsk, getCapEvent, insertCapEvent.
 * @param {string} day - UTC date key `YYYY-MM-DD`.
 * @param {number} cap - Daily maximum allowed requests.
 * @returns {{ count: number; allowed: boolean }}
 */
export function consumeDaily(db, day, cap) {
  return consumeSharedDaily(db, day, cap, 'cover_letter');
}
