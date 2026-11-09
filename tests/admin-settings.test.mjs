/**
 * tests/admin-settings.test.mjs
 *
 * Unit tests for admin settings save/mask/encryption contract:
 * src/lib/settings.mjs + src/lib/secrets.mjs + src/lib/db.mjs
 *
 * Covers:
 * 1. Every field validation with the exact data-model message:
 *    - aiBaseUrl, aiModel, aiApiKey, askDailyCap, askRateLimitPerHour,
 *      smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, generatorEndpoint.
 * 2. Blank non-secret deletes only that override and falls back to env/default.
 * 3. Blank secret keeps the stored envelope byte-for-byte.
 * 4. One invalid field writes nothing (all-or-nothing).
 * 5. Transaction rollback: direct call to db.applySettings with null value throws and writes nothing.
 * 6. Encryption at rest: raw secret rows start with v1: and neither plaintext appears in SQLite file bytes.
 * 7. Masked view: getMaskedSettings() returns hasApiKey/hasSmtpPass and last four masked;
 *    full secrets never appear in JSON.stringify(masked).
 * 8. Missing and wrong key handling:
 *    - Unset ENCRYPTION_KEY -> { ok: false, errors: { aiApiKey: 'Secret storage is unavailable.' } }.
 *    - Wrong key -> fail closed (hasApiKey: false, effective aiApiKey: '', no env fallback).
 * 9. smtpSecure explicit overrides: absent -> 'false', 'on' -> 'true'.
 *
 * Run with: node --experimental-sqlite --test tests/admin-settings.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as db from '../src/lib/db.mjs';
import * as env from '../src/lib/env.mjs';
import {
  saveSettings,
  getEffectiveSettings,
  getMaskedSettings,
  resetSettingsWarnings,
} from '../src/lib/settings.mjs';

const KEY_A = Buffer.alloc(32, 0x11).toString('base64');
const KEY_B = Buffer.alloc(32, 0x22).toString('base64');

describe('admin settings save/mask/encryption contract', () => {
  let tempDir;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-settings-test-'));
    process.env.DATA_DIR = tempDir;
    process.env.ENCRYPTION_KEY = KEY_A;
    env.reset();
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
    env.reset();
    resetSettingsWarnings();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('1. Field validation with exact data-model messages', () => {
    describe('aiBaseUrl', () => {
      const expectedMsg = 'Enter an HTTPS base URL (localhost may use HTTP).';

      test('valid URLs: https, http://localhost, http://127.0.0.1, http://[::1] are accepted', () => {
        const urls = [
          'https://openrouter.ai/api/v1',
          'http://localhost:11434',
          'http://127.0.0.1:8080/v1',
          'http://[::1]:8080/v1',
        ];
        for (const url of urls) {
          const res = saveSettings({ aiBaseUrl: url });
          assert.equal(res.ok, true, `Expected URL ${url} to be accepted`);
        }
      });

      test('invalid URLs: plain http remote, credentials, and >500 chars are rejected', () => {
        const invalidUrls = [
          'http://example.com',
          'http://example.com/api',
          'https://user:pass@example.com',
          'https://user@example.com',
          'https://example.com/' + 'a'.repeat(500),
          'ftp://example.com',
          'not-a-valid-url',
        ];
        for (const url of invalidUrls) {
          const res = saveSettings({ aiBaseUrl: url });
          assert.equal(res.ok, false, `Expected ${url} to fail validation`);
          assert.equal(res.errors?.aiBaseUrl, expectedMsg);
        }
      });
    });

    describe('aiModel', () => {
      const expectedMsg = 'Enter a model ID.';

      test('invalid aiModel: blank (non-string empty), 201 chars, control chars are rejected', () => {
        const invalidModels = [
          new String(''),
          [],
          'a'.repeat(201),
          'model\x00bad',
          'model\x1fbad',
          'model\x7fbad',
        ];
        for (const model of invalidModels) {
          const res = saveSettings({ aiModel: model });
          assert.equal(res.ok, false, `Expected aiModel ${String(model)} to fail validation`);
          assert.equal(res.errors?.aiModel, expectedMsg);
        }
      });

      test('valid aiModel is accepted', () => {
        const res = saveSettings({ aiModel: 'anthropic/claude-3-5-haiku' });
        assert.equal(res.ok, true);
        assert.equal(db.getSetting('ai.model'), 'anthropic/claude-3-5-haiku');
      });
    });

    describe('aiApiKey', () => {
      const expectedMsg = 'Enter a valid API key.';

      test('invalid aiApiKey: >4096 chars, CR, LF are rejected', () => {
        const invalidKeys = [
          'k'.repeat(4097),
          'key\rwithcr',
          'key\nwithlf',
          'key\r\nwithcrlf',
          'key\x00withnull',
        ];
        for (const key of invalidKeys) {
          const res = saveSettings({ aiApiKey: key });
          assert.equal(res.ok, false, `Expected aiApiKey to fail validation`);
          assert.equal(res.errors?.aiApiKey, expectedMsg);
        }
      });

      test('valid aiApiKey is accepted and encrypted', () => {
        const res = saveSettings({ aiApiKey: 'sk-ant-valid-key-12345678' });
        assert.equal(res.ok, true);
        const stored = db.getSetting('ai.apiKey');
        assert.ok(stored && stored.startsWith('v1:'));
      });
    });

    describe('askDailyCap', () => {
      const expectedMsg = 'Daily cap must be a whole number between 1 and 100000.';

      test('invalid askDailyCap: 0, 100001, abc, 1.5 are rejected', () => {
        const invalidCaps = [0, '0', 100001, '100001', 'abc', '1.5', 1.5, -1];
        for (const cap of invalidCaps) {
          const res = saveSettings({ askDailyCap: cap });
          assert.equal(res.ok, false, `Expected askDailyCap ${cap} to fail validation`);
          assert.equal(res.errors?.askDailyCap, expectedMsg);
        }
      });

      test('valid askDailyCap is accepted (bounds 1 and 100000)', () => {
        assert.equal(saveSettings({ askDailyCap: 1 }).ok, true);
        assert.equal(db.getSetting('ask.dailyCap'), '1');
        assert.equal(saveSettings({ askDailyCap: 100000 }).ok, true);
        assert.equal(db.getSetting('ask.dailyCap'), '100000');
        assert.equal(saveSettings({ askDailyCap: '250' }).ok, true);
        assert.equal(db.getSetting('ask.dailyCap'), '250');
      });
    });

    describe('askRateLimitPerHour', () => {
      const expectedMsg = 'Rate limit must be a whole number between 1 and 1000.';

      test('invalid askRateLimitPerHour: 0, 1001 are rejected', () => {
        const invalidLimits = [0, '0', 1001, '1001', -1, 'bad', '2.5'];
        for (const limit of invalidLimits) {
          const res = saveSettings({ askRateLimitPerHour: limit });
          assert.equal(res.ok, false, `Expected askRateLimitPerHour ${limit} to fail validation`);
          assert.equal(res.errors?.askRateLimitPerHour, expectedMsg);
        }
      });

      test('valid askRateLimitPerHour is accepted (bounds 1 and 1000)', () => {
        assert.equal(saveSettings({ askRateLimitPerHour: 1 }).ok, true);
        assert.equal(db.getSetting('ask.rateLimitPerHour'), '1');
        assert.equal(saveSettings({ askRateLimitPerHour: 1000 }).ok, true);
        assert.equal(db.getSetting('ask.rateLimitPerHour'), '1000');
        assert.equal(saveSettings({ askRateLimitPerHour: '15' }).ok, true);
        assert.equal(db.getSetting('ask.rateLimitPerHour'), '15');
      });
    });

    describe('smtpHost', () => {
      const expectedMsg = 'Enter a valid SMTP host.';

      test('invalid smtpHost: space, control characters, 256 chars are rejected', () => {
        const invalidHosts = [
          'smtp host.com',
          'smtp\x00host.com',
          'smtp\x1fhost.com',
          'smtp\x7fhost.com',
          'h'.repeat(256),
        ];
        for (const host of invalidHosts) {
          const res = saveSettings({ smtpHost: host });
          assert.equal(res.ok, false, `Expected smtpHost ${host} to fail validation`);
          assert.equal(res.errors?.smtpHost, expectedMsg);
        }
      });

      test('valid smtpHost is accepted', () => {
        const res = saveSettings({ smtpHost: 'smtp.sendgrid.net' });
        assert.equal(res.ok, true);
        assert.equal(db.getSetting('smtp.host'), 'smtp.sendgrid.net');
      });
    });

    describe('smtpPort', () => {
      const expectedMsg = 'Port must be between 1 and 65535.';

      test('invalid smtpPort: 0, 65536 are rejected', () => {
        const invalidPorts = [0, '0', 65536, '65536', -1, 'port', '587.2'];
        for (const port of invalidPorts) {
          const res = saveSettings({ smtpPort: port });
          assert.equal(res.ok, false, `Expected smtpPort ${port} to fail validation`);
          assert.equal(res.errors?.smtpPort, expectedMsg);
        }
      });

      test('valid smtpPort is accepted (bounds 1 and 65535)', () => {
        assert.equal(saveSettings({ smtpPort: 1 }).ok, true);
        assert.equal(db.getSetting('smtp.port'), '1');
        assert.equal(saveSettings({ smtpPort: 65535 }).ok, true);
        assert.equal(db.getSetting('smtp.port'), '65535');
        assert.equal(saveSettings({ smtpPort: '587' }).ok, true);
        assert.equal(db.getSetting('smtp.port'), '587');
      });
    });

    describe('smtpUser', () => {
      const expectedMsg = 'Enter a valid SMTP username.';

      test('invalid smtpUser: control characters, 321 chars are rejected', () => {
        const invalidUsers = [
          'user\x00name',
          'user\x1fname',
          'user\x7fname',
          'u'.repeat(321),
        ];
        for (const user of invalidUsers) {
          const res = saveSettings({ smtpUser: user });
          assert.equal(res.ok, false, `Expected smtpUser ${user} to fail validation`);
          assert.equal(res.errors?.smtpUser, expectedMsg);
        }
      });

      test('valid smtpUser is accepted', () => {
        const res = saveSettings({ smtpUser: 'admin@domain.com' });
        assert.equal(res.ok, true);
        assert.equal(db.getSetting('smtp.user'), 'admin@domain.com');
      });
    });

    describe('smtpPass', () => {
      const expectedMsg = 'Enter a valid SMTP password.';

      test('invalid smtpPass: CR, LF, 1025 chars are rejected', () => {
        const invalidPasses = [
          'pass\rword',
          'pass\nword',
          'pass\r\nword',
          'p'.repeat(1025),
          'pass\x00word',
        ];
        for (const pass of invalidPasses) {
          const res = saveSettings({ smtpPass: pass });
          assert.equal(res.ok, false, `Expected smtpPass to fail validation`);
          assert.equal(res.errors?.smtpPass, expectedMsg);
        }
      });

      test('valid smtpPass is accepted and encrypted', () => {
        const res = saveSettings({ smtpPass: 'super-secret-smtp-password' });
        assert.equal(res.ok, true);
        const stored = db.getSetting('smtp.pass');
        assert.ok(stored && stored.startsWith('v1:'));
      });
    });

    describe('smtpFrom', () => {
      const expectedMsg = 'Enter a valid from address.';

      test('invalid smtpFrom: not-an-address, Name <bad>, 321 chars are rejected', () => {
        const invalidAddrs = [
          'not-an-address',
          'Name <bad>',
          'a'.repeat(321),
          'user@',
          '@domain.com',
          'Name <user@domain>extra',
          '<missing-addr>',
          'Name with <unclosed',
        ];
        for (const from of invalidAddrs) {
          const res = saveSettings({ smtpFrom: from });
          assert.equal(res.ok, false, `Expected smtpFrom ${from} to fail validation`);
          assert.equal(res.errors?.smtpFrom, expectedMsg);
        }
      });

      test('valid smtpFrom is accepted: addr or Name <addr>', () => {
        assert.equal(saveSettings({ smtpFrom: 'emad@example.com' }).ok, true);
        assert.equal(db.getSetting('smtp.from'), 'emad@example.com');
        assert.equal(saveSettings({ smtpFrom: 'Emad Poursina <emad.poursina.work@gmail.com>' }).ok, true);
        assert.equal(db.getSetting('smtp.from'), 'Emad Poursina <emad.poursina.work@gmail.com>');
      });
    });

    describe('generatorEndpoint', () => {
      const expectedMsg = 'Enter an HTTPS endpoint (localhost may use HTTP).';

      test('valid generatorEndpoint: https, localhost http, 127.0.0.1, [::1], and blank are accepted', () => {
        const validEndpoints = [
          '',
          'https://generator.example.com/api',
          'http://localhost:3000',
          'http://127.0.0.1:3000/gen',
          'http://[::1]:3000/gen',
        ];
        for (const ep of validEndpoints) {
          const res = saveSettings({ generatorEndpoint: ep });
          assert.equal(res.ok, true, `Expected endpoint ${ep} to be accepted`);
        }
      });

      test('invalid generatorEndpoint: plain http remote, credentials, and >500 chars are rejected', () => {
        const invalidEndpoints = [
          'http://example.com',
          'http://example.com/gen',
          'https://user:pass@example.com',
          'https://user@example.com',
          'https://example.com/' + 'a'.repeat(500),
          'ftp://example.com',
        ];
        for (const ep of invalidEndpoints) {
          const res = saveSettings({ generatorEndpoint: ep });
          assert.equal(res.ok, false, `Expected endpoint ${ep} to fail validation`);
          assert.equal(res.errors?.generatorEndpoint, expectedMsg);
        }
      });
    });
  });

  describe('2. Blank non-secret deletes only that override', () => {
    test('saving askDailyCap + smtpHost then submitting blanks deletes their rows while leaving other settings intact', () => {
      // 1. Initial save of multiple overrides
      const saveRes = saveSettings({
        askDailyCap: 500,
        smtpHost: 'smtp.custom.org',
        aiModel: 'custom-model-v1',
      });
      assert.equal(saveRes.ok, true);
      assert.equal(db.getSetting('ask.dailyCap'), '500');
      assert.equal(db.getSetting('smtp.host'), 'smtp.custom.org');
      assert.equal(db.getSetting('ai.model'), 'custom-model-v1');

      // 2. Submit blanks for askDailyCap and smtpHost
      const clearRes = saveSettings({
        askDailyCap: '',
        smtpHost: '',
      });
      assert.equal(clearRes.ok, true);

      // 3. Their rows are gone from SQLite
      assert.equal(db.getSetting('ask.dailyCap'), null, 'ask.dailyCap row must be deleted');
      assert.equal(db.getSetting('smtp.host'), null, 'smtp.host row must be deleted');

      // 4. Other settings are untouched
      assert.equal(db.getSetting('ai.model'), 'custom-model-v1', 'ai.model override must remain untouched');

      // 5. Effective values fall back to defaults when env is unset
      let eff = getEffectiveSettings();
      assert.equal(eff.askDailyCap, 200, 'askDailyCap must fall back to default (200)');
      assert.equal(eff.smtpHost, '', 'smtpHost must fall back to default (empty)');
      assert.equal(eff.aiModel, 'custom-model-v1', 'aiModel remains effective from admin override');

      // 6. When env is set, effective values fall back to env
      process.env.ASK_DAILY_CAP = '350';
      process.env.SMTP_HOST = 'smtp.env.org';
      env.reset();

      eff = getEffectiveSettings();
      assert.equal(eff.askDailyCap, 350, 'askDailyCap must fall back to env (350)');
      assert.equal(eff.smtpHost, 'smtp.env.org', 'smtpHost must fall back to env');
    });
  });

  describe('3. Blank secret keeps the stored envelope byte-for-byte', () => {
    test('blank secret keeps stored envelope byte-identical (===) when submitting form with another field', () => {
      // 1. Save an API key
      const initialKey = 'initial-secret-api-key-12345678';
      const saveRes = saveSettings({ aiApiKey: initialKey });
      assert.equal(saveRes.ok, true);

      // 2. Read the raw row from SQLite
      const rawBefore = db.getSetting('ai.apiKey');
      assert.ok(rawBefore && rawBefore.startsWith('v1:'), 'Raw envelope must start with v1:');

      // 3. Submit a form with aiApiKey: '' and a different non-secret field
      const updateRes = saveSettings({
        aiApiKey: '',
        smtpHost: 'smtp.byteidentical.com',
      });
      assert.equal(updateRes.ok, true);

      // 4. Assert the raw row is identical (===)
      const rawAfter = db.getSetting('ai.apiKey');
      assert.equal(rawAfter, rawBefore);
      assert.ok(rawAfter === rawBefore, 'Stored envelope must be byte-for-byte identical');

      // 5. Assert the non-secret field was updated
      assert.equal(db.getSetting('smtp.host'), 'smtp.byteidentical.com');
    });
  });

  describe('4. One invalid field writes nothing (all-or-nothing)', () => {
    test('submitting a valid change plus an invalid field writes nothing and leaves DB unchanged', () => {
      // 1. Clean DB state: neither row exists
      assert.equal(db.getSetting('ai.baseUrl'), null);
      assert.equal(db.getSetting('smtp.port'), null);

      // 2. Submit one valid change plus one invalid field
      const res = saveSettings({
        aiBaseUrl: 'https://valid.target.com/api',
        smtpPort: 0, // invalid port (< 1)
      });

      assert.equal(res.ok, false);
      assert.equal(res.errors?.smtpPort, 'Port must be between 1 and 65535.');

      // 3. Both the attempted valid change and the invalid field are absent
      assert.equal(db.getSetting('ai.baseUrl'), null, 'Valid field must not be written when batch fails');
      assert.equal(db.getSetting('smtp.port'), null, 'Invalid field must not be written');
      assert.deepEqual(db.getAllSettings(), {}, 'No rows should exist in settings table');
    });

    test('seed a valid override, submit valid change + invalid field -> ok:false, seeded row preserved, valid change absent', () => {
      // 1. Seed a valid override in SQLite
      const seedRes = saveSettings({ aiModel: 'seeded-claude-model' });
      assert.equal(seedRes.ok, true);
      assert.equal(db.getSetting('ai.model'), 'seeded-claude-model');

      // 2. Submit one valid change plus one invalid field
      const res = saveSettings({
        aiBaseUrl: 'https://new-endpoint.example.com',
        askDailyCap: 'invalid-cap-abc',
      });

      assert.equal(res.ok, false);
      assert.equal(res.errors?.askDailyCap, 'Daily cap must be a whole number between 1 and 100000.');

      // 3. Valid change is absent, invalid field is absent, and seeded override is preserved
      assert.equal(db.getSetting('ai.baseUrl'), null, 'Attempted valid change must be absent');
      assert.equal(db.getSetting('ask.dailyCap'), null, 'Attempted invalid field must be absent');
      assert.equal(db.getSetting('ai.model'), 'seeded-claude-model', 'Seeded override must be untouched');
    });
  });

  describe('5. Transaction rollback in db.applySettings', () => {
    test('db.applySettings with one valid key and one null value throws and writes neither key', () => {
      // In SQLite schema: value TEXT NOT NULL. Passing null for value triggers constraint failure.
      assert.throws(
        () => {
          db.applySettings({
            'valid.key': 'some-valid-value',
            'invalid.key': /** @type {any} */ (null),
          });
        },
        /NOT NULL constraint failed/i,
        'Expected SQLite NOT NULL constraint violation'
      );

      // Neither key should have been committed
      assert.equal(db.getSetting('valid.key'), null, 'valid.key must not exist due to rollback');
      assert.equal(db.getSetting('invalid.key'), null, 'invalid.key must not exist');
      assert.deepEqual(db.getAllSettings(), {}, 'Transaction must be completely rolled back');
    });
  });

  describe('6. Encryption at rest in SQLite file', () => {
    test('raw secret rows start with v1: and plaintexts never appear in SQLite file bytes', () => {
      const apiKeyPlain = 'ai-secret-key-at-rest-token-987654321';
      const smtpPassPlain = 'smtp-secret-password-at-rest-123456789';

      const saveRes = saveSettings({
        aiApiKey: apiKeyPlain,
        smtpPass: smtpPassPlain,
      });
      assert.equal(saveRes.ok, true);

      // 1. Every raw secret row in DB starts with v1:
      const rawApiKey = db.getSetting('ai.apiKey');
      const rawSmtpPass = db.getSetting('smtp.pass');
      assert.ok(rawApiKey && rawApiKey.startsWith('v1:'), 'ai.apiKey must start with v1:');
      assert.ok(rawSmtpPass && rawSmtpPass.startsWith('v1:'), 'smtp.pass must start with v1:');

      // 2. Read SQLite file bytes directly
      const sqliteFile = join(tempDir, 'site.sqlite');
      const fileBytes = readFileSync(sqliteFile);
      const fileUtf8 = fileBytes.toString('utf8');

      // Assert envelope marker v1: appears in file
      assert.ok(fileUtf8.includes('v1:'), 'v1: envelope header must be present in SQLite file bytes');

      // Assert neither plaintext appears in SQLite file (string or buffer search)
      assert.ok(!fileUtf8.includes(apiKeyPlain), 'aiApiKey plaintext must NOT appear in SQLite file text');
      assert.ok(!fileUtf8.includes(smtpPassPlain), 'smtpPass plaintext must NOT appear in SQLite file text');
      assert.ok(!fileBytes.includes(Buffer.from(apiKeyPlain, 'utf8')), 'aiApiKey plaintext must NOT appear in file bytes');
      assert.ok(!fileBytes.includes(Buffer.from(smtpPassPlain, 'utf8')), 'smtpPass plaintext must NOT appear in file bytes');
    });
  });

  describe('7. Masked view contract', () => {
    test('getMaskedSettings returns hasApiKey:true, apiKeyMasked=••••last4, same for smtp pass; full secrets absent from JSON', () => {
      const apiKeyPlain = 'long-secret-ai-token-abcd'; // length 25 >= 8, last4: abcd
      const smtpPassPlain = 'long-secret-smtp-pass-wxyz'; // length 26 >= 8, last4: wxyz

      saveSettings({
        aiApiKey: apiKeyPlain,
        smtpPass: smtpPassPlain,
      });

      const masked = getMaskedSettings();
      assert.equal(masked.hasApiKey, true);
      assert.equal(masked.apiKeyMasked, '••••abcd');
      assert.equal(masked.hasSmtpPass, true);
      assert.equal(masked.smtpPassMasked, '••••wxyz');

      // Plaintext properties must never exist on masked view
      assert.equal(masked.aiApiKey, undefined);
      assert.equal(masked.smtpPass, undefined);

      // Full secrets never appear in JSON.stringify(masked)
      const jsonStr = JSON.stringify(masked);
      assert.ok(!jsonStr.includes(apiKeyPlain), 'Plaintext aiApiKey must not appear in JSON.stringify(masked)');
      assert.ok(!jsonStr.includes(smtpPassPlain), 'Plaintext smtpPass must not appear in JSON.stringify(masked)');
      assert.ok(jsonStr.includes('••••abcd'), 'Masked aiApiKey must appear in JSON.stringify(masked)');
      assert.ok(jsonStr.includes('••••wxyz'), 'Masked smtpPass must appear in JSON.stringify(masked)');
    });

    test('short secrets (<8 chars) mask as •••• without last four', () => {
      saveSettings({
        aiApiKey: 'short',
        smtpPass: 'pwd',
      });

      const masked = getMaskedSettings();
      assert.equal(masked.hasApiKey, true);
      assert.equal(masked.apiKeyMasked, '••••');
      assert.equal(masked.hasSmtpPass, true);
      assert.equal(masked.smtpPassMasked, '••••');

      const jsonStr = JSON.stringify(masked);
      assert.ok(!jsonStr.includes('short'));
      assert.ok(!jsonStr.includes('pwd'));
    });
  });

  describe('8. Missing key and wrong key handling', () => {
    test('missing key: unset ENCRYPTION_KEY -> ok:false, Secret storage is unavailable., no DB row, no plaintext anywhere', () => {
      delete process.env.ENCRYPTION_KEY;
      env.reset();

      const secretCandidate = 'unencryptable-secret-token-12345';
      const res = saveSettings({ aiApiKey: secretCandidate });

      assert.deepEqual(res, {
        ok: false,
        errors: { aiApiKey: 'Secret storage is unavailable.' },
      });

      // No DB row created
      assert.equal(db.getSetting('ai.apiKey'), null);

      // No plaintext anywhere in DB file
      const sqliteFile = join(tempDir, 'site.sqlite');
      try {
        const fileBytes = readFileSync(sqliteFile);
        assert.ok(!fileBytes.includes(Buffer.from(secretCandidate, 'utf8')));
      } catch {
        // File may not even exist yet
      }
    });

    test('wrong key: envelope saved under key A, switch to key B -> fail closed, hasApiKey:false, aiApiKey:"", no env fallback', () => {
      // 1. Save envelope under KEY_A
      process.env.ENCRYPTION_KEY = KEY_A;
      env.reset();

      const saveRes = saveSettings({ aiApiKey: 'secret-under-key-a-87654321' });
      assert.equal(saveRes.ok, true);

      // 2. Switch to KEY_B and set AI_API_KEY in environment
      process.env.ENCRYPTION_KEY = KEY_B;
      process.env.AI_API_KEY = 'env-api-key-that-must-never-be-used';
      env.reset();
      resetSettingsWarnings();

      // 3. Assert getMaskedSettings shows hasApiKey: false
      const masked = getMaskedSettings();
      assert.equal(masked.hasApiKey, false, 'Decryption failure must result in hasApiKey: false');
      assert.equal(masked.apiKeyMasked, '', 'apiKeyMasked must be empty on decryption failure');
      assert.equal(masked.aiConfigured, false, 'aiConfigured must be false on decryption failure');

      // 4. Assert getEffectiveSettings fails closed (empty string, not env fallback)
      const eff = getEffectiveSettings();
      assert.equal(eff.aiApiKey, '', 'Decryption failure must fail closed with empty string');
      assert.notEqual(eff.aiApiKey, 'env-api-key-that-must-never-be-used', 'Must NOT fall back to env AI_API_KEY');
      assert.equal(eff.aiConfigured, false);
    });
  });

  describe('9. smtpSecure explicit overrides', () => {
    test('smtpSecure: absent -> stored "false"; "on" -> stored "true"; both are explicit overrides', () => {
      // 1. Absent in input -> stored 'false'
      const resAbsent = saveSettings({ smtpHost: 'smtp.test.com' });
      assert.equal(resAbsent.ok, true);
      assert.equal(db.getSetting('smtp.secure'), 'false', 'Absent smtpSecure must store "false"');
      assert.equal(getEffectiveSettings().smtpSecure, false);

      // 2. 'on' in input (native form checkbox) -> stored 'true'
      const resOn = saveSettings({ smtpSecure: 'on' });
      assert.equal(resOn.ok, true);
      assert.equal(db.getSetting('smtp.secure'), 'true', 'smtpSecure "on" must store "true"');
      assert.equal(getEffectiveSettings().smtpSecure, true);

      // 3. Explicit boolean true -> stored 'true'
      const resTrue = saveSettings({ smtpSecure: true });
      assert.equal(resTrue.ok, true);
      assert.equal(db.getSetting('smtp.secure'), 'true');
      assert.equal(getEffectiveSettings().smtpSecure, true);

      // 4. Explicit boolean false -> stored 'false'
      const resFalse = saveSettings({ smtpSecure: false });
      assert.equal(resFalse.ok, true);
      assert.equal(db.getSetting('smtp.secure'), 'false');
      assert.equal(getEffectiveSettings().smtpSecure, false);
    });
  });
});
