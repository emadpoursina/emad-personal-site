/**
 * src/lib/mailer.mjs
 *
 * nodemailer transport wrapper.
 * - Transport cached with fingerprint of effective SMTP settings.
 * - Resolves effective SMTP settings per call (admin > env > default).
 * - status() returns 'configured' | 'disabled'.
 * - send({name, email, message}) sends the contact email.
 * - Disabled state warns once and throws without attempting a network call.
 * - Never logs credentials.
 */

import nodemailer from 'nodemailer';
import { getEffectiveSmtp } from './settings.mjs';
import { getConfig } from './env.mjs';

/** @type {import('nodemailer').Transporter | null} */
let _transport = null;

/** @type {string | null} */
let _fingerprint = null;

/** Flag to ensure disabled warning is logged at most once per process. */
let _disabledWarned = false;

/**
 * Emits console.warn at most once when SMTP is disabled.
 * Never logs credentials.
 */
function warnDisabledOnce() {
  if (!_disabledWarned) {
    _disabledWarned = true;
    console.warn('[mailer] Contact email delivery is disabled (SMTP not configured).');
  }
}

/**
 * Returns the cached transport or creates a new one if settings changed.
 *
 * @param {{ host: string; port: number; secure: boolean; user: string; pass: string }} smtp
 * @returns {import('nodemailer').Transporter}
 */
function getOrCreateTransport(smtp) {
  const fingerprint = JSON.stringify({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    user: smtp.user,
    pass: smtp.pass,
  });

  if (_transport === null || _fingerprint !== fingerprint) {
    _transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     30_000,
    });
    _fingerprint = fingerprint;
  }

  return _transport;
}

/**
 * Returns 'configured' when effective SMTP settings are enabled, 'disabled' otherwise.
 * Logs at most one warning when disabled.
 *
 * @returns {'configured' | 'disabled'}
 */
export function status() {
  const smtp = getEffectiveSmtp();
  if (smtp.enabled) {
    return 'configured';
  }
  warnDisabledOnce();
  return 'disabled';
}

/**
 * Strips CR/LF and other control characters from a value that is interpolated
 * into a mail header, collapsing each run to a single space. Defense in depth:
 * validation already rejects control characters in `name`, but a header built
 * from untrusted input must never carry a line break (header injection).
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeHeaderValue(value) {
  return String(value).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}

/**
 * Sends a contact email using effective SMTP settings.
 *
 * @param {{ name: string; email: string; message: string }} opts
 * @returns {Promise<void>}
 * @throws {Error} when SMTP is disabled or the send fails.
 */
export async function send({ name, email, message }) {
  const smtp = getEffectiveSmtp();
  if (!smtp.enabled) {
    warnDisabledOnce();
    throw new Error('Contact email delivery is disabled (SMTP not configured).');
  }

  const transport = getOrCreateTransport(smtp);

  const cfg = getConfig();
  const to        = /** @type {string} */ (cfg.CONTACT_TO);
  const from      = smtp.from;
  const timestamp = new Date().toUTCString();
  const safeName  = sanitizeHeaderValue(name);
  const safeEmail = sanitizeHeaderValue(email);

  const body = [
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Sent:    ${timestamp}`,
    ``,
    message,
  ].join('\n');

  await transport.sendMail({
    from,
    to,
    replyTo: safeEmail,
    subject: `Contact form: ${safeName}`,
    text:    body,
    // No html part, no visitor-supplied headers.
  });
}

/**
 * Resets the cached transport, fingerprint, and warning state. For tests only.
 */
export function resetTransport() {
  _transport = null;
  _fingerprint = null;
  _disabledWarned = false;
}
