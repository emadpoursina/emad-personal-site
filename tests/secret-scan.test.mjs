/**
 * tests/secret-scan.test.mjs
 *
 * Repository secret-hygiene test suite (task T038).
 * Proves:
 * - Scanned source trees (src/, scripts/, content/, and root .env.example) contain no leaked credentials:
 *   - zero private-key blocks
 *   - zero long provider-style tokens (sk-...)
 *   - zero real AES-256-GCM secret envelopes (v1:...)
 * - Failure messages name offending paths and only redacted tokens (first 8 chars + '...').
 * - Binary files containing NUL bytes are skipped.
 * - .env policy is strictly enforced:
 *   - .env does not exist at the repository root
 *   - .gitignore contains a line ignoring .env and a line negating !.env.example
 *   - no file named .env exists anywhere under src/, scripts/, content/
 * - .env.example documentation is complete and empty-valued:
 *   - every process.env variable read by src/lib/env.mjs appears exactly once with an empty value
 *   - all eight Phase 3 variables appear with empty values
 * - The test file passes its own rules when scanned.
 *
 * Run with: node --experimental-sqlite --test tests/secret-scan.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Needles built from concatenated fragments so the test file itself passes when scanned.
const PRIVATE_KEY_PATTERN = new RegExp(
  '-----' + 'BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY' + '-----'
);
const PROVIDER_TOKEN_PATTERN = new RegExp('\\b' + 's' + 'k-[A-Za-z0-9_-]{20,}');
const AES_ENVELOPE_PATTERN = new RegExp(
  'v' + '1:[A-Za-z0-9+/=]{12,}:[A-Za-z0-9+/=]{12,}:[A-Za-z0-9+/=]{12,}'
);

const PHASE_3_ENV_NAMES = [
  'ADMIN_PASSWORD_HASH',
  'ENCRYPTION_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_API_KEY',
  'ASK_DAILY_CAP',
  'ASK_RATE_LIMIT_PER_HOUR',
  'AI_TIMEOUT_MS',
];

/**
 * Recursively collects all regular file paths in a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function collectRegularFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRegularFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Returns a deterministically sorted list of all files to scan.
 * Scans src/, scripts/, content/ recursively, plus .env.example.
 * @param {string} rootDir
 * @returns {string[]}
 */
function getScannedFiles(rootDir) {
  const dirs = ['src', 'scripts', 'content'].map((d) => path.join(rootDir, d));
  const files = dirs.flatMap(collectRegularFiles);
  const envExample = path.join(rootDir, '.env.example');
  if (fs.existsSync(envExample)) {
    files.push(envExample);
  }
  return files.sort();
}

/**
 * Reads a file as UTF-8 string; returns null if it contains a NUL byte (binary).
 * @param {string} filePath
 * @returns {string | null}
 */
function readUtf8TextFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    return null;
  }
  return buffer.toString('utf8');
}

/**
 * Redacts a detected token: returns first 8 characters plus '...'.
 * Never returns the full token.
 * @param {string} token
 * @returns {string}
 */
function redactToken(token) {
  if (typeof token !== 'string') return '...';
  return token.slice(0, 8) + '...';
}

/**
 * Recursively finds files matching targetName.
 * @param {string} dir
 * @param {string} targetName
 * @returns {string[]}
 */
function findFilesByName(dir, targetName) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === targetName) {
      matches.push(fullPath);
    }
    if (entry.isDirectory()) {
      matches.push(...findFilesByName(fullPath, targetName));
    }
  }
  return matches;
}

describe('secret-hygiene test suite (T038)', () => {
  describe('source file discovery and binary filtering', () => {
    test('deterministically finds regular files in src/, scripts/, content/ and .env.example', () => {
      const files = getScannedFiles(ROOT_DIR);
      assert.ok(files.length > 0, 'Must find regular files to scan');

      // Verify list is deterministically sorted
      const sortedCopy = [...files].sort();
      assert.deepEqual(files, sortedCopy, 'File list must be sorted deterministically');

      // Verify every path exists and is a regular file
      for (const file of files) {
        assert.ok(fs.existsSync(file), `Scanned file must exist: ${file}`);
        assert.ok(fs.statSync(file).isFile(), `Scanned path must be a file: ${file}`);
      }

      // Verify .env.example is included in the scan list
      const envExamplePath = path.join(ROOT_DIR, '.env.example');
      assert.ok(
        files.includes(envExamplePath),
        '.env.example must be included in the scanned file list'
      );
    });

    test('skips files containing NUL bytes (binary detection)', () => {
      const binaryBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
      assert.ok(binaryBuffer.includes(0));

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-bin-'));
      const tempBinaryFile = path.join(tempDir, 'sample.bin');
      try {
        fs.writeFileSync(tempBinaryFile, binaryBuffer);
        const result = readUtf8TextFile(tempBinaryFile);
        assert.equal(result, null, 'Files with NUL bytes must return null (skipped as binary)');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('credential pattern zero-match assertions', () => {
    test('zero matches for private-key blocks across all scanned files', () => {
      const files = getScannedFiles(ROOT_DIR);
      for (const file of files) {
        const content = readUtf8TextFile(file);
        if (content === null) continue;

        const match = content.match(PRIVATE_KEY_PATTERN);
        const relPath = path.relative(ROOT_DIR, file);
        assert.ok(
          !match,
          `Found private-key block in ${relPath}: ${match ? redactToken(match[0]) : ''}`
        );
      }
    });

    test('zero matches for long provider-style tokens across all scanned files', () => {
      const files = getScannedFiles(ROOT_DIR);
      for (const file of files) {
        const content = readUtf8TextFile(file);
        if (content === null) continue;

        const match = content.match(PROVIDER_TOKEN_PATTERN);
        const relPath = path.relative(ROOT_DIR, file);
        assert.ok(
          !match,
          `Found provider-style token in ${relPath}: ${match ? redactToken(match[0]) : ''}`
        );
      }
    });

    test('zero matches for real AES envelopes across all scanned files (secrets.mjs placeholders exempt)', () => {
      const files = getScannedFiles(ROOT_DIR);
      for (const file of files) {
        const content = readUtf8TextFile(file);
        if (content === null) continue;

        const match = content.match(AES_ENVELOPE_PATTERN);
        const relPath = path.relative(ROOT_DIR, file);
        assert.ok(
          !match,
          `Found real AES envelope in ${relPath}: ${match ? redactToken(match[0]) : ''}`
        );
      }

      // Explicitly prove src/lib/secrets.mjs was scanned and contained no match
      const secretsMjsPath = path.join(ROOT_DIR, 'src', 'lib', 'secrets.mjs');
      assert.ok(files.includes(secretsMjsPath), 'src/lib/secrets.mjs must be among scanned files');
      const secretsContent = readUtf8TextFile(secretsMjsPath);
      assert.ok(secretsContent !== null, 'src/lib/secrets.mjs must be valid UTF-8');
      assert.equal(
        AES_ENVELOPE_PATTERN.test(secretsContent),
        false,
        'src/lib/secrets.mjs template placeholders must not match AES envelope pattern'
      );
    });

    test('redactToken helper produces exactly first 8 characters plus ellipsis and never full token', () => {
      const sample = 'secret-key-sample-material-here-1234567890';
      const redacted = redactToken(sample);
      assert.equal(redacted, 'secret-k...');
      assert.equal(redacted.length, 11);
      assert.ok(!redacted.includes('material'));
      assert.ok(!redacted.includes('1234567890'));
    });
  });

  describe('.env policy assertions', () => {
    test('.env does not exist at repository root', () => {
      const rootDotEnv = path.join(ROOT_DIR, '.env');
      assert.equal(
        fs.existsSync(rootDotEnv),
        false,
        `.env must not exist at repository root: ${rootDotEnv}`
      );
    });

    test('.gitignore has a line ignoring .env and a line negating !.env.example', () => {
      const gitignorePath = path.join(ROOT_DIR, '.gitignore');
      assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist');

      const lines = fs
        .readFileSync(gitignorePath, 'utf8')
        .split('\n')
        .map((l) => l.trim());

      assert.ok(
        lines.includes('.env'),
        '.gitignore must have a line ignoring .env'
      );
      assert.ok(
        lines.includes('!.env.example'),
        '.gitignore must have a line negating !.env.example'
      );
    });

    test('no file named .env exists anywhere under src/, scripts/, content/', () => {
      const scanDirs = ['src', 'scripts', 'content'];
      const dotEnvPaths = scanDirs
        .flatMap((dir) => findFilesByName(path.join(ROOT_DIR, dir), '.env'))
        .map((p) => path.relative(ROOT_DIR, p));

      assert.deepEqual(
        dotEnvPaths,
        [],
        `No file named .env may exist under src/, scripts/, content/; found: ${dotEnvPaths.join(', ')}`
      );
    });
  });

  describe('.env.example documentation assertions', () => {
    test('every env name read by src/lib/env.mjs appears in .env.example exactly once with empty value', () => {
      const envMjsPath = path.join(ROOT_DIR, 'src', 'lib', 'env.mjs');
      assert.ok(fs.existsSync(envMjsPath), 'src/lib/env.mjs must exist');
      const envMjsContent = fs.readFileSync(envMjsPath, 'utf8');

      const matches = [...envMjsContent.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
      const dedupedNames = [...new Set(matches)].sort();
      assert.ok(dedupedNames.length > 0, 'Must extract env names from src/lib/env.mjs');

      const envExamplePath = path.join(ROOT_DIR, '.env.example');
      assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');
      const envExampleLines = fs
        .readFileSync(envExamplePath, 'utf8')
        .split('\n')
        .map((line) => line.trim());

      for (const name of dedupedNames) {
        const pattern = new RegExp(`^${name}=$`);
        const matchingLines = envExampleLines.filter((line) => pattern.test(line));
        assert.equal(
          matchingLines.length,
          1,
          `Environment variable ${name} must appear in .env.example exactly once with an empty value (line matching ^${name}=$, found ${matchingLines.length})`
        );
      }
    });

    test('all eight Phase 3 environment variables are documented in .env.example with empty values', () => {
      const envExamplePath = path.join(ROOT_DIR, '.env.example');
      const envExampleLines = fs
        .readFileSync(envExamplePath, 'utf8')
        .split('\n')
        .map((line) => line.trim());

      for (const name of PHASE_3_ENV_NAMES) {
        const pattern = new RegExp(`^${name}=$`);
        const matchingLines = envExampleLines.filter((line) => pattern.test(line));
        assert.equal(
          matchingLines.length,
          1,
          `Phase 3 variable ${name} must appear in .env.example exactly once with an empty value (found ${matchingLines.length})`
        );
      }
    });

    test('every variable definition in .env.example has an empty value', () => {
      const envExamplePath = path.join(ROOT_DIR, '.env.example');
      const envExampleLines = fs
        .readFileSync(envExamplePath, 'utf8')
        .split('\n')
        .map((line) => line.trim());

      const varLines = envExampleLines.filter((line) => line.length > 0 && !line.startsWith('#'));
      for (const line of varLines) {
        assert.match(
          line,
          /^[A-Z0-9_]+=\s*$/,
          `Variable definition in .env.example must have an empty value: "${line}"`
        );
      }
    });
  });

  describe('secret-scan test self-check', () => {
    test('tests/secret-scan.test.mjs passes its own credential pattern checks', () => {
      const selfPath = path.join(ROOT_DIR, 'tests', 'secret-scan.test.mjs');
      assert.ok(fs.existsSync(selfPath), 'Self test file must exist');

      const content = readUtf8TextFile(selfPath);
      assert.ok(content !== null, 'Self test file must not be binary');

      assert.ok(
        !PRIVATE_KEY_PATTERN.test(content),
        'tests/secret-scan.test.mjs must not match private-key pattern'
      );
      assert.ok(
        !PROVIDER_TOKEN_PATTERN.test(content),
        'tests/secret-scan.test.mjs must not match provider-token pattern'
      );
      assert.ok(
        !AES_ENVELOPE_PATTERN.test(content),
        'tests/secret-scan.test.mjs must not match AES envelope pattern'
      );
    });
  });
});
