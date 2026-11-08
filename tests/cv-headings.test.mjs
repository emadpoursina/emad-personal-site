/**
 * tests/cv-headings.test.mjs
 *
 * Unit tests for pure helpers in scripts/check-cv.mjs:
 * - Heading order detection (accepts correct order, rejects wrong order).
 * - Multi-column gap detection (accepts close runs, rejects gaps > 24 pt and returns offending line text).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkHeadingOrder,
  detectColumnGaps,
  checkAuthorizationLine,
  checkRawPdfForImages,
  EXPECTED_HEADINGS,
} from '../scripts/check-cv.mjs';

describe('cv-headings — heading order detection', () => {
  it('accepts the exact correct heading order', () => {
    const lines = [
      'Emad Poursina',
      'Headline text',
      'Summary',
      'Some bio content here.',
      'Availability: one month notice',
      'Requires employer-sponsored work authorization.',
      'Experience',
      'Role — Company',
      'Mar 2020 – Dec 2023',
      '• Did tasks',
      'Skills',
      'Expert: Node.js',
      'Projects',
      'Project A — description',
      'Education',
      'BSc — University (2020)',
      'Languages',
      'English — Fluent',
    ];

    const result = checkHeadingOrder(lines);
    assert.strictEqual(result.ok, true, 'correct order should be accepted');
  });

  it('accepts correct order when passed as line objects with .text property', () => {
    const lineObjects = EXPECTED_HEADINGS.map((h) => ({ text: h }));
    const result = checkHeadingOrder(lineObjects);
    assert.strictEqual(result.ok, true);
  });

  it('rejects an out-of-order heading sequence', () => {
    const lines = [
      'Summary',
      'Skills', // Skills before Experience
      'Experience',
      'Projects',
      'Education',
      'Languages',
    ];

    const result = checkHeadingOrder(lines);
    assert.strictEqual(result.ok, false, 'swapped headings must be rejected');
    assert.ok(result.error?.includes('mismatch'));
  });

  it('rejects when a required heading is missing', () => {
    const lines = [
      'Summary',
      'Experience',
      'Skills',
      'Projects',
      'Education',
      // 'Languages' missing
    ];

    const result = checkHeadingOrder(lines);
    assert.strictEqual(result.ok, false, 'missing heading must be rejected');
  });

  it('rejects when headings are duplicated', () => {
    const lines = [
      'Summary',
      'Summary', // duplicated
      'Experience',
      'Skills',
      'Projects',
      'Education',
      'Languages',
    ];

    const result = checkHeadingOrder(lines);
    assert.strictEqual(result.ok, false, 'duplicate heading must be rejected');
  });
});

describe('cv-headings — gap detector', () => {
  it('accepts close runs on the same line (gap <= 24 pt)', () => {
    // Run 1: x=50, width=40 -> right edge is 90
    // Run 2: x=95, width=50 -> gap is 95 - 90 = 5 pt (<= 24 pt)
    const items = [
      {
        str: 'First part',
        transform: [12, 0, 0, 12, 50, 700],
        width: 40,
      },
      {
        str: 'Second part',
        transform: [12, 0, 0, 12, 95, 700],
        width: 50,
      },
    ];

    const result = detectColumnGaps(items, 24);
    assert.strictEqual(result.ok, true, 'gap of 5 pt should be accepted');
    assert.strictEqual(result.offendingLine, null);
  });

  it('accepts runs separated by exactly 24 pt', () => {
    const items = [
      { str: 'A', transform: [10, 0, 0, 10, 50, 700], width: 20 },
      { str: 'B', transform: [10, 0, 0, 10, 94, 700], width: 20 }, // 94 - (50 + 20) = 24
    ];

    const result = detectColumnGaps(items, 24);
    assert.strictEqual(result.ok, true);
  });

  it('rejects a synthetic second-column line (gap > 24 pt) and returns offending line text', () => {
    // Synthetic two-column line:
    // Left column: x=50, width=60 -> right edge = 110
    // Right column: x=250, width=70 -> gap = 250 - 110 = 140 pt (> 24 pt)
    const items = [
      {
        str: 'Left Column Content',
        transform: [12, 0, 0, 12, 50, 700],
        width: 60,
      },
      {
        str: 'Right Column Content',
        transform: [12, 0, 0, 12, 250, 700],
        width: 70,
      },
    ];

    const result = detectColumnGaps(items, 24);
    assert.strictEqual(result.ok, false, 'gap > 24 pt must be rejected');
    assert.ok(result.offendingLine, 'offending line text must be returned');
    assert.ok(
      result.offendingLine.includes('Left Column Content'),
      `expected "Left Column Content" in offendingLine, got: "${result.offendingLine}"`
    );
    assert.ok(
      result.offendingLine.includes('Right Column Content'),
      `expected "Right Column Content" in offendingLine, got: "${result.offendingLine}"`
    );
    assert.ok(result.gap && result.gap > 24);
  });

  it('ignores vertical separation between different lines', () => {
    // Two lines, each with single run
    const items = [
      { str: 'Line 1', transform: [12, 0, 0, 12, 50, 700], width: 50 },
      { str: 'Line 2', transform: [12, 0, 0, 12, 50, 650], width: 50 },
    ];

    const result = detectColumnGaps(items, 24);
    assert.strictEqual(result.ok, true);
  });
});

describe('cv-headings — image byte scan and authorization line', () => {
  it('detects embedded image subtype tokens in raw buffer', () => {
    const badBuffer = Buffer.from('some pdf data /Subtype /Image more data');
    const result = checkRawPdfForImages(badBuffer, 'test.pdf');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error?.includes('test.pdf'));
  });

  it('passes raw buffer without image tokens', () => {
    const goodBuffer = Buffer.from('some text pdf data /Subtype /Type1');
    const result = checkRawPdfForImages(goodBuffer, 'test.pdf');
    assert.strictEqual(result.ok, true);
  });

  it('validates authorization line presence with whitespace normalization', () => {
    const lines = [
      'Summary',
      'Requires    employer-sponsored \n work authorization.',
    ];
    const result = checkAuthorizationLine(lines);
    assert.strictEqual(result.ok, true);
  });

  it('fails when authorization line is missing', () => {
    const lines = ['Summary', 'No authorization line present'];
    const result = checkAuthorizationLine(lines);
    assert.strictEqual(result.ok, false);
  });
});
