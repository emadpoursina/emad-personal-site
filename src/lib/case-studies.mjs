/**
 * src/lib/case-studies.mjs
 *
 * Validates a parsed case-studies document and provides query helpers.
 * No file I/O — callers pass the parsed document.
 * Throws an Error naming the filePath, slug, and offending field on failure.
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Returns true if the value is a non-empty string.
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Validates a parsed case-studies document.
 * Throws an Error whose message starts with filePath, names the slug when known,
 * and names the offending field.
 *
 * @param {{ studies: unknown[] } | unknown} doc - parsed JSON document
 * @param {string} [filePath]
 */
export function validateCaseStudies(doc, filePath = 'content/case-studies.json') {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${filePath}: root value must be a JSON object`);
  }

  const d = /** @type {Record<string, unknown>} */ (doc);

  // studies must be a non-empty array
  if (!Array.isArray(d['studies']) || d['studies'].length === 0) {
    throw new Error(`${filePath}: "studies" must be a non-empty array`);
  }

  const studies = /** @type {unknown[]} */ (d['studies']);
  const seenSlugs = new Set();

  for (let i = 0; i < studies.length; i++) {
    const study = studies[i];

    if (study === null || typeof study !== 'object' || Array.isArray(study)) {
      throw new Error(`${filePath}: studies[${i}] is not a non-null object`);
    }

    const s = /** @type {Record<string, unknown>} */ (study);
    const slug = s['slug'];

    // slug validation
    if (!isNonEmptyString(slug) || !SLUG_RE.test(/** @type {string} */ (slug))) {
      throw new Error(
        `${filePath}: studies[${i}]: "slug" must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (got ${JSON.stringify(slug)})`
      );
    }
    const slugStr = /** @type {string} */ (slug);

    if (seenSlugs.has(slugStr)) {
      throw new Error(
        `${filePath}: slug "${slugStr}": duplicate slug — each slug must be unique`
      );
    }
    seenSlugs.add(slugStr);

    // title validation
    if (!isNonEmptyString(s['title'])) {
      throw new Error(
        `${filePath}: slug "${slugStr}": "title" must be a non-empty string`
      );
    }

    // status validation
    if (s['status'] !== 'published' && s['status'] !== 'draft') {
      throw new Error(
        `${filePath}: slug "${slugStr}": "status" must be "published" or "draft" (got ${JSON.stringify(s['status'])})`
      );
    }

    // visibility validation (optional field)
    if ('visibility' in s && s['visibility'] !== 'public' && s['visibility'] !== 'private') {
      throw new Error(
        `${filePath}: slug "${slugStr}": "visibility" must be "public" or "private" (got ${JSON.stringify(s['visibility'])})`
      );
    }

    if (s['status'] === 'published') {
      // published requires visibility
      if (!('visibility' in s) || (s['visibility'] !== 'public' && s['visibility'] !== 'private')) {
        throw new Error(
          `${filePath}: slug "${slugStr}": published study requires "visibility" to be "public" or "private"`
        );
      }

      // published requires non-empty problem, contribution, outcome
      for (const field of ['problem', 'contribution', 'outcome']) {
        if (!isNonEmptyString(s[field])) {
          throw new Error(
            `${filePath}: slug "${slugStr}": published study requires non-empty "${field}"`
          );
        }
      }

      // published requires non-empty stack of non-empty strings
      if (!Array.isArray(s['stack']) || s['stack'].length === 0) {
        throw new Error(
          `${filePath}: slug "${slugStr}": published study requires non-empty "stack" array`
        );
      }
      for (let j = 0; j < /** @type {unknown[]} */ (s['stack']).length; j++) {
        if (!isNonEmptyString(/** @type {unknown[]} */ (s['stack'])[j])) {
          throw new Error(
            `${filePath}: slug "${slugStr}": "stack[${j}]" must be a non-empty string`
          );
        }
      }

      // public: publicLink must be a non-null object with https:// url
      if (s['visibility'] === 'public') {
        const pl = s['publicLink'];
        if (
          pl === null ||
          typeof pl !== 'object' ||
          Array.isArray(pl) ||
          typeof (/** @type {Record<string, unknown>} */ (pl))['url'] !== 'string' ||
          !(/** @type {Record<string, unknown>} */ (pl))['url'].startsWith('https://')
        ) {
          throw new Error(
            `${filePath}: slug "${slugStr}": public study requires "publicLink" to be a non-null object with a "url" starting with "https://"`
          );
        }
      }

      // private: publicLink must be exactly null
      if (s['visibility'] === 'private') {
        if (s['publicLink'] !== null) {
          throw new Error(
            `${filePath}: slug "${slugStr}": private study requires "publicLink" to be null`
          );
        }
      }
    }

    if (s['status'] === 'draft') {
      // draft must not carry narrative fields, non-empty stack, or non-null publicLink
      for (const field of ['problem', 'contribution', 'outcome']) {
        if (isNonEmptyString(s[field])) {
          throw new Error(
            `${filePath}: slug "${slugStr}": draft study must not have a non-empty "${field}"`
          );
        }
      }
      if (Array.isArray(s['stack']) && /** @type {unknown[]} */ (s['stack']).length > 0) {
        throw new Error(
          `${filePath}: slug "${slugStr}": draft study must not have a non-empty "stack"`
        );
      }
      if (s['publicLink'] !== undefined && s['publicLink'] !== null) {
        throw new Error(
          `${filePath}: slug "${slugStr}": draft study must not have a non-null "publicLink"`
        );
      }
    }
  }
}

/**
 * Returns the published studies from the document, in array order.
 * Does not mutate the document.
 *
 * @param {{ studies: unknown[] } | unknown} doc - parsed JSON document
 * @returns {Record<string, unknown>[]}
 */
export function publishedStudies(doc) {
  const d = /** @type {Record<string, unknown>} */ (doc);
  const studies = /** @type {unknown[]} */ (d['studies'] ?? []);
  return studies.filter(
    (s) =>
      s !== null &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      (/** @type {Record<string, unknown>} */ (s))['status'] === 'published'
  );
}

/**
 * Returns the study with the given slug, or undefined.
 *
 * @param {{ studies: unknown[] } | unknown} doc - parsed JSON document
 * @param {string} slug
 * @returns {Record<string, unknown> | undefined}
 */
export function findStudy(doc, slug) {
  const d = /** @type {Record<string, unknown>} */ (doc);
  const studies = /** @type {unknown[]} */ (d['studies'] ?? []);
  return /** @type {Record<string, unknown> | undefined} */ (
    studies.find(
      (s) =>
        s !== null &&
        typeof s === 'object' &&
        !Array.isArray(s) &&
        (/** @type {Record<string, unknown>} */ (s))['slug'] === slug
    )
  );
}
