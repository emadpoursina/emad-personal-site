/**
 * tests/mailer.test.mjs
 *
 * Tests for src/lib/mailer.mjs:
 * - Header sanitizer protecting against CR/LF header injection.
 * - Effective SMTP resolution (admin > env > default) with fingerprint caching.
 * - Transport rebuild on settings change or resetTransport().
 * - Disabled SMTP status and rejection with single warning.
 * - Secret hygiene in logs.
 *
 * Run with: node --experimental-sqlite --test tests/mailer.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

import * as db from '../src/lib/db.mjs';
import { reset as resetEnv, getConfig } from '../src/lib/env.mjs';
import { saveSettings, resetSettingsWarnings } from '../src/lib/settings.mjs';
import {
  status,
  send,
  resetTransport,
  sanitizeHeaderValue,
} from '../src/lib/mailer.mjs';

const KEY_A = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

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

describe('mailer transport and resolution', () => {
  let tempDir;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mailer-test-'));
    process.env.DATA_DIR = tempDir;
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    resetEnv();
    db.close();
    resetSettingsWarnings();
    resetTransport();
    getConfig();
  });

  afterEach(() => {
    db.close();
    resetTransport();
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

  test('env precedence: SMTP_* set, no admin rows -> status configured, send uses env values', async () => {
    const origCreateTransport = nodemailer.createTransport;
    try {
      const transportCalls = [];
      const sentMails = [];
      nodemailer.createTransport = (config) => {
        transportCalls.push(config);
        return {
          sendMail: async (mail) => {
            sentMails.push(mail);
            return { messageId: 'msg-id' };
          },
        };
      };

      process.env.SMTP_HOST = 'smtp.env.example.com';
      process.env.SMTP_PORT = '465';
      process.env.SMTP_SECURE = 'true';
      process.env.SMTP_USER = 'env_user';
      process.env.SMTP_PASS = 'env_pass_secret';
      process.env.SMTP_FROM = 'Env Sender <env@example.com>';
      resetEnv();

      assert.equal(status(), 'configured');

      await send({
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello from env test',
      });

      assert.equal(transportCalls.length, 1);
      assert.deepEqual(transportCalls[0], {
        host: 'smtp.env.example.com',
        port: 465,
        secure: true,
        auth: {
          user: 'env_user',
          pass: 'env_pass_secret',
        },
        connectionTimeout: 10_000,
        greetingTimeout:   10_000,
        socketTimeout:     30_000,
      });

      assert.equal(sentMails.length, 1);
      assert.equal(sentMails[0].from, 'Env Sender <env@example.com>');
      assert.equal(sentMails[0].to, 'emad.poursina.work@gmail.com');
      assert.equal(sentMails[0].replyTo, 'alice@example.com');
      assert.equal(sentMails[0].subject, 'Contact form: Alice');
      assert.ok(sentMails[0].text.includes('Hello from env test'));
    } finally {
      nodemailer.createTransport = origCreateTransport;
    }
  });

  test('admin precedence: saveSettings overrides env vars; send uses admin values', async () => {
    const origCreateTransport = nodemailer.createTransport;
    try {
      const transportCalls = [];
      const sentMails = [];
      nodemailer.createTransport = (config) => {
        transportCalls.push(config);
        return {
          sendMail: async (mail) => {
            sentMails.push(mail);
            return { messageId: 'msg-id' };
          },
        };
      };

      // Set env vars
      process.env.SMTP_HOST = 'smtp.env.example.com';
      process.env.SMTP_PORT = '2525';
      process.env.SMTP_SECURE = 'false';
      process.env.SMTP_USER = 'env_user';
      process.env.SMTP_PASS = 'env_pass';
      process.env.SMTP_FROM = 'Env Sender <env@example.com>';
      resetEnv();

      // Save admin overrides
      const saveRes = saveSettings({
        smtpHost: 'smtp.admin.example.com',
        smtpPort: 587,
        smtpSecure: true,
        smtpUser: 'admin_user',
        smtpPass: 'admin_secret_pass',
        smtpFrom: 'Admin Sender <admin@example.com>',
      });
      assert.equal(saveRes.ok, true);

      assert.equal(status(), 'configured');

      await send({
        name: 'Bob',
        email: 'bob@example.com',
        message: 'Hello from admin test',
      });

      assert.equal(transportCalls.length, 1);
      assert.deepEqual(transportCalls[0], {
        host: 'smtp.admin.example.com',
        port: 587,
        secure: true,
        auth: {
          user: 'admin_user',
          pass: 'admin_secret_pass',
        },
        connectionTimeout: 10_000,
        greetingTimeout:   10_000,
        socketTimeout:     30_000,
      });

      assert.equal(sentMails.length, 1);
      assert.equal(sentMails[0].from, 'Admin Sender <admin@example.com>');
      assert.equal(sentMails[0].to, 'emad.poursina.work@gmail.com');
      assert.equal(sentMails[0].replyTo, 'bob@example.com');
      assert.equal(sentMails[0].subject, 'Contact form: Bob');
      assert.ok(sentMails[0].text.includes('Hello from admin test'));
    } finally {
      nodemailer.createTransport = origCreateTransport;
    }
  });

  test('fingerprint rebuild: changing smtp settings causes createTransport on next send; no change reuses transport', async () => {
    const origCreateTransport = nodemailer.createTransport;
    try {
      const transportCalls = [];
      nodemailer.createTransport = (config) => {
        transportCalls.push(config);
        return {
          sendMail: async () => ({ messageId: 'msg-id' }),
        };
      };

      saveSettings({
        smtpHost: 'smtp1.example.com',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'user1',
        smtpPass: 'pass1',
        smtpFrom: 'u1@example.com',
      });

      // 1st send -> creates transport
      await send({ name: 'Sender 1', email: 's1@example.com', message: 'Msg 1' });
      assert.equal(transportCalls.length, 1);
      assert.equal(transportCalls[0].host, 'smtp1.example.com');

      // Save different smtpHost
      const save2 = saveSettings({
        smtpHost: 'smtp2.example.com',
      });
      assert.equal(save2.ok, true);

      // 2nd send -> creates new transport with new host
      await send({ name: 'Sender 2', email: 's2@example.com', message: 'Msg 2' });
      assert.equal(transportCalls.length, 2);
      assert.equal(transportCalls[1].host, 'smtp2.example.com');

      // 3rd send with no change -> reuses cached transport (no 3rd call)
      await send({ name: 'Sender 3', email: 's3@example.com', message: 'Msg 3' });
      assert.equal(transportCalls.length, 2);
    } finally {
      nodemailer.createTransport = origCreateTransport;
    }
  });

  test('disabled: no SMTP configured -> status disabled, send rejects, no createTransport, exactly one warning', async () => {
    const origCreateTransport = nodemailer.createTransport;
    const origWarn = console.warn;
    const warnings = [];

    try {
      let createTransportCalled = false;
      nodemailer.createTransport = () => {
        createTransportCalled = true;
        return { sendMail: async () => {} };
      };

      console.warn = (...args) => {
        warnings.push(args.join(' '));
      };

      assert.equal(status(), 'disabled');

      await assert.rejects(
        async () => {
          await send({ name: 'Eve', email: 'eve@example.com', message: 'Test disabled' });
        },
        {
          name: 'Error',
          message: 'Contact email delivery is disabled (SMTP not configured).',
        }
      );

      assert.equal(createTransportCalled, false, 'createTransport must not be called when disabled');
      const disabledWarnings = warnings.filter((w) => w.includes('Contact email delivery is disabled'));
      assert.equal(disabledWarnings.length, 1, 'exactly one warning across two calls');
    } finally {
      nodemailer.createTransport = origCreateTransport;
      console.warn = origWarn;
    }
  });

  test('secret hygiene: no captured console.warn or console.error contains SMTP password or v1: envelope', async () => {
    const origCreateTransport = nodemailer.createTransport;
    const origWarn = console.warn;
    const origError = console.error;
    const captured = [];

    try {
      nodemailer.createTransport = () => ({
        sendMail: async () => {},
      });

      console.warn = (...args) => captured.push(args.join(' '));
      console.error = (...args) => captured.push(args.join(' '));

      const secretPassword = 'super-secret-password-xyz-12345';
      saveSettings({
        smtpHost: 'smtp.hygiene.test',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'hygiene-user',
        smtpPass: secretPassword,
        smtpFrom: 'hygiene@test.com',
      });

      // 1. Configured send
      await send({ name: 'Hygiene Test', email: 'h@example.com', message: 'testing secrets' });

      // 2. Disable SMTP and send again
      saveSettings({ smtpHost: '' });
      resetTransport();

      await assert.rejects(
        async () => {
          await send({ name: 'Hygiene Test', email: 'h@example.com', message: 'testing disabled' });
        },
        /Contact email delivery is disabled/
      );

      assert.ok(captured.length > 0, 'at least one warning should be captured');

      for (const msg of captured) {
        assert.ok(!msg.includes(secretPassword), `Captured log must not contain plaintext password: ${msg}`);
        assert.ok(!msg.includes('v1:'), `Captured log must not contain v1: envelope: ${msg}`);
      }
    } finally {
      nodemailer.createTransport = origCreateTransport;
      console.warn = origWarn;
      console.error = origError;
    }
  });

  test('resetTransport() forces a rebuild even when settings do not change', async () => {
    const origCreateTransport = nodemailer.createTransport;
    try {
      const transportCalls = [];
      nodemailer.createTransport = (config) => {
        transportCalls.push(config);
        return {
          sendMail: async () => ({ messageId: 'msg-id' }),
        };
      };

      saveSettings({
        smtpHost: 'smtp.rebuild.test',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'rebuild-user',
        smtpPass: 'rebuild-pass',
        smtpFrom: 'rebuild@test.com',
      });

      // 1st send -> creates transport
      await send({ name: 'Rebuild', email: 'r@example.com', message: 'First send' });
      assert.equal(transportCalls.length, 1);

      // Call resetTransport()
      resetTransport();

      // 2nd send -> must rebuild transport (call createTransport again)
      await send({ name: 'Rebuild', email: 'r@example.com', message: 'Second send' });
      assert.equal(transportCalls.length, 2);
    } finally {
      nodemailer.createTransport = origCreateTransport;
    }
  });
});
