#!/usr/bin/env node
/**
 * scripts/healthcheck.mjs
 *
 * Dependency-free Docker healthcheck.
 * Fetches http://127.0.0.1:${PORT:-4321}/healthz with a 5s timeout.
 * Exits 0 only when status is 200 and JSON status is 'ok'.
 * Never prints secrets.
 */

const port = process.env.PORT || '4321';
const url = `http://127.0.0.1:${port}/healthz`;

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (res.status !== 200) {
    console.error(`Healthcheck failed: HTTP status ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  if (data?.status === 'ok') {
    process.exit(0);
  } else {
    console.error(`Healthcheck failed: status is '${data?.status}'`);
    process.exit(1);
  }
} catch (err) {
  console.error(`Healthcheck failed: ${err.message || 'connection error'}`);
  process.exit(1);
}
