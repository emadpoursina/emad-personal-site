/**
 * tests/settings.test.mjs
 *
 * Unit tests for src/lib/settings.mjs.
 * Proves:
 * - Precedence: admin > env > default for non-secrets and secrets; sources matches.
 * - Blank non-secret deletes override; blank secret leaves envelope byte-identical;
 *   non-blank secret writes v1: envelope without plaintext appearing in SQLite file bytes.
 * - Every validation message from data-model.md is asserted once; one invalid field
 *   prevents all writes.
 * - URL rules: https ok, localhost http ok, [::1] ok, plain http non-localhost rejected,
 *   credentials rejected, >500 rejected, generatorEndpoint blank allowed.
 * - Wrong-key fail-closed: secret saved under key A, reopened with key B -> effective aiApiKey='',
 *   aiConfigured=false, hasApiKey=false, and env AI_API_KEY is NOT used.
 * - Masking: length >= 8 shows •••• + last four; short secret shows ••••; full secret never
 *   in getMaskedSettings() or its JSON.stringify.
 *
 * Run with: node --experimental-sqlite --test tests/settings.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as db from '../src/lib/db.mjs';
import { reset as resetEnv } from '../src/lib/env.mjs';
import {
  SETTINGS_FIELDS,
  getEffectiveSettings,
  getEffectiveSmtp,
  getEffectiveGenerator,
  getMaskedSettings,
  saveSettings,
  resetSettingsWarnings,
} from '../src/lib/settings.mjs';

const KEY_A = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const KEY_B = Buffer.from('fedcba9876543210fedcba9876543210', 'utf8').toString('base64');

describe('src/lib/settings.mjs', () => {
  let tempDir;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'settings-test-'));
    process.env.DATA_DIR = tempDir;
    process.env.ENCRYPTION_KEY = KEY_A;
    resetEnv();
    db.close();
    resetSettingsWarnings();
  });

  afterEach(() => {
    db.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    resetEnv();
    resetSettingsWarnings();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('SETTINGS_FIELDS exports all 12 form fields mapped to DB key and secret type', () => {
    const expected = {
      aiBaseUrl: { key: 'ai.baseUrl', type: 'non-secret' },
      aiModel: { key: 'ai.model', type: 'non-secret' },
      aiApiKey: { key: 'ai.apiKey', type: 'secret' },
      askDailyCap: { key: 'ask.dailyCap', type: 'non-secret' },
      askRateLimitPerHour: { key: 'ask.rateLimitPerHour', type: 'non-secret' },
      smtpHost: { key: 'smtp.host', type: 'non-secret' },
      smtpPort: { key: 'smtp.port', type: 'non-secret' },
      smtpSecure: { key: 'smtp.secure', type: 'non-secret' },
      smtpUser: { key: 'smtp.user', type: 'non-secret' },
      smtpPass: { key: 'smtp.pass', type: 'secret' },
      smtpFrom: { key: 'smtp.from', type: 'non-secret' },
      generatorEndpoint: { key: 'generator.endpoint', type: 'non-secret' },
    };

    assert.equal(Object.keys(SETTINGS_FIELDS).length, 12);
    for (const [field, meta] of Object.entries(expected)) {
      assert.ok(SETTINGS_FIELDS[field], `field ${field} must exist`);
      assert.equal(SETTINGS_FIELDS[field].key, meta.key);
      assert.equal(SETTINGS_FIELDS[field].type, meta.type);
    }
  });

  test('built-in defaults when DB and env are empty', () => {
    // Ensure relevant env vars are absent
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    delete process.env.AI_API_KEY;
    delete process.env.ASK_DAILY_CAP;
    delete process.env.ASK_RATE_LIMIT_PER_HOUR;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    delete process.env.GENERATOR_ENDPOINT;
    resetEnv();

    const eff = getEffectiveSettings();
    assert.equal(eff.aiBaseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(eff.aiModel, 'anthropic/claude-haiku-5.5');
    assert.equal(eff.aiApiKey, '');
    assert.equal(eff.askDailyCap, 200);
    assert.equal(eff.askRateLimitPerHour, 10);
    assert.equal(eff.smtpHost, '');
    assert.equal(eff.smtpPort, 587);
    assert.equal(eff.smtpSecure, false);
    assert.equal(eff.smtpUser, '');
    assert.equal(eff.smtpPass, '');
    assert.equal(eff.smtpFrom, 'Emad Poursina <emad.poursina.work@gmail.com>');
    assert.equal(eff.generatorEndpoint, '');
    assert.equal(eff.aiConfigured, false);

    const smtp = getEffectiveSmtp();
    assert.deepEqual(smtp, {
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      from: 'Emad Poursina <emad.poursina.work@gmail.com>',
      enabled: false,
    });

    const masked = getMaskedSettings();
    assert.equal(masked.aiBaseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(masked.aiModel, 'anthropic/claude-haiku-5.5');
    assert.equal(masked.hasApiKey, false);
    assert.equal(masked.hasSmtpPass, false);
    assert.equal(masked.apiKeyMasked, '');
    assert.equal(masked.smtpPassMasked, '');
    assert.equal(masked.aiConfigured, false);
    for (const key of Object.keys(SETTINGS_FIELDS)) {
      assert.equal(masked.sources[key], 'default');
    }
  });

  test('precedence: admin > env > default for non-secrets and secrets; sources matches', () => {
    // 1. Initial defaults
    delete process.env.SMTP_HOST;
    delete process.env.AI_API_KEY;
    resetEnv();

    let eff = getEffectiveSettings();
    let masked = getMaskedSettings();
    assert.equal(eff.smtpHost, '');
    assert.equal(eff.aiApiKey, '');
    assert.equal(masked.sources.smtpHost, 'default');
    assert.equal(masked.sources.aiApiKey, 'default');
    assert.equal(eff.aiConfigured, false);

    // 2. Set env variables
    process.env.SMTP_HOST = 'smtp.env.example.com';
    process.env.AI_API_KEY = 'env-api-key-12345678';
    resetEnv();

    eff = getEffectiveSettings();
    masked = getMaskedSettings();
    assert.equal(eff.smtpHost, 'smtp.env.example.com');
    assert.equal(eff.aiApiKey, 'env-api-key-12345678');
    assert.equal(masked.sources.smtpHost, 'env');
    assert.equal(masked.sources.aiApiKey, 'env');
    assert.equal(masked.hasApiKey, true);
    assert.equal(masked.apiKeyMasked, '••••5678');
    assert.equal(eff.aiConfigured, true);

    // 3. Save admin overrides
    const saveRes = saveSettings({
      smtpHost: 'smtp.admin.example.com',
      aiApiKey: 'admin-api-key-99999999',
    });
    assert.equal(saveRes.ok, true);

    eff = getEffectiveSettings();
    masked = getMaskedSettings();
    assert.equal(eff.smtpHost, 'smtp.admin.example.com');
    assert.equal(eff.aiApiKey, 'admin-api-key-99999999');
    assert.equal(masked.sources.smtpHost, 'admin');
    assert.equal(masked.sources.aiApiKey, 'admin');
    assert.equal(masked.apiKeyMasked, '••••9999');
    assert.equal(eff.aiConfigured, true);

    // 4. Clear admin non-secret override (blank deletes row, reverts to env)
    saveSettings({ smtpHost: '' });
    eff = getEffectiveSettings();
    masked = getMaskedSettings();
    assert.equal(eff.smtpHost, 'smtp.env.example.com');
    assert.equal(masked.sources.smtpHost, 'env');
    // Secret left unchanged by blank save
    saveSettings({ aiApiKey: '' });
    eff = getEffectiveSettings();
    assert.equal(eff.aiApiKey, 'admin-api-key-99999999');
    assert.equal(masked.sources.aiApiKey, 'admin');

    // 5. Remove env var -> reverts to default
    delete process.env.SMTP_HOST;
    resetEnv();
    eff = getEffectiveSettings();
    masked = getMaskedSettings();
    assert.equal(eff.smtpHost, '');
    assert.equal(masked.sources.smtpHost, 'default');
  });

  test('blank non-secret deletes override; blank secret leaves envelope byte-identical; non-blank secret writes v1: envelope without plaintext in SQLite', () => {
    const secretPlaintext = 'my-ultra-secret-token-abcdef123';
    const res = saveSettings({
      smtpHost: 'smtp.original.org',
      aiApiKey: secretPlaintext,
    });
    assert.equal(res.ok, true);

    // Read raw sqlite file bytes
    const sqlitePath = join(tempDir, 'site.sqlite');
    const fileBytes = readFileSync(sqlitePath);
    const fileContent = fileBytes.toString('utf8');

    // Envelope header appears in DB, but plaintext never appears anywhere in the file bytes
    assert.ok(fileContent.includes('v1:'), 'SQLite file must contain v1: envelope header');
    assert.ok(!fileContent.includes(secretPlaintext), 'Plaintext must NEVER appear in SQLite file bytes');

    // Get stored envelope directly from DB
    const firstEnvelope = db.getSetting('ai.apiKey');
    assert.ok(firstEnvelope && firstEnvelope.startsWith('v1:'));

    // Blank secret save leaves envelope byte-identical
    const blankSecretRes = saveSettings({ aiApiKey: '' });
    assert.equal(blankSecretRes.ok, true);
    const secondEnvelope = db.getSetting('ai.apiKey');
    assert.equal(secondEnvelope, firstEnvelope, 'Blank secret must leave stored envelope byte-identical');

    // Absent secret in save also leaves envelope byte-identical
    saveSettings({ smtpUser: 'admin-user' });
    const thirdEnvelope = db.getSetting('ai.apiKey');
    assert.equal(thirdEnvelope, firstEnvelope, 'Absent secret must leave stored envelope byte-identical');

    // Blank non-secret deletes override
    assert.equal(db.getSetting('smtp.host'), 'smtp.original.org');
    const deleteRes = saveSettings({ smtpHost: '' });
    assert.equal(deleteRes.ok, true);
    assert.equal(db.getSetting('smtp.host'), null, 'Blank non-secret must delete setting row');
  });

  test('every validation message from data-model is asserted once; one invalid field means no row changes', () => {
    // 1. aiBaseUrl
    const r1 = saveSettings({ aiBaseUrl: 'ftp://invalid-url.com' });
    assert.deepEqual(r1, {
      ok: false,
      errors: { aiBaseUrl: 'Enter an HTTPS base URL (localhost may use HTTP).' },
    });

    // 2. aiModel
    const r2 = saveSettings({ aiModel: 'a'.repeat(201) });
    assert.deepEqual(r2, {
      ok: false,
      errors: { aiModel: 'Enter a model ID.' },
    });

    // 3. aiApiKey
    const r3 = saveSettings({ aiApiKey: 'bad\nkey' });
    assert.deepEqual(r3, {
      ok: false,
      errors: { aiApiKey: 'Enter a valid API key.' },
    });

    // 4. askDailyCap
    const r4 = saveSettings({ askDailyCap: '100001' });
    assert.deepEqual(r4, {
      ok: false,
      errors: { askDailyCap: 'Daily cap must be a whole number between 1 and 100000.' },
    });

    // 5. askRateLimitPerHour
    const r5 = saveSettings({ askRateLimitPerHour: '1001' });
    assert.deepEqual(r5, {
      ok: false,
      errors: { askRateLimitPerHour: 'Rate limit must be a whole number between 1 and 1000.' },
    });

    // 6. smtpHost
    const r6 = saveSettings({ smtpHost: 'host with spaces' });
    assert.deepEqual(r6, {
      ok: false,
      errors: { smtpHost: 'Enter a valid SMTP host.' },
    });

    // 7. smtpPort
    const r7 = saveSettings({ smtpPort: '70000' });
    assert.deepEqual(r7, {
      ok: false,
      errors: { smtpPort: 'Port must be between 1 and 65535.' },
    });

    // 8. smtpUser
    const r8 = saveSettings({ smtpUser: 'user\x00withcontrol' });
    assert.deepEqual(r8, {
      ok: false,
      errors: { smtpUser: 'Enter a valid SMTP username.' },
    });

    // 9. smtpPass
    const r9 = saveSettings({ smtpPass: 'pass\r\nwithnewlines' });
    assert.deepEqual(r9, {
      ok: false,
      errors: { smtpPass: 'Enter a valid SMTP password.' },
    });

    // 10. smtpFrom
    const r10 = saveSettings({ smtpFrom: 'Invalid From Without At' });
    assert.deepEqual(r10, {
      ok: false,
      errors: { smtpFrom: 'Enter a valid from address.' },
    });

    // 11. generatorEndpoint
    const r11 = saveSettings({ generatorEndpoint: 'http://non-localhost.org' });
    assert.deepEqual(r11, {
      ok: false,
      errors: { generatorEndpoint: 'Enter an HTTPS endpoint (localhost may use HTTP).' },
    });

    // One invalid field means no row changes across all submitted fields
    const rMixed = saveSettings({
      aiBaseUrl: 'https://valid-target.com',
      smtpPort: 0, // invalid port (< 1)
    });
    assert.equal(rMixed.ok, false);
    assert.equal(rMixed.errors.smtpPort, 'Port must be between 1 and 65535.');
    assert.equal(db.getSetting('ai.baseUrl'), null, 'Valid field must not be written when another field fails');
    assert.equal(db.getSetting('smtp.port'), null);
  });

  test('non-blank secret when ENCRYPTION_KEY is missing/invalid produces field error with no write', () => {
    // Missing encryption key
    delete process.env.ENCRYPTION_KEY;
    resetEnv();

    const rApiKey = saveSettings({ aiApiKey: 'some-valid-key-format' });
    assert.deepEqual(rApiKey, {
      ok: false,
      errors: { aiApiKey: 'Secret storage is unavailable.' },
    });
    assert.equal(db.getSetting('ai.apiKey'), null);

    const rSmtpPass = saveSettings({ smtpPass: 'some-valid-pass-format' });
    assert.deepEqual(rSmtpPass, {
      ok: false,
      errors: { smtpPass: 'Secret storage is unavailable.' },
    });
    assert.equal(db.getSetting('smtp.pass'), null);

    // Invalid encryption key
    process.env.ENCRYPTION_KEY = 'invalid-key-not-32-bytes';
    resetEnv();

    const rApiKeyInvalid = saveSettings({ aiApiKey: 'some-valid-key-format' });
    assert.deepEqual(rApiKeyInvalid, {
      ok: false,
      errors: { aiApiKey: 'Secret storage is unavailable.' },
    });
    assert.equal(db.getSetting('ai.apiKey'), null);

    const rSmtpPassInvalid = saveSettings({ smtpPass: 'some-valid-pass-format' });
    assert.deepEqual(rSmtpPassInvalid, {
      ok: false,
      errors: { smtpPass: 'Secret storage is unavailable.' },
    });
    assert.equal(db.getSetting('smtp.pass'), null);
  });

  test('URL rules: https ok, localhost http ok, [::1] ok, plain http rejected, credentials rejected, >500 rejected, generatorEndpoint blank allowed', () => {
    // 1. https ok with trailing slash trimmed
    const rHttps = saveSettings({ aiBaseUrl: 'https://openrouter.ai/api/v1/' });
    assert.equal(rHttps.ok, true);
    assert.equal(getEffectiveSettings().aiBaseUrl, 'https://openrouter.ai/api/v1');

    // 2. localhost http ok
    const rLocalhost = saveSettings({ aiBaseUrl: 'http://localhost:11434/' });
    assert.equal(rLocalhost.ok, true);
    assert.equal(getEffectiveSettings().aiBaseUrl, 'http://localhost:11434');

    // 3. 127.0.0.1 http ok
    const rIpv4 = saveSettings({ aiBaseUrl: 'http://127.0.0.1:8080/v1' });
    assert.equal(rIpv4.ok, true);
    assert.equal(getEffectiveSettings().aiBaseUrl, 'http://127.0.0.1:8080/v1');

    // 4. [::1] http ok
    const rIpv6 = saveSettings({ aiBaseUrl: 'http://[::1]:8080/v1/' });
    assert.equal(rIpv6.ok, true);
    assert.equal(getEffectiveSettings().aiBaseUrl, 'http://[::1]:8080/v1');

    // 5. Plain http non-localhost rejected
    const rPlainHttp = saveSettings({ aiBaseUrl: 'http://example.com/api' });
    assert.equal(rPlainHttp.ok, false);
    assert.ok(rPlainHttp.errors.aiBaseUrl);

    // 6. Credentials rejected
    const rCreds1 = saveSettings({ aiBaseUrl: 'https://user:pass@example.com' });
    assert.equal(rCreds1.ok, false);
    assert.ok(rCreds1.errors.aiBaseUrl);

    const rCreds2 = saveSettings({ aiBaseUrl: 'https://user@example.com' });
    assert.equal(rCreds2.ok, false);
    assert.ok(rCreds2.errors.aiBaseUrl);

    // 7. >500 chars rejected
    const longUrl = 'https://example.com/' + 'a'.repeat(500);
    const rLong = saveSettings({ aiBaseUrl: longUrl });
    assert.equal(rLong.ok, false);
    assert.ok(rLong.errors.aiBaseUrl);

    // 8. generatorEndpoint blank allowed
    const rGenBlank = saveSettings({ generatorEndpoint: '' });
    assert.equal(rGenBlank.ok, true);
    assert.equal(getEffectiveSettings().generatorEndpoint, '');

    // 9. generatorEndpoint valid URL ok with trailing slash trimmed
    const rGenValid = saveSettings({ generatorEndpoint: 'https://gen.example.com/endpoint/' });
    assert.equal(rGenValid.ok, true);
    assert.equal(getEffectiveSettings().generatorEndpoint, 'https://gen.example.com/endpoint');
  });

  test('wrong-key fail-closed: save secret under key A, reopen with key B fails closed without env fallback', () => {
    // 1. Save secret under KEY_A
    process.env.ENCRYPTION_KEY = KEY_A;
    resetEnv();

    const saveRes = saveSettings({
      aiApiKey: 'secret-under-key-a-12345678',
      smtpPass: 'smtp-under-key-a-87654321',
    });
    assert.equal(saveRes.ok, true);

    // 2. Reopen / switch process to KEY_B and set env AI_API_KEY + SMTP_PASS
    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.AI_API_KEY = 'env-key-must-not-be-used';
    process.env.SMTP_PASS = 'env-pass-must-not-be-used';
    resetEnv();
    resetSettingsWarnings();

    const capturedWarnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => capturedWarnings.push(args.join(' '));

    try {
      const eff = getEffectiveSettings();
      assert.equal(eff.aiApiKey, '', 'Decryption failure must return empty string');
      assert.equal(eff.aiConfigured, false, 'Decryption failure must result in aiConfigured=false');
      assert.notEqual(eff.aiApiKey, 'env-key-must-not-be-used', 'Must not fall back to env value');

      const masked = getMaskedSettings();
      assert.equal(masked.hasApiKey, false);
      assert.equal(masked.apiKeyMasked, '');
      assert.equal(masked.hasSmtpPass, false);
      assert.equal(masked.smtpPassMasked, '');
      assert.equal(masked.aiConfigured, false);
      assert.equal(masked.sources.aiApiKey, 'admin');

      const smtp = getEffectiveSmtp();
      assert.equal(smtp.pass, '');
      assert.equal(smtp.enabled, false);

      // Assert warning was emitted once without logging key material
      const keyWarnings = capturedWarnings.filter((w) => w.includes('AI API key'));
      assert.equal(keyWarnings.length, 1);
      assert.ok(!keyWarnings[0].includes('secret-under-key-a-12345678'));
    } finally {
      console.warn = origWarn;
    }
  });

  test('masking: length >= 8 shows •••• + last four; short secret shows ••••; full value never in getMaskedSettings or its JSON', () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    resetEnv();

    // Long secret (length 16)
    const longSecret = 'secret-long-1234';
    saveSettings({ aiApiKey: longSecret });

    let masked = getMaskedSettings();
    assert.equal(masked.hasApiKey, true);
    assert.equal(masked.apiKeyMasked, '••••1234');
    assert.equal(masked.aiApiKey, undefined, 'Raw secret must not be a property of masked view');

    let jsonStr = JSON.stringify(masked);
    assert.ok(!jsonStr.includes(longSecret), 'Plaintext must not appear in JSON.stringify(getMaskedSettings())');
    assert.ok(jsonStr.includes('••••1234'));

    // Short secret (length 6)
    const shortSecret = 'short1';
    saveSettings({ aiApiKey: shortSecret });

    masked = getMaskedSettings();
    assert.equal(masked.hasApiKey, true);
    assert.equal(masked.apiKeyMasked, '••••');

    jsonStr = JSON.stringify(masked);
    assert.ok(!jsonStr.includes(shortSecret), 'Short plaintext must not appear in JSON string');
    assert.ok(jsonStr.includes('••••'));
  });

  test('invalid environment numbers or URLs fall back to built-in default with one warning', () => {
    process.env.ASK_DAILY_CAP = 'invalid-number';
    process.env.ASK_RATE_LIMIT_PER_HOUR = 'abc';
    process.env.SMTP_PORT = 'not-a-port';
    process.env.AI_BASE_URL = 'http://insecure-remote.example.com';
    process.env.GENERATOR_ENDPOINT = 'http://insecure-remote.example.com';
    resetEnv();
    resetSettingsWarnings();

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const eff1 = getEffectiveSettings();
      assert.equal(eff1.askDailyCap, 200, 'Invalid ASK_DAILY_CAP falls back to 200');
      assert.equal(eff1.askRateLimitPerHour, 10, 'Invalid ASK_RATE_LIMIT_PER_HOUR falls back to 10');
      assert.equal(eff1.smtpPort, 587, 'Invalid SMTP_PORT falls back to 587');
      assert.equal(eff1.aiBaseUrl, 'https://openrouter.ai/api/v1', 'Invalid AI_BASE_URL falls back to default');
      assert.equal(eff1.generatorEndpoint, '', 'Invalid GENERATOR_ENDPOINT falls back to empty');

      // Second call does not duplicate warnings
      const eff2 = getEffectiveSettings();
      assert.equal(eff2.askDailyCap, 200);

      const capWarnings = warnings.filter((w) => w.includes('[settings]') && w.includes('ASK_DAILY_CAP'));
      assert.equal(capWarnings.length, 1, 'Must warn exactly once per invalid env variable in settings');

      const portWarnings = warnings.filter((w) => w.includes('[settings]') && w.includes('SMTP_PORT'));
      assert.equal(portWarnings.length, 1);

      const urlWarnings = warnings.filter((w) => w.includes('[settings]') && w.includes('AI_BASE_URL'));
      assert.equal(urlWarnings.length, 1);
    } finally {
      console.warn = origWarn;
    }
  });

  test('smtpSecure always writes explicit true/false row; absent -> false', () => {
    // Explicit true boolean
    saveSettings({ smtpSecure: true });
    assert.equal(db.getSetting('smtp.secure'), 'true');
    assert.equal(getEffectiveSettings().smtpSecure, true);

    // String 'on' (HTML form checkbox submission)
    saveSettings({ smtpSecure: 'on' });
    assert.equal(db.getSetting('smtp.secure'), 'true');
    assert.equal(getEffectiveSettings().smtpSecure, true);

    // Explicit false
    saveSettings({ smtpSecure: false });
    assert.equal(db.getSetting('smtp.secure'), 'false');
    assert.equal(getEffectiveSettings().smtpSecure, false);

    // Absent from input -> writes 'false'
    saveSettings({ smtpHost: 'smtp.test.com' });
    assert.equal(db.getSetting('smtp.secure'), 'false');
    assert.equal(getEffectiveSettings().smtpSecure, false);
  });

  describe('getEffectiveGenerator()', () => {
    test('(a) admin-over-env: admin generator.endpoint row wins over valid GENERATOR_ENDPOINT env value and trims trailing slashes', () => {
      process.env.GENERATOR_ENDPOINT = 'https://env-endpoint.example.com/api/';
      process.env.GENERATOR_API_KEY = 'secret-test-key';

      // Before admin row: env is used, trailing slash stripped
      let gen = getEffectiveGenerator();
      assert.equal(gen.endpoint, 'https://env-endpoint.example.com/api');
      assert.equal(gen.apiKey, 'secret-test-key');
      assert.equal(gen.configured, true);

      // Save admin row with multiple trailing slashes
      const res = saveSettings({ generatorEndpoint: 'https://admin-endpoint.example.com/v1///' });
      assert.ok(res.ok);

      gen = getEffectiveGenerator();
      assert.equal(gen.endpoint, 'https://admin-endpoint.example.com/v1');
      assert.equal(gen.configured, true);
    });

    test('(b) env-only key: GENERATOR_API_KEY is trimmed, never in DB, getMaskedSettings(), or SETTINGS_FIELDS', () => {
      const testSecretKey = 'super-secret-generator-key-12345';
      process.env.GENERATOR_API_KEY = `  ${testSecretKey}  `;

      const gen = getEffectiveGenerator();
      assert.equal(gen.apiKey, testSecretKey);

      assert.equal('generatorApiKey' in SETTINGS_FIELDS, false);
      assert.equal('apiKey' in SETTINGS_FIELDS, false);
      assert.equal(Object.values(SETTINGS_FIELDS).some((f) => f.key.includes('generator') && f.type === 'secret'), false);

      const eff = getEffectiveSettings();
      assert.equal('generatorApiKey' in eff, false);
      assert.equal(JSON.stringify(eff).includes(testSecretKey), false);

      const masked = getMaskedSettings();
      assert.equal('generatorApiKey' in masked, false);
      assert.equal(JSON.stringify(masked).includes(testSecretKey), false);

      // Verify DB settings table doesn't have it either
      const allRows = db.getAllSettings();
      assert.equal(JSON.stringify(allRows).includes(testSecretKey), false);
    });

    test('(c) configured matrix: endpoint only -> false; key only -> false; both -> true; neither -> false', () => {
      // neither
      delete process.env.GENERATOR_ENDPOINT;
      delete process.env.GENERATOR_API_KEY;
      let gen = getEffectiveGenerator();
      assert.equal(gen.endpoint, '');
      assert.equal(gen.apiKey, '');
      assert.equal(gen.configured, false);

      // endpoint only
      process.env.GENERATOR_ENDPOINT = 'https://endpoint.example.com';
      delete process.env.GENERATOR_API_KEY;
      gen = getEffectiveGenerator();
      assert.equal(gen.endpoint, 'https://endpoint.example.com');
      assert.equal(gen.apiKey, '');
      assert.equal(gen.configured, false);

      // key only
      delete process.env.GENERATOR_ENDPOINT;
      process.env.GENERATOR_API_KEY = 'valid-key';
      gen = getEffectiveGenerator();
      assert.equal(gen.endpoint, '');
      assert.equal(gen.apiKey, 'valid-key');
      assert.equal(gen.configured, false);

      // whitespace-only values should also count as unconfigured
      process.env.GENERATOR_ENDPOINT = '   ';
      process.env.GENERATOR_API_KEY = '   ';
      gen = getEffectiveGenerator();
      assert.equal(gen.endpoint, '');
      assert.equal(gen.apiKey, '');
      assert.equal(gen.configured, false);

      // both
      process.env.GENERATOR_ENDPOINT = 'https://endpoint.example.com';
      process.env.GENERATOR_API_KEY = 'valid-key';
      gen = getEffectiveGenerator();
      assert.equal(gen.endpoint, 'https://endpoint.example.com');
      assert.equal(gen.apiKey, 'valid-key');
      assert.equal(gen.configured, true);
    });

    test('(d) timeout: unset -> 30000; 15000 -> 15000; 60000 -> 30000; 999999 -> 30000; invalid (\'abc\', \'0\') -> 30000', () => {
      // unset
      delete process.env.GENERATOR_TIMEOUT_MS;
      assert.equal(getEffectiveGenerator().timeoutMs, 30000);

      // 15000
      process.env.GENERATOR_TIMEOUT_MS = '15000';
      assert.equal(getEffectiveGenerator().timeoutMs, 15000);

      // 60000 capped at 30000
      process.env.GENERATOR_TIMEOUT_MS = '60000';
      assert.equal(getEffectiveGenerator().timeoutMs, 30000);

      // 999999 capped at 30000
      process.env.GENERATOR_TIMEOUT_MS = '999999';
      assert.equal(getEffectiveGenerator().timeoutMs, 30000);

      // invalid strings
      process.env.GENERATOR_TIMEOUT_MS = 'abc';
      assert.equal(getEffectiveGenerator().timeoutMs, 30000);

      process.env.GENERATOR_TIMEOUT_MS = '0';
      assert.equal(getEffectiveGenerator().timeoutMs, 30000);

      process.env.GENERATOR_TIMEOUT_MS = '-100';
      assert.equal(getEffectiveGenerator().timeoutMs, 30000);

      process.env.GENERATOR_TIMEOUT_MS = '15000.5';
      assert.equal(getEffectiveGenerator().timeoutMs, 30000);
    });

    test('(e) per-call resolution: save generatorEndpoint to URL B, next call returns B with no restart; change again and assert', () => {
      process.env.GENERATOR_API_KEY = 'test-key';

      // Initially no endpoint
      assert.equal(getEffectiveGenerator().endpoint, '');

      // Set to URL B
      const urlB = 'https://b.example.com/gen';
      saveSettings({ generatorEndpoint: urlB });
      assert.equal(getEffectiveGenerator().endpoint, urlB);

      // Change to URL C directly via db or saveSettings
      const urlC = 'https://c.example.com/gen';
      saveSettings({ generatorEndpoint: urlC });
      assert.equal(getEffectiveGenerator().endpoint, urlC);

      // Clear via blank generatorEndpoint
      saveSettings({ generatorEndpoint: '' });
      assert.equal(getEffectiveGenerator().endpoint, '');
    });

    test('(f) fail-closed: DATA_DIR broken causes getEffectiveGenerator() to fail closed without throwing, logging exactly one warning', () => {
      process.env.GENERATOR_API_KEY = 'my-env-api-key';
      process.env.GENERATOR_ENDPOINT = 'https://fallback.example.com';
      resetSettingsWarnings();

      // Ensure db connection is closed so next call tries to initialize in bad DATA_DIR
      db.close();

      const originalDataDir = process.env.DATA_DIR;
      process.env.DATA_DIR = '/dev/null/not-a-dir';

      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        const gen1 = getEffectiveGenerator();
        assert.equal(gen1.endpoint, '');
        assert.equal(gen1.apiKey, 'my-env-api-key');
        assert.equal(gen1.timeoutMs, 30000);
        assert.equal(gen1.configured, false);

        // Second call should not emit duplicate warning
        const gen2 = getEffectiveGenerator();
        assert.equal(gen2.endpoint, '');
        assert.equal(gen2.configured, false);

        const genWarnings = warnings.filter((w) => w.includes('[settings]') && w.includes('Failed to read settings for the generator'));
        assert.equal(genWarnings.length, 1, 'Must emit exactly one warning on settings store failure');
        assert.equal(genWarnings[0].includes('my-env-api-key'), false, 'Warning must not contain secret or input values');
      } finally {
        console.warn = origWarn;
        process.env.DATA_DIR = originalDataDir;
        db.close();
      }
    });
  });
});
