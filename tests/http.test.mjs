/**
 * tests/http.test.mjs
 *
 * Unit tests for src/lib/http.mjs.
 * Verifies Accept negotiation, response formats (JSON vs HTML), security headers,
 * error escaping, direct email fallbacks, and navigation links.
 * Run with: node --experimental-sqlite --test tests/http.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendOutcome } from '../src/lib/http.mjs';

describe('http.mjs - Accept negotiation', () => {
  test('application/json → JSON body + application/json content type', () => {
    const payload = { ok: true, status: 'sent', id: 42 };
    const res = sendOutcome(200, payload, 'application/json');

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^application\/json/);
    assert.deepEqual(JSON.parse(res.body), payload);
  });

  test('application/json; charset=utf-8 → JSON', () => {
    const payload = { ok: true, status: 'sent' };
    const res = sendOutcome(200, payload, 'application/json; charset=utf-8');

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^application\/json/);
    assert.deepEqual(JSON.parse(res.body), payload);
  });

  test('*/* → HTML', () => {
    const payload = { ok: true, status: 'sent' };
    const res = sendOutcome(200, payload, '*/*');

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^text\/html/);
    assert.ok(res.body.includes('<!doctype html>'));
  });

  test('a browser-style text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8 → HTML', () => {
    const accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    const res = sendOutcome(200, { ok: true, status: 'sent' }, accept);

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^text\/html/);
    assert.ok(res.body.includes('<!doctype html>'));
  });

  test('text/html, application/json → HTML', () => {
    const accept = 'text/html, application/json';
    const res = sendOutcome(200, { ok: true, status: 'sent' }, accept);

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^text\/html/);
    assert.ok(res.body.includes('<!doctype html>'));
  });

  test('application/json, text/html → JSON', () => {
    const accept = 'application/json, text/html';
    const payload = { ok: true, status: 'sent', id: 1 };
    const res = sendOutcome(200, payload, accept);

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^application\/json/);
    assert.deepEqual(JSON.parse(res.body), payload);
  });
});

describe('http.mjs - Headers and response content', () => {
  test('every response has Cache-Control no-store, X-Content-Type-Options nosniff, Content-Language en', () => {
    const testCases = [
      sendOutcome(200, { ok: true }, 'application/json'),
      sendOutcome(200, { ok: true }, 'text/html'),
      sendOutcome(400, { ok: false, errors: {} }, '*/*'),
      sendOutcome(429, { retryAfterSeconds: 30 }, null),
      sendOutcome(500, { ok: false }, undefined),
      sendOutcome(502, { ok: false }, 'text/html'),
      sendOutcome(503, { ok: false }, 'text/html'),
    ];

    for (const res of testCases) {
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(res.headers['Content-Language'], 'en');
    }
  });

  test('400 HTML lists the field errors escaped', () => {
    const payload = {
      ok: false,
      error: 'validation',
      errors: {
        email: 'Invalid email address',
        message: 'Message cannot be empty',
      },
    };
    const res = sendOutcome(400, payload, 'text/html');

    assert.equal(res.status, 400);
    assert.match(res.headers['Content-Type'], /^text\/html/);
    assert.ok(res.body.includes('<strong>email:</strong> Invalid email address'));
    assert.ok(res.body.includes('<strong>message:</strong> Message cannot be empty'));
  });

  test('429/502/503/500 HTML contains emad.poursina.work@gmail.com', () => {
    const directEmail = 'emad.poursina.work@gmail.com';
    const cases = [
      { status: 429, payload: { ok: false, error: 'rate_limited', retryAfterSeconds: 60 } },
      { status: 502, payload: { ok: false, error: 'delivery_failed', id: 1 } },
      { status: 503, payload: { ok: false, error: 'disabled' } },
      { status: 500, payload: { ok: false, error: 'storage' } },
    ];

    for (const { status, payload } of cases) {
      const res = sendOutcome(status, payload, 'text/html');
      assert.equal(res.status, status);
      assert.match(res.headers['Content-Type'], /^text\/html/);
      assert.ok(
        res.body.includes(directEmail),
        `status ${status} HTML should contain ${directEmail}`
      );
    }
  });

  test('200 HTML links to / and /contact', () => {
    const res = sendOutcome(200, { ok: true, status: 'sent', id: 1 }, 'text/html');

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^text\/html/);
    assert.ok(res.body.includes('href="/"'), 'HTML should link to /');
    assert.ok(res.body.includes('href="/contact"'), 'HTML should link to /contact');
  });

  test('an injected <script> in a field error is escaped', () => {
    const payload = {
      ok: false,
      error: 'validation',
      errors: {
        '<script>badKey</script>': '<script>alert("xss")</script>',
      },
    };
    const res = sendOutcome(400, payload, 'text/html');

    assert.equal(res.status, 400);
    assert.match(res.headers['Content-Type'], /^text\/html/);
    assert.ok(!res.body.includes('<script>badKey</script>'), 'unescaped script key must not be present');
    assert.ok(!res.body.includes('<script>alert("xss")</script>'), 'unescaped script tag must not be present');
    assert.ok(res.body.includes('&lt;script&gt;badKey&lt;/script&gt;'), 'escaped script key must be present');
    assert.ok(res.body.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), 'escaped script value must be present');
  });
});
