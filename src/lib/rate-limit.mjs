/**
 * src/lib/rate-limit.mjs
 *
 * Sliding-window rate limiter.
 * - Window: 3600 s (configurable via factory).
 * - Map<string, number[]> tracking timestamp arrays per client key.
 * - check(key) records the attempt and returns {allowed, retryAfterSeconds}.
 * - Every attempt counts (including rejected ones).
 * - Timestamps are pruned on access.
 */

/**
 * Creates a rate-limiter instance.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs]  - Window size in milliseconds (default: 3_600_000).
 * @param {number} [options.limit]     - Max requests per window (default: 5).
 * @returns {{ check: (key: string) => { allowed: boolean; retryAfterSeconds: number } }}
 */
export function createRateLimiter({ windowMs = 3_600_000, limit = 5 } = {}) {
  /** @type {Map<string, number[]>} */
  const store = new Map();

  /**
   * Records an attempt for key and returns whether it is allowed.
   *
   * @param {string} key
   * @returns {{ allowed: boolean; retryAfterSeconds: number }}
   */
  function check(key) {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Retrieve and prune old timestamps
    const timestamps = (store.get(key) ?? []).filter((t) => t > cutoff);

    // Record this attempt before deciding (every attempt counts)
    timestamps.push(now);
    store.set(key, timestamps);

    if (timestamps.length <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // Not allowed: compute retryAfterSeconds from the oldest timestamp in the window
    // The oldest timestamp is timestamps[0] (after pruning + push, the oldest qualifying
    // request is timestamps[0]).
    const oldest = timestamps[0];
    const retryAfterMs = oldest + windowMs - now;
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

    return { allowed: false, retryAfterSeconds };
  }

  return { check };
}

// ---------------------------------------------------------------------------
// Singleton instance using defaults from env (lazy to avoid circular import)
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof createRateLimiter> | null} */
let _instance = null;

/**
 * Returns the singleton rate-limiter instance, creating it on first call
 * using CONTACT_RATE_LIMIT_PER_HOUR from env.
 *
 * @returns {ReturnType<typeof createRateLimiter>}
 */
export function getRateLimiter() {
  if (_instance) return _instance;
  // Import lazily to avoid circular deps and to allow env to be set before this runs.
  let limit = 5;
  try {
    const limitEnv = parseInt(process.env.CONTACT_RATE_LIMIT_PER_HOUR ?? '5', 10);
    if (!isNaN(limitEnv) && limitEnv > 0) limit = limitEnv;
  } catch {
    // ignore; use default
  }
  _instance = createRateLimiter({ windowMs: 3_600_000, limit });
  return _instance;
}
