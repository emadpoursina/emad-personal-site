# Quickstart: Phase 4 — General Cover Letter and Generator Path

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Contracts**: [cover-letter-api.md](./contracts/cover-letter-api.md), [generator-adapter.md](./contracts/generator-adapter.md), [http-routes.md](./contracts/http-routes.md)

Every scenario below is runnable on a clean checkout of the phase branch. Nothing here needs a real generator service, a real key, or a real AI provider.

## Prerequisites

- Node 22+ and npm (the container uses `node:22-bookworm-slim`; the host runs newer).
- Docker and Compose only for the container scenario (`HOME=/opt/data/home DOCKER_CONFIG=/opt/data/home/.docker docker compose …` on this host).
- No `.env` values are required; every secret below is a test value.

## 1. Build and tests

```bash
npm ci
npm run build     # prebuild now runs check-profile.mjs && check-cover-letter.mjs && build-cv && check-contrast
npm test          # includes the new cover-letter suites
```

Expected: `cover letter ok`, `profile ok`, a successful Astro build, and no failing `node:test` file.

## 2. The build gate fails on a banned phrase

```bash
cp content/cover-letter.json /tmp/cover-letter.json
# replace one paragraph with text containing "synergy"
COVER_LETTER_PATH=/tmp/cover-letter.json npm run build
```

Expected: the build stops before Astro, prints `FAIL: banned phrase "synergy" found in paragraphs`, and exits non-zero. Restore the file afterwards.

The unit suite proves the same failure per phrase without editing the repository:

```bash
node --experimental-sqlite --test tests/cover-letter-content.test.mjs
```

## 3. Start the local generator stub

```bash
node scripts/generator-stub.mjs --self-test
node scripts/generator-stub.mjs --port 4599 --log /tmp/generator.jsonl \
  --letter "Dear Hiring Manager,

I build and operate production Node.js services.

Requires employer-sponsored work authorization.

Best regards, Emad Poursina"
```

The stub accepts `POST` on any path and writes one redacted JSONL line per request (method, path, authorization presence/scheme/length/last four, body). It never records the full key.

## 4. Start the site with the generator configured

```bash
DATA_DIR=/tmp/cover-letter-data GENERATOR_ENDPOINT=http://localhost:4599/cover-letter \
GENERATOR_API_KEY=test-generator-key GENERATOR_TIMEOUT_MS=30000 \
PORT=4321 node --experimental-sqlite dist/server/entry.mjs
```

```bash
# The page carries the letter and the form
curl -s http://127.0.0.1:4321/cover-letter | grep -c 'Requires employer-sponsored work authorization.'
curl -s http://127.0.0.1:4321/cover-letter | grep -o 'maxlength="8000"'
curl -s http://127.0.0.1:4321/cover-letter | grep -o 'role="status"'

# A configured generation
curl -s -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: application/json' \
  -d '{"jobDescription":"Senior backend engineer, Node.js and SQLite, remote in Ireland."}'
```

Expected: the page contains the exact authorization line, the exact sign-off, both links, `maxlength="8000"`, and a `role="status"` region; the POST returns 200 with `"ok":true`, a `letter`, and `"appended"` flags; `/tmp/generator.jsonl` has exactly one line whose body contains the job description.

## 5. Required lines are appended

```bash
# Restart the stub with a letter missing the sign-off
node scripts/generator-stub.mjs --port 4599 --log /tmp/generator2.jsonl \
  --letter "Dear Hiring Manager,

I build and operate production Node.js services."

curl -s -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: application/json' \
  -d '{"jobDescription":"Backend engineer."}'
```

Expected: 200 with `"appended":{"authorization":true,"signoff":true}` and a `letter` that ends with both exact lines; the letter body above them is unchanged.

## 6. Unconfigured generator

```bash
DATA_DIR=/tmp/cover-letter-data PORT=4321 node --experimental-sqlite dist/server/entry.mjs
```

```bash
curl -s http://127.0.0.1:4321/cover-letter | grep -c '<form'        # expect 0
curl -s -i -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: application/json' -d '{"jobDescription":"x"}' | head -1   # 503
```

Expected: no form on the page, the general letter intact, and `HTTP/1.1 503` with the exact message `The cover-letter generator is unavailable right now`; no stub call is made.

## 7. Input limits and content types

```bash
# Empty after trim
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: application/json' -d '{"jobDescription":"   "}'          # 400

# 8,001 characters
{ printf '{"jobDescription":"'; head -c 8001 /dev/zero | tr '\0' 'a'; printf '"}'; } \
  | curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4321/api/cover-letter \
    -H 'Content-Type: application/json' --data-binary @-                      # 400

# Wrong content type and method
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: text/plain' -d 'x'                                        # 415
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/api/cover-letter  # 405
```

Expected: 400 / 400 / 415 / 405, each before any generator call (the stub log stays unchanged).

## 8. Generator failure and timeout fall back to the letter

```bash
# Failure
node scripts/generator-stub.mjs --port 4599 --status 500 --log /tmp/generator3.jsonl
curl -s -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: application/json' -d '{"jobDescription":"Backend engineer."}'
# expect 502, fallback:true, generalLetter containing both required lines

# Timeout
node scripts/generator-stub.mjs --port 4599 --delay-ms 5000 --log /tmp/generator4.jsonl
GENERATOR_TIMEOUT_MS=500 ... # restart the site with a 500 ms bound, then POST again
# expect 504, fallback:true, the same generalLetter, no upstream body
```

Expected: 502 then 504 with `fallback:true` and `generalLetter` equal to the page's letter; no upstream body, key, or job description in either response; no new SQLite content row.

## 9. Per-IP rate limit

```bash
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "$i:%{http_code}\n" -X POST http://127.0.0.1:4321/api/cover-letter \
    -H 'Content-Type: application/json' -d '{"jobDescription":"Backend engineer."}';
done
```

Expected: the first 10 are processed, the 11th is `429` with `Retry-After`, and the stub log has 10 lines. A `/api/ask` request from the same IP is still allowed (separate windows).

## 10. Shared daily cap and restart persistence

```bash
# Cap 3, both stubs running, one DATA_DIR
ASK_DAILY_CAP=3 GENERATOR_ENDPOINT=http://localhost:4599/cover-letter GENERATOR_API_KEY=test \
AI_BASE_URL=http://localhost:4600/v1 AI_MODEL=test-model AI_API_KEY=test-key \
DATA_DIR=/tmp/shared-cap PORT=4321 node --experimental-sqlite dist/server/entry.mjs

# two assistant questions, then two cover-letter requests
curl -s -o /dev/null -w 'ask1:%{http_code}\n' -X POST http://127.0.0.1:4321/api/ask \
  -H 'Content-Type: application/json' -d '{"question":"What has Emad built with Node.js?"}'
curl -s -o /dev/null -w 'ask2:%{http_code}\n' -X POST http://127.0.0.1:4321/api/ask \
  -H 'Content-Type: application/json' -d '{"question":"Which databases has Emad used?"}'
curl -s -o /dev/null -w 'letter1:%{http_code}\n' -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: application/json' -d '{"jobDescription":"Backend engineer."}'
curl -s -w 'letter2:%{http_code}\n' -X POST http://127.0.0.1:4321/api/cover-letter \
  -H 'Content-Type: application/json' -d '{"jobDescription":"Backend engineer."}'
```

Expected: the fourth call is 429 `daily_cap`, both stub logs stop growing, and `daily_cap_events` has exactly one `(day, 'cover_letter')` row. Restarting with the same `DATA_DIR` on the same UTC day still returns 429.

```bash
# Inspect the stored state (no content, no IP)
sqlite3 /tmp/shared-cap/site.sqlite "select * from ask_daily_counters; select * from daily_cap_events;"
```

## 11. Privacy and secret hygiene

```bash
# No key, no job description, no letter in the database
strings /tmp/shared-cap/site.sqlite | grep -c 'test-generator-key'   # 0
strings /tmp/shared-cap/site.sqlite | grep -c 'Backend engineer'     # 0

# No key in any response
curl -s http://127.0.0.1:4321/cover-letter | grep -c 'test-generator-key'  # 0
```

Expected: 0 for every probe, and no new log line contains a job description or a letter.

## 12. Discovery surfaces

```bash
curl -s http://127.0.0.1:4321/sitemap.xml | grep -o '/cover-letter' | wc -l   # 1
curl -s http://127.0.0.1:4321/ | grep -o 'href="/cover-letter"'               # nav entry
curl -s http://127.0.0.1:4321/llms.txt | grep -c cover-letter                  # 0 (unchanged)
curl -s http://127.0.0.1:4321/cover-letter | grep -c 'noindex'                 # 0
```

## 13. Project validation list (unchanged eight commands)

```bash
npm ci
npm run build
npm test
node scripts/check-agent-output.mjs
node scripts/test-public-routes.mjs
node scripts/test-contact-api.mjs
node scripts/lighthouse-check.mjs
node scripts/verify-container.mjs
```

Expected: all eight pass; `lighthouse-check.mjs` reports five pages including `cover-letter`; `verify-container.mjs` reports the new route count and keeps the volume-persistence assertion.

## Expected outcomes

- `/cover-letter` always serves the complete general letter, with the exact authorization line, the exact sign-off, and both profile links, with or without JavaScript.
- The generator form exists only when an endpoint and a key are configured; otherwise the page and the API behave as if the feature did not exist.
- Every generated letter displayed by the site carries both required lines; only missing ones are appended.
- A failed or slow generator leaves the visitor with the general letter and a clean message, and stores nothing.
- The combined assistant + cover-letter UTC-day cap and the cover-letter per-IP window both reject with 429 and never let an extra external call through.
- No job description, letter, IP address, or secret appears in SQLite, logs, or any response.
