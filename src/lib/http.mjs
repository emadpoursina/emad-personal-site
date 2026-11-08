/**
 * src/lib/http.mjs
 *
 * Pure helper for rendering contact-API outcomes as JSON or HTML.
 *
 * sendOutcome(status, payload, accept) returns {status, headers, body}.
 * - JSON only when Accept header is exactly 'application/json' (with or without
 *   parameters). '*\/*' and other wildcards are NOT treated as JSON.
 * - HTML otherwise: status-specific documents with links back to /contact (or /
 *   on success), field errors for 400, and the direct email for 429/502/503/500.
 * - Every response: Cache-Control: no-store, X-Content-Type-Options: nosniff,
 *   Content-Language: en.
 * - No stack traces or internal details in any response.
 * - All interpolated values are HTML-escaped.
 */

const DIRECT_EMAIL = 'emad.poursina.work@gmail.com';

/**
 * HTML-escapes a string to prevent injection.
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Returns true when the Accept header value explicitly prefers application/json.
 * Parses media types with q-values, drops wildcards (* / * and any *),
 * sorts by q descending then original order, and returns true only when the winning
 * explicit type is application/json. If no explicit type, returns false (HTML).
 *
 * @param {string | null | undefined} accept
 * @returns {boolean}
 */
export function acceptsJson(accept) {
  if (!accept || typeof accept !== 'string') return false;

  const explicitTypes = [];
  const entries = accept.split(',');

  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i].trim();
    if (!raw) continue;

    const parts = raw.split(';').map((p) => p.trim());
    const type = parts[0].toLowerCase();

    // Drop wildcards (*/* or any type containing *) from preference choice
    if (!type || type.includes('*')) continue;

    let q = 1.0;
    for (let j = 1; j < parts.length; j++) {
      const match = /^q\s*=\s*(.*)$/i.exec(parts[j]);
      if (match) {
        const val = parseFloat(match[1]);
        if (!Number.isNaN(val)) {
          q = val;
        }
      }
    }

    explicitTypes.push({ type, q, index: i });
  }

  if (explicitTypes.length === 0) {
    return false;
  }

  // Sort by q descending, then original order ascending
  explicitTypes.sort((a, b) => {
    if (b.q !== a.q) {
      return b.q - a.q;
    }
    return a.index - b.index;
  });

  return explicitTypes[0].type === 'application/json';
}

/**
 * Builds the common headers for every response.
 * @param {string} contentType
 * @returns {Record<string, string>}
 */
function commonHeaders(contentType) {
  return {
    'Content-Type':           contentType,
    'Cache-Control':          'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Language':       'en',
  };
}

/**
 * Wraps content in a minimal HTML document.
 * @param {string} title
 * @param {string} bodyContent  - Already-safe HTML string.
 * @returns {string}
 */
function htmlDoc(title, bodyContent) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/**
 * Returns the outcome object: {status, headers, body}.
 *
 * @param {number} statusCode  - HTTP status code.
 * @param {Record<string, unknown>} payload  - JSON payload / structured data.
 * @param {string | null | undefined} accept  - Value of the Accept request header.
 * @returns {{ status: number; headers: Record<string, string>; body: string }}
 */
export function sendOutcome(statusCode, payload, accept) {
  if (acceptsJson(accept)) {
    return {
      status: statusCode,
      headers: commonHeaders('application/json; charset=utf-8'),
      body: JSON.stringify(payload),
    };
  }

  // HTML rendering
  let title;
  let bodyHtml;

  switch (statusCode) {
    case 200: {
      title = 'Message sent';
      bodyHtml = `<h1>Message sent</h1>
<p>Thank you — your message has been received.</p>
<p><a href="/">Return to home</a> | <a href="/contact">Send another message</a></p>`;
      break;
    }

    case 400: {
      title = 'Please correct your message';
      const errors = /** @type {Record<string, string>} */ (payload.errors ?? {});
      const errorLines = Object.entries(errors)
        .map(([field, msg]) => `<li><strong>${esc(field)}:</strong> ${esc(msg)}</li>`)
        .join('\n');
      bodyHtml = `<h1>Please correct your message</h1>
<ul>
${errorLines}
</ul>
<p><a href="/contact">Go back and try again</a></p>`;
      break;
    }

    case 429: {
      title = 'Too many messages';
      const retryAfter = payload.retryAfterSeconds ?? 0;
      bodyHtml = `<h1>Too many messages</h1>
<p>You have submitted too many messages. Please try again later (in approximately ${esc(retryAfter)} seconds).</p>
<p>Alternatively, write directly to <a href="mailto:${esc(DIRECT_EMAIL)}">${esc(DIRECT_EMAIL)}</a>.</p>
<p><a href="/contact">Return to contact page</a></p>`;
      break;
    }

    case 502: {
      title = 'Message saved — delivery issue';
      bodyHtml = `<h1>Message saved, but delivery failed</h1>
<p>Your message was saved, but the confirmation email could not be sent.</p>
<p>Please also write directly to <a href="mailto:${esc(DIRECT_EMAIL)}">${esc(DIRECT_EMAIL)}</a> to ensure it reaches us.</p>
<p><a href="/contact">Return to contact page</a></p>`;
      break;
    }

    case 503: {
      title = 'Contact form unavailable';
      bodyHtml = `<h1>Contact form unavailable</h1>
<p>The contact form is currently unavailable. Please write directly to <a href="mailto:${esc(DIRECT_EMAIL)}">${esc(DIRECT_EMAIL)}</a>.</p>
<p><a href="/contact">Return to contact page</a></p>`;
      break;
    }

    case 500:
    default: {
      title = 'Something went wrong';
      bodyHtml = `<h1>Something went wrong</h1>
<p>An unexpected error occurred. Please write directly to <a href="mailto:${esc(DIRECT_EMAIL)}">${esc(DIRECT_EMAIL)}</a>.</p>
<p><a href="/contact">Return to contact page</a></p>`;
      break;
    }
  }

  return {
    status: statusCode,
    headers: commonHeaders('text/html; charset=utf-8'),
    body: htmlDoc(title, bodyHtml),
  };
}
