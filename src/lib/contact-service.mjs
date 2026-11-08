/**
 * src/lib/contact-service.mjs
 *
 * Orchestrates the contact form submission pipeline.
 * Exact ordering (from data-model.md write path):
 *   1. Validate → 400
 *   2. Rate limit → 429
 *   3. Enabled check → 503
 *   4. Pessimistic insert (delivery_status='failed') → 500 on error
 *   5. Send email
 *   6. Update row (sent or failed with reason)
 *   7. Respond 200 or 502
 *
 * Collaborators are injected so tests never touch network or disk.
 */

import { validateContact } from './validation.mjs';

const CONTACT_EMAIL = 'emad.poursina.work@gmail.com';

/**
 * @typedef {object} ServiceOutcome
 * @property {number} status
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {object} DbLike
 * @property {(msg: {name:string;email:string;message:string}) => number} insertMessage
 * @property {(id: number) => void} markSent
 * @property {(id: number, reason: string) => void} markFailed
 */

/**
 * @typedef {object} MailerLike
 * @property {() => 'configured'|'disabled'} status
 * @property {(opts:{name:string;email:string;message:string}) => Promise<void>} send
 */

/**
 * @typedef {object} RateLimiterLike
 * @property {(key: string) => {allowed:boolean;retryAfterSeconds:number}} check
 */

/**
 * Processes a contact form submission.
 *
 * @param {Record<string, unknown>} rawInput  - Untrimmed form fields.
 * @param {string} clientIp                   - Client key (IP or XFF).
 * @param {object} deps                       - Injected collaborators.
 * @param {DbLike}          deps.db
 * @param {MailerLike}      deps.mailer
 * @param {RateLimiterLike} deps.rateLimiter
 * @returns {Promise<ServiceOutcome>}
 */
export async function processContact(rawInput, clientIp, { db, mailer, rateLimiter }) {
  // Rate limit attempt tracking: every POST attempt counts, including rejected ones.
  const rl = rateLimiter.check(clientIp);

  // 1. Validate
  const validation = validateContact(rawInput);
  if (!validation.ok) {
    return {
      status: 400,
      payload: { ok: false, error: 'validation', errors: validation.errors },
    };
  }

  // 2. Rate limit
  if (!rl.allowed) {
    return {
      status: 429,
      payload: { ok: false, error: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds },
    };
  }

  const { name, email, message } = validation.values;

  // 3. Enabled check
  if (mailer.status() !== 'configured') {
    return {
      status: 503,
      payload: { ok: false, error: 'disabled', contactEmail: CONTACT_EMAIL },
    };
  }

  // 4. Pessimistic insert
  let id;
  try {
    id = db.insertMessage({ name, email, message });
  } catch {
    return {
      status: 500,
      payload: { ok: false, error: 'storage' },
    };
  }

  // 5 & 6. Send and update
  try {
    await mailer.send({ name, email, message });
    db.markSent(id);
    return {
      status: 200,
      payload: { ok: true, status: 'sent', id },
    };
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.message.slice(0, 200)
        : 'Unknown error';
    db.markFailed(id, reason);
    return {
      status: 502,
      payload: {
        ok: false,
        error: 'delivery_failed',
        id,
        contactEmail: CONTACT_EMAIL,
      },
    };
  }
}
