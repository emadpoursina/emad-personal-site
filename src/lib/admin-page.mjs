/**
 * src/lib/admin-page.mjs
 *
 * Pure HTML renderers for admin surfaces:
 * - render401: 401 Not authorized page (no settings, link to login, noindex)
 * - render404: 404 Page not found page (no settings, link to /, noindex)
 * - renderLogin: public login form (posts to /api/admin/login, no script, no settings, noindex)
 * - renderSettings: settings form with 12 fields, masked secret placeholders,
 *   source hints, field errors, error summary, saved notice, and separate logout form.
 *
 * All interpolated values are escaped with escapeHtml.
 * No client-side scripts, full secrets, envelopes, or hash credentials are ever emitted.
 */

/**
 * Escapes characters with special meaning in HTML (& < > " ').
 * All interpolated values in every renderer must go through it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The 12 settings form fields in exact required order.
 */
export const SETTINGS_FORM_FIELDS = Object.freeze([
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

/**
 * Metadata configuration for each of the 12 fields.
 */
const FIELD_DEFINITIONS = Object.freeze([
  {
    name: 'aiBaseUrl',
    label: 'AI base URL',
    type: 'url',
    secret: false,
    placeholderKey: 'aiBaseUrl',
  },
  {
    name: 'aiModel',
    label: 'AI model',
    type: 'text',
    secret: false,
    placeholderKey: 'aiModel',
  },
  {
    name: 'aiApiKey',
    label: 'AI API key',
    type: 'password',
    secret: true,
    placeholderKey: 'apiKeyMasked',
  },
  {
    name: 'askDailyCap',
    label: 'Daily cap (assistant + cover letter)',
    type: 'number',
    secret: false,
    min: 1,
    max: 100000,
    placeholderKey: 'askDailyCap',
  },
  {
    name: 'askRateLimitPerHour',
    label: 'Rate limit per hour',
    type: 'number',
    secret: false,
    min: 1,
    max: 1000,
    placeholderKey: 'askRateLimitPerHour',
  },
  {
    name: 'smtpHost',
    label: 'SMTP host',
    type: 'text',
    secret: false,
    placeholderKey: 'smtpHost',
  },
  {
    name: 'smtpPort',
    label: 'SMTP port',
    type: 'number',
    secret: false,
    min: 1,
    max: 65535,
    placeholderKey: 'smtpPort',
  },
  {
    name: 'smtpSecure',
    label: 'SMTP secure',
    type: 'checkbox',
    secret: false,
  },
  {
    name: 'smtpUser',
    label: 'SMTP username',
    type: 'text',
    secret: false,
    placeholderKey: 'smtpUser',
  },
  {
    name: 'smtpPass',
    label: 'SMTP password',
    type: 'password',
    secret: true,
    placeholderKey: 'smtpPassMasked',
  },
  {
    name: 'smtpFrom',
    label: 'SMTP from',
    type: 'text',
    secret: false,
    placeholderKey: 'smtpFrom',
  },
  {
    name: 'generatorEndpoint',
    label: 'Generator endpoint',
    type: 'url',
    secret: false,
    placeholderKey: 'generatorEndpoint',
  },
]);

/**
 * Normalizes source value from settings.sources.<field> to 'admin', 'environment', or 'default'.
 *
 * @param {string | undefined} raw
 * @returns {string}
 */
function normalizeSource(raw) {
  if (raw === 'env') return 'environment';
  if (raw === 'admin' || raw === 'environment' || raw === 'default') {
    return raw;
  }
  return raw || 'default';
}

/**
 * Common HTML head styles adhering to design tokens without new colours.
 */
const COMMON_STYLES = `
    body {
      margin: 0;
      padding: 1.5rem 1rem;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      color: var(--fg);
      background-color: var(--bg);
    }
    main {
      max-width: 640px;
      margin: 0 auto;
    }
    h1 {
      color: var(--fg-heading);
      margin-top: 0;
      margin-bottom: 1rem;
      line-height: 1.25;
    }
    a {
      color: var(--fg-link);
      text-underline-offset: 0.15em;
    }
    a:hover {
      color: var(--fg-link-hover);
    }
    .form-field {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      margin-bottom: 0.25rem;
      font-weight: 500;
      color: var(--fg);
    }
    input[type="text"],
    input[type="url"],
    input[type="number"],
    input[type="password"] {
      display: block;
      width: 100%;
      padding: 0.5rem 0.75rem;
      box-sizing: border-box;
      font: inherit;
      font-size: 1rem;
      color: var(--fg);
      background-color: var(--bg-form);
      border: 1px solid var(--fg-muted);
      border-radius: 4px;
    }
    :focus-visible,
    input[type="text"]:focus,
    input[type="url"]:focus,
    input[type="number"]:focus,
    input[type="password"]:focus,
    input[type="checkbox"]:focus,
    button:focus,
    a:focus {
      outline: 3px solid var(--focus-ring);
      outline-offset: 2px;
    }
    .source-hint {
      display: block;
      font-size: 0.875rem;
      color: var(--fg-muted);
      margin-top: 0.25rem;
    }
    .field-error {
      display: block;
      font-size: 0.875rem;
      color: var(--color-error);
      margin-top: 0.25rem;
    }
    .error-summary {
      padding: 1rem;
      margin-bottom: 1.5rem;
      border: 2px solid var(--color-error);
      border-radius: 4px;
      background-color: var(--bg-form);
    }
    .error-summary h2 {
      margin-top: 0;
      font-size: 1.1rem;
      color: var(--color-error);
    }
    .error-summary ul {
      margin: 0.5rem 0 0 1.25rem;
      padding: 0;
    }
    .notice-success {
      padding: 0.75rem 1rem;
      margin-bottom: 1.5rem;
      border: 2px solid var(--color-success);
      border-radius: 4px;
      background-color: var(--bg-form);
      color: var(--color-success);
    }
    button {
      display: inline-block;
      padding: 0.6rem 1.5rem;
      font: inherit;
      font-size: 1rem;
      font-weight: 600;
      color: var(--fg-btn);
      background-color: var(--bg-btn);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover {
      color: var(--fg-btn-hover);
      background-color: var(--bg-btn-hover);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .admin-logout {
      margin-top: 2.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--bg-muted);
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }`;

/**
 * Renders the 401 Not authorized page.
 * Full HTML document with no settings, no session data, no script, and noindex meta.
 *
 * @returns {string}
 */
export function render401() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Not authorized — Emad Poursina</title>
  <link rel="stylesheet" href="/styles/tokens.css">
  <style>${COMMON_STYLES}
  </style>
</head>
<body>
  <main id="main">
    <h1>Not authorized</h1>
    <p>You are not authorized to view this page. Please log in.</p>
    <p><a href="/admin/login">Log in</a></p>
  </main>
</body>
</html>`;
}

/**
 * Renders the 404 Page not found page for admin routes.
 * Full HTML document with no settings, no script, and noindex meta.
 *
 * @returns {string}
 */
export function render404() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Page not found — Emad Poursina</title>
  <link rel="stylesheet" href="/styles/tokens.css">
  <style>${COMMON_STYLES}
  </style>
</head>
<body>
  <main id="main">
    <h1>Page not found</h1>
    <p>The page you requested could not be found.</p>
    <p><a href="/">Back to home</a></p>
  </main>
</body>
</html>`;
}

/**
 * Renders the admin login page.
 * Full HTML document with login form, no script, no settings, and noindex meta.
 *
 * @param {{ error?: string }} [options]
 * @returns {string}
 */
export function renderLogin({ error = '' } = {}) {
  const errorHtml = error
    ? `\n    <div class="field-error" role="alert"><p>${escapeHtml(error)}</p></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Admin login — Emad Poursina</title>
  <link rel="stylesheet" href="/styles/tokens.css">
  <style>${COMMON_STYLES}
  </style>
</head>
<body>
  <main id="main">
    <h1>Admin login</h1>${errorHtml}
    <form method="post" action="/api/admin/login" enctype="application/x-www-form-urlencoded">
      <div class="form-field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit">Log in</button>
    </form>
    <p><a href="/">Back to home</a></p>
  </main>
</body>
</html>`;
}

/**
 * Renders the admin settings page.
 * Full HTML document with the 12 settings fields, masked secret placeholders,
 * error summary and field errors, effective-source hints, saved notice, logout form,
 * and noindex meta. Client-side scripts and full secrets are forbidden.
 *
 * @param {{
 *   settings?: Record<string, any>;
 *   overrides?: Record<string, unknown>;
 *   errors?: Record<string, string>;
 *   saved?: boolean;
 *   submitted?: Record<string, unknown>;
 * }} [options]
 * @returns {string}
 */
export function renderSettings({
  settings = {},
  overrides = {},
  errors = {},
  saved = false,
  submitted = {},
} = {}) {
  // Success notice
  let savedNoticeHtml = '';
  if (saved === true) {
    savedNoticeHtml = `
    <div class="notice-success" role="status">
      <p>Settings saved.</p>
    </div>`;
  }

  // Error summary
  let errorSummaryHtml = '';
  if (errors && typeof errors === 'object' && Object.keys(errors).length > 0) {
    const errorItems = Object.entries(errors)
      .map(([fieldName, message]) => `        <li><a href="#${escapeHtml(fieldName)}">${escapeHtml(message)}</a></li>`)
      .join('\n');
    errorSummaryHtml = `
    <div class="error-summary" role="alert" tabindex="-1">
      <h2>Please fix the following errors</h2>
      <ul>
${errorItems}
      </ul>
    </div>`;
  }

  // Render each of the 12 fields
  const fieldsHtml = FIELD_DEFINITIONS.map((field) => {
    const rawSource = settings?.sources?.[field.name];
    const source = normalizeSource(rawSource);
    const sourceHintHtml = `<span class="source-hint">Using: ${escapeHtml(source)}</span>`;

    const fieldError = errors?.[field.name];
    const fieldErrorHtml = fieldError
      ? `\n      <span class="field-error" role="alert">${escapeHtml(fieldError)}</span>`
      : '';

    // Checkbox field: smtpSecure
    if (field.type === 'checkbox') {
      const isChecked = (submitted && 'smtpSecure' in submitted)
        ? (submitted.smtpSecure === 'on' || submitted.smtpSecure === true || submitted.smtpSecure === 'true' || submitted.smtpSecure === 1 || submitted.smtpSecure === '1')
        : Boolean(settings?.smtpSecure);

      return `    <div class="form-field">
      <label for="smtpSecure">${escapeHtml(field.label)}</label>
      <input type="checkbox" id="smtpSecure" name="smtpSecure" value="on"${isChecked ? ' checked' : ''}>
      ${sourceHintHtml}${fieldErrorHtml}
    </div>`;
    }

    // Secret fields: aiApiKey, smtpPass
    if (field.secret) {
      const placeholder = settings?.[field.placeholderKey]
        ? String(settings[field.placeholderKey])
        : '';

      return `    <div class="form-field">
      <label for="${escapeHtml(field.name)}">${escapeHtml(field.label)}</label>
      <input type="password" id="${escapeHtml(field.name)}" name="${escapeHtml(field.name)}" value="" placeholder="${escapeHtml(placeholder)}">
      ${sourceHintHtml}${fieldErrorHtml}
    </div>`;
    }

    // Non-secret fields
    let value = '';
    if (submitted && submitted[field.name] !== undefined && submitted[field.name] !== null) {
      value = String(submitted[field.name]);
    } else if (overrides && overrides[field.name] !== undefined && overrides[field.name] !== null) {
      value = String(overrides[field.name]);
    }

    let placeholder = '';
    if (settings && settings[field.placeholderKey] !== undefined && settings[field.placeholderKey] !== null) {
      placeholder = String(settings[field.placeholderKey]);
    }

    let boundsAttrs = '';
    if (field.min !== undefined) {
      boundsAttrs += ` min="${field.min}"`;
    }
    if (field.max !== undefined) {
      boundsAttrs += ` max="${field.max}"`;
    }

    return `    <div class="form-field">
      <label for="${escapeHtml(field.name)}">${escapeHtml(field.label)}</label>
      <input type="${field.type}" id="${escapeHtml(field.name)}" name="${escapeHtml(field.name)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"${boundsAttrs}>
      ${sourceHintHtml}${fieldErrorHtml}
    </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Admin settings — Emad Poursina</title>
  <link rel="stylesheet" href="/styles/tokens.css">
  <style>${COMMON_STYLES}
  </style>
</head>
<body>
  <main id="main">
    <h1>Admin settings</h1>${savedNoticeHtml}${errorSummaryHtml}
    <form method="post" action="/api/admin/settings">
${fieldsHtml}
      <button type="submit">Save settings</button>
    </form>
    <section class="admin-logout">
      <form method="post" action="/api/admin/logout">
        <button type="submit">Log out</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}
