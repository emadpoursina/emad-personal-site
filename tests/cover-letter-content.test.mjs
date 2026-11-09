/**
 * tests/cover-letter-content.test.mjs
 *
 * Unit tests for content/cover-letter.json and src/lib/cover-letter.mjs.
 * Run with: node --experimental-sqlite --test tests/cover-letter-content.test.mjs
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadCoverLetter,
  validateCoverLetter,
  buildGeneralLetter,
  ensureRequiredLines,
  findBannedPhrases,
  BANNED_PHRASES,
  REQUIRED_AUTHORIZATION,
  SIGNOFF,
} from '../src/lib/cover-letter.mjs';
import { loadProfile } from '../src/lib/profile.mjs';

// ---------------------------------------------------------------------------
// Helpers and Fixtures
// ---------------------------------------------------------------------------

function validDoc() {
  return {
    greeting: 'Dear Hiring Manager,',
    paragraphs: [
      'First paragraph with valid content.',
      'Second paragraph with valid content.',
      'Third paragraph with valid content.',
    ],
    authorization: 'Requires employer-sponsored work authorization.',
    signoff: 'Best regards, Emad Poursina',
    links: [
      {
        label: 'LinkedIn',
        href: 'https://www.linkedin.com/in/emadpoursina/',
      },
      {
        label: 'GitHub',
        href: 'https://github.com/emadpoursina',
      },
    ],
    lastUpdated: '2026-11-08',
  };
}

// ---------------------------------------------------------------------------
// 1. Shipped content
// ---------------------------------------------------------------------------

test('shipped content loads and passes validation against profile', () => {
  const doc = loadCoverLetter();
  assert.ok(doc && typeof doc === 'object', 'loadCoverLetter() returns an object');

  const profile = loadProfile();
  const validation = validateCoverLetter(doc, { profile });
  assert.deepEqual(validation, { ok: true });

  assert.equal(typeof doc.greeting, 'string');
  assert.ok(Array.isArray(doc.paragraphs));
  assert.ok(doc.paragraphs.length >= 2 && doc.paragraphs.length <= 6);
  assert.equal(typeof doc.authorization, 'string');
  assert.equal(typeof doc.signoff, 'string');
  assert.ok(Array.isArray(doc.links));
  assert.equal(doc.links.length, 2);
  assert.equal(typeof doc.lastUpdated, 'string');

  assert.equal(doc.links[0].label, 'LinkedIn');
  assert.equal(doc.links[0].href, profile.links.linkedin);
  assert.equal(doc.links[1].label, 'GitHub');
  assert.equal(doc.links[1].href, profile.links.github);
});

// ---------------------------------------------------------------------------
// 2. Validation rules (failing cases asserting specific error field)
// ---------------------------------------------------------------------------

test('validateCoverLetter fails on non-object document', () => {
  const result = validateCoverLetter(null);
  assert.equal(result.ok, false);
  assert.ok('document' in result.errors, 'errors should contain "document"');
});

test('validateCoverLetter fails on unknown top-level key', () => {
  const doc = { ...validDoc(), unknownField: 'unexpected' };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('unknownField' in result.errors, 'errors should contain "unknownField"');
});

test('validateCoverLetter fails on greeting not matching the form', () => {
  const doc = { ...validDoc(), greeting: 'Hi there!' };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('greeting' in result.errors, 'errors should contain "greeting"');
});

test('validateCoverLetter fails on greeting with a digit', () => {
  const doc = { ...validDoc(), greeting: 'Dear Team 2,' };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('greeting' in result.errors, 'errors should contain "greeting"');
});

test('validateCoverLetter fails on greeting naming a month', () => {
  const doc = { ...validDoc(), greeting: 'Dear April,' };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('greeting' in result.errors, 'errors should contain "greeting"');
});

test('validateCoverLetter fails on greeting over 80 chars', () => {
  const longName = 'A'.repeat(80);
  const doc = { ...validDoc(), greeting: `Dear ${longName},` };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('greeting' in result.errors, 'errors should contain "greeting"');
});

test('validateCoverLetter fails on paragraphs missing', () => {
  const doc = validDoc();
  delete doc.paragraphs;
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on paragraphs with 1 entry', () => {
  const doc = { ...validDoc(), paragraphs: ['Only one paragraph here.'] };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on paragraphs with 7 entries', () => {
  const doc = {
    ...validDoc(),
    paragraphs: [
      'Paragraph 1.',
      'Paragraph 2.',
      'Paragraph 3.',
      'Paragraph 4.',
      'Paragraph 5.',
      'Paragraph 6.',
      'Paragraph 7.',
    ],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on a paragraph that is empty after trim', () => {
  const doc = {
    ...validDoc(),
    paragraphs: ['First paragraph.', '   \t  \n  ', 'Third paragraph.'],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on a paragraph over 1500 chars', () => {
  const doc = {
    ...validDoc(),
    paragraphs: ['First paragraph.', 'a'.repeat(1501)],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on paragraphs total over 5000 chars', () => {
  const doc = {
    ...validDoc(),
    paragraphs: [
      'a'.repeat(1300),
      'b'.repeat(1300),
      'c'.repeat(1300),
      'd'.repeat(1300),
    ],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on a paragraph containing http://', () => {
  const doc = {
    ...validDoc(),
    paragraphs: ['First paragraph.', 'Visit http://example.com for info.'],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on a paragraph containing https://', () => {
  const doc = {
    ...validDoc(),
    paragraphs: ['First paragraph.', 'Visit https://example.com for info.'],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on a paragraph containing "@"', () => {
  const doc = {
    ...validDoc(),
    paragraphs: ['First paragraph.', 'Contact me at test@example.com anytime.'],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on a paragraph containing a control character', () => {
  const doc = {
    ...validDoc(),
    paragraphs: ['First paragraph.', 'Contains control char: \u0007 bell.'],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('paragraphs' in result.errors, 'errors should contain "paragraphs"');
});

test('validateCoverLetter fails on authorization not exactly profile.workAuthorization', () => {
  const profile = loadProfile();
  const doc = {
    ...validDoc(),
    authorization: 'Authorized to work without sponsorship.',
  };
  const result = validateCoverLetter(doc, { profile });
  assert.equal(result.ok, false);
  assert.ok('authorization' in result.errors, 'errors should contain "authorization"');
});

test('validateCoverLetter fails on signoff not exactly Best regards, ${profile.name}', () => {
  const profile = loadProfile();
  const doc = {
    ...validDoc(),
    signoff: 'Sincerely, Emad Poursina',
  };
  const result = validateCoverLetter(doc, { profile });
  assert.equal(result.ok, false);
  assert.ok('signoff' in result.errors, 'errors should contain "signoff"');
});

test('validateCoverLetter fails on links with one entry', () => {
  const doc = {
    ...validDoc(),
    links: [{ label: 'LinkedIn', href: 'https://linkedin.com/in/emad' }],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('links' in result.errors, 'errors should contain "links"');
});

test('validateCoverLetter fails on links in reversed order', () => {
  const profile = loadProfile();
  const doc = {
    ...validDoc(),
    links: [
      { label: 'GitHub', href: profile.links.github },
      { label: 'LinkedIn', href: profile.links.linkedin },
    ],
  };
  const result = validateCoverLetter(doc, { profile });
  assert.equal(result.ok, false);
  assert.ok('links' in result.errors, 'errors should contain "links"');
});

test('validateCoverLetter fails on link label not LinkedIn/GitHub', () => {
  const doc = {
    ...validDoc(),
    links: [
      { label: 'Twitter', href: 'https://twitter.com/emad' },
      { label: 'GitHub', href: 'https://github.com/emadpoursina' },
    ],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('links' in result.errors, 'errors should contain "links"');
});

test('validateCoverLetter fails on href not starting https://', () => {
  const doc = {
    ...validDoc(),
    links: [
      { label: 'LinkedIn', href: 'http://linkedin.com/in/emad' },
      { label: 'GitHub', href: 'https://github.com/emadpoursina' },
    ],
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('links' in result.errors, 'errors should contain "links"');
});

test('validateCoverLetter fails on lastUpdated in the future', () => {
  const doc = {
    ...validDoc(),
    lastUpdated: '2099-01-01',
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('lastUpdated' in result.errors, 'errors should contain "lastUpdated"');
});

test('validateCoverLetter fails on lastUpdated not YYYY-MM-DD', () => {
  const doc = {
    ...validDoc(),
    lastUpdated: '11/09/2026',
  };
  const result = validateCoverLetter(doc);
  assert.equal(result.ok, false);
  assert.ok('lastUpdated' in result.errors, 'errors should contain "lastUpdated"');
});

// ---------------------------------------------------------------------------
// 3. buildGeneralLetter exact text and ordering
// ---------------------------------------------------------------------------

test('buildGeneralLetter builds exact text and maintains section ordering', () => {
  const doc = validDoc();
  const letter = buildGeneralLetter(doc);

  const expected =
    `${doc.greeting}\n\n` +
    `${doc.paragraphs.join('\n\n')}\n\n` +
    `${doc.authorization}\n\n` +
    `${doc.signoff}\n\n` +
    `LinkedIn: ${doc.links[0].href}\n` +
    `GitHub: ${doc.links[1].href}\n`;

  assert.equal(letter, expected);

  // Assert exact trailing newline
  assert.ok(letter.endsWith('\n'), 'letter must end with newline');
  assert.ok(!letter.endsWith('\n\n'), 'letter must end with exactly one trailing newline');

  // Assert relative index ordering
  const greetingIdx = letter.indexOf(doc.greeting);
  const para0Idx = letter.indexOf(doc.paragraphs[0]);
  const paraLastIdx = letter.indexOf(doc.paragraphs[doc.paragraphs.length - 1]);
  const authIdx = letter.indexOf(doc.authorization);
  const signoffIdx = letter.indexOf(doc.signoff);
  const linkedinIdx = letter.indexOf(`LinkedIn: ${doc.links[0].href}`);
  const githubIdx = letter.indexOf(`GitHub: ${doc.links[1].href}`);

  assert.ok(greetingIdx !== -1, 'greeting found');
  assert.ok(greetingIdx < para0Idx, 'greeting before paragraphs');
  assert.ok(paraLastIdx < authIdx, 'authorization after paragraphs');
  assert.ok(authIdx < signoffIdx, 'signoff after authorization');
  assert.ok(signoffIdx < linkedinIdx, 'links after signoff');
  assert.ok(linkedinIdx < githubIdx, 'LinkedIn before GitHub');
});

// ---------------------------------------------------------------------------
// 4. ensureRequiredLines combinations and idempotency
// ---------------------------------------------------------------------------

test('ensureRequiredLines: neither line present appends both in order', () => {
  const body = 'Initial letter content without authorization or signoff.';
  const res = ensureRequiredLines(body);

  assert.deepEqual(res.appended, { authorization: true, signoff: true });
  assert.ok(res.letter.startsWith(body), 'original body is unchanged and comes first');

  const expected = `${body}\n\n${REQUIRED_AUTHORIZATION}\n\n${SIGNOFF}`;
  assert.equal(res.letter, expected);

  const authIdx = res.letter.indexOf(REQUIRED_AUTHORIZATION);
  const signoffIdx = res.letter.indexOf(SIGNOFF);
  assert.ok(authIdx < signoffIdx, 'authorization sits before sign-off');
  assert.ok(
    res.letter.includes(`${REQUIRED_AUTHORIZATION}\n\n${SIGNOFF}`),
    'separated by one blank line'
  );

  // Idempotent
  const res2 = ensureRequiredLines(res.letter);
  assert.equal(res2.letter, res.letter);
  assert.deepEqual(res2.appended, { authorization: false, signoff: false });
});

test('ensureRequiredLines: only authorization present appends only sign-off', () => {
  const body = `Body paragraph.\n\n${REQUIRED_AUTHORIZATION}`;
  const res = ensureRequiredLines(body);

  assert.deepEqual(res.appended, { authorization: false, signoff: true });
  assert.ok(res.letter.startsWith(body), 'original body is unchanged and comes first');
  assert.equal(res.letter, `${body}\n\n${SIGNOFF}`);

  // Idempotent
  const res2 = ensureRequiredLines(res.letter);
  assert.equal(res2.letter, res.letter);
  assert.deepEqual(res2.appended, { authorization: false, signoff: false });
});

test('ensureRequiredLines: only sign-off present appends only authorization', () => {
  const body = `Body paragraph.\n\n${SIGNOFF}`;
  const res = ensureRequiredLines(body);

  assert.deepEqual(res.appended, { authorization: true, signoff: false });
  assert.ok(res.letter.startsWith(body), 'original body is unchanged and comes first');
  assert.equal(res.letter, `${body}\n\n${REQUIRED_AUTHORIZATION}`);

  // Idempotent
  const res2 = ensureRequiredLines(res.letter);
  assert.equal(res2.letter, res.letter);
  assert.deepEqual(res2.appended, { authorization: false, signoff: false });
});

test('ensureRequiredLines: both present appends nothing', () => {
  const body = `Body paragraph.\n\n${REQUIRED_AUTHORIZATION}\n\n${SIGNOFF}`;
  const res = ensureRequiredLines(body);

  assert.deepEqual(res.appended, { authorization: false, signoff: false });
  assert.equal(res.letter, body);

  // Idempotent
  const res2 = ensureRequiredLines(res.letter);
  assert.equal(res2.letter, body);
  assert.deepEqual(res2.appended, { authorization: false, signoff: false });
});

// ---------------------------------------------------------------------------
// 5. findBannedPhrases
// ---------------------------------------------------------------------------

test('findBannedPhrases: finds each banned phrase in BANNED_PHRASES order, case-insensitively', () => {
  // Test each phrase individually including at least one mixed-case variant
  for (const phrase of BANNED_PHRASES) {
    const lowerSentence = `This sentence mentions ${phrase.toLowerCase()} clearly.`;
    assert.deepEqual(findBannedPhrases(lowerSentence), [phrase]);

    const upperSentence = `This sentence mentions ${phrase.toUpperCase()} clearly.`;
    assert.deepEqual(findBannedPhrases(upperSentence), [phrase]);

    const mixedVariant = phrase
      .split('')
      .map((ch, idx) => (idx % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
      .join('');
    const mixedSentence = `This sentence mentions ${mixedVariant} in mixed case.`;
    assert.deepEqual(findBannedPhrases(mixedSentence), [phrase]);
  }

  // Combined text matching multiple phrases in non-standard order in the text
  const combined = 'A dynamic and passionate team player with synergy, results-driven, saying: I am writing to express my interest.';
  assert.deepEqual(findBannedPhrases(combined), BANNED_PHRASES);

  // Clean sentence returns empty array
  const cleanSentence = 'This is a clean and professional engineering cover letter.';
  assert.deepEqual(findBannedPhrases(cleanSentence), []);
});

// ---------------------------------------------------------------------------
// 6. Spawned-script tests: scripts/check-cover-letter.mjs
// ---------------------------------------------------------------------------

describe('scripts/check-cover-letter.mjs CLI gate', () => {
  const repoRoot = process.cwd();

  test('passes on shipped content and prints "cover letter ok"', () => {
    const result = spawnSync('node', ['scripts/check-cover-letter.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('cover letter ok'));
  });

  test('fails on each of the six banned phrases placed in paragraphs', () => {
    for (const phrase of BANNED_PHRASES) {
      const tempDir = mkdtempSync(join(tmpdir(), 'check-cover-letter-banned-'));
      const fixturePath = join(tempDir, 'cover-letter.json');
      try {
        const doc = {
          ...validDoc(),
          paragraphs: [
            `Here is a paragraph containing ${phrase} inside it.`,
            'Second valid paragraph with good content.',
            'Third valid paragraph with good content.',
          ],
        };
        writeFileSync(fixturePath, JSON.stringify(doc, null, 2), 'utf8');

        const result = spawnSync('node', ['scripts/check-cover-letter.mjs'], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            COVER_LETTER_PATH: fixturePath,
          },
        });

        assert.equal(result.status, 1, `expected status 1 for banned phrase "${phrase}"`);
        assert.ok(
          result.stderr.includes(`FAIL: banned phrase "${phrase}" found in paragraphs`),
          `expected stderr to report banned phrase "${phrase}" in paragraphs, got:\n${result.stderr}`
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  test('fails on invalid content when a required key is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'check-cover-letter-invalid-'));
    const fixturePath = join(tempDir, 'cover-letter.json');
    try {
      const invalid = validDoc();
      delete invalid.greeting;
      writeFileSync(fixturePath, JSON.stringify(invalid, null, 2), 'utf8');

      const result = spawnSync('node', ['scripts/check-cover-letter.mjs'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          COVER_LETTER_PATH: fixturePath,
        },
      });

      assert.equal(result.status, 1);
      assert.ok(
        result.stderr.startsWith('FAIL:'),
        `expected stderr to start with "FAIL:", got:\n${result.stderr}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

