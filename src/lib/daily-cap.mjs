/**
 * src/lib/daily-cap.mjs
 *
 * Shared daily-cap wrapper for rate limiting and cap event tracking.
 * - utcDayKey: formats UTC day string 'YYYY-MM-DD'.
 * - consumeDaily: delegates counting to db.consumeDailyAsk, records cap events
 *   once per (day, feature), and logs console.warn with no IP or request content.
 */

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

/**
 * Valid features supported by daily cap tracking.
 */
const VALID_FEATURES = new Set(['ask', 'cover_letter']);

/**
 * Delegates atomic daily counter consumption to db.consumeDailyAsk and records
 * a cap event once per (day, feature) when the cap is reached.
 *
 * @param {object} db - Database module or stub providing consumeDailyAsk, getCapEvent, insertCapEvent
 * @param {string} day - UTC date key `YYYY-MM-DD`
 * @param {number} cap - Daily maximum allowed
 * @param {'ask' | 'cover_letter'} feature - Feature reaching or checking the cap
 * @returns {{ count: number; allowed: boolean }}
 */
export function consumeDaily(db, day, cap, feature) {
  if (!VALID_FEATURES.has(feature)) {
    throw new TypeError('feature must be "ask" or "cover_letter"');
  }

  const result = db.consumeDailyAsk(day, cap);

  if (!result.allowed) {
    try {
      const existing = db.getCapEvent(day, feature);
      if (existing === null || existing === undefined) {
        db.insertCapEvent(day, feature);
        console.warn(JSON.stringify({ event: 'daily_cap', day, feature }));
      }
    } catch {
      console.warn(`[daily-cap] Failed to record cap event for ${feature} on ${day}`);
    }
  }

  return result;
}
