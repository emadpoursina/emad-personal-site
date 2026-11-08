/**
 * tests/contrast.test.mjs
 *
 * Unit tests for WCAG contrast helpers in src/lib/contrast.mjs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHex,
  channelLuminance,
  relativeLuminance,
  contrastRatio,
} from '../src/lib/contrast.mjs';

describe('contrast — WCAG calculations', () => {
  it('black/white contrast ratio equals 21:1', () => {
    const ratio = contrastRatio('#000000', '#ffffff');
    assert.strictEqual(ratio, 21);

    // Symmetric check
    const reverseRatio = contrastRatio('#ffffff', '#000000');
    assert.strictEqual(reverseRatio, 21);
  });

  it('#777777 on #ffffff is below 4.5:1 (approx 4.48:1)', () => {
    const ratio = contrastRatio('#777777', '#ffffff');
    assert.ok(
      ratio < 4.5,
      `expected ratio < 4.5, got: ${ratio}`
    );
    // Close to 4.48
    assert.strictEqual(ratio.toFixed(2), '4.48');
  });

  it('#767676 on #ffffff is at least 4.5:1 (approx 4.54:1)', () => {
    const ratio = contrastRatio('#767676', '#ffffff');
    assert.ok(
      ratio >= 4.5,
      `expected ratio >= 4.5, got: ${ratio}`
    );
    assert.strictEqual(ratio.toFixed(2), '4.54');
  });

  it('handles 3-digit shorthand hex colors', () => {
    assert.deepStrictEqual(parseHex('#000'), [0, 0, 0]);
    assert.deepStrictEqual(parseHex('#fff'), [255, 255, 255]);
    assert.deepStrictEqual(parseHex('#f00'), [255, 0, 0]);
    const ratio = contrastRatio('#000', '#fff');
    assert.strictEqual(ratio, 21);
  });

  it('computes identical color contrast ratio as 1.0', () => {
    const ratio = contrastRatio('#123456', '#123456');
    assert.strictEqual(ratio, 1.0);
  });

  it('throws for invalid hex inputs', () => {
    assert.throws(() => parseHex('not-a-color'));
    assert.throws(() => parseHex('#12'));
    assert.throws(() => parseHex('#12345'));
    assert.throws(() => parseHex('#gggggg'));
  });
});
