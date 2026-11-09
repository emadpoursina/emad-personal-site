/**
 * src/pages/api/admin/logout.ts
 *
 * POST /api/admin/logout — Protected admin logout endpoint.
 * Requires an active admin session. Destroys the session row in SQLite
 * and clears the admin_session cookie.
 */

import type { APIRoute } from 'astro';
import * as db from '../../../lib/db.mjs';
import {
  getSessionFromRequest,
  destroySession,
  clearSessionCookie,
  isSecureRequest,
} from '../../../lib/admin-auth.mjs';
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const session = getSessionFromRequest(request, db, { now: Date.now() });
    if (!session) {
      return jsonResponse(401, { ok: false, error: 'unauthorized' });
    }

    destroySession(db, session.id);
    const cookie = clearSessionCookie({
      secure: isSecureRequest(request),
    });

    const isJson = acceptsJson(request.headers.get('accept'));
    if (isJson) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Language': 'en',
          'Set-Cookie': cookie,
        },
      });
    }

    return new Response('', {
      status: 303,
      headers: {
        Location: '/admin/login',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Language': 'en',
        'Set-Cookie': cookie,
      },
    });
  } catch {
    return jsonResponse(500, {
      ok: false,
      error: 'server',
    });
  }
};

export const ALL: APIRoute = async (context) => {
  if (context.request.method === 'POST') {
    return await POST(context);
  }

  const session = getSessionFromRequest(context.request, db, {
    now: Date.now(),
  });
  if (!session) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  }

  return methodNotAllowedResponse(context.request.headers.get('accept'));
};
