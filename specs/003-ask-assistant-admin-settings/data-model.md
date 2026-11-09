# Data Model: Phase 3 — Ask Assistant, Abuse Limits, and Admin Settings

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

## Storage overview

The feature extends the existing `node:sqlite` database (`DATA_DIR/site.sqlite`) from schema version 1 to version 2. The contact table is untouched. Four new tables are created additively; a fresh database runs version 1 then version 2, an existing version-1 database runs only version 2.

| Table | Purpose | Lifetime |
|---|---|---|
| `settings` | admin overrides for AI, ask limits, SMTP, and generator endpoint | until the owner changes or clears a value |
| `admin_sessions` | server-side admin sessions referenced by the cookie | 8 hours absolute |
| `ask_questions` | full question text log (PRD change log 1.2) | retained until the owner deletes it |
| `ask_daily_counters` | UTC-day request counts for the global cap | one row per day; old rows may be pruned later |

The named Docker volume keeps the database across container rebuilds (F11 AC4).

## Schema version 2 (exact DDL)

```sql
-- Applied when PRAGMA user_version < 2, after the version-1 DDL.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS ask_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  question   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ask_questions_created_at
  ON ask_questions (created_at DESC);

CREATE TABLE IF NOT EXISTS ask_daily_counters (
  day        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Migration algorithm in `src/lib/db.mjs`:

```text
version = PRAGMA user_version
if version < 1: run version-1 DDL (contact_messages + index)
if version < 2: run version-2 DDL (four tables + two indexes)
if version < 2: PRAGMA user_version = 2
```

Every statement is `IF NOT EXISTS`, so a re-run after a partial application is safe. No existing row is read, rewritten, or dropped. Tests cover: fresh database → version 2 and all five tables; version-1 database with one contact row → version 2, contact row intact, four new tables present; second open → no change and no error.

## Entity: settings row

`settings.key` is one of the names below. `value` is TEXT: plain for non-secrets, the versioned envelope for secrets. `updated_at` is an ISO-8601 UTC timestamp written by SQLite's default or by the update statement.

| Key | Form field | Type | Default when absent | Validation |
|---|---|---|---|---|
| `ai.baseUrl` | `aiBaseUrl` | URL | `AI_BASE_URL` env, else `https://openrouter.ai/api/v1` | absolute URL; `https:` required; `http:` allowed only for host `localhost`, `127.0.0.1`, `[::1]`; no username/password; ≤500 chars; trailing slash trimmed |
| `ai.model` | `aiModel` | string | `AI_MODEL` env, else `anthropic/claude-haiku-5.5` | non-empty; ≤200 chars; no control characters |
| `ai.apiKey` | `aiApiKey` | secret | `AI_API_KEY` env | non-empty; ≤4096 chars; no CR/LF/control characters; encrypted envelope |
| `ask.dailyCap` | `askDailyCap` | integer | `ASK_DAILY_CAP` env, else `200` | integer 1–100000 |
| `ask.rateLimitPerHour` | `askRateLimitPerHour` | integer | `ASK_RATE_LIMIT_PER_HOUR` env, else `10` | integer 1–1000 |
| `smtp.host` | `smtpHost` | string | `SMTP_HOST` env, else empty | ≤255 chars; no spaces or control characters |
| `smtp.port` | `smtpPort` | integer | `SMTP_PORT` env, else `587` | integer 1–65535 |
| `smtp.secure` | `smtpSecure` | boolean (`true`/`false`) | `SMTP_SECURE` env, else `false` | exactly `true` or `false` |
| `smtp.user` | `smtpUser` | string | `SMTP_USER` env, else empty | ≤320 chars; no control characters |
| `smtp.pass` | `smtpPass` | secret | `SMTP_PASS` env | non-empty; ≤1024 chars; no CR/LF/control characters; encrypted envelope |
| `smtp.from` | `smtpFrom` | string | `SMTP_FROM` env, else `Emad Poursina <emad.poursina.work@gmail.com>` | `addr` or `Name <addr>`; addr valid; ≤320 chars |
| `generator.endpoint` | `generatorEndpoint` | URL | `GENERATOR_ENDPOINT` env, else empty | blank allowed; otherwise same URL rule as `ai.baseUrl`; ≤500 chars |

### Precedence and write semantics

Resolution on every read, with no process-lifetime cache that survives a save:

```text
effective(key) = settings[key]           if the row exists and is non-empty
               = environment variable    if that variable is non-empty
               = built-in default        otherwise
```

- A non-secret form field that is blank deletes the `settings` row (inherit again).
- A secret form field that is blank leaves the existing row unchanged.
- A non-blank secret is validated, encrypted, and written as a new envelope (fresh IV).
- All fields are validated before any write; the writes run in one transaction, so an invalid field means no change at all.
- `smtpSecure` is a checkbox: present → `true`, absent → `false` (an explicit override, not "inherit"). The renderer shows the effective value when no row exists.
- An invalid environment number or URL (e.g. `ASK_DAILY_CAP=abc`) logs one warning and falls back to the built-in default; it never crashes a request.

### Secret envelope

```text
v1:<iv-base64>:<tag-base64>:<ciphertext-base64>
```

- Algorithm: AES-256-GCM; key = 32 bytes from `ENCRYPTION_KEY` (base64 or 64 hex characters).
- IV: 12 random bytes per encryption.
- Tag: 16 bytes, stored separately.
- Plaintext: UTF-8 secret.
- Decryption failure (wrong key, tampering, bad envelope) raises a typed error; the caller treats the secret as unusable, logs one warning, and never falls back to plaintext.

### Masked view

`getMaskedSettings()` returns the non-secret values plus `hasApiKey`, `hasSmtpPass`, `apiKeyMasked`, `smtpPassMasked`. The mask is `••••` + the last four characters when the plaintext is at least 8 characters; otherwise `••••`. The full value is never placed in the returned object.

## Entity: admin session

| Field | Type | Rule |
|---|---|---|
| `id` | TEXT | 32 random bytes hex (64 chars), primary key |
| `created_at` | TEXT | ISO-8601 UTC, default now |
| `expires_at` | TEXT | ISO-8601 UTC, `created_at + 8 hours` (absolute) |

- Lookup: parse the `admin_session` cookie, select the row, reject and delete when `expires_at <= now`.
- Logout: delete the row; the cookie is cleared with `Max-Age=0`.
- Expired rows are deleted opportunistically on lookup; a sweep is not required.
- Cookie: `admin_session=<id>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, plus `Secure` when the request is HTTPS or a trusted `X-Forwarded-Proto` says HTTPS.
- No user id, IP, user agent, or role is stored: there is one owner and the session is binary.

## Entity: login failure record (in memory)

Not a table. Per IP: `{failures: number[], blockedUntil: number | null}`.

- On a wrong password: prune failures older than 15 minutes, append `now`; if the retained count reaches 5, set `blockedUntil = now + 15 minutes`.
- While `blockedUntil > now`: every login attempt returns 429 with `Retry-After` equal to the remaining seconds, even with the correct password.
- On success: delete the record for that IP.
- Lockout state is lost on restart by design (research D6); sessions are not.

## Entity: ask question log

| Field | Type | Rule |
|---|---|---|
| `id` | INTEGER | primary key, autoincrement |
| `created_at` | TEXT | ISO-8601 UTC, default now |
| `question` | TEXT | the trimmed question, 1–1000 characters |

- Written after validation and before the configured/limit/policy checks, so a valid question that is later capped or declined is still recorded.
- No IP, user agent, answer, model, token count, or secret is stored.
- A write failure logs one warning and does not change the response (research D17).

## Entity: ask daily counter

| Field | Type | Rule |
|---|---|---|
| `day` | TEXT | UTC date key `YYYY-MM-DD`, primary key |
| `count` | INTEGER | request count for that day, ≥0 |
| `updated_at` | TEXT | ISO-8601 UTC, refreshed on each increment |

Atomic consume:

```sql
INSERT INTO ask_daily_counters (day, count, updated_at)
VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(day) DO UPDATE SET
  count = count + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
RETURNING count;
```

`allowed = returnedCount <= effectiveDailyCap`. The increment and the read are one statement, so concurrent requests cannot exceed the cap. A new UTC day uses a new key and starts at zero. One unit is consumed per valid, configured request that reaches this step; policy-declined questions consume it, while validation rejections and unconfigured requests do not. If SQLite is unavailable, the ask route returns 503 `storage` and does not call the provider (fail closed).

## Content: `assistantPolicy` block

Added to `content/profile.json` (the single approved content source). `validateProfile` requires the object and its six string fields; `disclaimer` and `unavailable` must equal the PRD strings exactly.

```jsonc
"assistantPolicy": {
  "disclaimer": "AI assistant. The CV and case studies are the source of record.",
  "unavailable": "The assistant is unavailable right now",
  "notAvailable": "I do not have that information in the approved profile. Please use the contact form to ask Emad directly.",
  "salary": "I cannot discuss salary expectations. Please use the contact form to ask Emad directly.",
  "privateCodebase": "That codebase is private. You can read the published case studies at {caseStudiesPath}, and use the contact form for anything else.",
  "visa": "I cannot discuss named visa programs. Requires employer-sponsored work authorization. Please use the contact form for details."
}
```

- `{caseStudiesPath}` is the only placeholder; it is replaced with `/case-studies` at response build time.
- The owner may edit `notAvailable`, `salary`, `privateCodebase`, and `visa` without a code change; the placeholders and any exact PRD sentences must be preserved (the visa string must contain the authorization line verbatim).
- No `.env` value, key, or private document enters this block.

## Derived: context sections and citations

`src/lib/assistant-context.mjs` derives sections from `content/profile.json` and published `content/case-studies.json`.

| Section id | Label | Href | Fact text |
|---|---|---|---|
| `summary` | `About — Summary` | `/about#summary` | name, headline, bio, target roles, target countries, availability, work authorization, contact email |
| `experience` | `About — Experience` | `/about#experience` | role, company, dates, points, team-context marker |
| `skills` | `About — Skills` | `/about#skills` | every skill grouped by category with its level (`Beginner / Learning` shown as `Learning`) |
| `education` | `About — Education` | `/about#education` | degree, institution, years |
| `languages` | `About — Languages` | `/about#languages` | language and proficiency |
| `projects` | `About — Experience` | `/about#experience` | project name, description, public URL when present |
| `study:<slug>` | `Case Study — <title>` | `/case-studies/<slug>` | problem, contribution, outcome, stack, public link; published studies only |
| `contact` | `Contact` | `/contact` | contact email and the contact-form suggestion |

Selection rules (case-insensitive; word-boundary token matching):

- `summary` is always selected.
- `experience` — question matches experience/role/company vocabulary, any recorded company or role token, or `work`, `job`, `career`, `team`, `lead`, `freelance`, `years`.
- `skills` — question matches `skill`, `tech`, `stack`, `proficiency`, a level word, `framework`, `tool`, `database`, `backend`, `frontend`, `devops`, `cloud`, or any recorded skill name/token.
- `education` — `education`, `degree`, `university`, `college`, `study`, `studied`, `academic`, `school`.
- `languages` — `language`, `speak`, `fluent`, or any recorded language name.
- `projects` — `project`, `built`, `build`, `portfolio`, `open source`, `github`, or any recorded project name/token.
- `study:<slug>` — the study's title/slug token appears, or the question says `case study`/`project` generically (then all published studies are selected).
- If the selected set is exactly `{summary}`, add `experience` and `skills` (a general profile question).
- Order is fixed as listed; duplicates are removed; every selected section contributes one `{label, href}` citation in that order.
- The prompt context contains exactly the selected sections; the response `sources` is exactly the citation list.
- Every href is a site route or anchor that exists: `/about#summary`, `/about#experience`, `/about#skills`, `/about#education`, `/about#languages` are emitted by `src/pages/about.astro`; `/case-studies/<slug>` exists for every published study; `/contact` exists. The `projects` section cites `/about#experience` (the public page that renders the profile's project work); this phase does not add a separate About projects section.

### Policy rules (deterministic, before the model)

| Order | Rule | Patterns (case-insensitive) | Answer | Sources |
|---|---|---|---|---|
| 1 | Salary | `\b(salary|compensation|remuneration)\b`, `\bpay\s+(range|floor|expectation|rate|scale)\b`, `\bexpected\s+(salary|pay|compensation)\b`, `\b(day|hourly)\s+rate\b`, `\bhow\s+much\s+(does|would)\s+emad\s+(charge|cost|want)\b` | `assistantPolicy.salary` | `/contact` |
| 2 | Named visa program | `\bvisa\b`, `\bh-?1b\b`, `\bo-?1\b`, `\btn\s+visa\b`, `\bwork\s+permit\b`, `\bimmigration\s+program\b` | `assistantPolicy.visa` (contains the exact authorization line) | `/contact` |
| 3 | Private codebase | `(voice\s*dash|villion).{0,40}(code|codebase|repo|repository|source|architecture|implementation|schema)`, `(code|codebase|repo|repository|source\s+code|architecture).{0,40}(voice\s*dash|villion)`, `\b(private|proprietary|confidential)\s+(code|codebase|repo|repository|source)\b`, `\bshow\s+(me\s+)?(the\s+)?(source|code)\b` | `assistantPolicy.privateCodebase` with `{caseStudiesPath}` → `/case-studies` | `/case-studies`, `/contact` |

First match wins. A policy match returns HTTP 200 with the canned answer, the exact disclaimer, and the listed sources; the provider is not called.

## Response models

See [contracts/ask-api.md](./contracts/ask-api.md) and [contracts/admin-api.md](./contracts/admin-api.md) for the exact JSON. Summary:

```jsonc
// POST /api/ask 200
{
  "ok": true,
  "answer": "…",
  "disclaimer": "AI assistant. The CV and case studies are the source of record.",
  "sources": [{ "label": "About — Experience", "href": "/about#experience" }],
  "model": "anthropic/claude-haiku-5.5"
}
```

```jsonc
// error shape, all non-2xx
{
  "ok": false,
  "error": "validation | rate_limited | daily_cap | unconfigured | provider_error | timeout | storage | server",
  "message": "human-readable, no upstream body and no secret",
  "errors": { "question": "…" },        // validation only
  "retryAfterSeconds": 1234             // rate_limited only
}
```

## Validation rules (server, single source for tests and routes)

| Field | Rule | Error message |
|---|---|---|
| `question` | present, string, trimmed length 1–1000 | `Question is required.` / `Question must be 1,000 characters or fewer.` |
| `aiBaseUrl` | URL, `https:` or localhost `http:`, no credentials, ≤500 | `Enter an HTTPS base URL (localhost may use HTTP).` |
| `aiModel` | non-empty, ≤200, no control chars | `Enter a model ID.` |
| `aiApiKey` | blank or 1–4096 printable chars, no CR/LF | `Enter a valid API key.` |
| `askDailyCap` | blank or integer 1–100000 | `Daily cap must be a whole number between 1 and 100000.` |
| `askRateLimitPerHour` | blank or integer 1–1000 | `Rate limit must be a whole number between 1 and 1000.` |
| `smtpHost` | blank or ≤255, no spaces/control | `Enter a valid SMTP host.` |
| `smtpPort` | blank or integer 1–65535 | `Port must be between 1 and 65535.` |
| `smtpSecure` | boolean | — |
| `smtpUser` | blank or ≤320, no control | `Enter a valid SMTP username.` |
| `smtpPass` | blank or 1–1024 printable chars, no CR/LF | `Enter a valid SMTP password.` |
| `smtpFrom` | blank or `addr`/`Name <addr>`, ≤320 | `Enter a valid from address.` |
| `generatorEndpoint` | blank or URL rule as base URL | `Enter an HTTPS endpoint (localhost may use HTTP).` |

## State transitions

```text
Ask request:
  received → parsed → per-IP checked → validated → question logged
    → unconfigured? 503 (no model)
    → daily cap?    429 (no model)
    → policy?       200 canned (no model)
    → provider      200 answer | 502 upstream | 504 timeout
  Logging failure never changes the transition; a DB failure in the cap check is 503 storage.

Admin:
  anonymous → login page → correct password → session (8 h) → settings page → logout → anonymous
  anonymous → login page → wrong password ×5 in 15 min → blocked 15 min → anonymous
  session expired/deleted → 401 on next protected request
```
