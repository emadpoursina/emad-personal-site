#!/usr/bin/env node
/**
 * scripts/verify-container.mjs
 *
 * Real end-to-end container verification script.
 * Exercises the Docker Compose setup, healthcheck, named volume persistence,
 * disabled SMTP fallback, and image secret hygiene.
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const ENV_PATH = path.join(ROOT, '.env');
const COMPOSE_PROJECT = 'emad-site-verify';
const SMTP_PASS_VALUE = 'sink-secret-should-not-leak';

function getGatewayIp() {
  try {
    const route = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of route.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === '00000000' && parts[2]) {
        const hex = parts[2];
        const b1 = parseInt(hex.substring(6, 8), 16);
        const b2 = parseInt(hex.substring(4, 6), 16);
        const b3 = parseInt(hex.substring(2, 4), 16);
        const b4 = parseInt(hex.substring(0, 2), 16);
        return `${b1}.${b2}.${b3}.${b4}`;
      }
    }
  } catch {}
  return '127.0.0.1';
}

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

function pollTcp(port, host = '127.0.0.1', timeoutMs = 5000) {
  const start = Date.now();
  return new Promise(async (resolve) => {
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise((r) => {
        const sock = net.createConnection({ port, host }, () => {
          sock.end();
          r(true);
        });
        sock.on('error', () => {
          sock.destroy();
          r(false);
        });
      });
      if (ok) return resolve(true);
      await new Promise((r) => setTimeout(r, 200));
    }
    resolve(false);
  });
}

function writeEnvFile(values) {
  const example = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const lines = example.split('\n');
  const outLines = lines.map((line) => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      return `${match[1]}=${values[match[1]]}`;
    }
    return line;
  });
  fs.writeFileSync(ENV_PATH, outLines.join('\n'), 'utf8');
}

async function pollHealthz(url, timeoutMs = 60000) {
  const startTime = Date.now();
  let lastErr = null;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) {
        const json = await res.json().catch(() => null);
        if (json?.status === 'ok') {
          return { status: 200, json };
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`healthz polling timed out after ${timeoutMs}ms (${lastErr?.message || 'unknown error'})`);
}

async function run() {
  let sinkProc = null;
  let fwdContainerName = null;
  let localProxy = null;

  // Track verified outcomes
  let healthzStatus = 0;
  let rowsBefore = 0;
  let rowsAfter = 0;
  let disabledStatus = 0;
  let warningPresent = false;
  let secretsNone = false;
  let aboutStatus = 0;
  let caseStudiesStatus = 0;
  let llmsStatus = 0;
  let resumeStatus = 0;
  let apiProfileStatus = 0;
  let voicedashStatus = 0;
  let routesPassed = 0;

  let sitePort = await getFreePort();
  let sinkPort = await getFreePort();
  while (sinkPort === sitePort) {
    sinkPort = await getFreePort();
  }

  const env = {
    ...process.env,
    DOCKER_CONFIG: '/opt/data/home/.docker',
    SITE_PORT: String(sitePort),
  };

  const gateway = getGatewayIp();

  try {
    // 1. Local proxy for 127.0.0.1:<sitePort> if running in a containerized environment
    if (gateway !== '127.0.0.1') {
      localProxy = net.createServer((client) => {
        const dest = net.createConnection({ host: gateway, port: sitePort });
        client.pipe(dest).pipe(client);
        dest.on('error', () => client.destroy());
        client.on('error', () => dest.destroy());
      });
      localProxy.on('error', () => {});
      await new Promise((resolve) => {
        localProxy.listen(sitePort, '127.0.0.1', () => resolve());
      });
    }

    // 2. Start smtp-sink.mjs
    sinkProc = spawn('node', ['scripts/smtp-sink.mjs', '--port', String(sinkPort)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sinkReady = await pollTcp(sinkPort, '127.0.0.1', 5000);
    if (!sinkReady) {
      throw new Error(`smtp-sink failed to listen on port ${sinkPort}`);
    }

    // Ensure host.docker.internal can reach the sink from docker containers
    let canReachHostInternal = false;
    try {
      execSync(`docker run --rm --add-host=host.docker.internal:host-gateway alpine nc -z -w 1 host.docker.internal ${sinkPort}`, {
        stdio: 'ignore',
        timeout: 4000,
      });
      canReachHostInternal = true;
    } catch {}

    if (!canReachHostInternal) {
      const myHostname = os.hostname();
      let networkName = 'personalagent_default';
      try {
        const netOut = execSync(`docker inspect ${myHostname} --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}'`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (netOut) networkName = netOut;
      } catch {}

      fwdContainerName = `emad-smtp-fwd-${sinkPort}-${Date.now()}`;
      execSync(
        `docker run -d --name ${fwdContainerName} --network ${networkName} -p ${sinkPort}:${sinkPort} node:22-bookworm-slim node -e "const net=require('net');const srv=net.createServer(c=>{const s=net.createConnection({host:'${myHostname}',port:${sinkPort}});c.pipe(s).pipe(c);s.on('error',()=>c.destroy());c.on('error',()=>s.destroy());});srv.listen(${sinkPort},'0.0.0.0');"`,
        { stdio: 'ignore' }
      );

      let fwdReady = false;
      for (let i = 0; i < 10; i++) {
        try {
          execSync(`docker run --rm --add-host=host.docker.internal:host-gateway alpine nc -z -w 1 host.docker.internal ${sinkPort}`, {
            stdio: 'ignore',
            timeout: 2000,
          });
          fwdReady = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!fwdReady) {
        throw new Error(`Failed to establish reachability to host.docker.internal:${sinkPort}`);
      }
    }

    // 3. Write throwaway .env
    writeEnvFile({
      PORT: '4321',
      HOST: '0.0.0.0',
      DATA_DIR: '/app/data',
      CONTACT_TO: 'emad.poursina.work@gmail.com',
      CONTACT_RATE_LIMIT_PER_HOUR: '5',
      TRUST_PROXY: '0',
      SMTP_HOST: 'host.docker.internal',
      SMTP_PORT: String(sinkPort),
      SMTP_SECURE: 'false',
      SMTP_USER: 'test',
      SMTP_PASS: SMTP_PASS_VALUE,
      SMTP_FROM: 'Emad Poursina <emad.poursina.work@gmail.com>',
    });

    // 4. docker compose build then docker compose up -d
    execSync(`docker compose -p ${COMPOSE_PROJECT} build`, { cwd: ROOT, env, stdio: 'ignore' });
    execSync(`docker compose -p ${COMPOSE_PROJECT} up -d`, { cwd: ROOT, env, stdio: 'ignore' });

    const health1 = await pollHealthz(`http://127.0.0.1:${sitePort}/healthz`, 60000);
    healthzStatus = health1.status;
    if (healthzStatus !== 200) {
      throw new Error(`Check failed: healthz returned ${healthzStatus}`);
    }

    // 4b. Phase 2 route probes
    async function probe(path, options = {}) {
      let res;
      try {
        res = await fetch(`http://127.0.0.1:${sitePort}${path}`);
      } catch (err) {
        throw new Error(
          `Check failed for ${path}: expected status ${options.expectedStatus ?? 200}, observed network error: ${err.message}`
        );
      }
      const ct = res.headers.get('content-type') || '';
      const body = await res.text();
      const expectedStatus = options.expectedStatus ?? 200;
      if (res.status !== expectedStatus) {
        throw new Error(
          `Check failed for ${path}: expected status ${expectedStatus}, observed ${res.status}`
        );
      }
      if (
        options.expectedContentTypePrefix &&
        !ct.toLowerCase().startsWith(options.expectedContentTypePrefix.toLowerCase())
      ) {
        throw new Error(
          `Check failed for ${path}: expected Content-Type starting with ${options.expectedContentTypePrefix}, observed '${ct}'`
        );
      }
      if (options.validateJson) {
        let json;
        try {
          json = JSON.parse(body);
        } catch (err) {
          throw new Error(
            `Check failed for ${path}: expected valid JSON body, observed parse error '${err.message}'`
          );
        }
        const validationErr = options.validateJson(json);
        if (validationErr) {
          throw new Error(`Check failed for ${path}: ${validationErr}`);
        }
      }
      return res.status;
    }

    aboutStatus = await probe('/about', { expectedStatus: 200, expectedContentTypePrefix: 'text/html' });
    routesPassed++;

    caseStudiesStatus = await probe('/case-studies', { expectedStatus: 200, expectedContentTypePrefix: 'text/html' });
    routesPassed++;

    llmsStatus = await probe('/llms.txt', { expectedStatus: 200, expectedContentTypePrefix: 'text/plain' });
    routesPassed++;

    resumeStatus = await probe('/resume.json', { expectedStatus: 200, expectedContentTypePrefix: 'application/json' });
    routesPassed++;

    apiProfileStatus = await probe('/api/profile', {
      expectedStatus: 200,
      expectedContentTypePrefix: 'application/json',
      validateJson: (json) => {
        if (!json?.basics?.name || typeof json.basics.name !== 'string' || json.basics.name.trim() === '') {
          return `expected non-empty basics.name, observed ${JSON.stringify(json?.basics?.name)}`;
        }
        return null;
      },
    });
    routesPassed++;

    voicedashStatus = await probe('/case-studies/voicedash', { expectedStatus: 404 });
    routesPassed++;

    // 5. POST one valid message to /api/contact -> 200; db-count -> 1
    const postRes1 = await fetch(`http://127.0.0.1:${sitePort}/api/contact`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Verification Alice',
        email: 'alice@example.com',
        message: 'Hello container verification message.',
      }),
    });

    if (postRes1.status !== 200) {
      throw new Error(`Check failed: contact POST returned HTTP ${postRes1.status}`);
    }

    const countBeforeOut = execSync(
      `docker compose -p ${COMPOSE_PROJECT} exec -T site node --experimental-sqlite scripts/db-count.mjs`,
      { cwd: ROOT, env, encoding: 'utf8' }
    ).trim();

    rowsBefore = parseInt(countBeforeOut, 10);
    if (rowsBefore !== 1) {
      throw new Error(`Check failed: rows_before expected 1, got ${rowsBefore} (raw: '${countBeforeOut}')`);
    }

    // 6. docker compose up -d --build, poll healthz, count again -> still 1
    execSync(`docker compose -p ${COMPOSE_PROJECT} up -d --build`, { cwd: ROOT, env, stdio: 'ignore' });
    const health2 = await pollHealthz(`http://127.0.0.1:${sitePort}/healthz`, 60000);
    if (health2.status !== 200) {
      throw new Error(`Check failed: healthz after rebuild returned ${health2.status}`);
    }

    const countAfterOut = execSync(
      `docker compose -p ${COMPOSE_PROJECT} exec -T site node --experimental-sqlite scripts/db-count.mjs`,
      { cwd: ROOT, env, encoding: 'utf8' }
    ).trim();

    rowsAfter = parseInt(countAfterOut, 10);
    if (rowsAfter !== 1) {
      throw new Error(`Check failed: rows_after_rebuild expected 1, got ${rowsAfter} (raw: '${countAfterOut}')`);
    }

    // 7. Rewrite .env with empty SMTP credentials and force-recreate
    writeEnvFile({
      PORT: '4321',
      HOST: '0.0.0.0',
      DATA_DIR: '/app/data',
      CONTACT_TO: 'emad.poursina.work@gmail.com',
      CONTACT_RATE_LIMIT_PER_HOUR: '5',
      TRUST_PROXY: '0',
      SMTP_HOST: '',
      SMTP_PORT: '',
      SMTP_SECURE: 'false',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_FROM: 'Emad Poursina <emad.poursina.work@gmail.com>',
    });

    execSync(`docker compose -p ${COMPOSE_PROJECT} up -d --force-recreate`, { cwd: ROOT, env, stdio: 'ignore' });
    await pollHealthz(`http://127.0.0.1:${sitePort}/healthz`, 60000);

    const postRes2 = await fetch(`http://127.0.0.1:${sitePort}/api/contact`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Verification Bob',
        email: 'bob@example.com',
        message: 'Testing disabled SMTP message.',
      }),
    });

    disabledStatus = postRes2.status;
    if (disabledStatus !== 503) {
      throw new Error(`Check failed: disabled path returned ${disabledStatus}, expected 503`);
    }

    const post2Body = await postRes2.text();
    if (!post2Body.includes('emad.poursina.work@gmail.com')) {
      throw new Error('Check failed: disabled response body did not contain direct email address');
    }

    const composeLogs = execSync(`docker compose -p ${COMPOSE_PROJECT} logs site`, { cwd: ROOT, env, encoding: 'utf8' });
    if (composeLogs.includes('Contact email delivery is disabled')) {
      warningPresent = true;
    } else {
      throw new Error('Check failed: docker compose logs site did not contain disabled warning');
    }

    // 8. Secret scan
    let imageId = '';
    try {
      imageId = execSync(`docker compose -p ${COMPOSE_PROJECT} images -q site`, { cwd: ROOT, env, encoding: 'utf8' }).trim();
    } catch {}
    if (!imageId) {
      imageId = `${COMPOSE_PROJECT}-site`;
    }

    const findOut = execSync(`docker run --rm ${imageId} sh -c 'find /app -name ".env*" -print'`, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    }).trim();

    if (findOut !== '') {
      throw new Error(`Check failed: secret scan found .env files in image: ${findOut}`);
    }

    const historyOut = execSync(`docker history --no-trunc ${imageId}`, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });

    if (historyOut.includes(SMTP_PASS_VALUE)) {
      throw new Error('Check failed: secret scan found SMTP_PASS in docker history');
    }

    secretsNone = true;

  } finally {
    // 9. Cleanup in finally
    try {
      execSync(`docker compose -p ${COMPOSE_PROJECT} down -v`, { cwd: ROOT, env, stdio: 'ignore' });
    } catch {}

    if (fwdContainerName) {
      try {
        execSync(`docker rm -f ${fwdContainerName}`, { cwd: ROOT, env, stdio: 'ignore' });
      } catch {}
    }

    if (localProxy) {
      try {
        localProxy.close();
      } catch {}
    }

    if (sinkProc) {
      try {
        sinkProc.kill('SIGTERM');
      } catch {}
    }

    if (fs.existsSync(ENV_PATH)) {
      try {
        fs.unlinkSync(ENV_PATH);
      } catch {}
    }
  }

  // 10. Summary line
  if (
    healthzStatus === 200 &&
    rowsBefore === 1 &&
    rowsAfter === 1 &&
    disabledStatus === 503 &&
    warningPresent &&
    secretsNone &&
    aboutStatus === 200 &&
    caseStudiesStatus === 200 &&
    llmsStatus === 200 &&
    resumeStatus === 200 &&
    apiProfileStatus === 200 &&
    voicedashStatus === 404 &&
    routesPassed === 6
  ) {
    console.log(
      `healthz=${healthzStatus} rows_before=${rowsBefore} rows_after_rebuild=${rowsAfter} ` +
      `disabled=${disabledStatus} warning=present secrets=none ` +
      `about=${aboutStatus} case_studies=${caseStudiesStatus} llms=${llmsStatus} ` +
      `resume=${resumeStatus} api_profile=${apiProfileStatus} voicedash=${voicedashStatus} routes=${routesPassed}/6`
    );
    process.exit(0);
  } else {
    console.error('One or more checks did not match expected values.');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
