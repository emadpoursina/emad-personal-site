/**
 * tests/secrets.test.mjs
 *
 * Unit tests for AES-256-GCM secret envelope module (src/lib/secrets.mjs).
 * Verifies key parsing (base64, hex, invalid forms, missing key),
 * authenticated encryption/decryption, tamper detection, failure modes,
 * secret masking, and single-warning log sanitization.
 *
 * Run with: node --experimental-sqlite --test tests/secrets.test.mjs
 */

import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SecretError, encryptSecret, decryptSecret, maskSecret } from '../src/lib/secrets.mjs';
import { reset } from '../src/lib/env.mjs';

// Deterministic 32-byte key
const DETERMINISTIC_RAW_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const DETERMINISTIC_B64_KEY = DETERMINISTIC_RAW_KEY.toString('base64');
const DETERMINISTIC_HEX_KEY = DETERMINISTIC_RAW_KEY.toString('hex');

describe('src/lib/secrets.mjs - secret envelope module', () => {
  const originalEnv = { ...process.env };
  const origWarn = console.warn;
  const capturedWarnings = [];

  before(() => {
    console.warn = (...args) => {
      capturedWarnings.push(args.map((a) => String(a)).join(' '));
    };
  });

  after(() => {
    console.warn = origWarn;
  });

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = DETERMINISTIC_B64_KEY;
    reset();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    reset();
  });

  test('SecretError inherits from Error and exposes code property', () => {
    const err = new SecretError('Test error message', 'decrypt_failed');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof SecretError);
    assert.equal(err.name, 'SecretError');
    assert.equal(err.message, 'Test error message');
    assert.equal(err.code, 'decrypt_failed');
  });

  test('round-trip encryption and decryption with 32-byte base64 key', () => {
    const secret = 'sk-live-test-credential-12345';
    const envelope = encryptSecret(secret);
    assert.equal(typeof envelope, 'string');
    assert.ok(envelope.startsWith('v1:'));

    const decrypted = decryptSecret(envelope);
    assert.equal(decrypted, secret);
  });

  test('round-trip encryption and decryption with 64 hex characters key', () => {
    process.env.ENCRYPTION_KEY = DETERMINISTIC_HEX_KEY;
    reset();

    const secret = 'hex-key-secret-payload-abc-987';
    const envelope = encryptSecret(secret);
    const decrypted = decryptSecret(envelope);
    assert.equal(decrypted, secret);
  });

  test('cross-compatibility: encrypt with base64 key, decrypt with identical hex key', () => {
    process.env.ENCRYPTION_KEY = DETERMINISTIC_B64_KEY;
    reset();
    const secret = 'cross-key-format-secret';
    const envelope = encryptSecret(secret);

    // Switch key to 64 hex characters of the exact same 32 bytes
    process.env.ENCRYPTION_KEY = DETERMINISTIC_HEX_KEY;
    reset();
    assert.equal(decryptSecret(envelope), secret);
  });

  test('round-trip encryption and decryption with unicode secrets', () => {
    const unicodeSecrets = [
      'عماد پورسینا 🚀 🔑 日本語',
      'Special chars: \u0000 \t \r\n <html>"\'&\\',
      'Multi-byte emojis: 👨‍👩‍👧‍👦 🏳️‍🌈 ✨ 💻',
      'Accented: résumé, naïve, señor, café, über',
    ];

    for (const secret of unicodeSecrets) {
      const envelope = encryptSecret(secret);
      assert.equal(decryptSecret(envelope), secret);
    }
  });

  test('two encryptions of the same plaintext produce different envelopes', () => {
    const plaintext = 'identical-secret-payload';
    const env1 = encryptSecret(plaintext);
    const env2 = encryptSecret(plaintext);

    assert.notEqual(env1, env2);
    assert.equal(decryptSecret(env1), plaintext);
    assert.equal(decryptSecret(env2), plaintext);

    // IVs must differ
    const iv1 = env1.split(':')[1];
    const iv2 = env2.split(':')[1];
    assert.notEqual(iv1, iv2);
  });

  test('the envelope string never contains the plaintext', () => {
    const secret = 'distinctive-super-secret-password-xyz';
    const envelope = encryptSecret(secret);
    assert.equal(envelope.includes(secret), false);
  });

  test('tampering ciphertext fails with decrypt_failed', () => {
    const secret = 'important-smtp-password';
    const envelope = encryptSecret(secret);
    const parts = envelope.split(':');

    // Flip bits in the base64-decoded ciphertext
    const ctBuf = Buffer.from(parts[3], 'base64');
    ctBuf[0] ^= 0x01;
    parts[3] = ctBuf.toString('base64');
    const tampered = parts.join(':');

    assert.throws(
      () => decryptSecret(tampered),
      (err) => err instanceof SecretError && err.code === 'decrypt_failed'
    );
  });

  test('tampering auth tag fails with decrypt_failed', () => {
    const secret = 'important-smtp-password';
    const envelope = encryptSecret(secret);
    const parts = envelope.split(':');

    // Flip bits in the auth tag
    const tagBuf = Buffer.from(parts[2], 'base64');
    tagBuf[0] ^= 0x01;
    parts[2] = tagBuf.toString('base64');
    const tampered = parts.join(':');

    assert.throws(
      () => decryptSecret(tampered),
      (err) => err instanceof SecretError && err.code === 'decrypt_failed'
    );
  });

  test('tampering IV fails with decrypt_failed', () => {
    const secret = 'important-smtp-password';
    const envelope = encryptSecret(secret);
    const parts = envelope.split(':');

    // Flip bits in the IV
    const ivBuf = Buffer.from(parts[1], 'base64');
    ivBuf[0] ^= 0x01;
    parts[1] = ivBuf.toString('base64');
    const tampered = parts.join(':');

    assert.throws(
      () => decryptSecret(tampered),
      (err) => err instanceof SecretError && err.code === 'decrypt_failed'
    );
  });

  test('decrypting with a different valid 32-byte key fails with decrypt_failed', () => {
    const secret = 'confidential-data';
    const envelope = encryptSecret(secret);

    // Switch to a different valid 32-byte key
    const otherKey = Buffer.alloc(32, 0xee).toString('base64');
    process.env.ENCRYPTION_KEY = otherKey;
    reset();

    assert.throws(
      () => decryptSecret(envelope),
      (err) => err instanceof SecretError && err.code === 'decrypt_failed'
    );
  });

  test('invalid key forms each throw key_invalid', () => {
    const invalidKeys = [
      Buffer.alloc(31, 0xaa).toString('base64'), // 31 bytes base64
      Buffer.alloc(33, 0xbb).toString('base64'), // 33 bytes base64
      'a'.repeat(63),                           // 63 hex characters
      'a'.repeat(65),                           // 65 hex characters
      'not_base64!!!',                          // invalid base64 characters
      '====',                                   // only padding
      'a'.repeat(44) + '=',                     // invalid length / padding
      'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY', // 43 chars (length not multiple of 4)
      ' '.repeat(44),                           // whitespace
    ];

    for (const badKey of invalidKeys) {
      process.env.ENCRYPTION_KEY = badKey;
      reset();

      assert.throws(
        () => encryptSecret('some plaintext'),
        (err) => err instanceof SecretError && err.code === 'key_invalid',
        `Expected key_invalid for: ${badKey.slice(0, 20)}`
      );

      assert.throws(
        () => decryptSecret('v1:0123456789abcdef:0123456789abcdef01234567:dGVzdA=='),
        (err) => err instanceof SecretError && err.code === 'key_invalid',
        `Expected key_invalid for: ${badKey.slice(0, 20)}`
      );
    }
  });

  test('absent or empty key throws key_missing', () => {
    delete process.env.ENCRYPTION_KEY;
    reset();

    assert.throws(
      () => encryptSecret('some plaintext'),
      (err) => err instanceof SecretError && err.code === 'key_missing'
    );
    assert.throws(
      () => decryptSecret('v1:0123456789abcdef:0123456789abcdef01234567:dGVzdA=='),
      (err) => err instanceof SecretError && err.code === 'key_missing'
    );

    process.env.ENCRYPTION_KEY = '';
    reset();

    assert.throws(
      () => encryptSecret('some plaintext'),
      (err) => err instanceof SecretError && err.code === 'key_missing'
    );
    assert.throws(
      () => decryptSecret('v1:0123456789abcdef:0123456789abcdef01234567:dGVzdA=='),
      (err) => err instanceof SecretError && err.code === 'key_missing'
    );
  });

  test('encryptSecret validates plaintext input', () => {
    const invalidInputs = ['', null, undefined, 12345, {}, [], false];

    for (const input of invalidInputs) {
      assert.throws(
        () => encryptSecret(input),
        (err) => err instanceof SecretError && err.code === 'invalid_input'
      );
    }
  });

  test('malformed envelopes throw decrypt_failed without leaking secrets', () => {
    const validEnvelope = encryptSecret('valid-payload');
    const parts = validEnvelope.split(':');
    const [v, ivB64, tagB64, ctB64] = parts;

    const malformedCases = [
      `v2:${ivB64}:${tagB64}:${ctB64}`,                // wrong version
      `v1:${ivB64}:${tagB64}`,                         // 3 parts
      `v1:${ivB64}:${tagB64}:${ctB64}:extra`,          // 5 parts
      `v1`,                                            // 1 part
      `v1:bad_base64!:${tagB64}:${ctB64}`,             // bad base64 IV
      `v1:${ivB64}:bad_base64!:${ctB64}`,             // bad base64 tag
      `v1:${ivB64}:${tagB64}:bad_base64!`,             // bad base64 ciphertext
      `v1:${Buffer.alloc(8).toString('base64')}:${tagB64}:${ctB64}`,  // IV length 8 != 12
      `v1:${Buffer.alloc(16).toString('base64')}:${tagB64}:${ctB64}`, // IV length 16 != 12
      `v1:${ivB64}:${Buffer.alloc(12).toString('base64')}:${ctB64}`, // tag length 12 != 16
      `v1:${ivB64}:${tagB64}:`,                        // empty ciphertext
      '',                                              // empty string
      null,                                            // non-string null
      undefined,                                       // non-string undefined
      12345,                                           // non-string number
      {},                                              // non-string object
    ];

    for (const malformed of malformedCases) {
      assert.throws(
        () => decryptSecret(malformed),
        (err) => {
          assert.ok(err instanceof SecretError);
          assert.equal(err.code, 'decrypt_failed');
          assert.equal(err.message.includes('valid-payload'), false);
          assert.equal(err.message.includes(DETERMINISTIC_B64_KEY), false);
          return true;
        }
      );
    }
  });

  test('maskSecret masks values correctly', () => {
    // length < 8 -> '••••'
    assert.equal(maskSecret('1234567'), '••••');
    assert.equal(maskSecret('123456'), '••••');
    assert.equal(maskSecret('a'), '••••');
    assert.equal(maskSecret(''), '••••');

    // length == 8 -> '••••' + last four
    assert.equal(maskSecret('12345678'), '••••5678');
    assert.equal(maskSecret('abcdefgh'), '••••efgh');

    // length == 20 -> '••••' + last four only
    assert.equal(maskSecret('12345678901234567890'), '••••7890');
    assert.equal(maskSecret('abcdefghijklmnopqrst'), '••••qrst');

    // non-strings -> '••••'
    assert.equal(maskSecret(null), '••••');
    assert.equal(maskSecret(undefined), '••••');
    assert.equal(maskSecret(12345678), '••••');
    assert.equal(maskSecret({}), '••••');
    assert.equal(maskSecret([]), '••••');
    assert.equal(maskSecret(true), '••••');
  });

  test('missing or invalid key emits console.warn at most once per process and never contains key material', () => {
    const distinctiveKey = 'distinctive-key-to-check-sanitization-12345';
    process.env.ENCRYPTION_KEY = distinctiveKey;
    reset();

    assert.throws(
      () => encryptSecret('sample'),
      (err) => err instanceof SecretError && err.code === 'key_invalid'
    );

    delete process.env.ENCRYPTION_KEY;
    reset();

    assert.throws(
      () => encryptSecret('sample'),
      (err) => err instanceof SecretError && err.code === 'key_missing'
    );

    const secretsWarnings = capturedWarnings.filter((w) => w.includes('[secrets]'));
    assert.equal(secretsWarnings.length, 1, 'Secrets module must emit console.warn at most once per process');
    assert.match(secretsWarnings[0], /missing or invalid/i);

    // Verify no warning ever contains key material or values
    for (const w of capturedWarnings) {
      assert.equal(w.includes(distinctiveKey), false, 'Warning must not contain invalid key');
      assert.equal(w.includes(DETERMINISTIC_B64_KEY), false, 'Warning must not contain valid base64 key');
      assert.equal(w.includes(DETERMINISTIC_HEX_KEY), false, 'Warning must not contain valid hex key');
    }
  });
});
