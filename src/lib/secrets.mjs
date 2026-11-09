/**
 * src/lib/secrets.mjs
 *
 * AES-256-GCM secret envelope module.
 * Provides encryption, decryption, and masking for sensitive settings.
 * Fails closed on any invalid key, envelope corruption, or tampering.
 */

import crypto from 'node:crypto';
import { getConfig } from './env.mjs';

/**
 * Custom error class for secret operations.
 */
export class SecretError extends Error {
  /**
   * @param {string} message
   * @param {'key_missing' | 'key_invalid' | 'decrypt_failed' | 'invalid_input'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

/** Whether the missing/invalid key warning has already been logged. */
let warnedKeyIssue = false;

/**
 * Emits console.warn at most once per process for key issues.
 * Never includes key material or key value.
 */
function warnKeyIssueOnce() {
  if (!warnedKeyIssue) {
    warnedKeyIssue = true;
    console.warn('[secrets] ENCRYPTION_KEY is missing or invalid.');
  }
}

/**
 * Checks if a string is strict base64:
 * characters matching ^[A-Za-z0-9+/]+={0,2}$ and length multiple of 4.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isStrictBase64(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
}

/**
 * Resolves and validates the 32-byte encryption key from ENCRYPTION_KEY.
 * Accepts exactly 32 bytes from either valid base64 (strict) or 64 hex characters.
 * Missing/empty key throws SecretError with 'key_missing'.
 * Any other invalid form throws SecretError with 'key_invalid'.
 *
 * @returns {Buffer} 32-byte key buffer
 */
function parseEncryptionKey() {
  const conf = getConfig();
  const rawKey = conf?.ENCRYPTION_KEY;

  if (rawKey === undefined || rawKey === null || rawKey === '') {
    warnKeyIssueOnce();
    throw new SecretError('ENCRYPTION_KEY is missing.', 'key_missing');
  }

  if (typeof rawKey !== 'string') {
    warnKeyIssueOnce();
    throw new SecretError('ENCRYPTION_KEY is invalid.', 'key_invalid');
  }

  // 64 hex characters -> exactly 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  // Strict base64 -> exactly 32 bytes
  if (isStrictBase64(rawKey)) {
    const buf = Buffer.from(rawKey, 'base64');
    if (buf.length === 32) {
      return buf;
    }
  }

  warnKeyIssueOnce();
  throw new SecretError('ENCRYPTION_KEY is invalid.', 'key_invalid');
}

/**
 * Encrypts a plaintext secret using AES-256-GCM.
 *
 * @param {string} plaintext - Plaintext to encrypt (must be a non-empty string).
 * @returns {string} Versioned envelope `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`
 */
export function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new SecretError('Plaintext must be a non-empty string.', 'invalid_input');
  }

  const key = parseEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts a versioned envelope string using AES-256-GCM.
 *
 * @param {string} envelope - Versioned envelope string.
 * @returns {string} Decrypted plaintext string.
 */
export function decryptSecret(envelope) {
  const key = parseEncryptionKey();

  if (typeof envelope !== 'string') {
    throw new SecretError('Failed to decrypt secret.', 'decrypt_failed');
  }

  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new SecretError('Failed to decrypt secret.', 'decrypt_failed');
  }

  const [version, ivB64, tagB64, ciphertextB64] = parts;

  if (version !== 'v1') {
    throw new SecretError('Failed to decrypt secret.', 'decrypt_failed');
  }

  if (!isStrictBase64(ivB64) || !isStrictBase64(tagB64) || !isStrictBase64(ciphertextB64)) {
    throw new SecretError('Failed to decrypt secret.', 'decrypt_failed');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');

  if (iv.length !== 12 || tag.length !== 16) {
    throw new SecretError('Failed to decrypt secret.', 'decrypt_failed');
  }

  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  if (ciphertext.length === 0) {
    throw new SecretError('Failed to decrypt secret.', 'decrypt_failed');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new SecretError('Failed to decrypt secret.', 'decrypt_failed');
  }
}

/**
 * Masks a secret string for display in settings.
 * Returns '••••' + last 4 characters when value length is >= 8, otherwise '••••'.
 * Non-strings return '••••'.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function maskSecret(value) {
  if (typeof value !== 'string') {
    return '••••';
  }
  if (value.length >= 8) {
    return '••••' + value.slice(-4);
  }
  return '••••';
}
