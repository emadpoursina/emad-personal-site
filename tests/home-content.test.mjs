/**
 * tests/home-content.test.mjs
 *
 * Tests assertions on the built dist/client/index.html.
 * Run with: node --experimental-sqlite --test tests/home-content.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'dist', 'client', 'index.html');
const PROFILE_JSON = path.join(ROOT, 'content', 'profile.json');

function getIndexHtml() {
  if (!fs.existsSync(INDEX_HTML)) {
    assert.fail('run npm run build first');
  }
  return fs.readFileSync(INDEX_HTML, 'utf8');
}

test('dist/client/index.html contains exact headline from content/profile.json', () => {
  const html = getIndexHtml();
  const profile = JSON.parse(fs.readFileSync(PROFILE_JSON, 'utf8'));
  assert.ok(
    html.includes(profile.headline),
    `dist/client/index.html does not contain headline "${profile.headline}"`
  );
});

test('dist/client/index.html contains work authorization and availability notices', () => {
  const html = getIndexHtml();
  assert.ok(
    html.includes('Requires employer-sponsored work authorization.'),
    'dist/client/index.html missing "Requires employer-sponsored work authorization."'
  );
  assert.ok(
    html.includes('one month notice'),
    'dist/client/index.html missing "one month notice"'
  );
});

test('dist/client/index.html contains links to /case-studies, /cv.pdf, /contact', () => {
  const html = getIndexHtml();
  assert.ok(
    /href=["']\/case-studies["']/.test(html),
    'dist/client/index.html missing link to /case-studies'
  );
  assert.ok(
    /href=["']\/cv\.pdf["']/.test(html),
    'dist/client/index.html missing link to /cv.pdf'
  );
  assert.ok(
    /href=["']\/contact["']/.test(html),
    'dist/client/index.html missing link to /contact'
  );
});

test('dist/client/index.html contains no target="_blank" without rel containing noopener', () => {
  const html = getIndexHtml();
  const anchorRegex = /<a\b[^>]*>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const tag = match[0];
    if (/target=["']_blank["']/i.test(tag)) {
      assert.ok(
        /rel=["'][^"']*noopener[^"']*["']/i.test(tag),
        `Found target="_blank" link without rel containing noopener: ${tag}`
      );
    }
  }
});
