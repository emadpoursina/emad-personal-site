/**
 * tests/skills.test.mjs
 *
 * Unit tests for skill presentation helpers, profile skill data integrity,
 * and date formatting helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  SKILL_CATEGORY_ORDER,
  displayLevel,
  isAtLeastIntermediate,
  knowsAbout,
} from '../src/lib/skills.mjs';

import {
  formatMonth,
  formatRange,
} from '../src/lib/dates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, '..', 'content', 'profile.json');
const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));

const EXPECTED_CATEGORIES = [
  'Backend',
  'Databases',
  'Frontend',
  'DevOps & Infrastructure',
  'Testing',
  'Other Technical Skills',
  'Agentic Coding & AI Tooling',
];

const EXPECTED_CATEGORY_COUNTS = {
  Backend: 16,
  Databases: 5,
  Frontend: 5,
  'DevOps & Infrastructure': 17,
  Testing: 3,
  'Other Technical Skills': 9,
  'Agentic Coding & AI Tooling': 6,
};

test('SKILL_CATEGORY_ORDER contains exactly the seven categories in the fixed order', () => {
  assert.strictEqual(SKILL_CATEGORY_ORDER.length, 7);
  assert.deepStrictEqual(SKILL_CATEGORY_ORDER, EXPECTED_CATEGORIES);
});

test('every skill in content/profile.json has a valid category from SKILL_CATEGORY_ORDER', () => {
  const allowed = new Set(SKILL_CATEGORY_ORDER);
  for (const skill of profile.skills) {
    assert.ok(
      allowed.has(skill.category),
      `Skill "${skill.name}" has invalid or missing category "${skill.category}"`
    );
  }
});

test('there are exactly 61 skills in content/profile.json and no duplicate skill names', () => {
  assert.strictEqual(profile.skills.length, 61);
  const names = profile.skills.map((s) => s.name);
  const uniqueNames = new Set(names);
  assert.strictEqual(
    uniqueNames.size,
    61,
    `Expected 61 unique skill names, got ${uniqueNames.size}`
  );
});

test('per-category skill counts match the approved matrix exactly', () => {
  const counts = {};
  for (const skill of profile.skills) {
    counts[skill.category] = (counts[skill.category] || 0) + 1;
  }
  assert.deepStrictEqual(counts, EXPECTED_CATEGORY_COUNTS);
});

test('displayLevel maps "Beginner / Learning" to "Learning" and leaves others unchanged', () => {
  assert.strictEqual(displayLevel('Beginner / Learning'), 'Learning');
  assert.strictEqual(displayLevel('Expert'), 'Expert');
  assert.strictEqual(displayLevel('Advanced'), 'Advanced');
  assert.strictEqual(displayLevel('Intermediate'), 'Intermediate');
  assert.strictEqual(displayLevel('Beginner'), 'Beginner');
  assert.strictEqual(displayLevel('Custom'), 'Custom');
});

test('isAtLeastIntermediate is true only for Intermediate, Advanced, Expert', () => {
  assert.strictEqual(isAtLeastIntermediate('Expert'), true);
  assert.strictEqual(isAtLeastIntermediate('Advanced'), true);
  assert.strictEqual(isAtLeastIntermediate('Intermediate'), true);

  assert.strictEqual(isAtLeastIntermediate('Beginner / Learning'), false);
  assert.strictEqual(isAtLeastIntermediate('Beginner'), false);
  assert.strictEqual(isAtLeastIntermediate(''), false);
  assert.strictEqual(isAtLeastIntermediate(null), false);
  assert.strictEqual(isAtLeastIntermediate(undefined), false);
  assert.strictEqual(isAtLeastIntermediate('Unknown'), false);
});

test('knowsAbout returns 36 skills preserving profile order and excludes Beginner / Learning', () => {
  const result = knowsAbout(profile.skills);
  assert.strictEqual(result.length, 36);

  // Compute expected list by filtering Intermediate / Advanced / Expert in profile order
  const expected = profile.skills
    .filter((s) => isAtLeastIntermediate(s.level))
    .map((s) => s.name);

  assert.deepStrictEqual(result, expected);

  // Verify none of the included skills has 'Beginner / Learning' or 'Beginner'
  const skillMap = new Map(profile.skills.map((s) => [s.name, s.level]));
  for (const name of result) {
    const level = skillMap.get(name);
    assert.notStrictEqual(level, 'Beginner / Learning');
    assert.notStrictEqual(level, 'Beginner');
  }

  // Gracefully handles non-array input
  assert.deepStrictEqual(knowsAbout([]), []);
  assert.deepStrictEqual(knowsAbout(null), []);
  assert.deepStrictEqual(knowsAbout(undefined), []);
});

test('formatMonth formats YYYY-MM, present, and leaves bare YYYY or other strings unchanged', () => {
  assert.strictEqual(formatMonth('2019-03'), 'Mar 2019');
  assert.strictEqual(formatMonth('2023-12'), 'Dec 2023');
  assert.strictEqual(formatMonth('2020-01'), 'Jan 2020');

  // Case-insensitive "present"
  assert.strictEqual(formatMonth('present'), 'Present');
  assert.strictEqual(formatMonth('Present'), 'Present');
  assert.strictEqual(formatMonth('PRESENT'), 'Present');

  // Bare YYYY unchanged
  assert.strictEqual(formatMonth('2020'), '2020');
  assert.strictEqual(formatMonth('1999'), '1999');

  // Anything else unchanged
  assert.strictEqual(formatMonth('unknown'), 'unknown');
  assert.strictEqual(formatMonth(''), '');
  assert.strictEqual(formatMonth('2019-13'), '2019-13');
  assert.strictEqual(formatMonth(1234), 1234);
});

test('formatRange produces "Start – End" with an en dash and single spaces', () => {
  assert.strictEqual(
    formatRange('2019-03', '2023-12'),
    'Mar 2019 \u2013 Dec 2023'
  );
  assert.strictEqual(
    formatRange('2020-06', 'present'),
    'Jun 2020 \u2013 Present'
  );
  assert.strictEqual(
    formatRange('2020', 'present'),
    '2020 \u2013 Present'
  );
  assert.strictEqual(
    formatRange('2018', '2020'),
    '2018 \u2013 2020'
  );
  // Verify it contains the exact en dash character U+2013
  const formatted = formatRange('2019-03', '2023-12');
  assert.ok(formatted.includes('\u2013'));
  assert.strictEqual(formatted, 'Mar 2019 – Dec 2023');
});
