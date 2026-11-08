/**
 * src/lib/mailer.mjs
 *
 * nodemailer transport wrapper.
 * - Transport built from env on first use, cached.
 * - status() returns 'configured' | 'disabled'.
 * - send({name, email, message}) sends the contact email.
 * - Disabled state throws without attempting a network call.
 * - Never logs credentials.
 */

import nodemailer from 'nodemailer';
import { smtpStatus, getConfig } from './env.mjs';

/** @type {import('nodemailer').Transporter | null} */
let _transport = null;

/**
 * Returns the cached transport, creating it on first use.
 * Returns null when SMTP is not configured.
 * @returns {import('nodemailer').Transporter | null}
 */
function getTransport() {
  if (_transport !== null) return _transport;
  if (smtpStatus() !== 'configured') return null;

  const cfg = getConfig();
  _transport = nodemailer.createTransport({
    host:   /** @type {string} */ (cfg.SMTP_HOST),
    port:   /** @type {number} */ (cfg.SMTP_PORT),
    secure: /** @type {boolean} */ (cfg.SMTP_SECURE),
    auth: {
      user: /** @type {string} */ (cfg.SMTP_USER),
      pass: /** @type {string} */ (cfg.SMTP_PASS),
    },
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     30_000,
  });

  return _transport;
}

/**
 * Returns 'configured' when SMTP credentials are present, 'disabled' otherwise.
 * @returns {'configured' | 'disabled'}
 */
export function status() {
  return smtpStatus();
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
 * Sends a contact email.
 *
 * @param {{ name: string; email: string; message: string }} opts
 * @returns {Promise<void>}
 * @throws {Error} when SMTP is disabled or the send fails.
 */
export async function send({ name, email, message }) {
  if (smtpStatus() !== 'configured') {
    throw new Error('Contact email delivery is disabled (SMTP not configured).');
  }

  const transport = getTransport();
  if (!transport) {
    throw new Error('Contact email delivery is disabled (SMTP not configured).');
  }

  const cfg = getConfig();
  const to      = /** @type {string} */ (cfg.CONTACT_TO);
  const from    = /** @type {string} */ (cfg.SMTP_FROM);
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
 * Resets the cached transport. For tests only.
 */
export function resetTransport() {
  _transport = null;
}
