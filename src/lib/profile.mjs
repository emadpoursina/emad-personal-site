/**
 * src/lib/profile.mjs
 *
 * Loads and validates content/profile.json.
 * Throws an Error naming the missing or invalid field when validation fails.
 * Exports the parsed profile and the approved constants used by scripts and pages.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, isAbsolute, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Approved constants (single source of truth — also used by pages/scripts)
// ---------------------------------------------------------------------------

export const APPROVED_HEADLINE =
  'AI and Agentic Systems Engineer with a strong foundation in software development';

export const APPROVED_WORK_AUTHORIZATION =
  'Requires employer-sponsored work authorization.';

export const APPROVED_AVAILABILITY = 'one month notice';

export const APPROVED_CONTACT_EMAIL = 'emad.poursina.work@gmail.com';

export const APPROVED_TARGET_COUNTRIES = [
  'Canada',
  'Ireland',
  'United Kingdom',
  'Netherlands',
  'Portugal',
];

export const ALLOWED_SKILL_LEVELS = new Set([
  'Expert',
  'Advanced',
  'Intermediate',
  'Beginner / Learning',
]);

export const SKILL_CATEGORIES = [
  'Backend',
  'Databases',
  'Frontend',
  'DevOps & Infrastructure',
  'Testing',
  'Other Technical Skills',
  'Agentic Coding & AI Tooling',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the value is a non-empty array.
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Returns true if the value is a non-null, non-array object with at least one key.
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0
  );
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validates a parsed profile object.
 * Throws an Error naming the first failing field.
 *
 * @param {unknown} profile
 * @param {string} [filePath] - path shown in missing-file errors
 */
export function validateProfile(profile, filePath = 'content/profile.json') {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`${filePath}: root value must be a JSON object`);
  }

  const p = /** @type {Record<string, unknown>} */ (profile);

  // --- lastUpdated: required ISO date string YYYY-MM-DD ---
  if (
    typeof p['lastUpdated'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(p['lastUpdated'])
  ) {
    throw new Error(
      `profile field missing or invalid: lastUpdated (expected YYYY-MM-DD, got ${JSON.stringify(p['lastUpdated'])})`
    );
  }

  // --- Required non-empty string fields ---
  const stringFields = [
    'name',
    'headline',
    'workAuthorization',
    'availability',
    'bio',
    'contactEmail',
  ];

  for (const field of stringFields) {
    if (typeof p[field] !== 'string' || p[field].trim() === '') {
      throw new Error(`profile field missing or empty: ${field}`);
    }
  }

  // --- Exact-match approved strings ---
  if (p['headline'] !== APPROVED_HEADLINE) {
    throw new Error(`profile field has wrong value: headline`);
  }

  if (p['workAuthorization'] !== APPROVED_WORK_AUTHORIZATION) {
    throw new Error(`profile field has wrong value: workAuthorization`);
  }

  if (p['availability'] !== APPROVED_AVAILABILITY) {
    throw new Error(`profile field has wrong value: availability`);
  }

  if (p['contactEmail'] !== APPROVED_CONTACT_EMAIL) {
    throw new Error(`profile field has wrong value: contactEmail`);
  }

  // --- targetCountries: exact ordered list ---
  const tc = p['targetCountries'];
  if (!Array.isArray(tc)) {
    throw new Error(`profile field missing or empty: targetCountries`);
  }
  if (
    tc.length !== APPROVED_TARGET_COUNTRIES.length ||
    !tc.every((v, i) => v === APPROVED_TARGET_COUNTRIES[i])
  ) {
    throw new Error(`profile field has wrong value: targetCountries`);
  }

  // --- targetRoles: non-empty array ---
  if (!isNonEmptyArray(p['targetRoles'])) {
    throw new Error(`profile field missing or empty: targetRoles`);
  }

  // --- links: non-empty object ---
  if (!isNonEmptyObject(p['links'])) {
    throw new Error(`profile field missing or empty: links`);
  }

  // --- experience: non-empty array ---
  if (!isNonEmptyArray(p['experience'])) {
    throw new Error(`profile field missing or empty: experience`);
  }
  const experience = /** @type {unknown[]} */ (p['experience']);
  for (const entry of experience) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry)
    ) {
      continue; // other shape errors handled elsewhere
    }
    const e = /** @type {Record<string, unknown>} */ (entry);
    if ('context' in e && e['context'] !== 'team') {
      throw new Error(
        `profile field invalid: experience[].context must be "team" (got "${e['context']}" for company "${e['company']}")`
      );
    }
  }

  // --- skills: non-empty array; each entry has a valid level ---
  if (!isNonEmptyArray(p['skills'])) {
    throw new Error(`profile field missing or empty: skills`);
  }
  const skills = /** @type {unknown[]} */ (p['skills']);
  for (const skill of skills) {
    if (
      skill === null ||
      typeof skill !== 'object' ||
      Array.isArray(skill)
    ) {
      throw new Error(`profile field invalid: skills[] entry is not an object`);
    }
    const s = /** @type {Record<string, unknown>} */ (skill);
    if (!ALLOWED_SKILL_LEVELS.has(/** @type {string} */ (s['level']))) {
      throw new Error(
        `profile field invalid: skills[].level "${s['level']}" is not in the allowed set`
      );
    }
    if (s['category'] === undefined || s['category'] === null) {
      throw new Error(
        `profile field invalid: skills[].category is missing for skill "${s['name']}"`
      );
    }
    if (!SKILL_CATEGORIES.includes(/** @type {string} */ (s['category']))) {
      throw new Error(
        `profile field invalid: skill "${s['name']}" has unknown category "${s['category']}"`
      );
    }
  }

  // --- projects: non-empty array ---
  if (!isNonEmptyArray(p['projects'])) {
    throw new Error(`profile field missing or empty: projects`);
  }

  // --- education: non-empty array ---
  if (!isNonEmptyArray(p['education'])) {
    throw new Error(`profile field missing or empty: education`);
  }

  // --- languages: non-empty array ---
  if (!isNonEmptyArray(p['languages'])) {
    throw new Error(`profile field missing or empty: languages`);
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolves the profile file path.
 * Checks, in order:
 * 1. process.env.PROFILE_PATH when set (absolute or relative to process.cwd())
 * 2. path.join(process.cwd(), 'content', 'profile.json')
 * 3. module-relative path.join(dirname(fileURLToPath(import.meta.url)), '../../content/profile.json')
 *
 * When none exists, throws an Error whose message starts "Cannot read profile file:"
 * and names each candidate path.
 *
 * @returns {string}
 */
export function resolveProfilePath() {
  const candidates = [];

  if (process.env.PROFILE_PATH && process.env.PROFILE_PATH.trim() !== '') {
    const envVal = process.env.PROFILE_PATH.trim();
    const envPath = isAbsolute(envVal) ? envVal : resolve(process.cwd(), envVal);
    if (existsSync(envPath)) {
      return envPath;
    }
    candidates.push(envPath);
    throw new Error(`Cannot read profile file: ${candidates.join(', ')}`);
  }

  const cwdPath = join(process.cwd(), 'content', 'profile.json');
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  candidates.push(cwdPath);

  const modulePath = join(dirname(fileURLToPath(import.meta.url)), '../../content/profile.json');
  if (existsSync(modulePath)) {
    return modulePath;
  }
  candidates.push(modulePath);

  throw new Error(`Cannot read profile file: ${candidates.join(', ')}`);
}

/** @type {Record<string, unknown> | null} */
let _cached = null;

/**
 * Loads content/profile.json, validates it, caches the result and returns it.
 * Throws if the file is absent or invalid.
 *
 * @returns {Record<string, unknown>}
 */
export function loadProfile() {
  if (_cached !== null) return _cached;

  const profilePath = resolveProfilePath();

  let raw;
  try {
    raw = readFileSync(profilePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read profile file: ${profilePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${profilePath}: invalid JSON — ${/** @type {Error} */ (err).message}`);
  }

  validateProfile(parsed, profilePath);
  _cached = /** @type {Record<string, unknown>} */ (parsed);
  return _cached;
}
