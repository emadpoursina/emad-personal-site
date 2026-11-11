/**
 * tests/validation.test.mjs
 *
 * Tests for src/lib/validation.mjs and src/lib/env.mjs.
 * Run with: node --experimental-sqlite --test tests/validation.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateContact } from '../src/lib/validation.mjs';

// ---------------------------------------------------------------------------
// Contact form validation tests
// ---------------------------------------------------------------------------

describe('validateContact', () => {
  test('valid input returns ok=true with trimmed values', () => {
    const result = validateContact({
      name:    '  Alice  ',
      email:   ' alice@example.com ',
      message: ' Hello there ',
    });
    assert.equal(result.ok, true);
    assert.equal(result.values.name, 'Alice');
    assert.equal(result.values.email, 'alice@example.com');
    assert.equal(result.values.message, 'Hello there');
    assert.deepEqual(result.errors, {});
  });

  test('empty name produces an error', () => {
    const result = validateContact({ name: '', email: 'a@b.com', message: 'msg' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.name, 'name error expected');
  });

  test('name exceeding 200 chars produces an error', () => {
    const result = validateContact({
      name: 'A'.repeat(201),
      email: 'a@b.com',
      message: 'msg',
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.name);
  });

  test('name with CR/LF produces a header-injection error', () => {
    const result = validateContact({
      name: 'Ada Lovelace\r\nBcc: evil@example.com',
      email: 'ada@example.com',
      message: 'msg',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.name ?? '', /control characters/i);
  });

  test('name with an interior tab produces a control-character error', () => {
    const result = validateContact({
      name: 'Ada\tLovelace',
      email: 'ada@example.com',
      message: 'msg',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.name ?? '', /control characters/i);
  });

  test('missing email produces an error', () => {
    const result = validateContact({ name: 'Alice', email: '', message: 'msg' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.email);
  });

  test('email without @ produces an error', () => {
    const result = validateContact({ name: 'Alice', email: 'notanemail', message: 'msg' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.email);
  });

  test('email with multiple @ signs produces an error', () => {
    const result = validateContact({ name: 'Alice', email: 'a@@b.com', message: 'msg' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.email);
  });

  test('email without dot in domain produces an error', () => {
    const result = validateContact({ name: 'Alice', email: 'a@nodot', message: 'msg' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.email);
  });

  test('email with whitespace produces an error', () => {
    const result = validateContact({ name: 'Alice', email: 'a @b.com', message: 'msg' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.email);
  });

  test('email over 320 chars produces an error', () => {
    // 316 + '@b.co' = 321 chars — over the 320 limit
    const longEmail = 'a'.repeat(316) + '@b.co';
    const result = validateContact({ name: 'Alice', email: longEmail, message: 'msg' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.email);
  });

  test('empty message produces an error', () => {
    const result = validateContact({ name: 'Alice', email: 'a@b.com', message: '' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.message);
  });

  test('message over 5000 chars produces an error', () => {
    const result = validateContact({
      name: 'Alice',
      email: 'a@b.com',
      message: 'x'.repeat(5001),
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.message);
  });

  test('message of exactly 5000 chars is valid', () => {
    const result = validateContact({
      name: 'Alice',
      email: 'a@b.com',
      message: 'x'.repeat(5000),
    });
    assert.equal(result.ok, true);
  });

  test('multiple field errors returned together', () => {
    const result = validateContact({ name: '', email: '', message: '' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.name);
    assert.ok(result.errors.email);
    assert.ok(result.errors.message);
  });

  test('error messages are human-readable strings', () => {
    const result = validateContact({ name: '', email: 'bad', message: '' });
    for (const msg of Object.values(result.errors)) {
      assert.equal(typeof msg, 'string');
      assert.ok(msg.length > 0, 'error message should be non-empty');
    }
  });
});

// ---------------------------------------------------------------------------
// env.mjs tests
// ---------------------------------------------------------------------------

describe('env.mjs', () => {
  // Save original env
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    // Reset cached config before each test
    const { reset } = await import('../src/lib/env.mjs');
    reset();
  });

  afterEach(async () => {
    // Restore env and reset again
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    const { reset } = await import('../src/lib/env.mjs');
    reset();
  });

  test('smtpStatus is disabled by default (no env set)', async () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const { smtpStatus, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(smtpStatus(), 'disabled');
  });

  test('smtpStatus is configured when all three SMTP keys are set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    const { smtpStatus, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(smtpStatus(), 'configured');
  });

  test('smtpStatus is disabled when SMTP_HOST is missing', async () => {
    delete process.env.SMTP_HOST;
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    const { smtpStatus, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(smtpStatus(), 'disabled');
  });

  test('smtpStatus is disabled when SMTP_USER is missing', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    delete process.env.SMTP_USER;
    process.env.SMTP_PASS = 'pass';
    const { smtpStatus, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(smtpStatus(), 'disabled');
  });

  test('smtpStatus is disabled when SMTP_PASS is missing', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user';
    delete process.env.SMTP_PASS;
    const { smtpStatus, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(smtpStatus(), 'disabled');
  });

  test('clientKey uses socket address when TRUST_PROXY is not 1', async () => {
    delete process.env.TRUST_PROXY;
    const { clientKey, reset } = await import('../src/lib/env.mjs');
    reset();

    // Simulate a request with X-Forwarded-For but TRUST_PROXY unset
    const fakeRequest = {
      headers: new Headers({ 'x-forwarded-for': '1.2.3.4' }),
      socket: { remoteAddress: '127.0.0.1' },
    };
    // Should use socket.remoteAddress, not XFF
    const key = clientKey(/** @type {any} */ (fakeRequest));
    assert.equal(key, '127.0.0.1');
  });

  test('clientKey uses X-Forwarded-For when TRUST_PROXY=1', async () => {
    process.env.TRUST_PROXY = '1';
    const { clientKey, reset } = await import('../src/lib/env.mjs');
    reset();

    const fakeRequest = {
      headers: new Headers({ 'x-forwarded-for': '9.8.7.6, 192.168.1.1' }),
      socket: { remoteAddress: '127.0.0.1' },
    };
    const key = clientKey(/** @type {any} */ (fakeRequest));
    assert.equal(key, '9.8.7.6');
  });

  test('clientKey ignores XFF header when TRUST_PROXY is 0', async () => {
    process.env.TRUST_PROXY = '0';
    const { clientKey, reset } = await import('../src/lib/env.mjs');
    reset();

    const fakeRequest = {
      headers: new Headers({ 'x-forwarded-for': '5.5.5.5' }),
      socket: { remoteAddress: '10.0.0.1' },
    };
    const key = clientKey(/** @type {any} */ (fakeRequest));
    assert.equal(key, '10.0.0.1');
  });

  test('default PORT is 4321', async () => {
    delete process.env.PORT;
    const { getConfig, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(getConfig().PORT, 4321);
  });

  test('default HOST is 0.0.0.0', async () => {
    delete process.env.HOST;
    const { getConfig, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(getConfig().HOST, '0.0.0.0');
  });

  test('default DATA_DIR is ./data', async () => {
    delete process.env.DATA_DIR;
    const { getConfig, reset } = await import('../src/lib/env.mjs');
    reset();
    assert.equal(getConfig().DATA_DIR, './data');
  });

  test('blank values fall back to defaults (the `cp .env.example .env` case)', async () => {
    process.env.PORT = '';
    process.env.HOST = '';
    process.env.DATA_DIR = '';
    process.env.CONTACT_TO = '';
    process.env.CONTACT_RATE_LIMIT_PER_HOUR = '';
    process.env.SMTP_PORT = '';
    process.env.SMTP_FROM = '';
    const { getConfig, reset } = await import('../src/lib/env.mjs');
    reset();

    const conf = getConfig();
    assert.equal(conf.PORT, 4321);
    assert.equal(conf.HOST, '0.0.0.0');
    assert.equal(conf.DATA_DIR, './data');
    assert.equal(conf.CONTACT_TO, 'emad.poursina.work@gmail.com');
    assert.equal(conf.CONTACT_RATE_LIMIT_PER_HOUR, 5);
    assert.equal(conf.SMTP_PORT, 587);
    assert.equal(conf.SMTP_FROM, 'Emad Poursina <emad.poursina.work@gmail.com>');
  });

  test('surrounding whitespace is trimmed from string and path values', async () => {
    process.env.HOST = '  127.0.0.1  ';
    process.env.DATA_DIR = '  /tmp/site-data  ';
    const { getConfig, reset } = await import('../src/lib/env.mjs');
    reset();

    const conf = getConfig();
    assert.equal(conf.HOST, '127.0.0.1');
    assert.equal(conf.DATA_DIR, '/tmp/site-data');
  });
});
