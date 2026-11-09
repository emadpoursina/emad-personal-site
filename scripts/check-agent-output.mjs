#!/usr/bin/env node
/**
 * scripts/check-agent-output.mjs
 *
 * Build-output proof for the agent-readable layer (F7, T022, T036).
 * Runs after `npm run build` and checks the machine surfaces:
 *
 *  1. dist/client/resume.json — validates against
 *     schemas/jsonresume-v1.0.0.json (ajv + ajv-draft-04) AND deep-equals
 *     buildResume(profile, studies).
 *  2. dist/client/llms.txt — deep-equals buildLlmsTxt(profile, studies).
 *  3. dist/client/sitemap.xml — deep-equals buildSitemap(studies), contains
 *     /ask exactly once, and contains no /admin path.
 *  4. Every *.html under dist/client — exactly one
 *     <script type="application/ld+json"> block, no other <script> element
 *     (with the approved single module island allowance for /ask), and
 *     parsed object deep-equals buildPersonJsonLd(profile).
 *  5. buildProfileApi(profile, studies) — contains no /admin path or admin fact.
 *  6. Builder isolation: buildResume, buildProfileApi, buildLlmsTxt, and
 *     buildPersonJsonLd are invariant under assistantPolicy changes.
 *
 * Additionally asserts that no draft slug/URL and no admin fact
 * (ADMIN_PASSWORD_HASH, ENCRYPTION_KEY, admin_session, /admin) appear in any surface.
 *
 * Exits 0 and prints "agent-output ok" on success.
 * Exits 1, naming the offending output for every failure.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv-draft-04';

import {
  buildResume,
  buildProfileApi,
  buildLlmsTxt,
  buildPersonJsonLd,
  buildSitemap,
} from '../src/lib/agent-output.mjs';
import { knowsAbout } from '../src/lib/skills.mjs';
import { DRAFT_SLUG, DRAFT_URL, firstDifference } from './lib/contract.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'client');
const SCHEMA_PATH = join(ROOT, 'schemas', 'jsonresume-v1.0.0.json');

const FORBIDDEN_ADMIN_PATTERNS = [
  '/admin',
  'ADMIN_PASSWORD_HASH',
  'ENCRYPTION_KEY',
  'admin_session',
];

/** @type {string[]} */
const failures = [];

/**
 * Records a failure.
 * @param {string} output - surface name, e.g. "resume.json"
 * @param {string} msg
 */
function fail(output, msg) {
  failures.push(`${output}: ${msg}`);
}

/**
 * Asserts that a text does not contain any /admin path or admin fact.
 * @param {string} output - surface name, e.g. "resume.json"
 * @param {string} text
 */
function assertNoAdminFacts(output, text) {
  for (const pattern of FORBIDDEN_ADMIN_PATTERNS) {
    if (text.includes(pattern)) {
      fail(output, `contains forbidden admin pattern "${pattern}"`);
    }
  }
}

/**
 * Recursively collects all *.html files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findHtmlFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findHtmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(fullPath);
    }
  }
  return out;
}

/**
 * Reads a built output as text; records a failure when it is missing.
 * @param {string} outputName
 * @param {string} filePath
 * @returns {string | null}
 */
function readOutput(outputName, filePath) {
  if (!existsSync(filePath)) {
    fail(outputName, `missing build artifact ${relative(ROOT, filePath)} (run npm run build first)`);
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

// ---------------------------------------------------------------------------
// Load content sources
// ---------------------------------------------------------------------------

const profile = JSON.parse(readFileSync(join(ROOT, 'content', 'profile.json'), 'utf8'));
const studiesDoc = JSON.parse(readFileSync(join(ROOT, 'content', 'case-studies.json'), 'utf8'));

// "VoiceDash" is approved public CV content (an employer role and a profile
// project since Phase 1); what must never appear is the DRAFT CASE STUDY.
// Its only addressable trace is the page URL, so resume.json and JSON-LD are
// checked for that URL, while llms.txt and sitemap.xml — which contain no
// employment data — keep the strict bare-substring ban. DRAFT_SLUG, DRAFT_URL
// and firstDifference live in scripts/lib/contract.mjs (shared, S2).

// ---------------------------------------------------------------------------
// 1. resume.json — schema conformance + builder equality
// ---------------------------------------------------------------------------

const resumeText = readOutput('resume.json', join(DIST, 'resume.json'));

if (resumeText !== null) {
  /** @type {unknown} */
  let resumeBuilt = null;
  try {
    resumeBuilt = JSON.parse(resumeText);
  } catch (err) {
    fail('resume.json', `is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }

  if (resumeBuilt !== null) {
    // Schema conformance against the vendored draft-04 schema.
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      fail('resume.json', `schema ${relative(ROOT, SCHEMA_PATH)} failed to compile: ${/** @type {Error} */ (err).message}`);
    }
    if (validate && !validate(resumeBuilt)) {
      const details = (validate.errors ?? [])
        .map((e) => `${e.instancePath || '$'} ${e.message ?? 'invalid'}`)
        .join('; ');
      fail('resume.json', `does not validate against ${relative(ROOT, SCHEMA_PATH)}: ${details}`);
    }

    // Conformance alone is insufficient: the schema declares no required fields.
    const built = buildResume(profile, studiesDoc);
    const diff = firstDifference(resumeBuilt, built);
    if (diff) {
      fail('resume.json', `does not deep-equal buildResume(): ${diff}`);
    }
  }

  if (new RegExp(DRAFT_URL, 'i').test(resumeText)) {
    fail('resume.json', `contains draft study URL "${DRAFT_URL}"`);
  }

  assertNoAdminFacts('resume.json', resumeText);
}

// ---------------------------------------------------------------------------
// 2. llms.txt — builder equality
// ---------------------------------------------------------------------------

const llmsText = readOutput('llms.txt', join(DIST, 'llms.txt'));

if (llmsText !== null) {
  const built = buildLlmsTxt(profile, studiesDoc);
  if (llmsText !== built) {
    const diff = firstDifference(llmsText.split('\n'), built.split('\n'));
    fail('llms.txt', `does not deep-equal buildLlmsTxt(): ${diff ?? 'text differs'}`);
  }
  if (new RegExp(DRAFT_SLUG, 'i').test(llmsText)) {
    fail('llms.txt', `contains draft slug "${DRAFT_SLUG}"`);
  }

  assertNoAdminFacts('llms.txt', llmsText);
}

// ---------------------------------------------------------------------------
// 3. sitemap.xml — builder equality
// ---------------------------------------------------------------------------

const sitemapText = readOutput('sitemap.xml', join(DIST, 'sitemap.xml'));

if (sitemapText !== null) {
  const built = buildSitemap(studiesDoc);
  if (sitemapText !== built) {
    const diff = firstDifference(sitemapText.split('\n'), built.split('\n'));
    fail('sitemap.xml', `does not deep-equal buildSitemap(): ${diff ?? 'text differs'}`);
  }
  if (new RegExp(DRAFT_SLUG, 'i').test(sitemapText)) {
    fail('sitemap.xml', `contains draft slug "${DRAFT_SLUG}"`);
  }

  const askMatches = sitemapText.match(/\/ask(?=[/<"'\s]|$)/g) ?? [];
  if (askMatches.length !== 1) {
    fail('sitemap.xml', `expected "/ask" exactly once, found ${askMatches.length}`);
  }

  assertNoAdminFacts('sitemap.xml', sitemapText);

  let askLocCount = 0;
  const locRegex = /<loc>([\s\S]*?)<\/loc>/gi;
  let locMatch;
  while ((locMatch = locRegex.exec(sitemapText)) !== null) {
    const loc = locMatch[1].trim();
    let pathname = loc;
    try {
      const url = new URL(loc);
      pathname = url.pathname;
    } catch {
      // fallback
    }
    if (pathname === '/ask' || pathname === '/ask/') {
      askLocCount++;
    }
    if (pathname.startsWith('/admin')) {
      fail('sitemap.xml', `loc pathname starts with "/admin": "${pathname}"`);
    } else if (loc.startsWith('/admin')) {
      fail('sitemap.xml', `loc pathname starts with "/admin": "${loc}"`);
    }
  }
  if (askLocCount !== 1) {
    fail('sitemap.xml', `expected exactly one /ask loc entry, found ${askLocCount}`);
  }

  const coverLetterLocs = [];
  const allLocRegex = /<loc>([\s\S]*?)<\/loc>/gi;
  let coverMatch;
  while ((coverMatch = allLocRegex.exec(sitemapText)) !== null) {
    const loc = coverMatch[1].trim();
    let pathname = loc;
    try { pathname = new URL(loc).pathname; } catch { /* keep raw */ }
    coverLetterLocs.push(pathname);
  }
  const coverLetterCount = coverLetterLocs.filter((p) => p === '/cover-letter').length;
  if (coverLetterCount !== 1) fail('sitemap.xml', `expected "/cover-letter" exactly once, found ${coverLetterCount}`);
  const contactIndex = coverLetterLocs.indexOf('/contact');
  const coverLetterIndex = coverLetterLocs.indexOf('/cover-letter');
  if (contactIndex === -1 || coverLetterIndex === -1 || coverLetterIndex !== contactIndex + 1) {
    fail('sitemap.xml', `expected "/cover-letter" immediately after "/contact" (contact index ${contactIndex}, cover-letter index ${coverLetterIndex})`);
  }
  const coverLetterMentions = sitemapText.match(/\/cover-letter(?=[/<"'\s]|$)/g) ?? [];
  if (coverLetterMentions.length !== 1) fail('sitemap.xml', `expected the text "/cover-letter" exactly once, found ${coverLetterMentions.length}`);
}

// ---------------------------------------------------------------------------
// 4. Person JSON-LD on every built HTML page
// ---------------------------------------------------------------------------

const expectedJsonLd = buildPersonJsonLd(profile);
const expectedKnowsAbout = knowsAbout(/** @type {any} */ (profile.skills));

const htmlFiles = findHtmlFiles(DIST);
if (htmlFiles.length === 0) {
  fail('JSON-LD', `no *.html files found under ${relative(ROOT, DIST)} (run npm run build first)`);
}

for (const filePath of htmlFiles) {
  const pageName = relative(DIST, filePath);
  const normalizedPageName = pageName.replace(/\\/g, '/');
  const isAskPage = normalizedPageName === 'ask/index.html';
  const html = readFileSync(filePath, 'utf8');

  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)];

  if (isAskPage) {
    let ldJsonCount = 0;
    let moduleCount = 0;

    for (const tag of scriptTags) {
      const fullTag = tag[0];
      const attrs = tag[1] ?? '';

      if (/type\s*=\s*(['"])application\/ld\+json\1/i.test(attrs)) {
        if (/\bsrc\s*=/i.test(attrs)) {
          fail('JSON-LD', `${pageName}: JSON-LD contains a src attribute: ${fullTag}`);
        }
        ldJsonCount++;
        if (ldJsonCount > 1) {
          fail('JSON-LD', `${pageName}: contains extra JSON-LD script tag: ${fullTag}`);
        }
      } else if (/type\s*=\s*(['"])module\1/i.test(attrs)) {
        const srcMatch = /\bsrc\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/i.exec(attrs);
        if (srcMatch) {
          const srcVal = srcMatch[2] ?? srcMatch[3];
          if (!srcVal.startsWith('/_astro/')) {
            fail('JSON-LD', `${pageName}: module script has src outside /_astro/: ${fullTag}`);
          }
        }
        moduleCount++;
        if (moduleCount > 1) {
          fail('JSON-LD', `${pageName}: contains extra module script tag: ${fullTag}`);
        }
      } else {
        fail('JSON-LD', `${pageName}: contains invalid script tag: ${fullTag}`);
      }
    }

    if (ldJsonCount !== 1) {
      fail('JSON-LD', `${pageName}: expected exactly one JSON-LD script, found ${ldJsonCount}`);
    }
    if (moduleCount > 1) {
      fail('JSON-LD', `${pageName}: expected at most one module script, found ${moduleCount}`);
    }
  } else {
    if (scriptTags.length !== 1) {
      const kinds = scriptTags.map((m) => m[0]).join(', ');
      fail('JSON-LD', `${pageName}: expected exactly one <script> element, found ${scriptTags.length} (${kinds || 'none'})`);
    }
    for (const tag of scriptTags) {
      if (/\bsrc\s*=/i.test(tag[0])) {
        fail('JSON-LD', `${pageName}: contains a <script src=…> element`);
      }
      if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(tag[0])) {
        fail('JSON-LD', `${pageName}: contains a non-JSON-LD <script> element: ${tag[0]}`);
      }
    }
  }

  const blockMatch = html.match(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!blockMatch) {
    fail('JSON-LD', `${pageName}: has no <script type="application/ld+json"> block`);
    continue;
  }

  const rawBlock = blockMatch[1];
  /** @type {any} */
  let parsed = null;
  try {
    parsed = JSON.parse(rawBlock);
  } catch (err) {
    fail('JSON-LD', `${pageName}: block is not valid JSON: ${/** @type {Error} */ (err).message}`);
    continue;
  }

  const diff = firstDifference(parsed, expectedJsonLd);
  if (diff) {
    fail('JSON-LD', `${pageName}: does not deep-equal buildPersonJsonLd(): ${diff}`);
  }

  if (parsed['@context'] !== 'https://schema.org') {
    fail('JSON-LD', `${pageName}: @context is ${JSON.stringify(parsed['@context'])}, expected "https://schema.org"`);
  }
  if (parsed['@type'] !== 'Person') {
    fail('JSON-LD', `${pageName}: @type is ${JSON.stringify(parsed['@type'])}, expected "Person"`);
  }
  if (parsed.name !== profile.name) {
    fail('JSON-LD', `${pageName}: name is ${JSON.stringify(parsed.name)}, expected ${JSON.stringify(profile.name)}`);
  }
  if (parsed.jobTitle !== profile.headline) {
    fail('JSON-LD', `${pageName}: jobTitle is ${JSON.stringify(parsed.jobTitle)}, expected ${JSON.stringify(profile.headline)}`);
  }
  if (parsed.email !== profile.contactEmail) {
    fail('JSON-LD', `${pageName}: email is ${JSON.stringify(parsed.email)}, expected ${JSON.stringify(profile.contactEmail)}`);
  }

  const expectedSameAs = [profile.links?.linkedin, profile.links?.github].filter(
    (v) => typeof v === 'string' && v.trim() !== ''
  );
  const sameAsDiff = firstDifference(parsed.sameAs, expectedSameAs, '$.sameAs');
  if (sameAsDiff) {
    fail('JSON-LD', `${pageName}: ${sameAsDiff}`);
  }

  const knowsDiff = firstDifference(parsed.knowsAbout, expectedKnowsAbout, '$.knowsAbout');
  if (knowsDiff) {
    fail('JSON-LD', `${pageName}: knowsAbout ${knowsDiff}`);
  }
  if (Array.isArray(parsed.knowsAbout)) {
    if (parsed.knowsAbout.length !== 36) {
      fail('JSON-LD', `${pageName}: knowsAbout has ${parsed.knowsAbout.length} names, expected exactly 36`);
    }
    for (const name of parsed.knowsAbout) {
      if (typeof name === 'string' && /beginner|learning/i.test(name)) {
        fail('JSON-LD', `${pageName}: knowsAbout contains a Beginner/Learning entry (${JSON.stringify(name)})`);
      }
    }
  }

  if (new RegExp(DRAFT_URL, 'i').test(rawBlock)) {
    fail('JSON-LD', `${pageName}: JSON-LD block contains draft study URL "${DRAFT_URL}"`);
  }

  for (const pattern of FORBIDDEN_ADMIN_PATTERNS) {
    if (rawBlock.includes(pattern)) {
      fail('JSON-LD', `${pageName}: JSON-LD block contains forbidden admin pattern "${pattern}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. /api/profile builder — direct call & admin isolation
// ---------------------------------------------------------------------------

const profileApi = buildProfileApi(profile, studiesDoc);
const profileApiText = JSON.stringify(profileApi);
assertNoAdminFacts('/api/profile', profileApiText);
if (new RegExp(DRAFT_URL, 'i').test(profileApiText)) {
  fail('/api/profile', `contains draft study URL "${DRAFT_URL}"`);
}

// ---------------------------------------------------------------------------
// 6. Builder isolation from assistantPolicy
// ---------------------------------------------------------------------------

const mutatedProfile = structuredClone(profile);
mutatedProfile.assistantPolicy = {
  disclaimer: 'CHANGED',
  unavailable: 'CHANGED',
  notAvailable: 'CHANGED',
  salary: 'CHANGED',
  privateCodebase: 'CHANGED',
  visa: 'CHANGED',
  ...(profile.assistantPolicy && typeof profile.assistantPolicy === 'object'
    ? Object.fromEntries(Object.keys(profile.assistantPolicy).map((k) => [k, 'CHANGED']))
    : {}),
};

const resumeOriginal = buildResume(profile, studiesDoc);
const resumeMutated = buildResume(mutatedProfile, studiesDoc);
const resumeDiff = firstDifference(resumeMutated, resumeOriginal);
if (resumeDiff) {
  fail('builder-isolation', `buildResume differs when assistantPolicy changes: ${resumeDiff}`);
}

const profileApiOriginal = buildProfileApi(profile, studiesDoc);
const profileApiMutated = buildProfileApi(mutatedProfile, studiesDoc);
const profileApiDiff = firstDifference(profileApiMutated, profileApiOriginal);
if (profileApiDiff) {
  fail('builder-isolation', `buildProfileApi differs when assistantPolicy changes: ${profileApiDiff}`);
}

const llmsOriginal = buildLlmsTxt(profile, studiesDoc);
const llmsMutated = buildLlmsTxt(mutatedProfile, studiesDoc);
if (llmsMutated !== llmsOriginal) {
  const diff = firstDifference(llmsMutated.split('\n'), llmsOriginal.split('\n'));
  fail('builder-isolation', `buildLlmsTxt differs when assistantPolicy changes: ${diff ?? 'text differs'}`);
}

const jsonLdOriginal = buildPersonJsonLd(profile);
const jsonLdMutated = buildPersonJsonLd(mutatedProfile);
const jsonLdDiff = firstDifference(jsonLdMutated, jsonLdOriginal);
if (jsonLdDiff) {
  fail('builder-isolation', `buildPersonJsonLd differs when assistantPolicy changes: ${jsonLdDiff}`);
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (failures.length === 0) {
  console.log('agent-output ok');
  process.exit(0);
} else {
  for (const f of failures) {
    console.error(`FAIL: ${f}`);
  }
  process.exit(1);
}
