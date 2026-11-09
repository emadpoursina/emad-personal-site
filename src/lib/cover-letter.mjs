/**
 * src/lib/cover-letter.mjs
 *
 * Plain-ESM library with zero runtime dependencies.
 * Loads, validates, and builds the general cover letter, detects banned phrases,
 * and enforces required lines on generated letters.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile } from './profile.mjs';

// ---------------------------------------------------------------------------
// Approved constants
// ---------------------------------------------------------------------------

export const REQUIRED_AUTHORIZATION =
  'Requires employer-sponsored work authorization.';

export const SIGNOFF = 'Best regards, Emad Poursina';

export const BANNED_PHRASES = [
  'I am writing to express my interest',
  'passionate',
  'dynamic',
  'synergy',
  'results-driven',
  'team player',
];

const ENGLISH_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const GREETING_RE = /^Dear [A-Za-z][A-Za-z .'-]*,$/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'greeting',
  'paragraphs',
  'authorization',
  'signoff',
  'links',
  'lastUpdated',
]);

// ---------------------------------------------------------------------------
// Pure Helpers
// ---------------------------------------------------------------------------

/**
 * Scans a string for banned phrases using case-insensitive substring matching.
 * Returns an array of matched banned phrases in BANNED_PHRASES order.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function findBannedPhrases(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase.toLowerCase()));
}

/**
 * Validates a cover letter document against the schema and profile facts.
 *
 * @param {unknown} doc
 * @param {{ profile?: Record<string, any>; now?: Date }} [options]
 * @returns {{ ok: true } | { ok: false; errors: Record<string, string> }}
 */
export function validateCoverLetter(doc, { profile, now } = {}) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      ok: false,
      errors: {
        document: 'Cover letter document must be a non-null object',
      },
    };
  }

  /** @type {Record<string, string>} */
  const errors = {};
  const d = /** @type {Record<string, unknown>} */ (doc);

  // Reject unknown top-level keys
  for (const key of Object.keys(d)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors[key] = `Unknown top-level key: "${key}"`;
    }
  }

  // Reject missing required keys
  for (const key of ALLOWED_TOP_LEVEL_KEYS) {
    if (!(key in d)) {
      errors[key] = `Missing required field: "${key}"`;
    }
  }

  // greeting: string, matches /^Dear [A-Za-z][A-Za-z .'-]*,$/, no digits, no month name, <= 80 chars
  if ('greeting' in d) {
    if (typeof d.greeting !== 'string') {
      errors.greeting = 'greeting must be a string';
    } else {
      const greeting = d.greeting;
      if (greeting.length > 80) {
        errors.greeting = 'greeting must be 80 characters or fewer';
      } else if (!GREETING_RE.test(greeting)) {
        errors.greeting = 'greeting must match pattern /^Dear [A-Za-z][A-Za-z .\'-]*,$/';
      } else if (/\d/.test(greeting)) {
        errors.greeting = 'greeting must not contain digits';
      } else {
        const lower = greeting.toLowerCase();
        if (ENGLISH_MONTHS.some((m) => lower.includes(m))) {
          errors.greeting = 'greeting must not contain an English month name';
        }
      }
    }
  }

  // paragraphs: array of 2..6 entries, each a string whose trim is 1..1500 chars,
  // total trim length <= 5000, no "http://", "https://" or "@", no control characters
  if ('paragraphs' in d) {
    if (!Array.isArray(d.paragraphs)) {
      errors.paragraphs = 'paragraphs must be an array';
    } else {
      const paras = d.paragraphs;
      if (paras.length < 2 || paras.length > 6) {
        errors.paragraphs = 'paragraphs must contain between 2 and 6 entries';
      } else {
        let totalTrimLength = 0;
        let paragraphError = '';

        for (let i = 0; i < paras.length; i++) {
          const p = paras[i];
          if (typeof p !== 'string') {
            paragraphError = `paragraphs[${i}] must be a string`;
            break;
          }
          const trimmed = p.trim();
          if (trimmed.length < 1 || trimmed.length > 1500) {
            paragraphError = `paragraphs[${i}] trim length must be between 1 and 1500 characters`;
            break;
          }
          if (CONTROL_CHARS_RE.test(p)) {
            paragraphError = `paragraphs[${i}] must not contain control characters`;
            break;
          }
          const lower = p.toLowerCase();
          if (lower.includes('http://') || lower.includes('https://') || p.includes('@')) {
            paragraphError = `paragraphs[${i}] must not contain URLs or email addresses`;
            break;
          }
          totalTrimLength += trimmed.length;
        }

        if (paragraphError) {
          errors.paragraphs = paragraphError;
        } else if (totalTrimLength > 5000) {
          errors.paragraphs = 'paragraphs total trim length must not exceed 5000 characters';
        }
      }
    }
  }

  // authorization: exactly profile.workAuthorization
  if ('authorization' in d) {
    if (typeof d.authorization !== 'string') {
      errors.authorization = 'authorization must be a string';
    } else {
      const expectedAuth = profile?.workAuthorization ?? REQUIRED_AUTHORIZATION;
      if (d.authorization !== expectedAuth) {
        errors.authorization = `authorization must match profile.workAuthorization ("${expectedAuth}")`;
      }
    }
  }

  // signoff: exactly `Best regards, ${profile.name}`
  if ('signoff' in d) {
    if (typeof d.signoff !== 'string') {
      errors.signoff = 'signoff must be a string';
    } else {
      const expectedSignoff = profile?.name ? `Best regards, ${profile.name}` : SIGNOFF;
      if (d.signoff !== expectedSignoff) {
        errors.signoff = `signoff must match "${expectedSignoff}"`;
      }
    }
  }

  // links: exactly 2 entries in order LinkedIn -> profile.links.linkedin then GitHub -> profile.links.github, each href starting "https://"
  if ('links' in d) {
    if (!Array.isArray(d.links)) {
      errors.links = 'links must be an array';
    } else {
      const links = d.links;
      if (links.length !== 2) {
        errors.links = 'links must contain exactly 2 entries';
      } else {
        const l0 = links[0];
        const l1 = links[1];

        if (
          l0 === null ||
          typeof l0 !== 'object' ||
          Array.isArray(l0) ||
          typeof l0.label !== 'string' ||
          typeof l0.href !== 'string'
        ) {
          errors.links = 'links[0] must be an object with string label and href';
        } else if (l0.label !== 'LinkedIn') {
          errors.links = 'links[0].label must be "LinkedIn"';
        } else if (!l0.href.startsWith('https://')) {
          errors.links = 'links[0].href must start with "https://"';
        } else if (profile?.links?.linkedin && l0.href !== profile.links.linkedin) {
          errors.links = `links[0].href must match profile.links.linkedin ("${profile.links.linkedin}")`;
        }

        if (!errors.links) {
          if (
            l1 === null ||
            typeof l1 !== 'object' ||
            Array.isArray(l1) ||
            typeof l1.label !== 'string' ||
            typeof l1.href !== 'string'
          ) {
            errors.links = 'links[1] must be an object with string label and href';
          } else if (l1.label !== 'GitHub') {
            errors.links = 'links[1].label must be "GitHub"';
          } else if (!l1.href.startsWith('https://')) {
            errors.links = 'links[1].href must start with "https://"';
          } else if (profile?.links?.github && l1.href !== profile.links.github) {
            errors.links = `links[1].href must match profile.links.github ("${profile.links.github}")`;
          }
        }
      }
    }
  }

  // lastUpdated: matches YYYY-MM-DD and is not in the future
  if ('lastUpdated' in d) {
    if (typeof d.lastUpdated !== 'string' || !DATE_RE.test(d.lastUpdated)) {
      errors.lastUpdated = 'lastUpdated must be a string matching YYYY-MM-DD';
    } else {
      const parsedDate = new Date(`${d.lastUpdated}T00:00:00Z`);
      if (Number.isNaN(parsedDate.getTime())) {
        errors.lastUpdated = 'lastUpdated must be a valid calendar date';
      } else {
        const refDate = now instanceof Date ? now : new Date();
        const todayUtc = refDate.toISOString().slice(0, 10);
        if (d.lastUpdated > todayUtc) {
          errors.lastUpdated = 'lastUpdated must not be in the future';
        }
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Path resolver & Loader
// ---------------------------------------------------------------------------

/**
 * Resolves the cover letter file path.
 * Checks, in order:
 * 1. process.env.COVER_LETTER_PATH (absolute, or relative resolved against process.cwd())
 * 2. path.join(process.cwd(), 'content', 'cover-letter.json')
 * 3. module-relative path.join(dirname(fileURLToPath(import.meta.url)), '../../content/cover-letter.json')
 *
 * @returns {string}
 */
export function resolveCoverLetterPath() {
  const candidates = [];

  if (process.env.COVER_LETTER_PATH && process.env.COVER_LETTER_PATH.trim() !== '') {
    const envVal = process.env.COVER_LETTER_PATH.trim();
    const envPath = isAbsolute(envVal) ? envVal : resolve(process.cwd(), envVal);
    if (existsSync(envPath)) {
      return envPath;
    }
    candidates.push(envPath);
    throw new Error(`Cannot read cover letter file: ${candidates.join(', ')}`);
  }

  const cwdPath = join(process.cwd(), 'content', 'cover-letter.json');
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  candidates.push(cwdPath);

  const modulePath = join(dirname(fileURLToPath(import.meta.url)), '../../content/cover-letter.json');
  if (existsSync(modulePath)) {
    return modulePath;
  }
  candidates.push(modulePath);

  throw new Error(`Cannot read cover letter file: ${candidates.join(', ')}`);
}

/**
 * Loads content/cover-letter.json, parses it, and validates it against loadProfile().
 * Throws an Error naming the failing field or candidate paths on failure.
 * No module-level cache.
 *
 * @returns {Record<string, any>}
 */
export function loadCoverLetter() {
  const filePath = resolveCoverLetterPath();

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read cover letter file: ${filePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath}: invalid JSON — ${/** @type {Error} */ (err).message}`);
  }

  const profile = loadProfile();
  const result = validateCoverLetter(parsed, { profile });
  if (!result.ok) {
    const firstField = Object.keys(result.errors)[0];
    const details = Object.entries(result.errors)
      .map(([k, v]) => `${k} (${v})`)
      .join('; ');
    throw new Error(`cover letter field missing or invalid: ${firstField} — ${details}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Letter Building & Enforcement
// ---------------------------------------------------------------------------

/**
 * Builds the exact general letter text from a cover letter document.
 * Format:
 * greeting, blank line, paragraphs joined by blank lines, blank line,
 * authorization, blank line, signoff, blank line,
 * "LinkedIn: <url>", newline, "GitHub: <url>", then exactly one trailing newline.
 *
 * @param {Record<string, any>} doc
 * @returns {string}
 */
export function buildGeneralLetter(doc) {
  if (!doc) {
    throw new Error('doc is required');
  }

  const linkedin =
    doc.links?.find((/** @type {{ label: string; href: string }} */ l) => l.label === 'LinkedIn')?.href ||
    doc.links?.[0]?.href ||
    '';
  const github =
    doc.links?.find((/** @type {{ label: string; href: string }} */ l) => l.label === 'GitHub')?.href ||
    doc.links?.[1]?.href ||
    '';

  const paragraphsText = Array.isArray(doc.paragraphs) ? doc.paragraphs.join('\n\n') : '';

  const sections = [
    doc.greeting,
    paragraphsText,
    doc.authorization,
    doc.signoff,
    `LinkedIn: ${linkedin}\nGitHub: ${github}`,
  ];

  return sections.join('\n\n') + '\n';
}

/**
 * Ensures the required authorization line and sign-off are present in letter text.
 * Appends only the missing exact lines, authorization before sign-off,
 * each separated from the existing text and from each other by one blank line.
 * Never edits, reorders, or dedupes existing text. Idempotent on its own output.
 *
 * @param {unknown} text
 * @returns {{ letter: string; appended: { authorization: boolean; signoff: boolean } }}
 */
export function ensureRequiredLines(text) {
  const str = typeof text === 'string' ? text : '';
  const hasAuth = str.includes(REQUIRED_AUTHORIZATION);
  const hasSignoff = str.includes(SIGNOFF);

  if (hasAuth && hasSignoff) {
    return {
      letter: str,
      appended: { authorization: false, signoff: false },
    };
  }

  const toAppend = [];
  if (!hasAuth) {
    toAppend.push(REQUIRED_AUTHORIZATION);
  }
  if (!hasSignoff) {
    toAppend.push(SIGNOFF);
  }

  const suffix = toAppend.join('\n\n');

  let letter;
  if (str.length === 0) {
    letter = suffix;
  } else if (/\n\s*\n$/.test(str)) {
    letter = str + suffix;
  } else if (/\n$/.test(str)) {
    letter = str + '\n' + suffix;
  } else {
    letter = str + '\n\n' + suffix;
  }

  return {
    letter,
    appended: {
      authorization: !hasAuth,
      signoff: !hasSignoff,
    },
  };
}
