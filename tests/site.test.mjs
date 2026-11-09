/**
 * tests/site.test.mjs
 *
 * Unit tests for site constants, absoluteUrl helper, and buildSitemap.
 * Run with: node --experimental-sqlite --test tests/site.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SITE_URL,
  PUBLIC_PAGE_PATHS,
  absoluteUrl,
  getSiteUrl
} from '../src/lib/site.mjs';
import { buildSitemap } from '../src/lib/agent-output.mjs';

test('PUBLIC_PAGE_PATHS contains the six approved public page routes', () => {
  assert.deepEqual(PUBLIC_PAGE_PATHS, [
    '/',
    '/about',
    '/case-studies',
    '/ask',
    '/contact',
    '/cover-letter'
  ]);
});

test('buildSitemap with fixture of two published studies and one draft', () => {
  const originalEnv = process.env.SITE_URL;
  try {
    delete process.env.SITE_URL;

    const fixture = {
      studies: [
        { slug: 'published-alpha', status: 'published' },
        { slug: 'draft-secret', status: 'draft' },
        { slug: 'published-beta', status: 'published' }
      ]
    };

    const xml = buildSitemap(fixture);

    // Declaration and <urlset> shape unchanged
    assert.ok(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      ),
      'Must start with standard XML declaration and sitemap 0.9 urlset'
    );
    assert.ok(xml.endsWith('</urlset>\n'), 'Must end with closing </urlset>');

    // Extract all <loc> values
    const locMatches = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)];
    const locs = locMatches.map((m) => m[1]);

    const expectedPaths = [
      '/',
      '/about',
      '/case-studies',
      '/ask',
      '/contact',
      '/cover-letter',
      '/case-studies/published-alpha',
      '/case-studies/published-beta'
    ];

    // Each loc is an absolute URL beginning with the default site URL
    for (const loc of locs) {
      assert.ok(
        loc.startsWith(DEFAULT_SITE_URL),
        `Expected loc "${loc}" to start with default site URL "${DEFAULT_SITE_URL}"`
      );
    }

    const actualPaths = locs.map((loc) => loc.slice(DEFAULT_SITE_URL.length));
    assert.deepEqual(actualPaths, expectedPaths);

    // The draft slug never appears
    assert.equal(
      xml.includes('draft-secret'),
      false,
      'Draft slug must never appear in sitemap'
    );

    // No <lastmod>
    assert.equal(
      xml.includes('<lastmod>'),
      false,
      'Sitemap must not contain <lastmod>'
    );
  } finally {
    if (originalEnv === undefined) {
      delete process.env.SITE_URL;
    } else {
      process.env.SITE_URL = originalEnv;
    }
  }
});

test('absoluteUrl default behaviour and trailing-slash trimming unchanged', () => {
  const originalEnv = process.env.SITE_URL;
  try {
    // Default behaviour when SITE_URL is unset
    delete process.env.SITE_URL;
    assert.equal(getSiteUrl(), DEFAULT_SITE_URL);
    assert.equal(absoluteUrl('/'), `${DEFAULT_SITE_URL}/`);
    assert.equal(absoluteUrl('/about'), `${DEFAULT_SITE_URL}/about`);
    assert.equal(absoluteUrl('/ask'), `${DEFAULT_SITE_URL}/ask`);
    assert.equal(absoluteUrl('contact'), `${DEFAULT_SITE_URL}/contact`);
    assert.equal(absoluteUrl(''), `${DEFAULT_SITE_URL}/`);

    // Trailing-slash trimming with custom SITE_URL
    process.env.SITE_URL = 'https://example.com';
    assert.equal(getSiteUrl(), 'https://example.com');
    assert.equal(absoluteUrl('/about'), 'https://example.com/about');

    process.env.SITE_URL = 'https://example.com/';
    assert.equal(getSiteUrl(), 'https://example.com');
    assert.equal(absoluteUrl('/ask'), 'https://example.com/ask');

    process.env.SITE_URL = 'https://example.com///';
    assert.equal(getSiteUrl(), 'https://example.com');
    assert.equal(absoluteUrl('/case-studies'), 'https://example.com/case-studies');

    process.env.SITE_URL = '  https://example.com/  ';
    assert.equal(getSiteUrl(), 'https://example.com');
    assert.equal(absoluteUrl('/contact'), 'https://example.com/contact');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.SITE_URL;
    } else {
      process.env.SITE_URL = originalEnv;
    }
  }
});
