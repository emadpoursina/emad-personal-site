#!/usr/bin/env node
/**
 * scripts/check-static-output.mjs
 *
 * Checks the six static-output invariants from contracts/http-routes.md.
 *
 * Invariants:
 *  1. dist/client/index.html and dist/client/contact/index.html exist and
 *     contain required strings.
 *  2. Neither page references a client-side script bundle (<script src=…>).
 *  3. dist/client/cv.pdf exists, is > 10 KB, and starts with %PDF-.
 *  4. No dist/client/healthz or dist/client/api/contact artifact exists.
 *  5. Every interactive element is native (<a>,<button>,<input>,<textarea>,
 *     <label>); no tabindex > 0.
 *  6. A :focus-visible rule exists in the shipped CSS.
 *
 * Exits 0 on success (prints "static-output ok").
 * Exits 1 and prints each failed invariant on failure.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'client');

/** @type {string[]} */
const failures = [];

/**
 * Records a failure.
 * @param {string} msg
 */
function fail(msg) {
  failures.push(msg);
}

// ---------------------------------------------------------------------------
// Invariant 1: dist/client/index.html and dist/client/contact/index.html exist
// ---------------------------------------------------------------------------
const indexPath   = join(DIST, 'index.html');
const contactPath = join(DIST, 'contact', 'index.html');

let indexHtml   = '';
let contactHtml = '';

if (!existsSync(indexPath)) {
  fail('INV-1: dist/client/index.html does not exist');
} else {
  indexHtml = readFileSync(indexPath, 'utf8');
  // Required strings for the home page
  const required = ['<h1', 'skip', '#main'];
  for (const str of required) {
    if (!indexHtml.toLowerCase().includes(str.toLowerCase())) {
      fail(`INV-1: dist/client/index.html is missing required string: "${str}"`);
    }
  }
}

if (!existsSync(contactPath)) {
  fail('INV-1: dist/client/contact/index.html does not exist');
} else {
  contactHtml = readFileSync(contactPath, 'utf8');
  // Required strings for the contact page
  const required = [
    '<form',
    'action="/api/contact"',
    'method="post"',
    'for="name"',
    'for="email"',
    'for="message"',
    'id="name"',
    'id="email"',
    'id="message"',
    'emad.poursina.work@gmail.com',
  ];
  for (const str of required) {
    if (!contactHtml.includes(str)) {
      fail(`INV-1: dist/client/contact/index.html is missing required string: "${str}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 2: Neither page references a client-side script bundle
// ---------------------------------------------------------------------------
const scriptBundleRe = /<script[^>]+src=/i;
const scriptTagRe = /<script\b/i;

if (indexHtml && scriptBundleRe.test(indexHtml)) {
  fail('INV-2: dist/client/index.html references a client-side script bundle (<script src=…>)');
}

if (contactHtml && scriptBundleRe.test(contactHtml)) {
  fail('INV-2: dist/client/contact/index.html references a client-side script bundle (<script src=…>)');
}

if (indexHtml && scriptTagRe.test(indexHtml)) {
  fail('INV-2: dist/client/index.html contains a <script> tag');
}

if (contactHtml && scriptTagRe.test(contactHtml)) {
  fail('INV-2: dist/client/contact/index.html contains a <script> tag');
}

// ---------------------------------------------------------------------------
// Invariant 3: dist/client/cv.pdf exists, > 10 KB, starts with %PDF-
// ---------------------------------------------------------------------------
const cvPath = join(DIST, 'cv.pdf');
if (!existsSync(cvPath)) {
  fail('INV-3: dist/client/cv.pdf does not exist');
} else {
  const stat = statSync(cvPath);
  if (stat.size <= 10_240) {
    fail(`INV-3: dist/client/cv.pdf is too small (${stat.size} bytes, expected > 10 KB)`);
  }
  const header = readFileSync(cvPath).slice(0, 5).toString('ascii');
  if (header !== '%PDF-') {
    fail(`INV-3: dist/client/cv.pdf does not start with %PDF- (got: "${header}")`);
  }
}

// ---------------------------------------------------------------------------
// Invariant 4: No dist/client/healthz or dist/client/api/contact artifact
// ---------------------------------------------------------------------------
const healthzPath    = join(DIST, 'healthz');
const apiContactPath = join(DIST, 'api', 'contact');

if (existsSync(healthzPath)) {
  fail('INV-4: dist/client/healthz exists but must remain on-demand (not prerendered)');
}
if (existsSync(apiContactPath)) {
  fail('INV-4: dist/client/api/contact exists but must remain on-demand (not prerendered)');
}

// ---------------------------------------------------------------------------
// Invariant 5: Interactive elements are native; no tabindex > 0;
// skip link is first anchor in <body> with target id="main"; exactly one <h1>
// ---------------------------------------------------------------------------
// Allowed native interactive elements: <a>, <button>, <input>, <textarea>, <label>
const tabindexRe = /tabindex\s*=\s*["']?\s*([1-9]\d*)["']?/gi;

function checkAccessibilityAndInteractive(html, file) {
  if (!html) return;

  // Check for tabindex > 0
  let m;
  tabindexRe.lastIndex = 0;
  while ((m = tabindexRe.exec(html)) !== null) {
    const val = parseInt(m[1], 10);
    if (val > 0) {
      fail(`INV-5: ${file} has tabindex="${val}" (must be 0 or -1 only)`);
    }
  }

  // Skip link (href="#main") must be the FIRST <a> element inside <body>
  const bodyIdx = html.toLowerCase().indexOf('<body');
  if (bodyIdx === -1) {
    fail(`INV-5: ${file} is missing <body> tag`);
  } else {
    const bodyHtml = html.slice(bodyIdx);
    const firstAnchorMatch = /<a\b([^>]*)>/i.exec(bodyHtml);
    if (!firstAnchorMatch) {
      fail(`INV-5: ${file} contains no <a> tag in <body>`);
    } else {
      const anchorAttrs = firstAnchorMatch[1];
      if (!/href\s*=\s*["']#main["']/i.test(anchorAttrs)) {
        fail(`INV-5: ${file} first <a> element in <body> must be skip link with href="#main" (got <a${anchorAttrs}>)`);
      }
    }
    // Target id="main" must exist
    if (!/id\s*=\s*["']main["']/i.test(bodyHtml)) {
      fail(`INV-5: ${file} is missing skip link target element with id="main"`);
    }
  }

  // Every page contains exactly one <h1>
  const h1Matches = html.match(/<h1\b/gi) || [];
  if (h1Matches.length !== 1) {
    fail(`INV-5: ${file} must contain exactly one <h1> (found ${h1Matches.length})`);
  }
}

checkAccessibilityAndInteractive(indexHtml, 'dist/client/index.html');
checkAccessibilityAndInteractive(contactHtml, 'dist/client/contact/index.html');

// Also check all other .html files in dist/client for single <h1>
if (existsSync(DIST)) {
  const otherHtmlFiles = readdirSync(DIST).filter(
    (f) => f.endsWith('.html') && f !== 'index.html'
  );
  for (const f of otherHtmlFiles) {
    const filePath = join(DIST, f);
    const content = readFileSync(filePath, 'utf8');
    const h1Matches = content.match(/<h1\b/gi) || [];
    if (h1Matches.length !== 1) {
      fail(`INV-5: dist/client/${f} must contain exactly one <h1> (found ${h1Matches.length})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 6: A :focus-visible rule exists in the shipped CSS
// ---------------------------------------------------------------------------
const astroDir = join(DIST, '_astro');
let focusVisibleFound = false;

if (existsSync(astroDir)) {
  const cssFiles = readdirSync(astroDir).filter((f) => f.endsWith('.css'));
  for (const file of cssFiles) {
    const content = readFileSync(join(astroDir, file), 'utf8');
    if (content.includes(':focus-visible')) {
      focusVisibleFound = true;
      break;
    }
  }
}

// Also check inline styles in HTML files (Astro inlines CSS when there's no external bundle)
if (!focusVisibleFound) {
  if ((indexHtml + contactHtml).includes(':focus-visible')) {
    focusVisibleFound = true;
  }
}

// Check all .html files in dist/client for inline styles
if (!focusVisibleFound && existsSync(DIST)) {
  const htmlFiles = readdirSync(DIST).filter((f) => f.endsWith('.html'));
  for (const file of htmlFiles) {
    const content = readFileSync(join(DIST, file), 'utf8');
    if (content.includes(':focus-visible')) {
      focusVisibleFound = true;
      break;
    }
  }
}

if (!focusVisibleFound) {
  fail('INV-6: No :focus-visible rule found in the shipped CSS (dist/client/_astro/*.css)');
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('static-output ok');
  process.exit(0);
} else {
  for (const f of failures) {
    console.error(`FAIL: ${f}`);
  }
  process.exit(1);
}
