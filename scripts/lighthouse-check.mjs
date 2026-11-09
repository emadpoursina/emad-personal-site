#!/usr/bin/env node
/**
 * scripts/lighthouse-check.mjs
 *
 * Pinned mobile Lighthouse audit and LCP gate (T038, FR-042/FR-044).
 * Implements research D6:
 *  - Discovers chrome-headless-shell or installs Chromium via Playwright
 *  - Resolves browser path by glob
 *  - Starts built standalone server on an ephemeral port
 *  - Executes Lighthouse 11.7.1 three times per page (/, /about, /case-studies/rousta-tv)
 *  - Gates on median Performance >= 95, Accessibility = 100, LCP < 2000 ms per page
 *  - Supports --self-test to verify gate logic without launching a browser
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'server', 'entry.mjs');
const EVIDENCE_DIR = path.join(ROOT, '.evidence');

export const PAGES = [
  { name: 'home', path: '/' },
  { name: 'about', path: '/about' },
  { name: 'ask', path: '/ask' },
  { name: 'rousta-tv', path: '/case-studies/rousta-tv' },
];

/**
 * Resolves chrome-headless-shell under PLAYWRIGHT_BROWSERS_PATH by glob:
 * chromium_headless_shell-* / chrome-headless-shell-linux-* / chrome-headless-shell
 *
 * @param {string} browsersPath
 * @returns {string|null}
 */
export function resolveChromeHeadlessShell(browsersPath) {
  if (!fs.existsSync(browsersPath)) {
    return null;
  }

  const rootEntries = fs.readdirSync(browsersPath, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-')) {
      const dir1 = path.join(browsersPath, entry.name);
      const subEntries = fs.readdirSync(dir1, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isDirectory() && sub.name.startsWith('chrome-headless-shell-linux')) {
          const candidate = path.join(dir1, sub.name, 'chrome-headless-shell');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    }
  }

  // Fallback: search any subdirectory under chromium_headless_shell-*
  for (const entry of rootEntries) {
    if (entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-')) {
      const dir1 = path.join(browsersPath, entry.name);
      const subEntries = fs.readdirSync(dir1, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isDirectory()) {
          const candidate = path.join(dir1, sub.name, 'chrome-headless-shell');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves the Playwright browsers path to use.
 * Checks env PLAYWRIGHT_BROWSERS_PATH first if it contains the browser or is writable,
 * otherwise falls back to $HOME/.cache/ms-playwright-p1.
 *
 * @returns {string}
 */
export function getBrowsersPath() {
  const defaultPath = path.join(os.homedir(), '.cache', 'ms-playwright-p1');
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;

  if (envPath && resolveChromeHeadlessShell(envPath)) {
    return envPath;
  }
  if (resolveChromeHeadlessShell(defaultPath)) {
    return defaultPath;
  }
  if (envPath) {
    try {
      fs.accessSync(envPath, fs.constants.W_OK);
      return envPath;
    } catch {
      // not writable, fall back to defaultPath
    }
  }
  return defaultPath;
}

/**
 * Ensures chrome-headless-shell is installed; runs Playwright install only if missing.
 *
 * @param {string} browsersPath
 * @param {string} npmCacheDir
 * @returns {string}
 */
export function ensureChromeHeadlessShell(browsersPath, npmCacheDir) {
  let shellPath = resolveChromeHeadlessShell(browsersPath);
  if (shellPath) {
    return shellPath;
  }

  console.log(`Browser missing. Installing chromium to ${browsersPath}...`);
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    npm_config_cache: npmCacheDir,
  };

  execSync('npx --yes playwright@1.65.0 install chromium', {
    env,
    stdio: 'inherit',
    cwd: ROOT,
  });

  shellPath = resolveChromeHeadlessShell(browsersPath);
  if (!shellPath) {
    throw new Error(
      `chrome-headless-shell was not found under ${browsersPath} after running playwright install`
    );
  }
  return shellPath;
}

/**
 * Computes median metrics for an array of runs.
 *
 * @param {Array<{ perf?: number, performance?: number, a11y?: number, accessibility?: number, lcp?: number, lcp_ms?: number }>} runs
 * @returns {{ performance: number, accessibility: number, lcp_ms: number, perf: number, a11y: number, lcp: number }}
 */
export function computeMedians(runs) {
  if (!runs || runs.length === 0) {
    throw new Error('No runs to compute medians from');
  }

  const perfs = runs.map((r) => r.perf ?? r.performance ?? 0).sort((a, b) => a - b);
  const a11ys = runs.map((r) => r.a11y ?? r.accessibility ?? 0).sort((a, b) => a - b);
  const lcps = runs.map((r) => r.lcp ?? r.lcp_ms ?? 0).sort((a, b) => a - b);

  const mid = Math.floor(runs.length / 2);
  const medianPerf = perfs[mid];
  const medianA11y = a11ys[mid];
  const medianLcp = lcps[mid];

  return {
    performance: medianPerf,
    accessibility: medianA11y,
    lcp_ms: medianLcp,
    perf: medianPerf,
    a11y: medianA11y,
    lcp: medianLcp,
  };
}

/**
 * Evaluates the gate criteria against run results.
 * Gate:
 *  - median Performance >= 95 (fail if < 95)
 *  - median Accessibility = 100 (fail if < 100)
 *  - median LCP < 2000 ms (fail if >= 2000 ms)
 *
 * @param {Array<{ perf?: number, performance?: number, a11y?: number, accessibility?: number, lcp?: number, lcp_ms?: number }>} runs
 * @returns {{ pass: boolean, medians: { performance: number, accessibility: number, lcp_ms: number, perf: number, a11y: number, lcp: number }, failures: string[] }}
 */
export function evaluateGate(runs) {
  const medians = computeMedians(runs);
  const failures = [];

  if (medians.performance < 95) {
    failures.push(`Performance ${medians.performance} < 95`);
  }
  if (medians.accessibility < 100) {
    failures.push(`Accessibility ${medians.accessibility} < 100`);
  }
  if (medians.lcp_ms >= 2000) {
    failures.push(`LCP ${medians.lcp_ms} ms >= 2000 ms`);
  }

  return {
    pass: failures.length === 0,
    medians,
    failures,
  };
}

/**
 * Runs self-test asserting gate behavior on synthetic failing and passing inputs.
 */
export function runSelfTest() {
  const failingSet = [
    { perf: 90, a11y: 100, lcp: 1500 },
    { perf: 91, a11y: 100, lcp: 1500 },
    { perf: 92, a11y: 100, lcp: 1500 },
  ];
  const failRes = evaluateGate(failingSet);
  if (failRes.pass) {
    console.error('Self-test error: gate accepted failing performance set');
    process.exit(1);
  }

  const failingA11y = [
    { perf: 99, a11y: 95, lcp: 1200 },
    { perf: 99, a11y: 98, lcp: 1300 },
    { perf: 99, a11y: 99, lcp: 1400 },
  ];
  if (evaluateGate(failingA11y).pass) {
    console.error('Self-test error: gate accepted failing accessibility set');
    process.exit(1);
  }

  const failingLcp = [
    { perf: 98, a11y: 100, lcp: 2000 },
    { perf: 98, a11y: 100, lcp: 2100 },
    { perf: 98, a11y: 100, lcp: 2200 },
  ];
  if (evaluateGate(failingLcp).pass) {
    console.error('Self-test error: gate accepted failing LCP set');
    process.exit(1);
  }

  const passingSet = [
    { perf: 96, a11y: 100, lcp: 1500 },
    { perf: 97, a11y: 100, lcp: 1600 },
    { perf: 95, a11y: 100, lcp: 1700 },
  ];
  const passRes = evaluateGate(passingSet);
  if (!passRes.pass) {
    console.error(
      `Self-test error: gate rejected passing set: ${passRes.failures.join(', ')}`
    );
    process.exit(1);
  }

  console.log('gate self-test ok');
  process.exit(0);
}

/**
 * Allocates an ephemeral free port.
 *
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

/**
 * Polls GET /healthz until 200 or timeout.
 *
 * @param {number} port
 * @param {number} timeoutMs
 */
async function waitForHealthz(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) {
        return;
      }
    } catch {
      // Server warming up
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for GET http://127.0.0.1:${port}/healthz`);
}

/**
 * Resolves the Lighthouse CLI version.
 *
 * @param {string} npmCacheDir
 * @returns {string}
 */
function getLighthouseVersion(npmCacheDir) {
  try {
    const output = execSync('npx --yes lighthouse@11.7.1 --version', {
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^\d+\.\d+\.\d+/.test(line)) {
        return line;
      }
    }
  } catch {}
  return '11.7.1';
}

/**
 * Main execution.
 */
async function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  if (!fs.existsSync(ENTRY)) {
    console.error(
      `Error: Built server entry not found at ${ENTRY}. Run "npm run build" first.`
    );
    process.exit(1);
  }

  const browsersPath = getBrowsersPath();

  const npmCacheDir =
    process.env.npm_config_cache || path.join(os.tmpdir(), 'npm-cache');

  const chromePath = ensureChromeHeadlessShell(browsersPath, npmCacheDir);
  const lhVersion = getLighthouseVersion(npmCacheDir);

  console.log(`browser: ${chromePath}`);
  console.log(`lighthouse: ${lhVersion}`);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const port = await getFreePort();
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighthouse-data-'));

  let serverProc = null;

  function cleanup() {
    if (serverProc && !serverProc.killed) {
      try {
        serverProc.kill('SIGTERM');
      } catch {}
    }
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    }
  }

  const onSignal = () => {
    cleanup();
    process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    serverProc = spawn(
      process.execPath,
      ['--experimental-sqlite', 'dist/server/entry.mjs'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          HOST: '127.0.0.1',
          DATA_DIR: tmpDataDir,
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let serverStderr = '';
    serverProc.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString();
    });

    serverProc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        // Logged if healthz times out
      }
    });

    try {
      await waitForHealthz(port, 30000);
    } catch (err) {
      if (serverStderr) {
        console.error(`Server stderr: ${serverStderr}`);
      }
      throw err;
    }

    const pageFailures = [];

    for (const page of PAGES) {
      const url = `http://127.0.0.1:${port}${page.path}`;
      const runs = [];

      for (let i = 1; i <= 3; i++) {
        const outputPath = path.join(
          EVIDENCE_DIR,
          `lighthouse-${page.name}-run${i}.json`
        );
        const relOutputPath = path.relative(ROOT, outputPath);

        const lhArgs = [
          '--yes',
          'lighthouse@11.7.1',
          url,
          '--only-categories=performance,accessibility',
          '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
          '--output=json',
          `--output-path=${relOutputPath}`,
          '--form-factor=mobile',
          '--throttling-method=simulate',
          '--quiet',
        ];

        execFileSync('npx', lhArgs, {
          cwd: ROOT,
          env: {
            ...process.env,
            CHROME_PATH: chromePath,
            npm_config_cache: npmCacheDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (!fs.existsSync(outputPath)) {
          throw new Error(
            `Lighthouse run ${i} for ${page.name} did not produce expected output at ${outputPath}`
          );
        }

        const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        const perf = Math.round(
          (report.categories?.performance?.score ?? 0) * 100
        );
        const a11y = Math.round(
          (report.categories?.accessibility?.score ?? 0) * 100
        );
        const lcp = Math.round(
          report.audits?.['largest-contentful-paint']?.numericValue ?? 0
        );

        runs.push({
          run: i,
          perf,
          a11y,
          lcp,
          performance: perf,
          accessibility: a11y,
          lcp_ms: lcp,
        });

        console.log(
          `page ${page.name} (${page.path}) run ${i}: performance=${perf} accessibility=${a11y} lcp_ms=${lcp}`
        );
      }

      const gate = evaluateGate(runs);
      console.log(
        `page ${page.name} median: performance=${gate.medians.perf} accessibility=${gate.medians.a11y} lcp_ms=${gate.medians.lcp}`
      );

      if (!gate.pass) {
        pageFailures.push({ page, failures: gate.failures });
      }
    }

    if (pageFailures.length > 0) {
      console.error('lighthouse gate failed:');
      for (const { page, failures } of pageFailures) {
        console.error(
          `  page ${page.name} (${page.path}): ${failures.join('; ')}`
        );
      }
      // Set the exit code and return instead of process.exit() so the finally
      // block runs: process.exit() would skip cleanup() and leak the server.
      process.exitCode = 1;
      return;
    }

    console.log(`lighthouse gate ok (${PAGES.length} pages)`);
    process.exitCode = 0;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
