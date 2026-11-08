/**
 * src/lib/skills.mjs
 *
 * Skill presentation helpers and constants.
 */

import { SKILL_CATEGORIES } from './profile.mjs';

/**
 * Ordered list of skill categories matching the approved matrix.
 */
export const SKILL_CATEGORY_ORDER = SKILL_CATEGORIES;

const AT_LEAST_INTERMEDIATE = new Set(['Intermediate', 'Advanced', 'Expert']);

/**
 * Returns 'Learning' for 'Beginner / Learning'; returns the input unchanged for any other string.
 *
 * @param {string} level
 * @returns {string}
 */
export function displayLevel(level) {
  if (level === 'Beginner / Learning') {
    return 'Learning';
  }
  return level;
}

/**
 * Returns true only for 'Intermediate', 'Advanced', 'Expert';
 * false for 'Beginner / Learning' and anything else.
 *
 * @param {unknown} level
 * @returns {boolean}
 */
export function isAtLeastIntermediate(level) {
  return typeof level === 'string' && AT_LEAST_INTERMEDIATE.has(level);
}

/**
 * Takes the profile's skills array and returns the name of each skill
 * whose level is at least Intermediate, in input order.
 * Never includes a 'Beginner / Learning' or 'Beginner' skill.
 *
 * @param {Array<{ name: string, level: string, category?: string }>} [skills]
 * @returns {string[]}
 */
export function knowsAbout(skills) {
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills
    .filter((skill) => skill && isAtLeastIntermediate(skill.level))
    .map((skill) => skill.name);
}
