import type { APIRoute } from 'astro';
import * as db from '../../lib/db.mjs';
import { processCoverLetter } from '../../lib/cover-letter-service.mjs';
import { checkPerIp, consumeDaily } from '../../lib/cover-letter-limits.mjs';
import { getConfig } from '../../lib/env.mjs';

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

  if (typeof payload?.retryAfterSeconds === 'number') {
    headers['Retry-After'] = String(payload.retryAfterSeconds);
  }

  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

export const POST: APIRoute = async (context) => {
  try {
    const contentType = context.request.headers.get('content-type') || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();

    if (mime !== 'application/json') {
      return jsonResponse(415, {
        ok: false,
        error: 'unsupported_media_type',
        message: 'Send application/json.',
      });
    }

    let parsedBody: unknown;
    try {
      parsedBody = await context.request.json();
    } catch {
      parsedBody = {};
    }

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

    const result = await processCoverLetter(parsedBody, clientKey, {
      db,
      limits: { checkPerIp, consumeDaily },
    });
    return jsonResponse(result.status, result.payload);
  } catch {
    return jsonResponse(500, {
      ok: false,
      error: 'server',
      message: 'Something went wrong. Please use the general cover letter or the contact form.',
    });
  }
};

export const ALL: APIRoute = async (context) => {
  try {
    if (context.request.method === 'POST') {
      return await POST(context);
    }
    return jsonResponse(
      405,
      {
        ok: false,
        error: 'method_not_allowed',
        message: 'Use POST.',
      },
      { Allow: 'POST' }
    );
  } catch {
    return jsonResponse(500, {
      ok: false,
      error: 'server',
      message: 'Something went wrong. Please use the general cover letter or the contact form.',
    });
  }
};
