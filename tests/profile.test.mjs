/**
 * tests/profile.test.mjs
 *
 * Unit tests for src/lib/profile.mjs.
 * Run with: node --experimental-sqlite --test tests/profile.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile, APPROVED_HEADLINE } from '../src/lib/profile.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal valid profile that passes all validation rules.
 * @returns {Record<string, unknown>}
 */
function validProfile() {
  return {
    name: 'Emad Poursina',
    headline: 'AI and Agentic Systems Engineer with a strong foundation in software development',
    workAuthorization: 'Requires employer-sponsored work authorization.',
    availability: 'one month notice',
    targetRoles: ['Software Engineer'],
    targetCountries: ['Canada', 'Ireland', 'United Kingdom', 'Netherlands', 'Portugal'],
    bio: 'A short bio.',
    contactEmail: 'emad.poursina.work@gmail.com',
    links: { github: 'https://github.com/emadpoursina' },
    experience: [{ role: 'Engineer', company: 'Acme', start: '2020', end: 'present', points: ['Did things.'] }],
    skills: [{ name: 'Node.js', level: 'Expert' }],
    projects: [{ name: 'Project A', description: 'Desc', url: '' }],
    education: [{ degree: 'BSc', institution: 'University', year: '2020' }],
    languages: [{ name: 'English', level: 'Fluent' }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('valid profile passes without throwing', () => {
  assert.doesNotThrow(() => validateProfile(validProfile()));
});

test('missing required key names the field in the error', () => {
  const cases = [
    'name',
    'headline',
    'workAuthorization',
    'availability',
    'bio',
    'contactEmail',
    'targetRoles',
    'targetCountries',
    'links',
    'experience',
    'skills',
    'projects',
    'education',
    'languages',
  ];

  for (const key of cases) {
    const p = validProfile();
    delete p[key];
    assert.throws(
      () => validateProfile(p),
      (err) => {
        assert.ok(err instanceof Error, `expected Error for missing "${key}"`);
        assert.ok(
          err.message.includes(key),
          `error message should mention "${key}", got: "${err.message}"`
        );
        return true;
      },
      `should throw when "${key}" is missing`
    );
  }
});

test('wrong headline names the field in the error', () => {
  const p = validProfile();
  p.headline = 'Wrong headline string';
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('headline'),
        `expected "headline" in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('invalid skill level names the field in the error', () => {
  const p = validProfile();
  p.skills = [{ name: 'Node.js', level: 'Master' }];
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('skills'),
        `expected "skills" in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('all four allowed skill levels are accepted', () => {
  const levels = ['Expert', 'Advanced', 'Intermediate', 'Beginner / Learning'];
  for (const level of levels) {
    const p = validProfile();
    p.skills = [{ name: 'Skill', level }];
    assert.doesNotThrow(
      () => validateProfile(p),
      `level "${level}" should be accepted`
    );
  }
});

test('wrong workAuthorization names the field', () => {
  const p = validProfile();
  p.workAuthorization = 'No authorization needed.';
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err.message.includes('workAuthorization'));
      return true;
    }
  );
});

test('wrong targetCountries names the field', () => {
  const p = validProfile();
  p.targetCountries = ['Canada', 'France'];
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err.message.includes('targetCountries'));
      return true;
    }
  );
});
