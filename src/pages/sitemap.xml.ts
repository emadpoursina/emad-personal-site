/**
 * src/pages/sitemap.xml.ts
 *
 * GET /sitemap.xml — prerendered sitemap index.
 * Returns the XML sitemap in the fixed contract order:
 * four public pages, followed by published case studies in content order.
 * Draft studies are never emitted.
 */

import type { APIRoute } from 'astro';
import studiesDoc from '../../content/case-studies.json';
import { buildSitemap } from '../lib/agent-output.mjs';

export const prerender = true;

// Prerendered: the adapter's static path serves this file as `application/xml`
// (no charset parameter — charset is declared in the XML prolog that
// buildSitemap emits). The header here mirrors what is actually served so the
// route and contracts/http-routes.md agree (W1).
export const GET: APIRoute = () =>
  new Response(buildSitemap(studiesDoc), {
    headers: {
      'Content-Type': 'application/xml',
    },
  });
