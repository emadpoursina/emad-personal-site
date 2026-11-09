/**
 * src/lib/cover-letter-service.mjs
 *
 * Cover-letter orchestration service module.
 * Coordinates rate limiting, job-description validation, settings resolution,
 * daily cap enforcement, external generator invocation, and required-line enforcement.
 */

import * as dbModule from './db.mjs';
import * as settingsModule from './settings.mjs';
import { callGenerator, GeneratorError } from './generator-provider.mjs';
import { ensureRequiredLines, buildGeneralLetter, loadCoverLetter } from './cover-letter.mjs';
import { utcDayKey } from './daily-cap.mjs';
import { loadProfile } from './profile.mjs';
import { checkPerIp, consumeDaily } from './cover-letter-limits.mjs';

/**
 * Validates untrusted job description input.
 *
 * @param {unknown} rawInput - Untrusted request body.
 * @returns {{ ok: true, jobDescription: string } | { ok: false, errors: { jobDescription: string } }}
 */
export function validateJobDescription(rawInput) {
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return {
      ok: false,
      errors: { jobDescription: 'Job description is required.' },
    };
  }

  const { jobDescription } = /** @type {Record<string, unknown>} */ (rawInput);
  if (typeof jobDescription !== 'string') {
    return {
      ok: false,
      errors: { jobDescription: 'Job description is required.' },
    };
  }

  const trimmed = jobDescription.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      errors: { jobDescription: 'Job description is required.' },
    };
  }

  if (trimmed.length > 8000) {
    return {
      ok: false,
      errors: { jobDescription: 'Job description must be 8,000 characters or fewer.' },
    };
  }

  return {
    ok: true,
    jobDescription: trimmed,
  };
}

/**
 * Default limits implementation wired to cover-letter-limits.mjs.
 */
export const DEFAULT_LIMITS = {
  checkPerIp,
  consumeDaily,
};

/**
 * Default provider implementation.
 */
const DEFAULT_PROVIDER = {
  call: callGenerator,
};

/**
 * Processes a cover letter generation request following the normative processing order.
 *
 * @param {unknown} rawInput - Untrusted request body.
 * @param {string} clientIp - Client IP address.
 * @param {object} [deps] - Optional injected dependencies.
 * @param {object} [deps.db] - Database accessors stub or module.
 * @param {object} [deps.settings] - Settings accessor stub or module.
 * @param {object} [deps.limits] - Limit checking functions {checkPerIp, consumeDaily}.
 * @param {object} [deps.provider] - Generator provider adapter {call}.
 * @param {() => Date | string | number} [deps.now] - Clock function returning current timestamp.
 * @param {Record<string, unknown>} [deps.profile] - Optional profile override.
 * @param {Record<string, unknown>} [deps.letterDoc] - Optional cover letter document override.
 * @returns {Promise<{ status: number, payload: Record<string, unknown> }>}
 */
export async function processCoverLetter(rawInput, clientIp, deps = {}) {
  try {
    const db = deps.db ?? dbModule;
    const settings = deps.settings ?? settingsModule;
    const limits = {
      ...DEFAULT_LIMITS,
      ...deps.limits,
    };
    const provider = {
      ...DEFAULT_PROVIDER,
      ...deps.provider,
    };
    const nowFn = typeof deps.now === 'function' ? deps.now : () => new Date();
    const profile = deps.profile ?? loadProfile();
    const letterDoc = deps.letterDoc ?? loadCoverLetter();

    // a. Sliding-window per-IP rate limit check (happens BEFORE validation so every attempt counts)
    const ip = await limits.checkPerIp(clientIp);
    if (!ip?.allowed) {
      return {
        status: 429,
        payload: {
          ok: false,
          error: 'rate_limited',
          message: 'Too many cover-letter requests from this address. Please try again later.',
          retryAfterSeconds: ip?.retryAfterSeconds ?? 0,
        },
      };
    }

    // b. Validate job description (1–8,000 characters)
    const v = validateJobDescription(rawInput);
    if (!v.ok) {
      return {
        status: 400,
        payload: {
          ok: false,
          error: 'validation',
          message: v.errors.jobDescription,
          errors: { jobDescription: v.errors.jobDescription },
        },
      };
    }

    // c. Generator configuration check
    const effective = settings.getEffectiveGenerator();
    if (!effective?.configured) {
      return {
        status: 503,
        payload: {
          ok: false,
          error: 'unconfigured',
          message: 'The cover-letter generator is unavailable right now',
        },
      };
    }

    // d. Shared daily cap check
    const effectiveSettings = settings.getEffectiveSettings();
    const cap = effectiveSettings?.askDailyCap;
    const day = utcDayKey(nowFn());

    let daily;
    try {
      daily = await limits.consumeDaily(db, day, cap);
    } catch {
      return {
        status: 503,
        payload: {
          ok: false,
          error: 'storage',
          message: 'The cover-letter generator is unavailable right now',
        },
      };
    }

    if (daily?.allowed === false) {
      return {
        status: 429,
        payload: {
          ok: false,
          error: 'daily_cap',
          message:
            'The cover-letter generator is paused for today. Please try again tomorrow or use the general cover letter.',
        },
      };
    }

    // e. Build general letter fallback & call generator provider
    const generalLetter = buildGeneralLetter(letterDoc);

    let result;
    try {
      result = await provider.call({
        endpoint: effective.endpoint,
        apiKey: effective.apiKey,
        jobDescription: v.jobDescription,
        candidate: profile,
        timeoutMs: effective.timeoutMs,
      });
    } catch (err) {
      if (err instanceof GeneratorError && err.kind === 'timeout') {
        return {
          status: 504,
          payload: {
            ok: false,
            error: 'generator_timeout',
            message:
              'The cover-letter generator took too long. The general cover letter is available below.',
            fallback: true,
            generalLetter,
          },
        };
      }
      return {
        status: 502,
        payload: {
          ok: false,
          error: 'generator_error',
          message:
            'The cover-letter generator could not produce a letter right now. The general cover letter is available below.',
          fallback: true,
          generalLetter,
        },
      };
    }

    const { letter, appended } = ensureRequiredLines(result);
    return {
      status: 200,
      payload: {
        ok: true,
        letter,
        appended,
      },
    };
  } catch {
    return {
      status: 500,
      payload: {
        ok: false,
        error: 'server',
        message:
          'Something went wrong. Please use the general cover letter or the contact form.',
      },
    };
  }
}
