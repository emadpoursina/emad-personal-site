/**
 * src/lib/validation.mjs
 *
 * Field-level validation for the contact form.
 * - Trims all values before checking length.
 * - Returns {ok, values: {name, email, message}, errors: {field: message}}.
 * - Multiple errors are possible.
 */

/**
 * @typedef {{ name: string; email: string; message: string }} ContactValues
 * @typedef {{ name?: string; email?: string; message?: string }} ContactErrors
 * @typedef {{ ok: true; values: ContactValues; errors: ContactErrors }
 *          | { ok: false; values: ContactValues; errors: ContactErrors }} ValidationResult
 */

/**
 * Validates contact form fields.
 *
 * @param {Record<string, unknown>} raw  - Raw input (untrusted).
 * @returns {ValidationResult}
 */
export function validateContact(raw) {
  const name    = typeof raw.name    === 'string' ? raw.name.trim()    : '';
  const email   = typeof raw.email   === 'string' ? raw.email.trim()   : '';
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';

  /** @type {ContactErrors} */
  const errors = {};

  // --- name ---
  if (name.length === 0) {
    errors.name = 'Name is required.';
  } else if (name.length > 200) {
    errors.name = 'Name must be 200 characters or fewer.';
  } else if (/[\u0000-\u001F\u007F]/.test(name)) {
    // CR/LF and other control characters would let the name break out of the
    // mail Subject header (header injection). Reject them at the boundary.
    errors.name = 'Name must not contain control characters.';
  }

  // --- email ---
  if (email.length === 0) {
    errors.email = 'Email address is required.';
  } else if (email.length < 3) {
    errors.email = 'Email address is too short.';
  } else if (email.length > 320) {
    errors.email = 'Email address must be 320 characters or fewer.';
  } else if (/\s/.test(email)) {
    errors.email = 'Email address must not contain spaces.';
  } else {
    const atIndex = email.indexOf('@');
    if (atIndex === -1) {
      errors.email = 'Email address must contain an "@" symbol.';
    } else if (email.indexOf('@', atIndex + 1) !== -1) {
      errors.email = 'Email address must contain exactly one "@" symbol.';
    } else {
      const domain = email.slice(atIndex + 1);
      if (!domain.includes('.')) {
        errors.email = 'Email address domain must contain a dot (e.g. example.com).';
      }
    }
  }

  // --- message ---
  if (message.length === 0) {
    errors.message = 'Message is required.';
  } else if (message.length > 5000) {
    errors.message = 'Message must be 5,000 characters or fewer.';
  }

  const ok = Object.keys(errors).length === 0;
  return { ok, values: { name, email, message }, errors };
}
