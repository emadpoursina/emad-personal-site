#!/usr/bin/env node
/**
 * scripts/admin-credentials.mjs
 *
 * Offline admin credential and encryption key generator.
 *
 * CLI shape:
 *   node scripts/admin-credentials.mjs --hash
 *     Reads a password from stdin (stripping exactly one trailing \n or \r\n),
 *     rejects an empty result with exit 2, derives a 64-byte key using
 *     node:crypto scrypt with N=16384, r=8, p=1 and a 16-byte random salt,
 *     and prints:
 *       ADMIN_PASSWORD_HASH=scrypt$16384$8$1$<salt-base64>$<hash-base64>
 *     Never echoes or prints the password.
 *
 *   node scripts/admin-credentials.mjs --key
 *     Generates 32 random bytes and prints:
 *       ENCRYPTION_KEY=<base64 of 32 random bytes>
 *
 * Exit codes:
 *   0: success
 *   1: invalid usage / no recognized mode / both modes provided
 *   2: empty password provided to --hash
 */

import crypto from 'node:crypto';
import util from 'node:util';

const scryptAsync = util.promisify(crypto.scrypt);

const USAGE = 'Usage: node scripts/admin-credentials.mjs <--hash|--key>';

/**
 * Strips exactly one trailing \n or \r\n from a string.
 * @param {string} str
 * @returns {string}
 */
function stripTrailingNewline(str) {
  if (str.endsWith('\r\n')) {
    return str.slice(0, -2);
  }
  if (str.endsWith('\n')) {
    return str.slice(0, -1);
  }
  return str;
}

/**
 * Reads all data from stdin as a UTF-8 string.
 * @returns {Promise<string>}
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Derives and prints the scrypt password hash.
 */
async function handleHash() {
  const rawInput = await readStdin();
  const password = stripTrailingNewline(rawInput);

  if (password.length === 0) {
    console.error('admin-credentials: password on stdin cannot be empty');
    process.exit(2);
  }

  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });

  const saltB64 = salt.toString('base64');
  const hashB64 = derivedKey.toString('base64');

  console.log(`ADMIN_PASSWORD_HASH=scrypt$16384$8$1$${saltB64}$${hashB64}`);
}

/**
 * Generates and prints a random 32-byte encryption key.
 */
function handleKey() {
  const key = crypto.randomBytes(32);
  console.log(`ENCRYPTION_KEY=${key.toString('base64')}`);
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const hasHash = args.includes('--hash');
const hasKey = args.includes('--key');

if ((hasHash && hasKey) || (!hasHash && !hasKey) || args.length !== 1) {
  console.error(USAGE);
  process.exit(1);
}

if (hasHash) {
  handleHash().catch((err) => {
    console.error('admin-credentials error:', err.message);
    process.exit(1);
  });
} else if (hasKey) {
  handleKey();
}
