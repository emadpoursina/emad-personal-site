#!/usr/bin/env node
/**
 * scripts/test-public-routes.mjs
 *
 * Live-server proof for every row of contracts/http-routes.md
 * § Behavioural contract (T023).
 *
 * Boots the built standalone server (dist/server/entry.mjs) on a free port
 * with a temporary DATA_DIR, exercises each route with fetch, and shuts the
 * server down and removes the temp directory afterwards.
 *
 * Run `npm run build` first. Exits 0 and prints "public-routes ok" on success;
 * exits 1 naming the URL and assertion for every failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILL_CATEGORY_ORDER, displayLevel } from '../src/lib/skills.mjs';
import { publishedStudies } from '../src/lib/case-studies.mjs';
import { DRAFT_SLUG, DRAFT_URL, firstDifference } from './lib/contract.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'server', 'entry.mjs');
const CLIENT = path.join(ROOT, 'dist', 'client');

if (!existsSync(ENTRY)) {
  console.error('run npm run build first');
  process.exit(1);
}

const profile = JSON.parse(readFileSync(path.join(ROOT, 'content', 'profile.json'), 'utf8'));
const studiesDoc = JSON.parse(readFileSync(path.join(ROOT, 'content', 'case-studies.json'), 'utf8'));
const published = publishedStudies(studiesDoc);

// "VoiceDash" is approved public CV content (an employer role and a profile
// project since Phase 1); the banned thing is the DRAFT CASE STUDY. On the two
// surfaces that carry employment history the assertion targets the draft study
// URL; llms.txt and sitemap.xml contain no employment data and keep the strict
// bare-substring ban. DRAFT_SLUG, DRAFT_URL and firstDifference live in
// scripts/lib/contract.mjs (shared, S2).

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const passes = [];

/**
 * Records a failure.
 * @param {string} url
 * @param {string} msg
 */
function fail(url, msg) {
  failures.push(`${url}: ${msg}`);
}

/**
 * Records a pass.
 * @param {string} name
 */
function pass(name) {
  passes.push(name);
}

/**
 * Decodes the HTML entities Astro emits inside text nodes.
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'");
}

/**
 * Returns the decoded visible text of an HTML document.
 * @param {string} html
 * @returns {string}
 */
function visibleText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ');
}

/**
 * Returns the decoded text of every heading with the given tag, in document order.
 * @param {string} html
 * @param {string} tag
 * @returns {string[]}
 */
function headingTexts(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  /** @type {string[]} */
  const texts = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    texts.push(
      decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    );
  }
  return texts;
}

/**
 * Returns the inner HTML of <main id="main">.
 * @param {string} html
 * @returns {string | null}
 */
function mainInnerHtml(html) {
  const match = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

/**
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForHealthz(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for GET /healthz on port ${port}`);
}

/**
 * @param {import('node:child_process').ChildProcess | null} proc
 */
async function stopProc(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    const done = () => resolve(undefined);
    proc.once('exit', done);
    try {
      proc.kill('SIGTERM');
    } catch {
      resolve(undefined);
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(undefined);
    }, 3000);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess | null} */
let serverProc = null;
/** @type {string | null} */
let dataDir = null;

try {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'public-routes-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;

  serverProc = spawn(process.execPath, ['--experimental-sqlite', 'dist/server/entry.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      // SMTP intentionally unset: /healthz must still be 200 with smtp "disabled".
      SMTP_HOST: '',
      SMTP_PORT: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      CONTACT_TO: profile.contactEmail,
      TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** @type {string[]} */
  const serverStderr = [];
  serverProc.stderr?.on('data', (chunk) => serverStderr.push(String(chunk)));

  try {
    await waitForHealthz(port);
  } catch (err) {
    throw new Error(
      `${/** @type {Error} */ (err).message}\nserver stderr:\n${serverStderr.join('')}`
    );
  }

  /**
   * Fetches a URL and asserts status, content type, and body.
   * @param {string} urlPath
   * @param {{ status?: number; contentType?: string; method?: string; headers?: Record<string, string> }} expect
   * @returns {Promise<{ res: Response; body: string; bytes: Buffer }>}
   */
  async function fetchRoute(urlPath, expect = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method: expect.method ?? 'GET',
      headers: expect.headers,
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const body = bytes.toString('utf8');
    const wantStatus = expect.status ?? 200;
    if (res.status !== wantStatus) {
      fail(urlPath, `expected status ${wantStatus}, got ${res.status}`);
    }
    if (expect.contentType) {
      const got = res.headers.get('content-type') ?? '';
      if (!got.toLowerCase().startsWith(expect.contentType.toLowerCase())) {
        fail(urlPath, `expected Content-Type ${expect.contentType}, got ${got || '(none)'}`);
      }
    }
    return { res, body, bytes };
  }

  // -------------------------------------------------------------------------
  // 1. Phase 1 regression: /, /contact, /cv.pdf, /healthz
  // -------------------------------------------------------------------------

  {
    const { res, body } = await fetchRoute('/', { contentType: 'text/html; charset=utf-8' });
    if (res.status === 200) {
      const text = visibleText(body);
      if (!text.includes(profile.headline)) fail('/', 'missing the headline');
      if (!text.includes(profile.name)) fail('/', 'missing the name');
      if (!body.includes('href="/case-studies"')) fail('/', 'missing the Case Studies link');
      if (!body.includes('href="/cv.pdf"')) fail('/', 'missing the CV link');
      if (!body.includes('href="/contact"')) fail('/', 'missing the Contact link');
      pass('GET / (Phase 1 regression)');
    }
  }

  {
    const { res, body } = await fetchRoute('/contact', { contentType: 'text/html; charset=utf-8' });
    if (res.status === 200) {
      if (!/<form\b[^>]*method=["']post["']/i.test(body)) fail('/contact', 'missing the native form POST');
      if (!/<textarea\b/i.test(body)) fail('/contact', 'missing the message textarea');
      pass('GET /contact (Phase 1 regression)');
    }
  }

  {
    const { res, bytes } = await fetchRoute('/cv.pdf', { contentType: 'application/pdf' });
    if (res.status === 200) {
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') fail('/cv.pdf', 'does not start with %PDF-');
      if (bytes.length <= 10 * 1024) fail('/cv.pdf', `is ${bytes.length} bytes, expected > 10 KB`);
      pass('GET /cv.pdf (Phase 1 regression)');
    }
  }

  {
    const { res, body } = await fetchRoute('/healthz', { contentType: 'application/json' });
    if (res.status === 200) {
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        fail('/healthz', 'body is not JSON');
      }
      if (json) {
        if (json.status !== 'ok') fail('/healthz', `expected status "ok", got ${JSON.stringify(json.status)}`);
        if (json.db !== 'ok') fail('/healthz', `expected db "ok", got ${JSON.stringify(json.db)}`);
      }
      const cache = res.headers.get('cache-control') ?? '';
      if (!/no-store/i.test(cache)) fail('/healthz', `expected Cache-Control no-store, got ${cache || '(none)'}`);
      pass('GET /healthz (Phase 1 regression)');
    }
  }

  // -------------------------------------------------------------------------
  // 2. /about
  // -------------------------------------------------------------------------

  {
    const { res, body } = await fetchRoute('/about', { contentType: 'text/html; charset=utf-8' });
    if (res.status === 200) {
      const text = visibleText(body);

      if (!text.includes(profile.bio)) fail('/about', 'missing the summary/bio');

      for (const category of SKILL_CATEGORY_ORDER) {
        if (!text.includes(category)) fail('/about', `missing skill category heading "${category}"`);
      }

      for (const skill of profile.skills) {
        if (!text.includes(skill.name)) fail('/about', `missing skill name "${skill.name}"`);
        if (displayLevel(skill.level) === 'Learning' && !text.includes('Learning')) {
          fail('/about', `missing the "Learning" label for "${skill.name}"`);
        }
      }

      for (const entry of profile.education) {
        if (!text.includes(entry.institution)) fail('/about', `missing education institution "${entry.institution}"`);
        if (!text.includes(entry.degree)) fail('/about', `missing education degree "${entry.degree}"`);
      }

      for (const language of profile.languages) {
        if (!text.includes(language.name)) fail('/about', `missing language "${language.name}"`);
        if (!text.includes(language.level)) fail('/about', `missing language level "${language.level}"`);
      }

      const teamRole = profile.experience.find((exp) => exp.context === 'team');
      if (!teamRole) {
        fail('/about', 'profile has no team-context role to assert against');
      } else {
        if (!text.includes(teamRole.company)) fail('/about', `missing team-context company "${teamRole.company}"`);
        if (!text.includes('Team context')) fail('/about', 'missing the "Team context" label');
        if (!text.includes('This work was done within a team.')) fail('/about', 'missing the team context sentence');
      }

      pass('GET /about');
    }
  }

  // -------------------------------------------------------------------------
  // 2b. /ask
  // -------------------------------------------------------------------------

  {
    const { res, body } = await fetchRoute('/ask', { contentType: 'text/html' });
    if (res.status === 200) {
      if (!/<form\b/i.test(body)) fail('/ask', 'missing <form element');
      if (!body.includes('maxlength="1000"')) fail('/ask', 'missing maxlength="1000"');
      if (!body.includes('AI assistant. The CV and case studies are the source of record.')) {
        fail('/ask', 'missing exact text "AI assistant. The CV and case studies are the source of record."');
      }
      pass('GET /ask');
    }
  }

  // -------------------------------------------------------------------------
  // 3. /case-studies index
  // -------------------------------------------------------------------------

  {
    const { res, body } = await fetchRoute('/case-studies', { contentType: 'text/html; charset=utf-8' });
    if (res.status === 200) {
      const text = visibleText(body);
      for (const study of published) {
        if (!text.includes(study.title)) fail('/case-studies', `missing published title "${study.title}"`);
        if (!body.includes(`href="/case-studies/${study.slug}"`)) {
          fail('/case-studies', `missing link to /case-studies/${study.slug}`);
        }
      }
      if (new RegExp(DRAFT_SLUG, 'i').test(body)) fail('/case-studies', `contains draft slug "${DRAFT_SLUG}"`);
      pass('GET /case-studies');
    }
  }

  // -------------------------------------------------------------------------
  // 4. Case-study detail pages
  // -------------------------------------------------------------------------

  const EXPECTED_HEADINGS = ['Problem', 'My Contribution', 'Outcome', 'Stack', 'Public Link'];

  for (const study of published) {
    const urlPath = `/case-studies/${study.slug}`;
    const { res, body } = await fetchRoute(urlPath, { contentType: 'text/html; charset=utf-8' });
    if (res.status !== 200) continue;

    const main = mainInnerHtml(body);
    if (main === null) {
      fail(urlPath, 'has no <main> element');
      continue;
    }

    const headings = headingTexts(main, 'h2');
    const headingsDiff = firstDifference(headings, EXPECTED_HEADINGS, 'h2');
    if (headingsDiff) fail(urlPath, `h2 order mismatch: ${headingsDiff}`);

    const text = visibleText(main);
    for (const field of ['problem', 'contribution', 'outcome']) {
      if (typeof study[field] === 'string' && !text.includes(study[field])) {
        fail(urlPath, `missing ${field}`);
      }
    }
    for (const item of study.stack) {
      if (!text.includes(item)) fail(urlPath, `missing stack item "${item}"`);
    }

    if (study.visibility === 'public') {
      const link = study.publicLink?.url;
      if (!link) {
        fail(urlPath, 'public study has no publicLink.url to assert');
      } else if (!body.includes(`href="${link}"`)) {
        fail(urlPath, `missing public link href ${link}`);
      }
      if (!/rel=["']noopener["']/.test(body)) fail(urlPath, 'public link is missing rel="noopener"');
    } else {
      if (!text.includes('Private personal project — no public link.')) {
        fail(urlPath, 'private study is missing the no-public-link sentence');
      }
      const outbound = [...main.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
      if (outbound.length > 0) {
        fail(urlPath, `private study body contains outbound link(s): ${outbound.join(', ')}`);
      }
    }

    pass(`GET ${urlPath}`);
  }

  // -------------------------------------------------------------------------
  // 5. Draft study is exactly 404
  // -------------------------------------------------------------------------

  {
    const { res, body } = await fetchRoute(`/case-studies/${DRAFT_SLUG}`, {
      status: 404,
      contentType: 'text/html; charset=utf-8',
    });
    if (res.status === 404) {
      for (const study of studiesDoc.studies) {
        if (study.status === 'draft' && typeof study.problem === 'string' && body.includes(study.problem)) {
          fail(`/case-studies/${DRAFT_SLUG}`, '404 body leaks draft narrative content');
        }
      }
      pass(`GET /case-studies/${DRAFT_SLUG} → exactly 404`);
    }
  }

  {
    const { res } = await fetchRoute('/case-studies/does-not-exist', { status: 404 });
    if (res.status === 404) pass('GET /case-studies/<unknown> → 404');
  }

  // -------------------------------------------------------------------------
  // 5b. Admin routes (T034): /admin, /admin/login, /admin/* catch-all
  // -------------------------------------------------------------------------

  const BANNED_ADMIN_STRINGS = ['Admin settings', '••••', 'v1:', 'ADMIN_PASSWORD_HASH', 'ENCRYPTION_KEY'];
  const ADMIN_FACTS = ['ADMIN_PASSWORD_HASH', 'ENCRYPTION_KEY', 'admin_session'];

  {
    const { res, body } = await fetchRoute('/admin', { status: 401, contentType: 'text/html' });
    if (res.status === 401) {
      if (!body.includes('noindex')) fail('/admin', 'missing "noindex"');
      if (!body.includes('href="/admin/login"')) fail('/admin', 'missing href="/admin/login"');
      for (const banned of BANNED_ADMIN_STRINGS) {
        if (body.includes(banned)) fail('/admin', `body leaks "${banned}"`);
      }
      pass('GET /admin (unauthenticated → 401)');
    }
  }

  {
    const { res, body } = await fetchRoute('/admin/login', { contentType: 'text/html' });
    if (res.status === 200) {
      if (!body.includes('noindex')) fail('/admin/login', 'missing "noindex"');
      if (!/<input\b[^>]*\btype=["']password["']/i.test(body) && !body.includes('type="password"')) {
        fail('/admin/login', 'missing type="password" input');
      }
      if (!/<form\b[^>]*\baction=["']\/api\/admin\/login["']/i.test(body) && !body.includes('action="/api/admin/login"')) {
        fail('/admin/login', 'missing form action="/api/admin/login"');
      }
      for (const banned of BANNED_ADMIN_STRINGS) {
        if (body.includes(banned)) fail('/admin/login', `body leaks "${banned}"`);
      }
      pass('GET /admin/login');
    }
  }

  {
    const { res, body } = await fetchRoute('/admin/whatever', { status: 401, contentType: 'text/html' });
    if (res.status === 401) {
      if (!body.includes('noindex')) fail('/admin/whatever', 'missing "noindex"');
      pass('GET /admin/whatever → 401 (catch-all)');
    }
  }

  // -------------------------------------------------------------------------
  // 6. /llms.txt
  // -------------------------------------------------------------------------

  {
    const { res, body } = await fetchRoute('/llms.txt', { contentType: 'text/plain; charset=utf-8' });
    if (res.status === 200) {
      if (!body.startsWith(`# ${profile.name}`)) fail('/llms.txt', 'does not start with the name heading');
      if (!body.includes(`> ${profile.headline}`)) fail('/llms.txt', 'missing the headline blockquote');
      for (const role of profile.targetRoles) {
        if (!body.includes(`- ${role}`)) fail('/llms.txt', `missing target role "${role}"`);
      }
      if (!body.includes(profile.workAuthorization)) fail('/llms.txt', 'missing the work-authorization line');
      if (!body.includes(profile.availability)) fail('/llms.txt', 'missing the availability line');
      for (const study of published) {
        if (!body.includes(`/case-studies/${study.slug}`)) {
          fail('/llms.txt', `missing published study URL for ${study.slug}`);
        }
      }
      if (!body.includes('/cv.pdf')) fail('/llms.txt', 'missing the CV URL');
      if (!body.includes('/contact')) fail('/llms.txt', 'missing the contact URL');
      if (!body.includes(profile.contactEmail)) fail('/llms.txt', 'missing the contact email');
      if (new RegExp(DRAFT_SLUG, 'i').test(body)) fail('/llms.txt', `contains draft slug "${DRAFT_SLUG}"`);
      if (body.includes('/admin')) fail('/llms.txt', 'contains "/admin" path');
      for (const fact of ADMIN_FACTS) {
        if (body.includes(fact)) fail('/llms.txt', `contains admin fact "${fact}"`);
      }
      pass('GET /llms.txt');
    }
  }

  // -------------------------------------------------------------------------
  // 7. /resume.json
  // -------------------------------------------------------------------------

  /** @type {any} */
  let resumeJson = null;
  {
    const { res, body } = await fetchRoute('/resume.json', { contentType: 'application/json; charset=utf-8' });
    if (res.status === 200) {
      try {
        resumeJson = JSON.parse(body);
      } catch {
        fail('/resume.json', 'body is not valid JSON');
      }
      if (resumeJson) {
        if (resumeJson.$schema !== 'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json') {
          fail('/resume.json', `unexpected $schema ${JSON.stringify(resumeJson.$schema)}`);
        }
        if (resumeJson.basics?.name !== profile.name) fail('/resume.json', 'basics.name mismatch');
        if (resumeJson.basics?.email !== profile.contactEmail) fail('/resume.json', 'basics.email mismatch');
        if (resumeJson.basics?.summary !== profile.bio) fail('/resume.json', 'basics.summary mismatch');
        if (!Array.isArray(resumeJson.work) || resumeJson.work.length !== profile.experience.length) {
          fail('/resume.json', `work[] length ${resumeJson.work?.length} != experience length ${profile.experience.length}`);
        }
        if (!Array.isArray(resumeJson.skills) || resumeJson.skills.length !== profile.skills.length) {
          fail('/resume.json', `skills[] length ${resumeJson.skills?.length} != ${profile.skills.length}`);
        }
        for (const skill of resumeJson.skills ?? []) {
          if ('level' in skill) fail('/resume.json', `skill "${skill.name}" leaks a level (belongs to /api/profile)`);
        }
        if (Array.isArray(resumeJson.projects)) {
          const expectedProjects = profile.projects.length + published.length;
          if (resumeJson.projects.length !== expectedProjects) {
            fail('/resume.json', `projects[] length ${resumeJson.projects.length} != ${expectedProjects} (profile projects + published studies)`);
          }
        } else {
          fail('/resume.json', 'projects[] is missing');
        }
        if (new RegExp(DRAFT_URL, 'i').test(body)) fail('/resume.json', `contains draft study URL "${DRAFT_URL}"`);
        if (body.includes('/admin')) fail('/resume.json', 'contains "/admin" path');
        for (const fact of ADMIN_FACTS) {
          if (body.includes(fact)) fail('/resume.json', `contains admin fact "${fact}"`);
        }
      }
      pass('GET /resume.json');
    }
  }

  // -------------------------------------------------------------------------
  // 8. /api/profile
  // -------------------------------------------------------------------------

  {
    const { res, body } = await fetchRoute('/api/profile', { contentType: 'application/json; charset=utf-8' });
    if (res.status === 200) {
      const cache = res.headers.get('cache-control') ?? '';
      if (!/public,\s*max-age=300/i.test(cache)) {
        fail('/api/profile', `expected Cache-Control "public, max-age=300", got ${cache || '(none)'}`);
      }

      /** @type {any} */
      let api = null;
      try {
        api = JSON.parse(body);
      } catch {
        fail('/api/profile', 'body is not valid JSON');
      }

      if (api) {
        if (api.last_updated !== profile.lastUpdated) {
          fail('/api/profile', `last_updated ${JSON.stringify(api.last_updated)} != profile.lastUpdated ${JSON.stringify(profile.lastUpdated)}`);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(api.last_updated))) {
          fail('/api/profile', 'last_updated is not an ISO YYYY-MM-DD date');
        }

        if (!Array.isArray(api.skills) || api.skills.length !== profile.skills.length) {
          fail('/api/profile', `skills[] length ${api.skills?.length} != ${profile.skills.length}`);
        }
        for (const [i, skill] of (api.skills ?? []).entries()) {
          if (typeof skill.level !== 'string' || skill.level === '') fail('/api/profile', `skills[${i}] is missing level`);
          if (typeof skill.category !== 'string' || skill.category === '') fail('/api/profile', `skills[${i}] is missing category`);
          if (skill.name !== profile.skills[i].name) {
            fail('/api/profile', `skills[${i}] name ${JSON.stringify(skill.name)} != profile order ${JSON.stringify(profile.skills[i].name)}`);
          }
        }

        // Every non-skills, non-last_updated key must deep-equal /resume.json.
        if (resumeJson) {
          /**
           * @param {Record<string, unknown>} doc
           * @param {string[]} skip
           * @returns {Record<string, unknown>}
           */
          const without = (doc, skip) =>
            Object.fromEntries(Object.entries(doc).filter(([key]) => !skip.includes(key)));

          const apiRest = without(api, ['skills', 'last_updated']);
          const resumeRest = without(resumeJson, ['skills']);
          const diff = firstDifference(apiRest, resumeRest);
          if (diff) fail('/api/profile', `non-skill keys do not deep-equal /resume.json: ${diff}`);

          const apiSkillNames = (api.skills ?? []).map((s) => s.name);
          const resumeSkillNames = (resumeJson.skills ?? []).map((s) => s.name);
          const namesDiff = firstDifference(apiSkillNames, resumeSkillNames, 'skills[].name');
          if (namesDiff) fail('/api/profile', `skill order differs from /resume.json: ${namesDiff}`);
        }

        if (new RegExp(DRAFT_URL, 'i').test(body)) fail('/api/profile', `contains draft study URL "${DRAFT_URL}"`);
        if (body.includes('/admin')) fail('/api/profile', 'contains "/admin" path');
        for (const fact of ADMIN_FACTS) {
          if (body.includes(fact)) fail('/api/profile', `contains admin fact "${fact}"`);
        }
      }

      pass('GET /api/profile');
    }
  }

  {
    // FR-307: /api/profile must answer in under 500 ms excluding network
    // latency. Loopback only, payload fully consumed, slowest of 5 samples.
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const res = await fetch(`${base}/api/profile`);
      await res.arrayBuffer();
      samples.push(performance.now() - started);
      if (res.status !== 200) fail('/api/profile', `FR-307 timing probe got status ${res.status}`);
    }
    const slowest = Math.max(...samples);
    if (slowest >= 500) {
      fail('/api/profile', `FR-307 timing: slowest of 5 = ${slowest.toFixed(1)} ms, budget 500 ms`);
    } else {
      pass(`FR-307 /api/profile < 500 ms (slowest of 5: ${slowest.toFixed(1)} ms)`);
    }
  }

  {
    // Astro's origin check runs before routing, so a browser-shaped same-origin
    // POST is the honest probe: it must fall through to 404, not reach a handler.
    const { res } = await fetchRoute('/api/profile', {
      method: 'POST',
      status: 404,
      headers: { Origin: base, 'Content-Type': 'application/json' },
    });
    if (res.status === 404) pass('POST /api/profile → 404 (GET only, no write surface)');
  }

  // -------------------------------------------------------------------------
  // 9. /sitemap.xml
  // -------------------------------------------------------------------------

  {
    // Prerendered static files are served by @astrojs/node with the MIME type
    // of their extension; for .xml that is `application/xml` with no charset
    // parameter, so UTF-8 is declared in the XML prolog instead. The contract
    // row was amended to `application/xml` + prolog requirement (W1).
    const { res, body } = await fetchRoute('/sitemap.xml', { contentType: 'application/xml' });
    if (res.status === 200) {
      if (!/^<\?xml\b[^>]*encoding=["']UTF-8["']/i.test(body)) {
        fail('/sitemap.xml', 'XML declaration does not declare UTF-8');
      }
      if (!body.includes('<urlset')) fail('/sitemap.xml', 'missing <urlset>');
      if (/<lastmod>/i.test(body)) fail('/sitemap.xml', 'contains a <lastmod> element');

      const locs = [...body.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => m[1].trim());
      const paths = locs.map((loc) => {
        try {
          return new URL(loc).pathname;
        } catch {
          return loc;
        }
      });
      const expectedPaths = ['/', '/about', '/case-studies', '/ask', '/contact',
        ...published.map((study) => `/case-studies/${study.slug}`)];
      const diff = firstDifference(paths, expectedPaths, 'loc[]');
      if (diff) fail('/sitemap.xml', `URL list mismatch: ${diff}`);
      if (new RegExp(DRAFT_SLUG, 'i').test(body)) fail('/sitemap.xml', `contains draft slug "${DRAFT_SLUG}"`);

      const askCount = paths.filter((p) => p === '/ask').length;
      if (askCount !== 1) fail('/sitemap.xml', `expected /ask exactly once, got ${askCount}`);
      for (const p of paths) {
        if (p.startsWith('/admin') || p.includes('/admin')) {
          fail('/sitemap.xml', `contains admin path "${p}"`);
        }
      }
      if (body.includes('/admin')) fail('/sitemap.xml', 'contains "/admin"');

      pass('GET /sitemap.xml');
    }
  }

  // -------------------------------------------------------------------------
  // 10. Navigation on every page
  // -------------------------------------------------------------------------

  {
    /** @type {string[]} */
    const pages = ['/', '/about', '/case-studies', '/ask', '/contact',
      ...published.map((study) => `/case-studies/${study.slug}`)];

    for (const page of pages) {
      const res = await fetch(`${base}${page}`);
      const body = await res.text();
      const main = mainInnerHtml(body);
      // Nav lives outside <main>; look at the whole document.
      if (!body.includes('href="/about"')) fail(page, 'navigation is missing /about');
      if (!body.includes('href="/case-studies"')) fail(page, 'navigation is missing /case-studies');
      if (!body.includes('href="/ask"')) fail(page, 'navigation is missing /ask');
      // "VoiceDash" is approved CV content (employer + project); the ban is a
      // link to the DRAFT STUDY.
      if (body.includes(`href="/case-studies/${DRAFT_SLUG}"`)) {
        fail(page, `page links to the draft study /case-studies/${DRAFT_SLUG}`);
      }
      if (main === null) fail(page, 'has no <main> element');

      const askLinks = [...body.matchAll(/<a\b[^>]*\bhref=["']\/ask\/?["'][^>]*>([\s\S]*?)<\/a>/gi)];
      const hasAskLabel = askLinks.some((m) => {
        const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).trim();
        return text === 'Ask';
      });
      if (!hasAskLabel) {
        fail(page, 'missing link to /ask labelled "Ask"');
      }

      if (/href=["']\/admin\b/i.test(body)) {
        fail(page, 'page contains href="/admin"');
      }

      const navMatches = [...body.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)];
      for (const navMatch of navMatches) {
        const navHtml = navMatch[1];
        const navLinks = [...navHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
        for (const link of navLinks) {
          const attrs = link[1];
          const text = decodeHtmlEntities(link[2].replace(/<[^>]+>/g, '')).trim();
          if (/href=["'][^"']*\/admin\b/i.test(attrs)) {
            fail(page, `navigation contains link to admin: ${link[0]}`);
          }
          if (/\badmin\b/i.test(text)) {
            fail(page, `navigation contains "Admin" nav link: "${text}"`);
          }
        }
      }
    }
    if (failures.length === 0) pass('navigation on every public page');
  }

  // -------------------------------------------------------------------------
  // 11. Person JSON-LD in every built page
  // -------------------------------------------------------------------------

  /**
   * Recursively finds all *.html files under dir.
   * @param {string} dir
   * @returns {string[]}
   */
  function findHtmlFiles(dir) {
    if (!existsSync(dir)) return [];
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...findHtmlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        out.push(fullPath);
      }
    }
    return out;
  }

  {
    const htmlFiles = findHtmlFiles(CLIENT);
    if (htmlFiles.length === 0) {
      fail('Person JSON-LD', `no *.html files found under ${CLIENT}`);
    }
    for (const filePath of htmlFiles) {
      const rel = path.relative(CLIENT, filePath);
      const html = readFileSync(filePath, 'utf8');
      const match = html.match(
        /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
      );
      if (!match) {
        fail(rel, 'missing <script type="application/ld+json"> block');
        continue;
      }
      const jsonLd = match[1];
      if (jsonLd.includes('/admin')) {
        fail(rel, 'Person JSON-LD contains "/admin" path');
      }
      for (const fact of ADMIN_FACTS) {
        if (jsonLd.includes(fact)) {
          fail(rel, `Person JSON-LD contains admin fact "${fact}"`);
        }
      }
    }
    pass('Person JSON-LD in every built page contains no admin path or facts');
  }

  // -------------------------------------------------------------------------
  // Result
  // -------------------------------------------------------------------------

  // Sanity: the client build must not contain on-demand artifacts.
  for (const artifact of ['healthz', path.join('api', 'contact'), path.join('api', 'profile')]) {
    if (existsSync(path.join(CLIENT, artifact))) {
      fail(artifact, 'on-demand route emitted a static artifact under dist/client');
    }
  }
  if (existsSync(path.join(CLIENT, 'cv.pdf')) && statSync(path.join(CLIENT, 'cv.pdf')).size <= 10 * 1024) {
    fail('/cv.pdf', 'built cv.pdf is unexpectedly small');
  }
} catch (err) {
  console.error(`FATAL: ${/** @type {Error} */ (err).message}`);
  failures.push(`fatal: ${/** @type {Error} */ (err).message}`);
} finally {
  await stopProc(serverProc);
  if (dataDir) {
    // Retry: SQLite may still hold the file for a moment after SIGTERM.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

if (failures.length === 0) {
  for (const p of passes) console.log(`ok: ${p}`);
  console.log('public-routes ok');
  process.exit(0);
} else {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
