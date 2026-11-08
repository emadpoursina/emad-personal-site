/**
 * src/pages/healthz.ts
 *
 * GET /healthz — on-demand health check endpoint.
 * Returns 200 {status:'ok',db:'ok',smtp:'configured'|'disabled',uptimeSeconds}
 * or 503 {status:'degraded',db:'error',...} when the DB cannot be opened.
 * Never exposes secrets, paths, or dependency versions.
 */

import type { APIRoute } from 'astro';
import { isHealthy } from '../lib/db.mjs';
import { smtpStatus } from '../lib/env.mjs';

export const prerender = false;

const startTime = Date.now();

export const GET: APIRoute = () => {
  const dbOk = isHealthy();
  const smtp = smtpStatus();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  if (dbOk) {
    return new Response(
      JSON.stringify({ status: 'ok', db: 'ok', smtp, uptimeSeconds }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      }
    );
  }

  return new Response(
    JSON.stringify({ status: 'degraded', db: 'error', smtp, uptimeSeconds }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
};

// 404 for any other method
export const ALL: APIRoute = ({ request }) => {
  if (request.method === 'GET') {
    return GET({ request } as Parameters<APIRoute>[0]);
  }
  return new Response(null, { status: 405, headers: { Allow: 'GET' } });
};
