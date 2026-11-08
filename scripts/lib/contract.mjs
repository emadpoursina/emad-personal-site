/**
 * scripts/lib/contract.mjs
 *
 * Shared Phase 2 output-contract constants and the strict deep-equality
 * helper used by the three build-output checks (S2 finding on the critic
 * review: these were duplicated in check-agent-output.mjs and
 * test-public-routes.mjs).
 *
 * "VoiceDash" is approved public CV content (an employer role and a profile
 * project since Phase 1); what must never appear is the DRAFT CASE STUDY.
 * Its only addressable trace is the page URL, so resume.json, /api/profile
 * and JSON-LD are checked for that URL, while llms.txt and sitemap.xml —
 * which carry no employment data — keep the strict bare-slug ban.
 */

export const DRAFT_SLUG = 'voicedash';
export const DRAFT_URL = `/case-studies/${DRAFT_SLUG}`;

/**
 * Strict deep equality. Returns null when equal, otherwise a short
 * description of the first mismatch including the offending path.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [path]
 * @returns {string | null}
 */
export function firstDifference(actual, expected, path = '$') {
  if (Object.is(actual, expected)) return null;

  if (typeof actual !== typeof expected) {
    return `${path}: expected ${typeof expected}, got ${typeof actual}`;
  }
  if (actual === null || expected === null || typeof actual !== 'object') {
    return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }

  const aIsArray = Array.isArray(actual);
  const eIsArray = Array.isArray(expected);
  if (aIsArray !== eIsArray) {
    return `${path}: expected ${eIsArray ? 'array' : 'object'}, got ${aIsArray ? 'array' : 'object'}`;
  }

  if (aIsArray) {
    const a = /** @type {unknown[]} */ (actual);
    const e = /** @type {unknown[]} */ (expected);
    if (a.length !== e.length) {
      return `${path}: expected array length ${e.length}, got ${a.length}`;
    }
    for (let i = 0; i < a.length; i++) {
      const diff = firstDifference(a[i], e[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  const a = /** @type {Record<string, unknown>} */ (actual);
  const e = /** @type {Record<string, unknown>} */ (expected);
  const aKeys = Object.keys(a).sort();
  const eKeys = Object.keys(e).sort();
  if (aKeys.length !== eKeys.length || aKeys.some((k, i) => k !== eKeys[i])) {
    return `${path}: keys differ — expected {${eKeys.join(',')}}, got {${aKeys.join(',')}}`;
  }
  for (const key of eKeys) {
    const diff = firstDifference(a[key], e[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}
