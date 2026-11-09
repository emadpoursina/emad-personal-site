/**
 * tests/admin-page.test.mjs
 *
 * Unit tests for admin HTML renderers (src/lib/admin-page.mjs).
 * Proves:
 * - escapeHtml: & < > " ' escaping; raw tag absent, escaped text present; null/undefined handling.
 * - mask-only output: known secrets masked with apiKeyMasked/smtpPassMasked never appear in full.
 * - noindex meta present in render401, renderLogin, renderSettings, render404.
 * - all 12 field names present exactly once in the settings form with matching labels.
 * - password inputs for secrets and login, always value="" for secrets.
 * - saved notice on saved: true, absent on saved: false.
 * - error re-render shows submitted non-secret values and all error messages (summary and field).
 * - effective source hints (admin, environment, default) next to fields; secrets have source only.
 * - logout form separate with its own submit button.
 * - renderLogin form posts to /api/admin/login with required fields.
 * - no <script tag in any renderer output under any input.
 * - render401 and render404 contain no settings values.
 *
 * Run with: node --experimental-sqlite --test tests/admin-page.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  SETTINGS_FORM_FIELDS,
  render401,
  render404,
  renderLogin,
  renderSettings,
} from '../src/lib/admin-page.mjs';

/**
 * Builds a sample masked settings object matching getMaskedSettings() return shape.
 */
function buildSampleMaskedSettings(overrides = {}) {
  return {
    aiBaseUrl: 'https://openrouter.ai/api/v1',
    aiModel: 'anthropic/claude-haiku-5.5',
    askDailyCap: 200,
    askRateLimitPerHour: 10,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'notifier@example.com',
    smtpFrom: 'Emad Poursina <emad.poursina.work@gmail.com>',
    generatorEndpoint: '',
    hasApiKey: true,
    hasSmtpPass: true,
    apiKeyMasked: '••••abcd',
    smtpPassMasked: '••••wxyz',
    aiConfigured: true,
    sources: {
      aiBaseUrl: 'default',
      aiModel: 'default',
      aiApiKey: 'admin',
      askDailyCap: 'default',
      askRateLimitPerHour: 'default',
      smtpHost: 'env',
      smtpPort: 'default',
      smtpSecure: 'default',
      smtpUser: 'env',
      smtpPass: 'admin',
      smtpFrom: 'default',
      generatorEndpoint: 'default',
    },
    ...overrides,
  };
}

describe('src/lib/admin-page.mjs', () => {
  describe('escapeHtml', () => {
    test('escapes & < > " \' characters', () => {
      const raw = `& < > " '`;
      const escaped = escapeHtml(raw);
      assert.equal(escaped, '&amp; &lt; &gt; &quot; &#39;');
      assert.ok(!escaped.includes('<'));
      assert.ok(!escaped.includes('>'));
      assert.ok(!escaped.includes('"'));
      assert.ok(!escaped.includes("'"));
    });

    test('handles null and undefined by returning empty string', () => {
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
    });

    test('converts numbers and booleans to string safely', () => {
      assert.equal(escapeHtml(123), '123');
      assert.equal(escapeHtml(0), '0');
      assert.equal(escapeHtml(true), 'true');
      assert.equal(escapeHtml(false), 'false');
    });

    test('HTML escaping of submitted value containing <script>alert(1)</script> and quotes', () => {
      const malicious = '<script>alert("1")</script> and \'test\' & "more"';
      const escaped = escapeHtml(malicious);

      assert.ok(!escaped.includes('<script>'));
      assert.ok(!escaped.includes('</script>'));
      assert.ok(!escaped.includes('"'));
      assert.ok(!escaped.includes("'"));
      assert.ok(escaped.includes('&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt;'));
      assert.ok(escaped.includes('&#39;test&#39;'));
      assert.ok(escaped.includes('&amp;'));
      assert.ok(escaped.includes('&quot;more&quot;'));
    });
  });

  describe('SETTINGS_FORM_FIELDS', () => {
    test('exports exactly 12 fields in specified order', () => {
      assert.equal(SETTINGS_FORM_FIELDS.length, 12);
      assert.deepEqual(Array.from(SETTINGS_FORM_FIELDS), [
        'aiBaseUrl',
        'aiModel',
        'aiApiKey',
        'askDailyCap',
        'askRateLimitPerHour',
        'smtpHost',
        'smtpPort',
        'smtpSecure',
        'smtpUser',
        'smtpPass',
        'smtpFrom',
        'generatorEndpoint',
      ]);
    });
  });

  describe('render401', () => {
    test('renders 401 document with Not authorized heading, login link, and noindex', () => {
      const html = render401();

      assert.ok(html.startsWith('<!doctype html>'));
      assert.ok(html.includes('<h1>Not authorized</h1>'));
      assert.ok(!html.includes('<h1>Admin settings</h1>'));
      assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
      assert.ok(html.includes('href="/admin/login"'));
      assert.ok(!html.toLowerCase().includes('<script'));
    });

    test('contains no settings values or session data', () => {
      const html = render401();

      assert.ok(!html.includes('aiBaseUrl'));
      assert.ok(!html.includes('openrouter.ai'));
      assert.ok(!html.includes('admin_session'));
      assert.ok(!html.includes('askDailyCap'));
    });
  });

  describe('render404', () => {
    test('renders 404 document with Page not found heading, link to /, and noindex', () => {
      const html = render404();

      assert.ok(html.startsWith('<!doctype html>'));
      assert.ok(html.includes('<h1>Page not found</h1>'));
      assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
      assert.ok(html.includes('href="/"'));
      assert.ok(!html.toLowerCase().includes('<script'));
    });

    test('contains no settings values', () => {
      const html = render404();

      assert.ok(!html.includes('aiBaseUrl'));
      assert.ok(!html.includes('smtpHost'));
      assert.ok(!html.includes('openrouter.ai'));
    });
  });

  describe('renderLogin', () => {
    test('renders login document with Admin login heading and noindex', () => {
      const html = renderLogin();

      assert.ok(html.startsWith('<!doctype html>'));
      assert.ok(html.includes('<h1>Admin login</h1>'));
      assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
      assert.ok(!html.toLowerCase().includes('<script'));
    });

    test('form posts to /api/admin/login with required password field', () => {
      const html = renderLogin();

      assert.ok(
        html.includes('<form method="post" action="/api/admin/login" enctype="application/x-www-form-urlencoded">'),
      );
      assert.ok(html.includes('<label for="password">'));
      assert.ok(
        html.includes(
          '<input type="password" id="password" name="password" required autocomplete="current-password">',
        ),
      );
      assert.ok(html.includes('<button type="submit">'));
      assert.ok(html.includes('href="/"'));
    });

    test('contains no settings values or scripts', () => {
      const html = renderLogin();

      assert.ok(!html.includes('aiBaseUrl'));
      assert.ok(!html.includes('apiKeyMasked'));
      assert.ok(!html.toLowerCase().includes('<script'));
    });

    test('escapes and displays error when provided', () => {
      const html = renderLogin({ error: 'Invalid <credentials> & "quotes"' });

      assert.ok(!html.includes('<credentials>'));
      assert.ok(html.includes('Invalid &lt;credentials&gt; &amp; &quot;quotes&quot;'));
    });
  });

  describe('renderSettings', () => {
    test('renders full document with Admin settings heading and noindex', () => {
      const settings = buildSampleMaskedSettings();
      const html = renderSettings({ settings });

      assert.ok(html.startsWith('<!doctype html>'));
      assert.ok(html.includes('<h1>Admin settings</h1>'));
      assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
      assert.ok(!html.toLowerCase().includes('<script'));
    });

    test('settings form posts to /api/admin/settings and contains all 12 field names exactly once', () => {
      const settings = buildSampleMaskedSettings();
      const html = renderSettings({ settings });

      // Settings form exists
      assert.ok(html.includes('<form method="post" action="/api/admin/settings">'));

      // Extract settings form content (before the logout form)
      const settingsFormMatch = html.match(/<form method="post" action="\/api\/admin\/settings">([\s\S]*?)<\/form>/);
      assert.ok(settingsFormMatch, 'settings form must exist and be closed');
      const formContent = settingsFormMatch[1];

      for (const field of SETTINGS_FORM_FIELDS) {
        const regex = new RegExp(`name="${field}"`, 'g');
        const matches = formContent.match(regex);
        assert.equal(
          matches?.length,
          1,
          `field name="${field}" must appear exactly once in settings form`,
        );
      }
    });

    test('labels and input attributes for all 12 fields', () => {
      const settings = buildSampleMaskedSettings();
      const html = renderSettings({ settings });

      // All 12 labels exist with matching for attribute
      for (const field of SETTINGS_FORM_FIELDS) {
        assert.ok(
          html.includes(`<label for="${field}">`),
          `label for="${field}" must exist`,
        );
      }

      // Field types and bounds
      assert.ok(html.includes('<input type="url" id="aiBaseUrl" name="aiBaseUrl"'));
      assert.ok(html.includes('<input type="text" id="aiModel" name="aiModel"'));
      assert.ok(html.includes('<input type="password" id="aiApiKey" name="aiApiKey" value=""'));
      assert.ok(
        html.includes(
          '<input type="number" id="askDailyCap" name="askDailyCap" value="" placeholder="200" min="1" max="100000">',
        ),
      );
      assert.ok(
        html.includes(
          '<input type="number" id="askRateLimitPerHour" name="askRateLimitPerHour" value="" placeholder="10" min="1" max="1000">',
        ),
      );
      assert.ok(html.includes('<input type="text" id="smtpHost" name="smtpHost"'));
      assert.ok(
        html.includes(
          '<input type="number" id="smtpPort" name="smtpPort" value="" placeholder="587" min="1" max="65535">',
        ),
      );
      assert.ok(html.includes('<input type="checkbox" id="smtpSecure" name="smtpSecure" value="on"'));
      assert.ok(html.includes('<input type="text" id="smtpUser" name="smtpUser"'));
      assert.ok(html.includes('<input type="password" id="smtpPass" name="smtpPass" value=""'));
      assert.ok(html.includes('<input type="text" id="smtpFrom" name="smtpFrom"'));
      assert.ok(html.includes('<input type="url" id="generatorEndpoint" name="generatorEndpoint"'));
    });

    test('mask-only output: known secrets never appear in full and masks appear as placeholders', () => {
      const secretApiKey = 'sk-real-secret-api-key-99887766';
      const secretSmtpPass = 'super-secret-smtp-password-55443322';

      const settings = buildSampleMaskedSettings({
        apiKeyMasked: '••••7766',
        smtpPassMasked: '••••3322',
      });

      const html = renderSettings({ settings });

      // Full plaintext secrets must NEVER appear
      assert.ok(!html.includes(secretApiKey));
      assert.ok(!html.includes(secretSmtpPass));

      // Masks must appear in placeholders
      assert.ok(html.includes('placeholder="••••7766"'));
      assert.ok(html.includes('placeholder="••••3322"'));

      // Secrets must be rendered with value=""
      assert.ok(html.includes('id="aiApiKey" name="aiApiKey" value="" placeholder="••••7766"'));
      assert.ok(html.includes('id="smtpPass" name="smtpPass" value="" placeholder="••••3322"'));
    });

    test('HTML escaping of submitted value containing <script>alert(1)</script> and quotes', () => {
      const settings = buildSampleMaskedSettings();
      const submitted = {
        aiModel: '<script>alert(1)</script>',
        smtpUser: 'bad"user\'<script>',
      };

      const html = renderSettings({ settings, submitted });

      // Raw tag must be absent
      assert.ok(!html.includes('<script>'));
      assert.ok(!html.includes('</script>'));
      assert.ok(!html.toLowerCase().includes('<script'));

      // Escaped text must be present in value attribute
      assert.ok(html.includes('value="&lt;script&gt;alert(1)&lt;/script&gt;"'));
      assert.ok(html.includes('value="bad&quot;user&#39;&lt;script&gt;"'));
    });

    test('saved notice appears when saved === true and is absent when saved is false', () => {
      const settings = buildSampleMaskedSettings();

      const htmlSaved = renderSettings({ settings, saved: true });
      assert.ok(htmlSaved.includes('Settings saved.'));

      const htmlNotSaved = renderSettings({ settings, saved: false });
      assert.ok(!htmlNotSaved.includes('Settings saved.'));

      const htmlDefault = renderSettings({ settings });
      assert.ok(!htmlDefault.includes('Settings saved.'));
    });

    test('error re-render shows submitted non-secret values and each error message', () => {
      const settings = buildSampleMaskedSettings();
      const submitted = {
        aiBaseUrl: 'http://insecure-host.com',
        aiModel: 'custom-submitted-model',
        askDailyCap: '999999',
        smtpPort: '99999',
      };
      const errors = {
        aiBaseUrl: 'Enter an HTTPS base URL (localhost may use HTTP).',
        askDailyCap: 'Daily cap must be a whole number between 1 and 100000.',
        smtpPort: 'Port must be between 1 and 65535.',
      };

      const html = renderSettings({ settings, submitted, errors });

      // Submitted non-secret values appear in value attributes
      assert.ok(html.includes('value="http://insecure-host.com"'));
      assert.ok(html.includes('value="custom-submitted-model"'));
      assert.ok(html.includes('value="999999"'));
      assert.ok(html.includes('value="99999"'));

      // Error summary list
      assert.ok(html.includes('Please fix the following errors'));
      assert.ok(html.includes('Enter an HTTPS base URL (localhost may use HTTP).'));
      assert.ok(html.includes('Daily cap must be a whole number between 1 and 100000.'));
      assert.ok(html.includes('Port must be between 1 and 65535.'));

      // Per-field error messages appear next to fields
      assert.ok(
        html.includes(
          '<span class="field-error" role="alert">Enter an HTTPS base URL (localhost may use HTTP).</span>',
        ),
      );
      assert.ok(
        html.includes(
          '<span class="field-error" role="alert">Daily cap must be a whole number between 1 and 100000.</span>',
        ),
      );
      assert.ok(
        html.includes(
          '<span class="field-error" role="alert">Port must be between 1 and 65535.</span>',
        ),
      );
    });

    test('submitted takes precedence over overrides', () => {
      const settings = buildSampleMaskedSettings();
      const overrides = {
        aiModel: 'overridden-model',
        smtpHost: 'overridden.smtp.com',
      };
      const submitted = {
        aiModel: 'submitted-model',
      };

      const html = renderSettings({ settings, overrides, submitted });

      // submitted took precedence for aiModel
      assert.ok(html.includes('id="aiModel" name="aiModel" value="submitted-model"'));
      // overrides used for smtpHost since submitted did not have it
      assert.ok(html.includes('id="smtpHost" name="smtpHost" value="overridden.smtp.com"'));
    });

    test('effective source hints appear as plain text and secrets have source only', () => {
      const settings = buildSampleMaskedSettings({
        sources: {
          aiBaseUrl: 'admin',
          aiModel: 'env',
          aiApiKey: 'admin',
          askDailyCap: 'default',
          smtpHost: 'env',
          smtpPass: 'default',
        },
      });

      const html = renderSettings({ settings });

      assert.ok(html.includes('Using: admin'));
      assert.ok(html.includes('Using: environment')); // 'env' normalized to 'environment'
      assert.ok(html.includes('Using: default'));

      // For secrets, verify the hint is source only, never a secret or masked value
      const apiKeyBlock = html.match(/<div class="form-field">[\s\S]*?id="aiApiKey"[\s\S]*?<\/div>/)?.[0];
      assert.ok(apiKeyBlock);
      assert.ok(apiKeyBlock.includes('Using: admin'));
      assert.ok(!apiKeyBlock.includes('Using: ••••'));
      assert.ok(!apiKeyBlock.includes('Using: sk-'));

      const smtpPassBlock = html.match(/<div class="form-field">[\s\S]*?id="smtpPass"[\s\S]*?<\/div>/)?.[0];
      assert.ok(smtpPassBlock);
      assert.ok(smtpPassBlock.includes('Using: default'));
      assert.ok(!smtpPassBlock.includes('Using: ••••'));
    });

    test('smtpSecure checkbox state reflects settings and submitted', () => {
      const settingsSecure = buildSampleMaskedSettings({ smtpSecure: true });
      const htmlSecure = renderSettings({ settings: settingsSecure });
      assert.ok(htmlSecure.includes('<input type="checkbox" id="smtpSecure" name="smtpSecure" value="on" checked>'));

      const settingsInsecure = buildSampleMaskedSettings({ smtpSecure: false });
      const htmlInsecure = renderSettings({ settings: settingsInsecure });
      assert.ok(htmlInsecure.includes('<input type="checkbox" id="smtpSecure" name="smtpSecure" value="on">'));
      assert.ok(!htmlInsecure.includes('<input type="checkbox" id="smtpSecure" name="smtpSecure" value="on" checked>'));

      // submitted overrides settings
      const htmlSubmittedSecure = renderSettings({
        settings: settingsInsecure,
        submitted: { smtpSecure: 'on' },
      });
      assert.ok(htmlSubmittedSecure.includes('<input type="checkbox" id="smtpSecure" name="smtpSecure" value="on" checked>'));

      const htmlSubmittedFalse = renderSettings({
        settings: settingsSecure,
        submitted: { smtpSecure: false },
      });
      assert.ok(!htmlSubmittedFalse.includes('checked>'));
    });

    test('separate logout form exists with its own submit button and is not nested', () => {
      const settings = buildSampleMaskedSettings();
      const html = renderSettings({ settings });

      // Settings form must close before logout form opens
      const settingsFormEnd = html.indexOf('</form>');
      const logoutFormStart = html.indexOf('<form method="post" action="/api/admin/logout">');

      assert.ok(settingsFormEnd !== -1, 'settings form must close');
      assert.ok(logoutFormStart !== -1, 'logout form must exist');
      assert.ok(
        settingsFormEnd < logoutFormStart,
        'logout form must not be nested inside settings form',
      );

      // Logout form contains submit button
      const logoutFormMatch = html.match(/<form method="post" action="\/api\/admin\/logout">([\s\S]*?)<\/form>/);
      assert.ok(logoutFormMatch);
      assert.ok(logoutFormMatch[1].includes('<button type="submit">Log out</button>'));
    });

    test('no <script tag in any renderer even with adversarial inputs', () => {
      const renderers = [
        render401(),
        render404(),
        renderLogin({ error: '<script>alert(1)</script>' }),
        renderSettings({
          settings: buildSampleMaskedSettings(),
          overrides: { aiModel: '<script src="evil.js"></script>' },
          submitted: { smtpUser: '<script>evil()</script>' },
          errors: { aiBaseUrl: '<script>fail()</script>' },
        }),
      ];

      for (const renderedHtml of renderers) {
        assert.ok(!renderedHtml.toLowerCase().includes('<script'));
      }
    });

    test('renderSettings with no arguments defaults safely', () => {
      const html = renderSettings();
      assert.ok(html.startsWith('<!doctype html>'));
      assert.ok(html.includes('<h1>Admin settings</h1>'));
      assert.ok(html.includes('<form method="post" action="/api/admin/settings">'));
    });
  });
});
