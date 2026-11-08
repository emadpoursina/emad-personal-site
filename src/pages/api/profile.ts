/**
 * src/pages/api/profile.ts
 *
 * GET /api/profile — on-demand enriched profile for agents.
 * Exactly resume.json plus top-level last_updated and skills enriched with
 * level and category (contracts/agent-outputs.md § 2).
 *
 * Both content documents are imported and validated once at module scope;
 * a bad content file fails the request path loudly instead of serving
 * half-valid data.
 */

import type { APIRoute } from 'astro';
import profile from '../../../content/profile.json';
import studiesDoc from '../../../content/case-studies.json';
import { validateProfile } from '../../lib/profile.mjs';
import { validateCaseStudies } from '../../lib/case-studies.mjs';
import { buildProfileApi } from '../../lib/agent-output.mjs';

export const prerender = false;

// Validate once, at first module load — never per request.
validateProfile(profile, 'content/profile.json');
validateCaseStudies(studiesDoc, 'content/case-studies.json');

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildProfileApi(profile, studiesDoc)), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
