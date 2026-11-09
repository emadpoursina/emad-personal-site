/**
 * tests/profile.test.mjs
 *
 * Unit tests for src/lib/profile.mjs.
 * Run with: node --experimental-sqlite --test tests/profile.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProfile,
  APPROVED_HEADLINE,
  SKILL_CATEGORIES,
  APPROVED_ASSISTANT_DISCLAIMER,
  APPROVED_ASSISTANT_UNAVAILABLE,
} from '../src/lib/profile.mjs';

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
    lastUpdated: '2026-11-08',
    targetRoles: ['Software Engineer'],
    targetCountries: ['Canada', 'Ireland', 'United Kingdom', 'Netherlands', 'Portugal'],
    bio: 'A short bio.',
    contactEmail: 'emad.poursina.work@gmail.com',
    links: { github: 'https://github.com/emadpoursina' },
    experience: [{ role: 'Engineer', company: 'Acme', start: '2020', end: 'present', points: ['Did things.'] }],
    skills: [{ name: 'Node.js', level: 'Expert', category: 'Backend' }],
    projects: [{ name: 'Project A', description: 'Desc', url: '' }],
    education: [{ degree: 'BSc', institution: 'University', year: '2020' }],
    languages: [{ name: 'English', level: 'Fluent' }],
    assistantPolicy: {
      disclaimer: 'AI assistant. The CV and case studies are the source of record.',
      unavailable: 'The assistant is unavailable right now',
      notAvailable: 'I do not have that information in the approved profile. Please use the contact form to ask Emad directly.',
      salary: 'I cannot discuss salary expectations. Please use the contact form to ask Emad directly.',
      privateCodebase: 'That codebase is private. You can read the published case studies at {caseStudiesPath}, and use the contact form for anything else.',
      visa: 'I cannot discuss named visa programs. Requires employer-sponsored work authorization. Please use the contact form for details.',
    },
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
    'assistantPolicy',
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
    p.skills = [{ name: 'Skill', level, category: 'Backend' }];
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

test('skill with no category throws and names the skill', () => {
  const p = validProfile();
  p.skills = [{ name: 'Node.js', level: 'Expert' }];
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('Node.js'),
        `expected skill name in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('category') || err.message.includes('skills'),
        `expected "category" or "skills" in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('skill with unknown category throws and names the value', () => {
  const p = validProfile();
  p.skills = [{ name: 'Node.js', level: 'Expert', category: 'Magic' }];
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('Node.js'),
        `expected skill name in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('Magic'),
        `expected bad value in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('missing or invalid lastUpdated throws and names lastUpdated', () => {
  const cases = [
    { lastUpdated: undefined },
    { lastUpdated: '2026/11/08' },
    { lastUpdated: '' },
    { lastUpdated: 'not-a-date' },
  ];
  for (const patch of cases) {
    const p = validProfile();
    if (patch.lastUpdated === undefined) {
      delete p.lastUpdated;
    } else {
      p.lastUpdated = patch.lastUpdated;
    }
    assert.throws(
      () => validateProfile(p),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('lastUpdated'),
          `expected "lastUpdated" in error, got: "${err.message}"`
        );
        return true;
      },
      `should throw for lastUpdated = ${JSON.stringify(patch.lastUpdated)}`
    );
  }
});

test('experience[].context: "lead" throws and names context; "team" is accepted', () => {
  // Invalid context throws and names "context"
  const p1 = validProfile();
  p1.experience = [{ role: 'Engineer', company: 'Acme', start: '2020', end: 'present', points: [], context: 'lead' }];
  assert.throws(
    () => validateProfile(p1),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('context'),
        `expected "context" in error, got: "${err.message}"`
      );
      return true;
    }
  );

  // Valid context: 'team' is accepted
  const p2 = validProfile();
  p2.experience = [{ role: 'Engineer', company: 'Acme', start: '2020', end: 'present', points: [], context: 'team' }];
  assert.doesNotThrow(() => validateProfile(p2), 'context: "team" should be accepted');

  // Absent context is also fine
  const p3 = validProfile();
  p3.experience = [{ role: 'Engineer', company: 'Acme', start: '2020', end: 'present', points: [] }];
  assert.doesNotThrow(() => validateProfile(p3), 'missing context should be accepted');
});

test('missing or non-object assistantPolicy throws and names assistantPolicy', () => {
  const cases = [undefined, null, {}, 'invalid', []];
  for (const val of cases) {
    const p = validProfile();
    if (val === undefined) {
      delete p.assistantPolicy;
    } else {
      p.assistantPolicy = val;
    }
    assert.throws(
      () => validateProfile(p),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('assistantPolicy'),
          `expected "assistantPolicy" in error, got: "${err.message}"`
        );
        return true;
      },
      `should throw for assistantPolicy = ${JSON.stringify(val)}`
    );
  }
});

test('wrong assistantPolicy disclaimer throws and names assistantPolicy and disclaimer', () => {
  const p = validProfile();
  p.assistantPolicy.disclaimer = 'Wrong disclaimer';
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('assistantPolicy') && err.message.includes('disclaimer'),
        `expected "assistantPolicy" and "disclaimer" in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('wrong assistantPolicy unavailable throws and names assistantPolicy and unavailable', () => {
  const p = validProfile();
  p.assistantPolicy.unavailable = 'Wrong unavailable';
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('assistantPolicy') && err.message.includes('unavailable'),
        `expected "assistantPolicy" and "unavailable" in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('empty assistantPolicy notAvailable or salary throws and names the field', () => {
  for (const field of ['notAvailable', 'salary']) {
    for (const emptyVal of ['', '   ']) {
      const p = validProfile();
      p.assistantPolicy[field] = emptyVal;
      assert.throws(
        () => validateProfile(p),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('assistantPolicy') && err.message.includes(field),
            `expected "assistantPolicy" and "${field}" in error, got: "${err.message}"`
          );
          return true;
        },
        `should throw for empty assistantPolicy.${field}`
      );
    }
  }
});

test('assistantPolicy privateCodebase missing placeholder throws and names the field', () => {
  const p = validProfile();
  p.assistantPolicy.privateCodebase = 'That codebase is private. No placeholder here.';
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('assistantPolicy') && err.message.includes('privateCodebase'),
        `expected "assistantPolicy" and "privateCodebase" in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('assistantPolicy visa missing authorization sentence throws and names the field', () => {
  const p = validProfile();
  p.assistantPolicy.visa = 'I cannot discuss named visa programs. Please use contact form.';
  assert.throws(
    () => validateProfile(p),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('assistantPolicy') && err.message.includes('visa'),
        `expected "assistantPolicy" and "visa" in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('missing assistantPolicy subfield throws and names the subfield', () => {
  const fields = ['disclaimer', 'unavailable', 'notAvailable', 'salary', 'privateCodebase', 'visa'];
  for (const field of fields) {
    const p = validProfile();
    delete p.assistantPolicy[field];
    assert.throws(
      () => validateProfile(p),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('assistantPolicy') && err.message.includes(field),
          `expected "assistantPolicy" and "${field}" in error, got: "${err.message}"`
        );
        return true;
      },
      `should throw when assistantPolicy.${field} is missing`
    );
  }
});
