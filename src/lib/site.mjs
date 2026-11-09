/**
 * src/lib/site.mjs
 *
 * Site-URL resolution helpers and public route constants.
 * Pure ESM module with no dependencies.
 */

export const DEFAULT_SITE_URL = 'http://localhost:4321';

/**
 * Returns process.env.SITE_URL trimmed when it is a non-empty string,
 * otherwise DEFAULT_SITE_URL; strips all trailing slashes from the result.
 *
 * @returns {string}
 */
export function getSiteUrl() {
  const raw = (process.env.SITE_URL ?? '').trim();
  const base = raw.length > 0 ? raw : DEFAULT_SITE_URL;
  return base.replace(/\/+$/, '');
}

export const PUBLIC_PAGE_PATHS = ['/', '/about', '/case-studies', '/ask', '/contact', '/cover-letter'];

/**
 * Returns an absolute URL for the given root-relative path.
 *
 * @param {string} path - Path beginning with '/' (e.g. '/about').
 * @returns {string}
 */
export function absoluteUrl(path) {
  const normalizedPath = typeof path === 'string' && path.startsWith('/')
    ? path
    : `/${path ?? ''}`;
  return `${getSiteUrl()}${normalizedPath}`;
}
