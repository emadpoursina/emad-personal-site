/**
 * src/pages/api/admin/[...path].ts
 *
 * Catch-all on-demand route for undefined /api/admin/* endpoints.
 * Checks for an active admin session:
 * - No session -> 401 JSON {"ok":false,"error":"unauthorized"}
 * - Valid session -> 404 JSON {"ok":false,"error":"not_found"}
 */

import type { APIRoute } from 'astro';
import * as db from '../../../lib/db.mjs';
import { getSessionFromRequest } from '../../../lib/admin-auth.mjs';

export const prerender = false;

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Language': 'en',
    },
  });
}

export const ALL: APIRoute = async ({ request }) => {
  try {
    const session = getSessionFromRequest(request, db, { now: Date.now() });
    if (!session) {
      return jsonResponse(401, { ok: false, error: 'unauthorized' });
    }
    return jsonResponse(404, { ok: false, error: 'not_found' });
  } catch {
    return jsonResponse(500, { ok: false, error: 'server' });
  }
};

export const GET: APIRoute = ALL;
export const POST: APIRoute = ALL;
export const PUT: APIRoute = ALL;
export const DELETE: APIRoute = ALL;
export const PATCH: APIRoute = ALL;
