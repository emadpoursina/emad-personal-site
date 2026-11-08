/**
 * src/pages/llms.txt.ts
 *
 * GET /llms.txt — prerendered machine-readable summary for LLM agents.
 * Plain text in the fixed section order from contracts/agent-outputs.md § 3.
 * Draft studies are never emitted.
 */

import type { APIRoute } from 'astro';
import profile from '../../content/profile.json';
import studiesDoc from '../../content/case-studies.json';
import { buildLlmsTxt } from '../lib/agent-output.mjs';

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(buildLlmsTxt(profile, studiesDoc), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
