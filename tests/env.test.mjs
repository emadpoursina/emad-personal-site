/**
 * tests/env.test.mjs
 *
 * Unit tests for assistant and admin environment configuration in src/lib/env.mjs.
 * Verifies defaults, raw strings, integer parsing, fallback on invalid numbers,
 * timeout clamping at 30,000 ms, one-warning-only behavior, and secret sanitization in logs.
 *
 * Run with: node --experimental-sqlite --test tests/env.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, config, reset } from '../src/lib/env.mjs';

const NEW_ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ENCRYPTION_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_API_KEY',
  'ASK_DAILY_CAP',
  'ASK_RATE_LIMIT_PER_HOUR',
  'AI_TIMEOUT_MS',
];

describe('src/lib/env.mjs - assistant and admin configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
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

  test('defaults for all eight new names', () => {
    for (const key of NEW_ENV_KEYS) {
      delete process.env[key];
    }

    const conf = getConfig();
    assert.equal(conf.ADMIN_PASSWORD_HASH, '');
    assert.equal(conf.ENCRYPTION_KEY, '');
    assert.equal(conf.AI_BASE_URL, '');
    assert.equal(conf.AI_MODEL, '');
    assert.equal(conf.AI_API_KEY, '');
    assert.equal(conf.ASK_DAILY_CAP, 200);
    assert.equal(conf.ASK_RATE_LIMIT_PER_HOUR, 10);
    assert.equal(conf.AI_TIMEOUT_MS, 30000);
  });

  test('string values are returned raw without modification', () => {
    process.env.ADMIN_PASSWORD_HASH = 'scrypt$16384$8$1$salt$hash';
    process.env.ENCRYPTION_KEY = 'base64encryptionkey==';
    process.env.AI_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.AI_MODEL = 'anthropic/claude-haiku-5.5';
    process.env.AI_API_KEY = 'sk-or-v1-secret-token';

    const conf = getConfig();
    assert.equal(conf.ADMIN_PASSWORD_HASH, 'scrypt$16384$8$1$salt$hash');
    assert.equal(conf.ENCRYPTION_KEY, 'base64encryptionkey==');
    assert.equal(conf.AI_BASE_URL, 'https://openrouter.ai/api/v1');
    assert.equal(conf.AI_MODEL, 'anthropic/claude-haiku-5.5');
    assert.equal(conf.AI_API_KEY, 'sk-or-v1-secret-token');
  });

  test('integer parsing for valid numbers within range', () => {
    process.env.ASK_DAILY_CAP = '500';
    process.env.ASK_RATE_LIMIT_PER_HOUR = '25';
    process.env.AI_TIMEOUT_MS = '15000';

    const conf = getConfig();
    assert.equal(conf.ASK_DAILY_CAP, 500);
    assert.equal(conf.ASK_RATE_LIMIT_PER_HOUR, 25);
    assert.equal(conf.AI_TIMEOUT_MS, 15000);
  });

  test('integer parsing accepts boundary values', () => {
    process.env.ASK_DAILY_CAP = '1';
    process.env.ASK_RATE_LIMIT_PER_HOUR = '1';
    process.env.AI_TIMEOUT_MS = '1';

    let conf = getConfig();
    assert.equal(conf.ASK_DAILY_CAP, 1);
    assert.equal(conf.ASK_RATE_LIMIT_PER_HOUR, 1);
    assert.equal(conf.AI_TIMEOUT_MS, 1);

    reset();
    process.env.ASK_DAILY_CAP = '100000';
    process.env.ASK_RATE_LIMIT_PER_HOUR = '1000';
    process.env.AI_TIMEOUT_MS = '30000';

    conf = getConfig();
    assert.equal(conf.ASK_DAILY_CAP, 100000);
    assert.equal(conf.ASK_RATE_LIMIT_PER_HOUR, 1000);
    assert.equal(conf.AI_TIMEOUT_MS, 30000);
  });

  test('invalid-number fallback for ASK_DAILY_CAP (non-integer, out of bounds, negative, zero)', () => {
    const invalidCases = ['not-a-number', '0', '-5', '100001', '12.34', '100abc'];
    for (const invalid of invalidCases) {
      reset();
      process.env.ASK_DAILY_CAP = invalid;
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
      try {
        const conf = getConfig();
        assert.equal(conf.ASK_DAILY_CAP, 200);
        assert.equal(
          warnings.some((w) => w.includes('ASK_DAILY_CAP')),
          true,
          `Expected warning for ASK_DAILY_CAP=${invalid}`
        );
      } finally {
        console.warn = origWarn;
      }
    }
  });

  test('invalid-number fallback for ASK_RATE_LIMIT_PER_HOUR (non-integer, out of bounds, negative, zero)', () => {
    const invalidCases = ['not-an-int', '0', '-1', '1001', '5.5'];
    for (const invalid of invalidCases) {
      reset();
      process.env.ASK_RATE_LIMIT_PER_HOUR = invalid;
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
      try {
        const conf = getConfig();
        assert.equal(conf.ASK_RATE_LIMIT_PER_HOUR, 10);
        assert.equal(
          warnings.some((w) => w.includes('ASK_RATE_LIMIT_PER_HOUR')),
          true,
          `Expected warning for ASK_RATE_LIMIT_PER_HOUR=${invalid}`
        );
      } finally {
        console.warn = origWarn;
      }
    }
  });

  test('invalid-number fallback for AI_TIMEOUT_MS (non-integer, zero, negative)', () => {
    const invalidCases = ['bad-timeout', '0', '-500', '12.5'];
    for (const invalid of invalidCases) {
      reset();
      process.env.AI_TIMEOUT_MS = invalid;
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
      try {
        const conf = getConfig();
        assert.equal(conf.AI_TIMEOUT_MS, 30000);
        assert.equal(
          warnings.some((w) => w.includes('AI_TIMEOUT_MS')),
          true,
          `Expected warning for AI_TIMEOUT_MS=${invalid}`
        );
      } finally {
        console.warn = origWarn;
      }
    }
  });

  test('AI_TIMEOUT_MS clamps values above 30000 to 30000 without crashing', () => {
    process.env.AI_TIMEOUT_MS = '60000';
    let conf = getConfig();
    assert.equal(conf.AI_TIMEOUT_MS, 30000);

    reset();
    process.env.AI_TIMEOUT_MS = '999999';
    conf = getConfig();
    assert.equal(conf.AI_TIMEOUT_MS, 30000);
  });

  test('one-warning-only behaviour: repeated config() calls do not duplicate feature warnings', () => {
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    delete process.env.AI_API_KEY;
    delete process.env.ADMIN_PASSWORD_HASH;
    delete process.env.ENCRYPTION_KEY;

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      reset();
      config();
      config();
      getConfig();

      const assistantWarnings = warnings.filter((w) => w.includes('Ask assistant'));
      const adminWarnings = warnings.filter((w) => w.includes('Admin settings'));

      assert.equal(assistantWarnings.length, 1);
      assert.equal(adminWarnings.length, 1);
    } finally {
      console.warn = origWarn;
    }
  });

  test('reset() clears warning set allowing new cycle to emit warnings again without duplicating within cycle', () => {
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    delete process.env.AI_API_KEY;

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      reset();
      getConfig();
      getConfig();
      const firstCycleCount = warnings.filter((w) => w.includes('Ask assistant')).length;
      assert.equal(firstCycleCount, 1, 'First cycle must warn exactly once');

      reset();
      getConfig();
      getConfig();
      const secondCycleCount = warnings.filter((w) => w.includes('Ask assistant')).length;
      assert.equal(secondCycleCount, 2, 'Second cycle after reset must warn once more (total 2)');
    } finally {
      console.warn = origWarn;
    }
  });

  test('warns once when assistant is unconfigured if AI_BASE_URL, AI_MODEL, or AI_API_KEY is empty', () => {
    const unconfiguredCombinations = [
      { AI_BASE_URL: '', AI_MODEL: 'model', AI_API_KEY: 'key' },
      { AI_BASE_URL: 'https://api.com', AI_MODEL: '', AI_API_KEY: 'key' },
      { AI_BASE_URL: 'https://api.com', AI_MODEL: 'model', AI_API_KEY: '' },
    ];

    for (const combo of unconfiguredCombinations) {
      reset();
      Object.assign(process.env, combo);
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
      try {
        getConfig();
        const assistantWarnings = warnings.filter((w) => w.includes('Ask assistant'));
        assert.equal(assistantWarnings.length, 1);
      } finally {
        console.warn = origWarn;
      }
    }

    // Configured: no assistant warning
    reset();
    process.env.AI_BASE_URL = 'https://api.com';
    process.env.AI_MODEL = 'model';
    process.env.AI_API_KEY = 'key';
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      getConfig();
      const assistantWarnings = warnings.filter((w) => w.includes('Ask assistant'));
      assert.equal(assistantWarnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });

  test('warns once when admin is unconfigured if ADMIN_PASSWORD_HASH or ENCRYPTION_KEY is empty', () => {
    const unconfiguredCombinations = [
      { ADMIN_PASSWORD_HASH: '', ENCRYPTION_KEY: 'key' },
      { ADMIN_PASSWORD_HASH: 'hash', ENCRYPTION_KEY: '' },
    ];

    for (const combo of unconfiguredCombinations) {
      reset();
      Object.assign(process.env, combo);
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
      try {
        getConfig();
        const adminWarnings = warnings.filter((w) => w.includes('Admin settings'));
        assert.equal(adminWarnings.length, 1);
      } finally {
        console.warn = origWarn;
      }
    }

    // Configured: no admin warning
    reset();
    process.env.ADMIN_PASSWORD_HASH = 'hash';
    process.env.ENCRYPTION_KEY = 'key';
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      getConfig();
      const adminWarnings = warnings.filter((w) => w.includes('Admin settings'));
      assert.equal(adminWarnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });

  test('no warning output contains a secret value that was set in the test environment', () => {
    const secretApiKey = 'super-distinctive-secret-key-xyz-987';
    const secretHash = 'super-distinctive-password-hash-abc-123';
    const secretEncryptionKey = 'super-distinctive-encryption-key-456';
    const secretSmtpPass = 'super-distinctive-smtp-pass-789';
    const invalidDailyCap = 'invalid-cap-marker-999';

    process.env.AI_API_KEY = secretApiKey;
    delete process.env.AI_BASE_URL; // triggers assistant unconfigured warning
    process.env.ADMIN_PASSWORD_HASH = secretHash;
    delete process.env.ENCRYPTION_KEY; // triggers admin unconfigured warning
    process.env.SMTP_PASS = secretSmtpPass;
    delete process.env.SMTP_HOST; // triggers smtp disabled warning
    process.env.ASK_DAILY_CAP = invalidDailyCap; // triggers invalid number warning

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      getConfig();
      const allWarnings = warnings.join('\n');
      assert.equal(allWarnings.includes(secretApiKey), false, 'AI_API_KEY must never appear in warnings');
      assert.equal(allWarnings.includes(secretHash), false, 'ADMIN_PASSWORD_HASH must never appear in warnings');
      assert.equal(allWarnings.includes(secretEncryptionKey), false, 'ENCRYPTION_KEY must never appear in warnings');
      assert.equal(allWarnings.includes(secretSmtpPass), false, 'SMTP_PASS must never appear in warnings');
      assert.equal(allWarnings.includes(invalidDailyCap), false, 'Configured value must never appear in warnings');
    } finally {
      console.warn = origWarn;
    }
  });
});
