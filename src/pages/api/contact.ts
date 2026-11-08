/**
 * src/pages/api/contact.ts
 *
 * POST /api/contact — On-demand contact form submission endpoint.
 * Accepts urlencoded, multipart, or json payloads.
 * Validates, rate-limits, inserts pessimistic DB record, sends email, and responds.
 */

import type { APIRoute } from 'astro';
import * as db from '../../lib/db.mjs';
import * as mailer from '../../lib/mailer.mjs';
import { getRateLimiter } from '../../lib/rate-limit.mjs';
import { processContact } from '../../lib/contact-service.mjs';
import { sendOutcome } from '../../lib/http.mjs';
import { getConfig } from '../../lib/env.mjs';

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const accept = request.headers.get('accept');

  try {
    const contentType = request.headers.get('content-type') || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();

    let raw = { name: '', email: '', message: '' };

    if (mime === 'application/x-www-form-urlencoded') {
      const text = await request.text();
      const params = new URLSearchParams(text);
      raw = {
        name: params.get('name') ?? '',
        email: params.get('email') ?? '',
        message: params.get('message') ?? '',
      };
    } else if (mime === 'multipart/form-data') {
      const formData = await request.formData();
      raw = {
        name: String(formData.get('name') ?? ''),
        email: String(formData.get('email') ?? ''),
        message: String(formData.get('message') ?? ''),
      };
    } else if (mime === 'application/json') {
      let json: Record<string, unknown> = {};
      try {
        const parsed = await request.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed;
        }
      } catch {
        json = {};
      }
      raw = {
        name: json.name != null ? String(json.name) : '',
        email: json.email != null ? String(json.email) : '',
        message: json.message != null ? String(json.message) : '',
      };
    } else {
      try {
        const text = await request.text();
        const params = new URLSearchParams(text);
        raw = {
          name: params.get('name') ?? '',
          email: params.get('email') ?? '',
          message: params.get('message') ?? '',
        };
      } catch {
        raw = { name: '', email: '', message: '' };
      }
    }

    let clientAddr = '';
    try {
      clientAddr = clientAddress;
    } catch {
      clientAddr = '';
    }

    let clientKey = 'unknown';
    const config = getConfig();
    const xff = request.headers.get('x-forwarded-for');

    if (config.TRUST_PROXY === 1 && xff) {
      const first = xff.split(',')[0].trim();
      clientKey = first || clientAddr || 'unknown';
    } else if (clientAddr) {
      clientKey = clientAddr;
    }

    const result = await processContact(raw, clientKey, {
      db,
      mailer,
      rateLimiter: getRateLimiter(),
    });

    const { status, headers, body } = sendOutcome(result.status, result.payload, accept);

    if (status === 429 && result.payload?.retryAfterSeconds !== undefined) {
      headers['Retry-After'] = String(result.payload.retryAfterSeconds);
    }

    return new Response(body, { status, headers });
  } catch {
    const { status, headers, body } = sendOutcome(500, { ok: false, error: 'storage' }, accept);
    return new Response(body, { status, headers });
  }
};

export const ALL: APIRoute = ({ request }) => {
  if (request.method === 'POST') {
    return POST({ request } as Parameters<APIRoute>[0]);
  }
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
