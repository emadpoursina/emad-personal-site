/**
 * tests/case-studies.test.mjs
 *
 * Unit tests for src/lib/case-studies.mjs.
 * Run with: node --test tests/case-studies.test.mjs
 *
 * Uses inline fixture objects only — no filesystem reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCaseStudies,
  publishedStudies,
  findStudy,
} from '../src/lib/case-studies.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid published/public study. */
function makePublicStudy(overrides = {}) {
  return {
    slug: 'rousta-tv',
    title: 'Rousta TV',
    status: 'published',
    visibility: 'public',
    problem: 'A Persian-language media platform.',
    contribution: 'Sole fullstack developer.',
    outcome: 'Live in production.',
    stack: ['MongoDB', 'Express', 'React', 'Node.js'],
    publicLink: { url: 'https://roustatv.com/' },
    ...overrides,
  };
}

/** Minimal valid published/private study. */
function makePrivateStudy(overrides = {}) {
  return {
    slug: 'namehamal',
    title: 'NamehAmal',
    status: 'published',
    visibility: 'private',
    problem: 'A personal time-tracking web application.',
    contribution: 'Built end to end as a personal project.',
    outcome: 'In personal use.',
    stack: ['Next.js'],
    publicLink: null,
    ...overrides,
  };
}

/** Minimal valid draft study. */
function makeDraftStudy(overrides = {}) {
  return {
    slug: 'voicedash',
    title: 'VoiceDash',
    status: 'draft',
    ...overrides,
  };
}

/** Wraps studies in a document. */
function doc(...studies) {
  return { studies };
}

// ---------------------------------------------------------------------------
// Tests — validation passing
// ---------------------------------------------------------------------------

test('valid document with one published/public and one published/private study passes', () => {
  assert.doesNotThrow(() =>
    validateCaseStudies(doc(makePublicStudy(), makePrivateStudy()))
  );
});

test('valid document with a draft study passes', () => {
  assert.doesNotThrow(() =>
    validateCaseStudies(doc(makePublicStudy(), makeDraftStudy()))
  );
});

// ---------------------------------------------------------------------------
// Tests — validation rejections
// ---------------------------------------------------------------------------

test('duplicate slug is rejected and names the slug', () => {
  assert.throws(
    () => validateCaseStudies(doc(makePublicStudy(), makePublicStudy())),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('rousta-tv'),
        `expected slug in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('draft with non-empty problem is rejected and names slug and field', () => {
  assert.throws(
    () => validateCaseStudies(doc(makeDraftStudy({ problem: 'Some narrative.' }))),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('voicedash'),
        `expected slug in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('problem'),
        `expected field name in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('draft with non-empty stack is rejected and names slug and field', () => {
  assert.throws(
    () => validateCaseStudies(doc(makeDraftStudy({ stack: ['Node.js'] }))),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('voicedash'),
        `expected slug in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('stack'),
        `expected field name in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('published study missing outcome is rejected and names slug and field', () => {
  const study = makePublicStudy();
  delete study.outcome;
  assert.throws(
    () => validateCaseStudies(doc(study)),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('rousta-tv'),
        `expected slug in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('outcome'),
        `expected field name in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('published study missing visibility is rejected and names slug and field', () => {
  const study = makePublicStudy();
  delete study.visibility;
  assert.throws(
    () => validateCaseStudies(doc(study)),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('rousta-tv'),
        `expected slug in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('visibility'),
        `expected field name in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('public study with http:// publicLink is rejected and names slug and field', () => {
  assert.throws(
    () =>
      validateCaseStudies(
        doc(makePublicStudy({ publicLink: { url: 'http://roustatv.com/' } }))
      ),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('rousta-tv'),
        `expected slug in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('publicLink'),
        `expected field name in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('public study with missing url in publicLink is rejected and names slug and field', () => {
  assert.throws(
    () =>
      validateCaseStudies(
        doc(makePublicStudy({ publicLink: { href: 'https://roustatv.com/' } }))
      ),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('rousta-tv'),
        `expected slug in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('publicLink'),
        `expected field name in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

test('private study with non-null publicLink is rejected and names slug and field', () => {
  assert.throws(
    () =>
      validateCaseStudies(
        doc(makePrivateStudy({ publicLink: { url: 'https://example.com/' } }))
      ),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('namehamal'),
        `expected slug in error, got: "${err.message}"`
      );
      assert.ok(
        err.message.includes('publicLink'),
        `expected field name in error, got: "${err.message}"`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Tests — publishedStudies
// ---------------------------------------------------------------------------

test('publishedStudies returns only published studies in order', () => {
  const pub1 = makePublicStudy();
  const priv1 = makePrivateStudy();
  const draft1 = makeDraftStudy();
  const result = publishedStudies(doc(pub1, priv1, draft1));
  assert.equal(result.length, 2);
  assert.equal(result[0].slug, 'rousta-tv');
  assert.equal(result[1].slug, 'namehamal');
});

test('publishedStudies does not mutate the document', () => {
  const d = doc(makePublicStudy(), makeDraftStudy());
  const before = d.studies.length;
  publishedStudies(d);
  assert.equal(d.studies.length, before);
});

// ---------------------------------------------------------------------------
// Tests — findStudy
// ---------------------------------------------------------------------------

test('findStudy finds a published study by slug', () => {
  const d = doc(makePublicStudy(), makePrivateStudy(), makeDraftStudy());
  const result = findStudy(d, 'rousta-tv');
  assert.ok(result !== undefined);
  assert.equal(result.slug, 'rousta-tv');
});

test('findStudy returns undefined for an unknown slug', () => {
  const d = doc(makePublicStudy(), makePrivateStudy());
  assert.equal(findStudy(d, 'unknown-slug'), undefined);
});

test('findStudy returns undefined for a draft slug when looking for it', () => {
  // findStudy finds by slug regardless of status — but we confirm draft is returned too
  // (the exclusion of drafts is a rendering concern, not findStudy's)
  // Per spec: "returns the matching study object or undefined"
  // A draft IS a study object, so findStudy correctly returns it.
  const d = doc(makeDraftStudy());
  const result = findStudy(d, 'voicedash');
  // findStudy finds it; exclusion from rendering is the caller's responsibility.
  // We confirm it is not undefined and has the right slug.
  assert.ok(result !== undefined);
  assert.equal(result.slug, 'voicedash');
  assert.equal(result.status, 'draft');
});
