# Quickstart: Phase 3 — Ask Assistant, Abuse Limits, and Admin Settings

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Contracts**: [ask-api.md](./contracts/ask-api.md), [admin-api.md](./contracts/admin-api.md), [http-routes.md](./contracts/http-routes.md)

This guide proves the feature end to end on a local machine with **no real AI provider and no real SMTP account**. Everything below runs against the built Astro server, the local AI stub, and the local SMTP sink.

## Prerequisites

- Node.js 22 LTS (the container's runtime; the host may be newer).
- `npm ci` at the repository root.
- A built server: `npm run build` (creates `dist/server/entry.mjs` and `dist/client/*`).
- No `.env` file is required for the checks; pass secrets inline in the shell. Never commit a real key or password.

## 1. Build and unit/integration tests

```bash
npm ci
npm run build
npm test
```

Expected: build exits 0; `npm test` runs every `tests/*.test.mjs`, including the new settings, secrets, admin-auth, assistant-context, assistant-prompt, ai-provider, ask-service, ask-limits, admin-page, ask-api integration, and admin-api integration suites.

## 2. Start the local AI stub

```bash
mkdir -p .evidence
node scripts/ai-stub.mjs --port 4010 --log .evidence/ai-stub.jsonl
```

The stub accepts `POST /v1/chat/completions` (and any path ending `/chat/completions`), records `{model, messages}` per request to the JSONL log, and returns a canned OpenAI-compatible answer. `--delay-ms 2000` simulates a slow provider; `--self-test` proves the stub itself.

## 3. Generate local admin credentials

```bash
printf '%s\n' 'local-test-password' | node scripts/admin-credentials.mjs --hash
node scripts/admin-credentials.mjs --key
```

Copy the printed `ADMIN_PASSWORD_HASH=…` and `ENCRYPTION_KEY=…` values into the server environment below. These are local test values; never commit them.

## 4. Start the site (configured assistant)

```bash
DATA_DIR=$(mktemp -d) PORT=4321 HOST=127.0.0.1 \
AI_BASE_URL=http://127.0.0.1:4010/v1 \
AI_MODEL=stub-model \
AI_API_KEY=local-test-key \
ADMIN_PASSWORD_HASH='scrypt$16384$8$1$…' \
ENCRYPTION_KEY='…' \
node --experimental-sqlite dist/server/entry.mjs
```

In another shell:

```bash
# The page
curl -s http://127.0.0.1:4321/ask | grep -E 'maxlength="1000"|AI assistant\. The CV and case studies are the source of record\.'

# A configured question
curl -s -X POST http://127.0.0.1:4321/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Has Emad run Docker Compose in production?"}' | jq .
```

Expected: 200; `answer` non-empty; `disclaimer` exactly the required sentence; `sources` non-empty with hrefs such as `/about#experience`; `model` is `stub-model`; `.evidence/ai-stub.jsonl` gained one record whose `model` is `stub-model`.

Also open `http://127.0.0.1:4321/ask` in a browser and submit a question: the submit button becomes disabled and the status region shows `Thinking…` until the answer arrives, then the answer renders as text and the citations render as internal links. This is the manual proof for the thinking, disabled-submit, and ARIA-live behavior; the static check proves only the markup.

## 5. Unconfigured assistant

Stop the server and start it again without `AI_*` variables (keep the admin secrets):

```bash
DATA_DIR=$(mktemp -d) PORT=4321 HOST=127.0.0.1 \
ADMIN_PASSWORD_HASH='…' ENCRYPTION_KEY='…' \
node --experimental-sqlite dist/server/entry.mjs

curl -s -o /tmp/ask.json -w '%{http_code}\n' -X POST http://127.0.0.1:4321/api/ask \
  -H 'Content-Type: application/json' -d '{"question":"What is Emad’s availability?"}'
cat /tmp/ask.json
```

Expected: `503`; `{"ok":false,"error":"unconfigured","message":"The assistant is unavailable right now"}`; the stub log gained no record.

## 6. Input limits

```bash
# Empty after trim
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4321/api/ask \
  -H 'Content-Type: application/json' -d '{"question":"   "}'          # 400

# 1,001 characters
python3 -c 'import json;print(json.dumps({"question":"a"*1001}))' > /tmp/long.json
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4321/api/ask \
  -H 'Content-Type: application/json' --data-binary @/tmp/long.json     # 400
```

Expected: both 400 with `errors.question`; the stub log is unchanged.

## 7. Per-IP rate limit

Restart with `ASK_RATE_LIMIT_PER_HOUR=10` (or rely on the default) and send eleven valid questions from the same address:

```bash
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "$i %{http_code}\n" -X POST http://127.0.0.1:4321/api/ask \
    -H 'Content-Type: application/json' -d "{\"question\":\"Question $i about Emad\"}"
done
```

Expected: the first ten reach the configured/unconfigured outcome; the eleventh is `429` with `Retry-After`; no stub record for the eleventh.

## 8. Daily cap and restart persistence

```bash
DATA_DIR=/tmp/p3-daily PORT=4321 HOST=127.0.0.1 ASK_DAILY_CAP=2 \
AI_BASE_URL=http://127.0.0.1:4010/v1 AI_MODEL=stub-model AI_API_KEY=local-test-key \
node --experimental-sqlite dist/server/entry.mjs &
# send three valid questions; the third is 429 daily_cap
kill %1
# start again with the same DATA_DIR and cap; a fourth request is still 429
```

Expected: third and fourth responses are `429` with `The assistant is paused for today. Please try again tomorrow or use the contact form.`; the stub recorded exactly two calls. The `ask_daily_counters` row for today has `count >= 3`.

## 9. Admin login, 401s, and masking

```bash
# 401 without a session
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/admin          # 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/api/admin/settings  # 401

# Login (native form flow)
curl -s -i -c /tmp/admin-cookies.txt -X POST http://127.0.0.1:4321/api/admin/login \
  -H 'Origin: http://127.0.0.1:4321' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'password=local-test-password' | grep -Ei '^(HTTP|set-cookie|location)'

# Authenticated page
curl -s -b /tmp/admin-cookies.txt http://127.0.0.1:4321/admin | grep -E 'Admin settings|noindex|••••'
```

Expected: 401s first; 303 with `admin_session=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`; then 200 with the form, `noindex`, and only masked secrets.

## 10. Model switch with no restart

```bash
# Save a new base URL and model through the admin endpoint
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/admin-cookies.txt \
  -X POST http://127.0.0.1:4321/api/admin/settings \
  -H 'Origin: http://127.0.0.1:4321' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'aiBaseUrl=http://127.0.0.1:4010/v1&aiModel=stub-model-2&aiApiKey='

# The next question must use the new model
curl -s -X POST http://127.0.0.1:4321/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"What backend stack does Emad use?"}' | jq -r .model
tail -n 1 .evidence/ai-stub.jsonl | jq -r .model
```

Expected: both print `stub-model-2`; no restart occurred; the API key field was blank so the stored key is unchanged.

## 11. Lockout

```bash
for i in $(seq 1 5); do
  curl -s -o /dev/null -w "$i %{http_code}\n" -X POST http://127.0.0.1:4321/api/admin/login \
    -H 'Origin: http://127.0.0.1:4321' \
    -H 'Content-Type: application/x-www-form-urlencoded' --data 'password=wrong'
done
curl -s -o /dev/null -w 'correct %{http_code}\n' -X POST http://127.0.0.1:4321/api/admin/login \
  -H 'Origin: http://127.0.0.1:4321' \
  -H 'Content-Type: application/x-www-form-urlencoded' --data 'password=local-test-password'
```

Expected: five 401s, then `429` with `Retry-After` even though the password is correct.

## 12. SMTP settings take effect without a restart

```bash
node scripts/smtp-sink.mjs --port 2525   # sink A (bootstrap) — stop it before sink B starts
node scripts/smtp-sink.mjs --port 2526   # sink B (admin-saved)
```

The sink writes one fixed `.evidence/smtp-sink.jsonl`, so run only one sink at a time. Start the server with `SMTP_HOST=127.0.0.1 SMTP_PORT=2525` and the admin secrets. Post one valid contact message and confirm it in the log. Stop sink A, start sink B on 2526, log in, then save `smtpHost=127.0.0.1&smtpPort=2526&smtpSecure=&smtpUser=test&smtpPass=local-pass&smtpFrom=Emad <emad.poursina.work@gmail.com>`. Post a second valid contact message from the same IP: it appears in the same log after sink A stopped, which proves delivery switched to sink B with no restart. The contact rate limit is 5/hour, so two submissions are fine.

## 13. Secret hygiene

```bash
# The full key must not appear in the page or any response
grep -R --binary-files=text -n 'local-test-key' dist/client /tmp/admin-cookies.txt 2>/dev/null || true
# The SQLite file must contain the envelope, not the plaintext
strings /tmp/p3-daily/site.sqlite | grep -E 'v1:|local-test-key' || true
```

Expected: no plaintext key in the built client or the SQLite file; the `settings` row for `ai.apiKey` (if saved) starts with `v1:`.

## 14. Discovery surfaces

```bash
curl -s http://127.0.0.1:4321/sitemap.xml | grep -E '/ask|/admin'     # /ask only
curl -s http://127.0.0.1:4321/llms.txt | grep -i admin || true        # nothing
curl -s http://127.0.0.1:4321/admin/login | grep -i 'noindex'          # present
```

## 15. The project validation list (unchanged eight commands)

Run in order from a clean shell:

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

Phase 3 extends the checks inside these commands (new `tests/*.test.mjs` under `npm test`; `/ask`, admin, sitemap, and noindex probes inside the existing scripts) rather than adding a ninth command. `scripts/lighthouse-check.mjs` audits `/`, `/about`, `/case-studies/rousta-tv`, and `/ask`; `scripts/verify-container.mjs` probes `/ask` 200, `/admin` 401, `/admin/login` 200, `POST /api/ask` 503 unconfigured, and `POST /api/admin/login` 401 inside the container.

## Expected outcomes

- Every scenario above matches its stated status and message.
- The AI stub log proves which model/base URL received each call and proves the absence of calls after a cap or a policy decline.
- The SQLite file persists across restarts and contains the question log, daily counter, sessions, and encrypted settings.
- No real provider key, SMTP password, or private document is needed, printed, or committed.
