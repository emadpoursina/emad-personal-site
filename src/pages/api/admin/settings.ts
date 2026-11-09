/**
 * src/pages/api/admin/settings.ts
 *
 * POST /api/admin/settings — Protected, same-origin admin settings update endpoint.
 * Requires an active admin session and matching origin/referer.
 * Validates and atomically saves the 12 settings fields.
 * Returns JSON or re-renders settings HTML with per-field errors.
 */

import type { APIRoute } from 'astro';
import * as db from '../../../lib/db.mjs';
import {
  getSessionFromRequest,
  isSameOrigin,
} from '../../../lib/admin-auth.mjs';
import {
  saveSettings,
  getMaskedSettings,
  SETTINGS_FIELDS,
} from '../../../lib/settings.mjs';
import {
  renderSettings,
  SETTINGS_FORM_FIELDS,
} from '../../../lib/admin-page.mjs';
import { acceptsJson } from '../../../lib/http.mjs';

export const prerender = false;

function jsonResponse(
  status: number,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Language': 'en',
    ...extraHeaders,
  };

  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

function methodNotAllowedResponse(accept: string | null): Response {
  const isJson = acceptsJson(accept);
  if (isJson) {
    return jsonResponse(
      405,
      { ok: false, error: 'method_not_allowed' },
      { Allow: 'POST' }
    );
  }

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Method not allowed — Emad Poursina</title>
</head>
<body>
  <main id="main">
    <h1>Method not allowed</h1>
    <p>Method not allowed. Use POST.</p>
  </main>
</body>
</html>`,
    {
      status: 405,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Language': 'en',
        Allow: 'POST',
      },
    }
  );
}

function getNonSecretOverrides(): Record<string, string> {
  const all = db.getAllSettings();
  const overrides: Record<string, string> = {};
  for (const [fieldName, meta] of Object.entries(SETTINGS_FIELDS)) {
    if (
      meta.type === 'non-secret' &&
      Object.prototype.hasOwnProperty.call(all, meta.key) &&
      all[meta.key] !== undefined
    ) {
      overrides[fieldName] = String(all[meta.key]);
    }
  }
  return overrides;
}

function getSubmittedNonSecrets(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const submitted: Record<string, unknown> = {};
  for (const [fieldName, meta] of Object.entries(SETTINGS_FIELDS)) {
    if (meta.type === 'non-secret') {
      if (fieldName === 'smtpSecure') {
        submitted.smtpSecure =
          fields.smtpSecure === 'on' ||
          fields.smtpSecure === true ||
          fields.smtpSecure === 'true' ||
          fields.smtpSecure === 1 ||
          fields.smtpSecure === '1';
      } else if (fieldName in fields && fields[fieldName] !== undefined) {
        submitted[fieldName] = fields[fieldName];
      }
    }
  }
  return submitted;
}

async function parseRequestFields(
  request: Request
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || '';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const fields: Record<string, unknown> = {};

  if (mime === 'application/json') {
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  } else if (mime === 'multipart/form-data') {
    try {
      const formData = await request.formData();
      for (const key of SETTINGS_FORM_FIELDS) {
        if (key === 'smtpSecure') {
          fields.smtpSecure = formData.has('smtpSecure')
            ? formData.get('smtpSecure')
            : undefined;
        } else {
          const val = formData.get(key);
          if (val !== null) {
            fields[key] = String(val);
          }
        }
      }
      return fields;
    } catch {
      return {};
    }
  } else {
    try {
      const text = await request.text();
      const params = new URLSearchParams(text);
      for (const key of SETTINGS_FORM_FIELDS) {
        if (key === 'smtpSecure') {
          fields.smtpSecure = params.has('smtpSecure')
            ? (params.get('smtpSecure') ?? 'on')
            : undefined;
        } else {
          const val = params.get(key);
          if (val !== null) {
            fields[key] = val;
          }
        }
      }
      return fields;
    } catch {
      return {};
    }
  }

  return fields;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    // 1. Session first -> 401
    const session = getSessionFromRequest(request, db, { now: Date.now() });
    if (!session) {
      return jsonResponse(401, { ok: false, error: 'unauthorized' });
    }

    // 2. Same-origin check -> 403
    if (!isSameOrigin(request)) {
      const isJson = acceptsJson(request.headers.get('accept'));
      if (isJson) {
        return jsonResponse(403, { ok: false, error: 'cross_origin' });
      }
      return new Response(
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Forbidden — Emad Poursina</title>
</head>
<body>
  <main id="main">
    <h1>Forbidden</h1>
    <p>Cross-origin requests are forbidden.</p>
  </main>
</body>
</html>`,
        {
          status: 403,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Language': 'en',
          },
        }
      );
    }

    // 3. Parse fields and call saveSettings
    const fields = await parseRequestFields(request);
    const saveResult = saveSettings(fields);

    const isJson = acceptsJson(request.headers.get('accept'));

    if (!saveResult.ok) {
      if (isJson) {
        return jsonResponse(400, {
          ok: false,
          error: 'validation',
          errors: saveResult.errors,
        });
      }

      const html = renderSettings({
        settings: getMaskedSettings(),
        overrides: getNonSecretOverrides(),
        errors: saveResult.errors,
        submitted: getSubmittedNonSecrets(fields),
      });

      return new Response(html, {
        status: 400,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Language': 'en',
        },
      });
    }

    // Success
    if (isJson) {
      return new Response(
        JSON.stringify({
          ok: true,
          settings: getMaskedSettings(),
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Language': 'en',
          },
        }
      );
    }

    return new Response('', {
      status: 303,
      headers: {
        Location: '/admin?saved=1',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Language': 'en',
      },
    });
  } catch {
    const isJson = acceptsJson(request.headers.get('accept'));
    if (isJson) {
      return jsonResponse(500, { ok: false, error: 'server' });
    }
    return new Response(
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Server error — Emad Poursina</title>
</head>
<body>
  <main id="main">
    <h1>Server error</h1>
    <p>An internal server error occurred.</p>
  </main>
</body>
</html>`,
      {
        status: 500,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Language': 'en',
        },
      }
    );
  }
};

export const ALL: APIRoute = async (context) => {
  if (context.request.method === 'POST') {
    return await POST(context);
  }

  // Session check first so GET without session returns 401 per normative test matrix
  const session = getSessionFromRequest(context.request, db, {
    now: Date.now(),
  });
  if (!session) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  }

  return methodNotAllowedResponse(context.request.headers.get('accept'));
};
