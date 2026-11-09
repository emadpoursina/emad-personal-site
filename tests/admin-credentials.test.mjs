/**
 * tests/admin-credentials.test.mjs
 *
 * Tests for scripts/admin-credentials.mjs.
 * Proves password hashing, scrypt derivation parameters, key generation,
 * argument validation, and that secrets are never echoed to stdout/stderr.
 *
 * Run with: node --experimental-sqlite --test tests/admin-credentials.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(
  new URL('../scripts/admin-credentials.mjs', import.meta.url)
);

/**
 * Spawns the admin-credentials script and returns the result.
 * @param {string[]} args
 * @param {string|Buffer|null} [stdinInput=null]
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>}
 */
function runScript(args, stdinInput = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (data) => {
      stdout += data;
    });

    proc.stderr.on('data', (data) => {
      stderr += data;
    });

    proc.on('error', reject);

    proc.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });

    if (stdinInput !== null) {
      proc.stdin.write(stdinInput);
    }
    proc.stdin.end();
  });
}

describe('admin-credentials CLI', () => {
  describe('--hash', () => {
    test('derives scrypt hash from known password on stdin with trailing newline', async () => {
      const password = 'correct-horse-battery-staple-2026';
      const result = await runScript(['--hash'], `${password}\n`);

      assert.equal(result.code, 0, `Process exited with code ${result.code}: ${result.stderr}`);
      assert.equal(result.stderr, '', 'stderr should be empty');

      // Assert password is never echoed to stdout or stderr
      assert.ok(!result.stdout.includes(password), 'stdout must not contain the password');
      assert.ok(!result.stderr.includes(password), 'stderr must not contain the password');

      // Assert exactly one stdout line
      const lines = result.stdout.trim().split('\n');
      assert.equal(lines.length, 1, 'Expected exactly one stdout line');

      // Parse ADMIN_PASSWORD_HASH=scrypt$16384$8$1$<salt-b64>$<hash-b64>
      const match = lines[0].match(
        /^ADMIN_PASSWORD_HASH=scrypt\$16384\$8\$1\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/
      );
      assert.ok(match, `Output does not match expected scrypt shape: ${lines[0]}`);

      const [, saltB64, hashB64] = match;
      const salt = Buffer.from(saltB64, 'base64');
      const hash = Buffer.from(hashB64, 'base64');

      assert.equal(salt.length, 16, 'Salt should decode to 16 bytes');
      assert.equal(hash.length, 64, 'Hash should decode to 64 bytes');

      // Re-derive with crypto.scryptSync and assert equality
      const rederived = crypto.scryptSync(password, salt, 64, {
        N: 16384,
        r: 8,
        p: 1,
      });

      assert.deepEqual(rederived, hash, 'Rederived hash must equal the printed hash');
      assert.equal(rederived.toString('base64'), hashB64);
    });

    test('strips exactly one trailing CRLF (\\r\\n)', async () => {
      const password = 'password-with-crlf';
      const result = await runScript(['--hash'], `${password}\r\n`);

      assert.equal(result.code, 0);
      assert.ok(!result.stdout.includes(password));

      const match = result.stdout.trim().match(
        /^ADMIN_PASSWORD_HASH=scrypt\$16384\$8\$1\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/
      );
      assert.ok(match);

      const salt = Buffer.from(match[1], 'base64');
      const hash = Buffer.from(match[2], 'base64');
      const rederived = crypto.scryptSync(password, salt, 64, {
        N: 16384,
        r: 8,
        p: 1,
      });
      assert.deepEqual(rederived, hash);
    });

    test('handles password without trailing newline', async () => {
      const password = 'password-without-newline';
      const result = await runScript(['--hash'], password);

      assert.equal(result.code, 0);
      assert.ok(!result.stdout.includes(password));

      const match = result.stdout.trim().match(
        /^ADMIN_PASSWORD_HASH=scrypt\$16384\$8\$1\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/
      );
      assert.ok(match);

      const salt = Buffer.from(match[1], 'base64');
      const hash = Buffer.from(match[2], 'base64');
      const rederived = crypto.scryptSync(password, salt, 64, {
        N: 16384,
        r: 8,
        p: 1,
      });
      assert.deepEqual(rederived, hash);
    });

    test('rejects empty stdin with exit code 2 and clear error', async () => {
      const result = await runScript(['--hash'], '');
      assert.notEqual(result.code, 0, 'Empty stdin should exit non-zero');
      assert.equal(result.code, 2, 'Expected exit code 2 for empty password');
      assert.equal(result.stdout, '', 'stdout should be empty on failure');
      assert.match(result.stderr, /empty/i, 'stderr should clearly explain the password cannot be empty');
    });

    test('rejects stdin containing only a single newline with exit code 2', async () => {
      const result = await runScript(['--hash'], '\n');
      assert.notEqual(result.code, 0);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /empty/i);
    });

    test('rejects stdin containing only \\r\\n with exit code 2', async () => {
      const result = await runScript(['--hash'], '\r\n');
      assert.notEqual(result.code, 0);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /empty/i);
    });
  });

  describe('--key', () => {
    test('generates valid 32-byte base64 encryption key', async () => {
      const result = await runScript(['--key']);

      assert.equal(result.code, 0, `Process exited with code ${result.code}: ${result.stderr}`);
      assert.equal(result.stderr, '', 'stderr should be empty');

      const lines = result.stdout.trim().split('\n');
      assert.equal(lines.length, 1, 'Expected exactly one stdout line');

      const match = lines[0].match(/^ENCRYPTION_KEY=([A-Za-z0-9+/=]+)$/);
      assert.ok(match, `Output does not match expected ENCRYPTION_KEY shape: ${lines[0]}`);

      const keyBytes = Buffer.from(match[1], 'base64');
      assert.equal(keyBytes.length, 32, 'Encryption key must decode to exactly 32 bytes');
    });

    test('generates different random keys on repeated invocations', async () => {
      const res1 = await runScript(['--key']);
      const res2 = await runScript(['--key']);

      assert.equal(res1.code, 0);
      assert.equal(res2.code, 0);
      assert.notEqual(res1.stdout.trim(), res2.stdout.trim(), 'Generated keys should be distinct');
    });
  });

  describe('CLI arguments and usage', () => {
    test('exits 1 with usage message when no mode specified', async () => {
      const result = await runScript([]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /usage:/i);
    });

    test('exits 1 with usage message when both --hash and --key specified', async () => {
      const result = await runScript(['--hash', '--key']);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /usage:/i);
    });

    test('exits 1 with usage message on unrecognized flag', async () => {
      const result = await runScript(['--unrecognized']);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /usage:/i);
    });

    test('exits 1 with usage message when extra arguments are provided', async () => {
      const result = await runScript(['--key', 'extra-arg']);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /usage:/i);
    });
  });
});
