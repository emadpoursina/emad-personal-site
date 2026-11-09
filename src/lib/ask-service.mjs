/**
 * src/lib/ask-service.mjs
 *
 * Ask assistant orchestration service module.
 * Coordinates rate limiting, question validation, settings resolution,
 * question logging, daily cap enforcement, decline policy matching,
 * context section selection, prompt building, and AI provider invocation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import * as dbModule from './db.mjs';
import { getEffectiveSettings } from './settings.mjs';
import { checkPerIp, consumeDaily, utcDayKey } from './ask-limits.mjs';
import { callProvider, ProviderError } from './ai-provider.mjs';
import {
  buildSections,
  selectSections,
  buildCitations,
  matchPolicy,
  getPolicySources,
  buildPolicyAnswer,
} from './assistant-context.mjs';
import { buildMessages } from './assistant-prompt.mjs';
import { loadProfile } from './profile.mjs';

/**
 * Resolves the path to content/case-studies.json.
 * Checks, in order:
 * 1. process.env.CASE_STUDIES_PATH when set (absolute or relative to process.cwd())
 * 2. path.join(process.cwd(), 'content', 'case-studies.json')
 * 3. module-relative path.join(dirname(fileURLToPath(import.meta.url)), '../../content/case-studies.json')
 *
 * @returns {string}
 */
function resolveCaseStudiesPath() {
  const candidates = [];

  if (process.env.CASE_STUDIES_PATH && process.env.CASE_STUDIES_PATH.trim() !== '') {
    const envVal = process.env.CASE_STUDIES_PATH.trim();
    const envPath = isAbsolute(envVal) ? envVal : resolve(process.cwd(), envVal);
    if (existsSync(envPath)) {
      return envPath;
    }
    candidates.push(envPath);
    throw new Error(`Cannot read case studies file: ${candidates.join(', ')}`);
  }

  const cwdPath = join(process.cwd(), 'content', 'case-studies.json');
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  candidates.push(cwdPath);

  const modulePath = join(dirname(fileURLToPath(import.meta.url)), '../../content/case-studies.json');
  if (existsSync(modulePath)) {
    return modulePath;
  }
  candidates.push(modulePath);

  throw new Error(`Cannot read case studies file: ${candidates.join(', ')}`);
}

/**
 * Loads content/case-studies.json once at module scope.
 *
 * @returns {Record<string, unknown>}
 */
function loadCaseStudiesDoc() {
  const resolvedPath = resolveCaseStudiesPath();
  let raw;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch {
    throw new Error(`Cannot read case studies file: ${resolvedPath}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${resolvedPath}: invalid JSON \u2014 ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const studiesDoc = loadCaseStudiesDoc();

/**
 * Validates a visitor question.
 *
 * @param {unknown} rawInput - Untrusted request payload.
 * @returns {{ ok: true, question: string } | { ok: false, errors: { question: string } }}
 */
export function validateQuestion(rawInput) {
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return {
      ok: false,
      errors: { question: 'Question is required.' },
    };
  }

  const { question } = /** @type {Record<string, unknown>} */ (rawInput);
  if (typeof question !== 'string') {
    return {
      ok: false,
      errors: { question: 'Question is required.' },
    };
  }

  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      errors: { question: 'Question is required.' },
    };
  }

  if (trimmed.length > 1000) {
    return {
      ok: false,
      errors: { question: 'Question must be 1,000 characters or fewer.' },
    };
  }

  return {
    ok: true,
    question: trimmed,
  };
}

/**
 * Default limits implementation wired to ask-limits.mjs.
 */
const DEFAULT_LIMITS = {
  checkPerIp,
  consumeDaily,
};

/**
 * Default provider implementation.
 */
const DEFAULT_PROVIDER = {
  call: callProvider,
};

/**
 * Processes an ask assistant question request following the normative processing order.
 *
 * @param {unknown} rawInput - Untrusted request body.
 * @param {string} clientIp - Client IP address for sliding-window rate limiting.
 * @param {object} [deps] - Optional injected dependencies.
 * @param {object} [deps.db] - Database accessors stub or module.
 * @param {object} [deps.settings] - Settings accessor stub or module.
 * @param {object} [deps.limits] - Limit checking functions {checkPerIp, consumeDaily}.
 * @param {object} [deps.provider] - AI completion provider {call}.
 * @param {() => Date | string | number} [deps.now] - Clock function returning current timestamp.
 * @param {Record<string, unknown>} [deps.profile] - Optional profile override.
 * @param {Record<string, unknown>} [deps.studiesDoc] - Optional case studies doc override.
 * @returns {Promise<{ status: number, payload: Record<string, unknown> }>}
 */
export async function processAsk(rawInput, clientIp, deps = {}) {
  try {
    const limits = {
      ...DEFAULT_LIMITS,
      ...deps.limits,
    };
    const settings = deps.settings ?? { getEffectiveSettings };
    const db = deps.db ?? dbModule;
    const provider = {
      ...DEFAULT_PROVIDER,
      ...deps.provider,
    };
    const nowFn = typeof deps.now === 'function' ? deps.now : () => new Date();

    const effective = settings.getEffectiveSettings();

    // 1. limits.checkPerIp(clientIp, effective.askRateLimitPerHour)
    const ipCheck = await limits.checkPerIp(clientIp, effective?.askRateLimitPerHour);
    if (!ipCheck || !ipCheck.allowed) {
      return {
        status: 429,
        payload: {
          ok: false,
          error: 'rate_limited',
          message: 'Too many questions from this address. Please try again later.',
          retryAfterSeconds: ipCheck?.retryAfterSeconds ?? 0,
        },
      };
    }

    // 2. validateQuestion(rawInput)
    const validation = validateQuestion(rawInput);
    if (!validation.ok) {
      const fieldMsg = validation.errors.question;
      return {
        status: 400,
        payload: {
          ok: false,
          error: 'validation',
          message: fieldMsg,
          errors: { question: fieldMsg },
        },
      };
    }
    const trimmed = validation.question;

    // 3. Settings resolution & configuration check
    if (!effective || !effective.aiConfigured) {
      return {
        status: 503,
        payload: {
          ok: false,
          error: 'unconfigured',
          message: 'The assistant is unavailable right now',
        },
      };
    }

    // 4. Best-effort question logging: failure logs one warning with no question text
    try {
      await db.insertQuestion(trimmed);
    } catch {
      console.warn('[ask-service] Failed to log ask question to database');
    }

    // 5. Daily cap check
    const day = utcDayKey(nowFn());

    let dailyCheck;
    try {
      dailyCheck = await limits.consumeDaily(db, day, effective.askDailyCap);
    } catch {
      return {
        status: 503,
        payload: {
          ok: false,
          error: 'storage',
          message: 'The assistant is unavailable right now',
        },
      };
    }

    if (!dailyCheck || !dailyCheck.allowed) {
      return {
        status: 429,
        payload: {
          ok: false,
          error: 'daily_cap',
          message:
            'The assistant is paused for today. Please try again tomorrow or use the contact form.',
        },
      };
    }

    // 6. Match decline policy (salary -> visa -> privateCodebase)
    const profile = deps.profile ?? loadProfile();
    const policy = profile?.assistantPolicy ?? {};
    const policyMatch = matchPolicy(trimmed);
    if (policyMatch) {
      return {
        status: 200,
        payload: {
          ok: true,
          answer: buildPolicyAnswer(policyMatch.kind, policy),
          disclaimer: policy.disclaimer,
          sources: getPolicySources(policyMatch.kind),
          model: effective.aiModel,
        },
      };
    }

    // 7. Context selection, citation extraction, prompt building, and provider call
    const activeStudiesDoc = deps.studiesDoc ?? studiesDoc;
    const sections = buildSections(profile, activeStudiesDoc);
    const selected = selectSections(trimmed, sections);
    const sources = buildCitations(selected);
    const messages = buildMessages(selected, trimmed, policy);

    let answer;
    try {
      answer = await provider.call({
        baseUrl: effective.aiBaseUrl,
        apiKey: effective.aiApiKey,
        model: effective.aiModel,
        messages,
      });
      if (typeof answer !== 'string' || answer.trim().length === 0) {
        throw new ProviderError('AI provider returned empty content', { kind: 'upstream' });
      }
    } catch (err) {
      if (err?.kind === 'timeout') {
        return {
          status: 504,
          payload: {
            ok: false,
            error: 'timeout',
            message:
              'The assistant took too long to answer. Please try again or use the contact form.',
          },
        };
      }
      return {
        status: 502,
        payload: {
          ok: false,
          error: 'provider_error',
          message:
            'The assistant could not answer right now. Please try again later or use the contact form.',
        },
      };
    }

    return {
      status: 200,
      payload: {
        ok: true,
        answer: answer.trim(),
        disclaimer: policy.disclaimer,
        sources,
        model: effective.aiModel,
      },
    };
  } catch {
    return {
      status: 500,
      payload: {
        ok: false,
        error: 'server',
        message: 'Something went wrong. Please use the contact form.',
      },
    };
  }
}
