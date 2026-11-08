/**
 * tests/mailer.test.mjs
 *
 * Tests for src/lib/mailer.mjs — specifically the header sanitizer that
 * protects the mail Subject from CR/LF header injection (critic W2).
 * Run with: node --experimental-sqlite --test tests/mailer.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHeaderValue } from '../src/lib/mailer.mjs';

describe('sanitizeHeaderValue', () => {
  test('leaves a normal name unchanged', () => {
    assert.equal(sanitizeHeaderValue('Ada Lovelace'), 'Ada Lovelace');
  });

  test('collapses CR/LF into a single space so no header break survives', () => {
    const out = sanitizeHeaderValue('Ada\r\nBcc: evil@example.com');
    assert.equal(out, 'Ada Bcc: evil@example.com');
    assert.ok(!/[\r\n]/.test(out), 'output must not contain CR or LF');
  });

  test('collapses a bare LF and a bare CR', () => {
    assert.equal(sanitizeHeaderValue('Ada\nLovelace'), 'Ada Lovelace');
    assert.equal(sanitizeHeaderValue('Ada\rLovelace'), 'Ada Lovelace');
  });

  test('drops NUL and other C0 control characters', () => {
    const out = sanitizeHeaderValue('A\u0000d\u0007a');
    assert.equal(out, 'A d a');
    assert.ok(!/[\u0000-\u001F\u007F]/.test(out));
  });

  test('trims leading and trailing whitespace left by the replacement', () => {
    assert.equal(sanitizeHeaderValue('\r\nAda\r\n'), 'Ada');
  });

  test('a value that is only control characters becomes empty', () => {
    assert.equal(sanitizeHeaderValue('\r\n\u0000\r'), '');
  });
});
