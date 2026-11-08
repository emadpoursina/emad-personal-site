#!/usr/bin/env node
/**
 * scripts/check-agent-output.mjs
 *
 * Build-output proof for the agent-readable layer (F7, T022).
 * Runs after `npm run build` and checks the four machine surfaces:
 *
 *  1. dist/client/resume.json — validates against
 *     schemas/jsonresume-v1.0.0.json (ajv + ajv-draft-04) AND deep-equals
 *     buildResume(profile, studies).
 *  2. dist/client/llms.txt — deep-equals buildLlmsTxt(profile, studies).
 *  3. dist/client/sitemap.xml — deep-equals buildSitemap(studies).
 *  4. Every *.html under dist/client — exactly one
 *     <script type="application/ld+json"> block, no other <script> element
 *     and no src, parsed object deep-equals buildPersonJsonLd(profile), and
 *     the object carries the approved Person fields.
 *
 * Additionally asserts that no draft slug appears in any of the four outputs.
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
  buildLlmsTxt,
  buildPersonJsonLd,
  buildSitemap,
} from '../src/lib/agent-output.mjs';
import { knowsAbout } from '../src/lib/skills.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'client');
const SCHEMA_PATH = join(ROOT, 'schemas', 'jsonresume-v1.0.0.json');

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
 * Strict deep equality. Returns null when equal, otherwise a short
 * description of the first mismatch including the offending path.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [path]
 * @returns {string | null}
 */
function firstDifference(actual, expected, path = '$') {
  if (Object.is(actual, expected)) return null;

  if (typeof actual !== typeof expected) {
    return `${path}: expected ${typeof expected}, got ${typeof actual}`;
  }
  if (actual === null || expected === null) {
    return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (typeof actual !== 'object') {
    return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }

  const aIsArray = Array.isArray(actual);
  const eIsArray = Array.isArray(expected);
  if (aIsArray !== eIsArray) {
    return `${path}: expected ${eIsArray ? 'array' : 'object'}, got ${aIsArray ? 'array' : 'object'}`;
  }

  if (aIsArray) {
    const a = /** @type {unknown[]} */ (actual);
    const e = /** @type {unknown[]} */ (expected);
    if (a.length !== e.length) {
      return `${path}: expected array length ${e.length}, got ${a.length}`;
    }
    for (let i = 0; i < a.length; i++) {
      const diff = firstDifference(a[i], e[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  const a = /** @type {Record<string, unknown>} */ (actual);
  const e = /** @type {Record<string, unknown>} */ (expected);
  const aKeys = Object.keys(a).sort();
  const eKeys = Object.keys(e).sort();
  if (aKeys.length !== eKeys.length || aKeys.some((k, i) => k !== eKeys[i])) {
    return `${path}: keys differ — expected {${eKeys.join(',')}}, got {${aKeys.join(',')}}`;
  }
  for (const key of eKeys) {
    const diff = firstDifference(a[key], e[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
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

const DRAFT_SLUG = 'voicedash';
// "VoiceDash" is approved public CV content (an employer role and a profile
// project since Phase 1); what must never appear is the DRAFT CASE STUDY.
// Its only addressable trace is the page URL, so resume.json and JSON-LD are
// checked for that URL, while llms.txt and sitemap.xml — which contain no
// employment data — keep the strict bare-substring ban.
const DRAFT_URL = `/case-studies/${DRAFT_SLUG}`;

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
  const html = readFileSync(filePath, 'utf8');

  const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)];
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
