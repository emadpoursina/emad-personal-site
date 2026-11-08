/**
 * src/pages/resume.json.ts
 *
 * GET /resume.json — prerendered JSON Resume v1.0.0 document.
 * Built from content/profile.json and content/case-studies.json by buildResume().
 * No skill levels (those belong to /api/profile); draft studies never appear.
 */

import type { APIRoute } from 'astro';
import profile from '../../content/profile.json';
import studiesDoc from '../../content/case-studies.json';
import { buildResume } from '../lib/agent-output.mjs';

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildResume(profile, studiesDoc)), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
