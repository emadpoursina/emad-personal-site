/**
 * src/pages/api/admin/login.ts
 *
 * POST /api/admin/login — Public admin login endpoint.
 * Accepts form or JSON bodies, enforces in-memory lockout per client IP,
 * verifies password against ADMIN_PASSWORD_HASH with scrypt, and issues
 * an HttpOnly admin_session cookie.
 */

import type { APIRoute } from 'astro';
import * as db from '../../../lib/db.mjs';
import {
  verifyPassword,
  createSession,
  buildSessionCookie,
  isSecureRequest,
  getLockout,
  recordLoginFailure,
  clearLoginFailures,
} from '../../../lib/admin-auth.mjs';
import { acceptsJson } from '../../../lib/http.mjs';
import { getConfig } from '../../../lib/env.mjs';

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

function getClientIp(context: Parameters<APIRoute>[0]): string {
  let clientAddr = '';
  try {
    clientAddr = context.clientAddress ?? '';
  } catch {
    clientAddr = '';
  }

  let clientKey = 'unknown';
  const config = getConfig();
  const xff = context.request.headers.get('x-forwarded-for');

  if (config.TRUST_PROXY === 1 && xff) {
    const first = xff.split(',')[0].trim();
    clientKey = first || clientAddr || 'unknown';
  } else if (clientAddr) {
    clientKey = clientAddr;
  }

  return clientKey;
}

export const POST: APIRoute = async (context) => {
  const { request } = context;

  try {
    const ip = getClientIp(context);

    // Lockout FIRST: check if IP is currently blocked
    const lockout = getLockout(ip, { now: Date.now() });
    if (lockout.blocked) {
      return jsonResponse(
        429,
        {
          ok: false,
          error: 'locked',
          message: 'Too many failed attempts. Try again later.',
          retryAfterSeconds: lockout.retryAfterSeconds,
        },
        { 'Retry-After': String(lockout.retryAfterSeconds) }
      );
    }

    const contentType = request.headers.get('content-type') || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();

    let password: unknown = undefined;

    if (mime === 'application/x-www-form-urlencoded') {
      try {
        const text = await request.text();
        const params = new URLSearchParams(text);
        password = params.get('password');
      } catch {
        password = undefined;
      }
    } else if (mime === 'application/json') {
      try {
        const json = await request.json();
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          password = (json as Record<string, unknown>).password;
        }
      } catch {
        password = undefined;
      }
    } else {
      return jsonResponse(400, {
        ok: false,
        error: 'validation',
        errors: { password: 'Enter your password.' },
      });
    }

    if (
      typeof password !== 'string' ||
      password.length === 0 ||
      password.length > 1024
    ) {
      return jsonResponse(400, {
        ok: false,
        error: 'validation',
        errors: { password: 'Enter your password.' },
      });
    }

    const config = getConfig();
    const storedHash =
      typeof config.ADMIN_PASSWORD_HASH === 'string'
        ? config.ADMIN_PASSWORD_HASH
        : '';

    const valid = await verifyPassword(password, storedHash);

    if (!valid) {
      recordLoginFailure(ip, { now: Date.now() });
      return jsonResponse(401, {
        ok: false,
        error: 'invalid_credentials',
        message: 'Incorrect password.',
      });
    }

    clearLoginFailures(ip);
    const session = createSession(db, { now: Date.now() });
    const cookie = buildSessionCookie(session.id, {
      secure: isSecureRequest(request),
    });

    const isJson = acceptsJson(request.headers.get('accept'));

    if (isJson) {
      return new Response(
        JSON.stringify({ ok: true, expiresAt: session.expiresAt }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Language': 'en',
            'Set-Cookie': cookie,
          },
        }
      );
    }

    return new Response('', {
      status: 303,
      headers: {
        Location: '/admin',
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
  return methodNotAllowedResponse(context.request.headers.get('accept'));
};
