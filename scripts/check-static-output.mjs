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
 *  4. No dist/client/healthz, dist/client/api/contact, or
 *     dist/client/api/profile artifact exists.
 *  5. Every interactive element is native (<a>,<button>,<input>,<textarea>,
 *     <label>); no tabindex > 0.
 *  6. A :focus-visible rule exists in the shipped CSS.
 *
 * Exits 0 on success (prints "static-output ok").
 * Exits 1 and prints each failed invariant on failure.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_CATEGORY_ORDER } from '../src/lib/skills.mjs';
import { formatRange } from '../src/lib/dates.mjs';
import { DRAFT_SLUG } from './lib/contract.mjs';

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

/**
 * Recursively collects all *.html files in a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findHtmlFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findHtmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(fullPath);
    }
  }
  return files;
}

const allHtmlPaths = findHtmlFiles(DIST);

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
// Invariant 2: Per-HTML-file script tag rules
// - dist/client/ask/index.html only: allow exactly one ld+json block PLUS exactly
//   one executable script (type="module", src="/_astro/..." or no src).
// - every other HTML file: exactly one JSON-LD script, no src, no other script.
// ---------------------------------------------------------------------------
const askHtmlPath = join(DIST, 'ask', 'index.html');

for (const filePath of allHtmlPaths) {
  const relPath = relative(ROOT, filePath);
  const html = readFileSync(filePath, 'utf8');

  // Match all <script ...> opening tags
  const scriptTagRegex = /<script\b([^>]*)>/gi;
  let match;

  if (filePath === askHtmlPath) {
    let ldJsonCount = 0;
    let moduleCount = 0;

    while ((match = scriptTagRegex.exec(html)) !== null) {
      const fullTag = match[0];
      const attrs = match[1];

      if (/type\s*=\s*(['"])application\/ld\+json\1/i.test(attrs)) {
        if (/\bsrc\s*=/i.test(attrs)) {
          fail(`INV-2: ${relPath} contains script with src attribute: ${fullTag}`);
        }
        ldJsonCount++;
        if (ldJsonCount > 1) {
          fail(`INV-2: ${relPath} contains extra script: ${fullTag}`);
        }
      } else if (/type\s*=\s*(['"])module\1/i.test(attrs)) {
        const srcMatch = /\bsrc\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/i.exec(attrs);
        if (srcMatch) {
          const srcVal = srcMatch[2] ?? srcMatch[3];
          if (!srcVal.startsWith('/_astro/')) {
            fail(`INV-2: ${relPath} contains module script with src outside /_astro/: ${fullTag}`);
          }
        }
        moduleCount++;
        if (moduleCount > 1) {
          fail(`INV-2: ${relPath} contains extra script: ${fullTag}`);
        }
      } else {
        fail(`INV-2: ${relPath} contains non-module script tag: ${fullTag}`);
      }
    }

    if (ldJsonCount === 0) {
      fail(`INV-2: ${relPath} contains 0 <script type="application/ld+json"> tags (expected exactly 1)`);
    } else if (ldJsonCount > 1) {
      fail(`INV-2: ${relPath} contains ${ldJsonCount} <script type="application/ld+json"> tags (expected exactly 1)`);
    }

    if (moduleCount === 0) {
      fail(`INV-2: ${relPath} contains 0 executable module script tags (expected exactly 1)`);
    } else if (moduleCount > 1) {
      fail(`INV-2: ${relPath} contains ${moduleCount} executable module script tags (expected exactly 1)`);
    }
  } else {
    let ldJsonCount = 0;

    while ((match = scriptTagRegex.exec(html)) !== null) {
      const fullTag = match[0];
      const attrs = match[1];

      if (/\bsrc\s*=/i.test(attrs)) {
        fail(`INV-2: ${relPath} contains script with src attribute: ${fullTag}`);
      }

      if (/type\s*=\s*(['"])application\/ld\+json\1/i.test(attrs)) {
        ldJsonCount++;
      } else {
        fail(`INV-2: ${relPath} contains non-JSON-LD script tag: ${fullTag}`);
      }
    }

    if (ldJsonCount === 0) {
      fail(`INV-2: ${relPath} contains 0 <script type="application/ld+json"> tags (expected exactly 1)`);
    } else if (ldJsonCount > 1) {
      fail(`INV-2: ${relPath} contains ${ldJsonCount} <script type="application/ld+json"> tags (expected exactly 1)`);
    }
  }
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
// Invariant 4: No dist/client/healthz, dist/client/api/contact, or
// dist/client/api/profile artifact exists
// ---------------------------------------------------------------------------
const healthzPath    = join(DIST, 'healthz');
const apiContactPath = join(DIST, 'api', 'contact');
const apiProfilePath = join(DIST, 'api', 'profile');

if (existsSync(healthzPath)) {
  fail('INV-4: dist/client/healthz exists but must remain on-demand (not prerendered)');
}
if (existsSync(apiContactPath)) {
  fail('INV-4: dist/client/api/contact exists but must remain on-demand (not prerendered)');
}
if (existsSync(apiProfilePath)) {
  fail('INV-4: dist/client/api/profile exists but must remain on-demand (not prerendered)');
}

// ---------------------------------------------------------------------------
// Invariant 2 (Phase 2): the three prerendered agent-readable outputs exist
// ---------------------------------------------------------------------------
for (const artifact of ['llms.txt', 'resume.json', 'sitemap.xml']) {
  if (!existsSync(join(DIST, artifact))) {
    fail(`INV-2: dist/client/${artifact} is missing but is a prerendered output`);
  }
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

// Apply single-<h1> rule (INV-5) to every HTML file found by the recursive walk
for (const filePath of allHtmlPaths) {
  const relPath = relative(ROOT, filePath);
  // index.html and contact/index.html were already checked above by checkAccessibilityAndInteractive
  if (filePath === indexPath || filePath === contactPath) continue;

  const content = readFileSync(filePath, 'utf8');
  const h1Matches = content.match(/<h1\b/gi) || [];
  if (h1Matches.length !== 1) {
    fail(`INV-5: ${relPath} must contain exactly one <h1> (found ${h1Matches.length})`);
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

// Check all .html files found by recursive walk in dist/client for inline styles
if (!focusVisibleFound) {
  for (const filePath of allHtmlPaths) {
    const content = readFileSync(filePath, 'utf8');
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
// US1: case-studies pages and sitemap
// ---------------------------------------------------------------------------

// 1. Index page
const csIndexPath = join(DIST, 'case-studies', 'index.html');
if (!existsSync(csIndexPath)) {
  fail('US1-1: dist/client/case-studies/index.html does not exist');
} else {
  const csIndexHtml = readFileSync(csIndexPath, 'utf8');

  if (!csIndexHtml.includes('Rousta TV')) {
    fail('US1-1: dist/client/case-studies/index.html is missing "Rousta TV"');
  }
  if (!csIndexHtml.includes('NamehAmal')) {
    fail('US1-1: dist/client/case-studies/index.html is missing "NamehAmal"');
  }

  // Study slugs from anchors whose href is exactly /case-studies/<slug>
  const anchorHrefRegex = /<a\b[^>]*\bhref=(["'])\/case-studies\/([^"'#?]+)\1/gi;
  const foundSlugs = new Set();
  let m;
  while ((m = anchorHrefRegex.exec(csIndexHtml)) !== null) {
    foundSlugs.add(m[2]);
  }
  const sortedSlugs = Array.from(foundSlugs).sort();
  const expectedSlugs = ['namehamal', 'rousta-tv'];
  if (
    sortedSlugs.length !== expectedSlugs.length ||
    !sortedSlugs.every((slug, idx) => slug === expectedSlugs[idx])
  ) {
    fail(
      `US1-1: dist/client/case-studies/index.html case study slugs mismatch: expected [ 'namehamal', 'rousta-tv' ], got ${JSON.stringify(sortedSlugs)}`
    );
  }

  if (new RegExp(DRAFT_SLUG, 'i').test(csIndexHtml)) {
    fail(`US1-1: dist/client/case-studies/index.html contains draft "${DRAFT_SLUG}"`);
  }
}

// 2. Detail pages
const expectedHeadings = ['Problem', 'My Contribution', 'Outcome', 'Stack', 'Public Link'];
const detailPages = [
  { slug: 'rousta-tv', path: join(DIST, 'case-studies', 'rousta-tv', 'index.html') },
  { slug: 'namehamal', path: join(DIST, 'case-studies', 'namehamal', 'index.html') },
];

for (const detail of detailPages) {
  if (!existsSync(detail.path)) {
    fail(`US1-2: ${detail.path} does not exist`);
  } else {
    const html = readFileSync(detail.path, 'utf8');

    // Extract <h2> inner text in document order (strip nested tags, collapse whitespace, trim)
    const h2Regex = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
    const headings = [];
    let h2Match;
    while ((h2Match = h2Regex.exec(html)) !== null) {
      const stripped = h2Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      headings.push(stripped);
    }

    if (
      headings.length !== expectedHeadings.length ||
      !headings.every((h, idx) => h === expectedHeadings[idx])
    ) {
      fail(
        `US1-2: ${detail.path} <h2> headings mismatch: expected ${JSON.stringify(expectedHeadings)}, got ${JSON.stringify(headings)}`
      );
    }

    if (new RegExp(DRAFT_SLUG, 'i').test(html)) {
      fail(`US1-2: ${detail.path} contains draft "${DRAFT_SLUG}"`);
    }
  }
}

// 3. Rousta TV public link
const roustaPath = join(DIST, 'case-studies', 'rousta-tv', 'index.html');
if (existsSync(roustaPath)) {
  const roustaHtml = readFileSync(roustaPath, 'utf8');
  const aRegex = /<a\b([^>]*)>/gi;
  let hasValidLink = false;
  let hasHref = false;
  let hasRel = false;
  let tagMatch;

  while ((tagMatch = aRegex.exec(roustaHtml)) !== null) {
    const attrs = tagMatch[1];
    const matchHref = /\bhref=(["'])https:\/\/roustatv\.com\/\1/i.test(attrs);
    const matchRel = /\brel=(["'])(?:[^"']*\s+)?noopener(?:\s+[^"']*)?\1/i.test(attrs);
    if (matchHref) hasHref = true;
    if (matchRel) hasRel = true;
    if (matchHref && matchRel) {
      hasValidLink = true;
      break;
    }
  }

  if (!hasValidLink) {
    if (!hasHref && !hasRel) {
      fail('US1-3: rousta-tv page is missing <a> tag with href="https://roustatv.com/" and rel="noopener"');
    } else if (!hasHref) {
      fail('US1-3: rousta-tv page is missing href="https://roustatv.com/" on <a> tag');
    } else {
      fail('US1-3: rousta-tv page is missing rel="noopener" on <a> tag with href="https://roustatv.com/"');
    }
  }
}

// 4. NamehAmal private link
const namehamalPath = join(DIST, 'case-studies', 'namehamal', 'index.html');
if (existsSync(namehamalPath)) {
  const namehamalHtml = readFileSync(namehamalPath, 'utf8');
  const exactSentence = 'Private personal project \u2014 no public link.';
  if (!namehamalHtml.includes(exactSentence)) {
    fail(`US1-4: namehamal page is missing exact sentence "${exactSentence}"`);
  }

  const aRegex = /<a\b[^>]*\bhref=(["'])(https?:\/\/[^"']*)\1/gi;
  const matchedOutbound = aRegex.exec(namehamalHtml);
  if (matchedOutbound) {
    fail(
      `US1-4: namehamal page contains anchor tag with external href: ${matchedOutbound[0]}`
    );
  }
}

// 5. Draft absence
const voicedashPath = join(DIST, 'case-studies', DRAFT_SLUG);
if (existsSync(voicedashPath)) {
  fail(`US1-5: draft absence violated: ${voicedashPath} exists as a file or directory`);
}

// 6. Sitemap
const sitemapPath = join(DIST, 'sitemap.xml');
if (!existsSync(sitemapPath)) {
  fail('US1-6: dist/client/sitemap.xml does not exist');
} else {
  const sitemapXml = readFileSync(sitemapPath, 'utf8');
  const locRegex = /<loc>([\s\S]*?)<\/loc>/gi;
  const locs = [];
  let locMatch;
  while ((locMatch = locRegex.exec(sitemapXml)) !== null) {
    locs.push(locMatch[1].trim());
  }

  const expectedPaths = [
    '/',
    '/about',
    '/case-studies',
    '/ask',
    '/contact',
    '/case-studies/rousta-tv',
    '/case-studies/namehamal',
  ];

  let allProtocolsValid = true;
  for (const loc of locs) {
    if (!/^https?:\/\//i.test(loc)) {
      allProtocolsValid = false;
      fail(`US1-6: sitemap.xml loc "${loc}" does not start with http:// or https://`);
    }
  }

  const actualPaths = [];
  for (const loc of locs) {
    try {
      const url = new URL(loc);
      actualPaths.push(url.pathname);
    } catch (err) {
      actualPaths.push(`[invalid-url: ${loc}]`);
    }
  }

  for (const p of actualPaths) {
    if (p.startsWith('/admin')) {
      fail(`US1-6: sitemap.xml loc pathname starts with "/admin": "${p}"`);
    }
  }

  if (
    actualPaths.length !== expectedPaths.length ||
    !actualPaths.every((p, idx) => p === expectedPaths[idx])
  ) {
    fail(
      `US1-6: sitemap.xml pathnames mismatch in ${sitemapPath}: expected ${JSON.stringify(expectedPaths)}, got ${JSON.stringify(actualPaths)}`
    );
  }

  if (/voicedash/i.test(sitemapXml)) {
    fail(`US1-6: ${sitemapPath} contains draft "voicedash"`);
  }
}

// ---------------------------------------------------------------------------
// US2: About page
// ---------------------------------------------------------------------------
const aboutPath = join(DIST, 'about', 'index.html');
let aboutHtml = '';

if (!existsSync(aboutPath)) {
  fail('US2-1: dist/client/about/index.html does not exist');
} else {
  aboutHtml = readFileSync(aboutPath, 'utf8');
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
 * Returns the inner HTML of the first <section id="..."> block.
 * @param {string} html
 * @param {string} id
 * @returns {string | null}
 */
function sectionInnerHtml(html, id) {
  const re = new RegExp(`<section\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'i');
  const match = re.exec(html);
  return match ? match[1] : null;
}

/**
 * Returns the decoded text of every heading with the given tag inside html.
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
    const text = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    texts.push(text);
  }
  return texts;
}

if (aboutHtml !== '') {
  const profilePath = join(ROOT, 'content', 'profile.json');
  /** @type {any} */
  let profile = null;
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (err) {
    fail(`US2-1: cannot read ${profilePath}: ${/** @type {Error} */ (err).message}`);
  }

  // Section order: summary first, then experience, skills, education, languages.
  const sectionOrder = ['summary', 'experience', 'skills', 'education', 'languages'];
  const sectionPositions = sectionOrder.map((id) =>
    aboutHtml.search(new RegExp(`<section\\b[^>]*\\bid=["']${id}["']`, 'i'))
  );
  const missingSections = sectionOrder.filter((_, idx) => sectionPositions[idx] === -1);
  if (missingSections.length > 0) {
    fail(`US2-1: about page is missing required section(s): ${missingSections.join(', ')}`);
  } else {
    for (let i = 1; i < sectionPositions.length; i += 1) {
      if (sectionPositions[i] < sectionPositions[i - 1]) {
        fail(`US2-1: about page section order must be ${sectionOrder.join(' -> ')} (got out of order)`);
        break;
      }
    }
  }

  if (profile !== null) {
    const skills = Array.isArray(profile.skills) ? profile.skills : [];
    const experience = Array.isArray(profile.experience) ? profile.experience : [];
    const education = Array.isArray(profile.education) ? profile.education : [];
    const languages = Array.isArray(profile.languages) ? profile.languages : [];
    const learningSkills = skills.filter((skill) => skill.level === 'Beginner / Learning');

    // Text of the page without the JSON-LD block, so assertions are about the
    // rendered content and not about structured data.
    const pageText = decodeHtmlEntities(
      aboutHtml.replace(/<script\b[\s\S]*?<\/script>/gi, '')
    );

    // Summary block: profile.bio verbatim, and no Learning-level skill name inside it.
    const summaryHtml = sectionInnerHtml(aboutHtml, 'summary');
    if (summaryHtml === null) {
      fail('US2-2: about page has no <section id="summary"> block');
    } else {
      const summaryText = decodeHtmlEntities(summaryHtml);
      if (typeof profile.bio === 'string' && !summaryText.includes(profile.bio)) {
        fail('US2-2: summary block does not contain profile.bio');
      }
      for (const skill of learningSkills) {
        if (summaryText.includes(skill.name)) {
          fail(`US2-2: summary block contains Learning-level skill name "${skill.name}"`);
        }
      }
    }

    // Seven category headings in the required order inside the skills section.
    const skillsHtml = sectionInnerHtml(aboutHtml, 'skills');
    if (skillsHtml === null) {
      fail('US2-3: about page has no <section id="skills"> block');
    } else {
      const categoryHeadings = headingTexts(skillsHtml, 'h3');
      if (
        categoryHeadings.length !== SKILL_CATEGORY_ORDER.length ||
        !categoryHeadings.every((heading, idx) => heading === SKILL_CATEGORY_ORDER[idx])
      ) {
        fail(
          `US2-3: skill category headings mismatch: expected ${JSON.stringify(SKILL_CATEGORY_ORDER)}, got ${JSON.stringify(categoryHeadings)}`
        );
      }
    }

    // All 61 skill names present; Learning rendered as the label.
    for (const skill of skills) {
      if (!pageText.includes(skill.name)) {
        fail(`US2-4: about page is missing skill "${skill.name}"`);
      }
    }
    if (!pageText.includes('Learning')) {
      fail('US2-4: about page is missing the "Learning" level label');
    }
    if (pageText.includes('Beginner / Learning')) {
      fail('US2-4: about page displays the raw level "Beginner / Learning" instead of "Learning"');
    }

    // Team context: the label and team sentence sit inside the team-context role.
    const experienceHtml = sectionInnerHtml(aboutHtml, 'experience');
    if (experienceHtml === null) {
      fail('US2-5: about page has no <section id="experience"> block');
    } else {
      const entries = experienceHtml.split(/<article\b/i).slice(1);

      // Every role with its company, formatted date range, and points.
      for (const job of experience) {
        const expectedValues = [job.role, job.company, formatRange(job.start, job.end)];
        if (Array.isArray(job.points)) expectedValues.push(...job.points);
        for (const value of expectedValues) {
          if (typeof value === 'string' && !pageText.includes(value)) {
            fail(`US2-5: about page is missing experience value "${value}"`);
          }
        }
      }

      for (const job of experience) {
        if (job.context !== 'team') continue;
        const teamEntry = entries.find((entry) => {
          const entryText = decodeHtmlEntities(entry);
          return entryText.includes(job.role) && entryText.includes(job.company);
        });
        if (!teamEntry) {
          fail(`US2-5: experience timeline is missing the team-context role at "${job.company}"`);
          continue;
        }
        const teamText = decodeHtmlEntities(teamEntry);
        if (!teamText.includes('Team context')) {
          fail(`US2-5: team-context role at "${job.company}" is missing the "Team context" label`);
        }
        if (!teamText.includes('This work was done within a team.')) {
          fail(`US2-5: team-context role at "${job.company}" is missing the team sentence`);
        }
      }
    }

    // Every education entry: degree, institution, and years.
    for (const entry of education) {
      for (const field of ['degree', 'institution', 'year']) {
        if (typeof entry[field] === 'string' && !pageText.includes(entry[field])) {
          fail(`US2-6: about page is missing education ${field} "${entry[field]}"`);
        }
      }
    }

    // Every language entry: name and proficiency.
    for (const language of languages) {
      for (const field of ['name', 'level']) {
        if (typeof language[field] === 'string' && !pageText.includes(language[field])) {
          fail(`US2-7: about page is missing language ${field} "${language[field]}"`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// US3: Ask page
// ---------------------------------------------------------------------------
const askPath = join(DIST, 'ask', 'index.html');
if (!existsSync(askPath)) {
  fail('US3: dist/client/ask/index.html does not exist');
} else {
  const askHtml = readFileSync(askPath, 'utf8');

  if (!askHtml.includes('<form')) {
    fail('US3: dist/client/ask/index.html is missing <form element');
  }

  if (!askHtml.includes('maxlength="1000"')) {
    fail('US3: dist/client/ask/index.html is missing maxlength="1000"');
  }

  // A status element carrying BOTH role="status" and aria-live="polite"
  const tagRegex = /<([a-zA-Z0-9]+)\b([^>]*)>/g;
  let statusTagMatch;
  let hasValidStatusElement = false;
  while ((statusTagMatch = tagRegex.exec(askHtml)) !== null) {
    const attrs = statusTagMatch[2];
    const hasRoleStatus = /\brole\s*=\s*(["'])status\1/i.test(attrs);
    const hasAriaLive = /\baria-live\s*=\s*(["'])polite\1/i.test(attrs);
    if (hasRoleStatus && hasAriaLive) {
      hasValidStatusElement = true;
      break;
    }
  }
  if (!hasValidStatusElement) {
    fail('US3: dist/client/ask/index.html is missing status element carrying both role="status" and aria-live="polite"');
  }

  // The exact text "AI assistant. The CV and case studies are the source of record." appearing exactly once
  const exactDisclaimer = 'AI assistant. The CV and case studies are the source of record.';
  const disclaimerOccurrences = askHtml.split(exactDisclaimer).length - 1;
  if (disclaimerOccurrences !== 1) {
    fail(`US3: dist/client/ask/index.html contains exact text "${exactDisclaimer}" ${disclaimerOccurrences} times (expected exactly 1)`);
  }

  // Assert exactly one module island as above
  const scriptTagRegex = /<script\b([^>]*)>/gi;
  let scriptMatch;
  let askModuleCount = 0;
  while ((scriptMatch = scriptTagRegex.exec(askHtml)) !== null) {
    const fullTag = scriptMatch[0];
    const attrs = scriptMatch[1];

    if (/type\s*=\s*(['"])application\/ld\+json\1/i.test(attrs)) {
      continue;
    }

    if (/type\s*=\s*(['"])module\1/i.test(attrs)) {
      const srcMatch = /\bsrc\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/i.exec(attrs);
      if (srcMatch) {
        const srcVal = srcMatch[2] ?? srcMatch[3];
        if (!srcVal.startsWith('/_astro/')) {
          fail(`US3: dist/client/ask/index.html contains module script with src outside /_astro/: ${fullTag}`);
        }
      }
      askModuleCount++;
      if (askModuleCount > 1) {
        fail(`US3: dist/client/ask/index.html contains extra executable script tag: ${fullTag}`);
      }
    } else {
      fail(`US3: dist/client/ask/index.html contains non-module script tag: ${fullTag}`);
    }
  }

  if (askModuleCount !== 1) {
    fail(`US3: dist/client/ask/index.html contains ${askModuleCount} executable module script tags (expected exactly 1)`);
  }
}

// ---------------------------------------------------------------------------
// US3: Admin pages and on-demand assertions
// ---------------------------------------------------------------------------
const adminLoginPath = join(DIST, 'admin', 'login', 'index.html');
if (!existsSync(adminLoginPath)) {
  fail('US3: dist/client/admin/login/index.html does not exist');
} else {
  const adminLoginHtml = readFileSync(adminLoginPath, 'utf8');

  if (!adminLoginHtml.includes('noindex')) {
    fail('US3: dist/client/admin/login/index.html is missing "noindex"');
  }

  if (!/type\s*=\s*(["'])password\1/i.test(adminLoginHtml)) {
    fail('US3: dist/client/admin/login/index.html is missing type="password" input');
  }

  const forbiddenTokens = ['AI_API_KEY', 'SMTP_HOST', 'v1:', 'ADMIN_PASSWORD_HASH'];
  for (const token of forbiddenTokens) {
    if (adminLoginHtml.includes(token)) {
      fail(`US3: dist/client/admin/login/index.html contains forbidden settings token "${token}"`);
    }
  }

  const envTokens = [
    process.env.AI_API_KEY,
    process.env.SMTP_HOST,
    process.env.ADMIN_PASSWORD_HASH,
    process.env.ENCRYPTION_KEY,
  ].filter((v) => typeof v === 'string' && v.trim().length > 0);

  for (const envVal of envTokens) {
    if (adminLoginHtml.includes(envVal)) {
      fail('US3: dist/client/admin/login/index.html contains active environment secret');
    }
  }
}

const adminIndexPath = join(DIST, 'admin', 'index.html');
if (existsSync(adminIndexPath)) {
  fail('US3: dist/client/admin/index.html exists but must remain on-demand (not prerendered)');
}

const apiAdminLoginPath = join(DIST, 'api', 'admin', 'login');
if (existsSync(apiAdminLoginPath)) {
  fail('US3: dist/client/api/admin/login exists but must remain on-demand (not prerendered)');
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
