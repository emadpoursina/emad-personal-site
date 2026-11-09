# Research: Phase 3 — Ask Assistant, Abuse Limits, and Admin Settings

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Data model**: [data-model.md](./data-model.md)

Each decision below is resolved in this phase; none remains "NEEDS CLARIFICATION". The PRD, the parent card's locked decisions, and the existing Phase 1/2 code are the authorities; research records how the design satisfies them without adding a dependency or a second runtime.

## D1 — SQLite schema v2: additive, idempotent migration

**Decision**: Raise `src/lib/db.mjs` from schema version 1 to 2. Version 2 runs `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` for `settings`, `admin_sessions`, `ask_questions`, and `ask_daily_counters`, then sets `PRAGMA user_version = 2`. Version 1's `contact_messages` DDL stays untouched. A fresh database runs both blocks in order; an existing version-1 database runs only the version-2 block. No `DROP`, no table rewrite, no column change to `contact_messages`.

**Rationale**: The PRD's F11 AC4 and the parent's locked decision 11 require existing rows to survive both a container rebuild (named volume) and a schema upgrade. `IF NOT EXISTS` makes a partially applied migration safe to re-run. A single `PRAGMA user_version` gate is already the project's convention and needs no migration framework.

**Alternatives considered**: A migration library (new dependency, rejected under the stack rule); one JSON blob for all new state (loses atomic counters and per-key updates); rewriting `contact_messages` (destructive, unnecessary).

## D2 — Settings storage: one row per named setting

**Decision**: `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`. Keys are namespaced strings (`ai.baseUrl`, `ai.model`, `ai.apiKey`, `ask.dailyCap`, `ask.rateLimitPerHour`, `smtp.host`, `smtp.port`, `smtp.secure`, `smtp.user`, `smtp.pass`, `smtp.from`, `generator.endpoint`). A save validates all fields, then writes/deletes the changed keys inside one transaction.

**Rationale**: The settings page saves a mix of inherited and overridden values; one row per key lets a blank non-secret field *delete* the override and fall back to the environment, while a blank secret field leaves the stored ciphertext untouched. Partial updates stay simple and testable, and a transaction gives the "all or nothing" rule in FR-712.

**Alternatives considered**: One JSON document in a single row (harder to express per-field inheritance/deletion and to update atomically without read-modify-write races); a column per setting (schema churn whenever the form changes); environment-only configuration (fails F21's no-restart promise).

## D3 — Secret envelope: AES-256-GCM, versioned, fail closed

**Decision**: `src/lib/secrets.mjs` implements `encryptSecret(plaintext)` and `decryptSecret(envelope)` with AES-256-GCM, a fresh 12-byte random IV per write, a 16-byte auth tag, and the envelope string `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`. `ENCRYPTION_KEY` is accepted as 32 raw bytes encoded in base64 or as 64 hex characters; anything else is invalid. A missing or invalid key makes secret saves fail with a field-level error and logs one warning. An undecryptable stored secret is treated as unavailable, never as plaintext.

**Rationale**: F21 AC7 explicitly names AES-256-GCM and `ENCRYPTION_KEY`. A versioned envelope allows a future format change without a destructive migration. Fresh IVs prevent ciphertext reuse; the auth tag detects tampering and a wrong key. Failing closed satisfies the "no plaintext fallback" rule.

**Alternatives considered**: AES-256-CBC (no built-in authentication); storing a hash instead of ciphertext (cannot display the last four characters or use the secret); a KMS/secret manager (not in the stack, not available on this host).

## D4 — Admin password hash: versioned scrypt

**Decision**: `ADMIN_PASSWORD_HASH` format `scrypt$N$r$p$salt-b64$hash-b64`. Verification parses the parameters, bounds `N` to a power of two up to 2^20, `r`/`p` to 1–16, derives the key with `crypto.scrypt`, and compares with `timingSafeEqual`. Default generation uses N=16384, r=8, p=1, a 16-byte salt, and a 64-byte hash. A missing or malformed value fails every login closed and logs one warning.

**Rationale**: The parent's locked decision 9 names `crypto.scrypt`, a documented versioned format, and constant-time comparison. Storing parameters in the string makes the hash portable across future cost increases. A malformed hash must never be treated as "no password required".

**Alternatives considered**: bcrypt/argon2 (new native dependencies); a plain SHA-256 hash (fast to brute-force, unsuitable for a password); a fixed unversioned scrypt string (cannot raise cost later).

## D5 — Admin sessions: server-side row + opaque cookie

**Decision**: A session is a random 32-byte id (64 hex characters) stored in `admin_sessions` with `created_at` and an absolute `expires_at` of 8 hours. The cookie is `admin_session=<id>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, plus `Secure` when the request is HTTPS (directly or via a trusted `X-Forwarded-Proto`). Every protected request looks the row up, removes it if expired, and treats a missing row as no session. Logout deletes the row and clears the cookie.

**Rationale**: F21 AC1 requires HttpOnly, SameSite=Strict, 8-hour expiry, and revocation. A server-side row makes logout and expiry authoritative; a signed stateless cookie could not be revoked. `SameSite=Strict` plus Astro's origin check covers CSRF without a token.

**Alternatives considered**: A signed JWT cookie (no revocation, needs a signing secret); in-memory sessions (lost on restart, not revocable across processes); `localStorage` (not HttpOnly, requires client JS).

## D6 — Login lockout: in-memory per-IP failure window

**Decision**: `src/lib/admin-auth.mjs` keeps a `Map<ip, {failures: number[], blockedUntil: number}>`. Each wrong password appends a timestamp; failures older than 15 minutes are pruned; the fifth failure in the window sets `blockedUntil = now + 15 minutes`. While blocked, even the correct password returns HTTP 429 with `Retry-After`. A successful login clears the record. Unit tests inject `now`; HTTP tests exercise five failures and a sixth correct attempt immediately.

**Rationale**: The PRD §9 rate-limiting pattern is an in-memory per-IP limiter, and F21 AC2 does not require the block to survive a restart. A restart clearing the block is not an attacker-controlled action, and the single-container deployment has no shared state to coordinate. Keeping it in memory avoids a fifth table and a cleanup job.

**Alternatives considered**: A SQLite `admin_login_attempts` table (survives restart but adds schema and cleanup for a short-lived signal); reusing `createRateLimiter` with a limit of 5 (close, but its sliding window and retry math are request-count semantics, not "block for 15 minutes from the fifth failure"); blocking the account globally (the spec requires per-IP).

## D7 — Ask API: JSON-only, ordered gates, explicit statuses

**Decision**: `POST /api/ask` requires `Content-Type: application/json` and a body object with a string `question` (415/400 otherwise). Order: parse/415 → per-IP limiter (every attempt counts) → validate (400) → unconfigured (503 exact message) → daily cap (429 paused message) → policy decline (200) → provider call (200/502/504). Every response is `Cache-Control: no-store`. The success body is `{ok, answer, disclaimer, sources, model}`; errors are `{ok:false, error, message?, errors?, retryAfterSeconds?}`.

**Rationale**: The parent's locked decision 4 fixes the body, the exact strings, and "gates before the model call". Putting the per-IP limiter first matches the existing contact service, so invalid attempts still count as abuse. Putting the unconfigured check before the daily cap avoids burning the global allowance on requests that cost nothing. Policy before the model guarantees the decline wording cannot be reworded by a model. `no-store` keeps answers and errors out of caches.

**Alternatives considered**: Accepting form-encoded bodies (the `/ask` panel uses `fetch` JSON; a second parser adds surface); 200 with the unconfigured text in `answer` (hides a service failure from monitoring and from the client's error handling); daily cap before validation (invalid traffic would consume the owner's allowance).

## D8 — Citations: deterministic section selection, server-built

**Decision**: `src/lib/assistant-context.mjs` builds named sections from `content/profile.json` and published `content/case-studies.json`: `summary` → `/about#summary`, `experience` → `/about#experience`, `skills` → `/about#skills`, `education` → `/about#education`, `languages` → `/about#languages`, `projects` → `/about#experience`, each published study → `/case-studies/<slug>`, and `contact` → `/contact`. Selection is keyword-matched, case-insensitive, with token matching against role, company, skill, and study-title vocabularies; `summary` is always included; a question that matches nothing specific also gets `experience` and `skills`. The prompt context contains exactly the selected sections and the response `sources` is exactly their `{label, href}` list, deduplicated in section order.

**Rationale**: The phase AC requires server-built citations that cannot be parsed out of free text. Selecting the context and the citation from the same data structure makes the citation truthful by construction: the model only saw those sections. Every href is an existing site route or anchor. Keyword selection is deterministic, testable, and has no model dependency.

**Alternatives considered**: Asking the model to return citations (fabricatable, needs parsing, fails the AC); always citing every section (technically valid but noisy and not "the sections the request used"); a vector search (new dependency, no need for a profile this size).

## D9 — Decline policy: server-side interception before the model

**Decision**: `matchPolicy(question)` checks, in order, salary → named visa → private codebase, using word-boundary patterns. A match returns the corresponding string from `content/profile.json`'s `assistantPolicy` block, with `{caseStudiesPath}` replaced by `/case-studies`, plus fixed `sources` (`/contact`, and `/case-studies` for the private-codebase case). The model is not called for a policy match. The policy strings are validated as non-empty; `disclaimer` and `unavailable` are validated against the exact PRD strings.

**Rationale**: F8 AC4 says the assistant must "state the approved position". Prompt-only enforcement lets a model invent a number or an immigration position. Server-side interception makes the guarantee testable and owner-editable without code. The private-codebase rule links the case-studies index because VoiceDash is a draft 404 and Villion has no study; no nonexistent page is linked.

**Alternatives considered**: Prompt-only policy (unverifiable, model-dependent); a separate moderation model (extra dependency and cost); refusing all salary/visa questions with the generic not-available text (does not state the approved position and does not repeat the authorization line).

## D10 — Limits: reuse the per-IP limiter, add a SQLite daily counter

**Decision**: The per-IP window uses `createRateLimiter({windowMs: 3_600_000, limit})`. A small holder in `src/lib/ask-limits.mjs` keeps the current limiter and recreates it only when the effective limit changes, so an admin edit takes effect on the next request. The daily counter uses `ask_daily_counters(day TEXT PRIMARY KEY, count INTEGER)` with a single atomic upsert: `INSERT ... ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count`; `allowed = count <= cap`. The day key is `new Date().toISOString().slice(0, 10)`. If SQLite is unavailable the endpoint returns 503 and does not call the model.

**Rationale**: The parent's locked decision 10 says to reuse `createRateLimiter` and add a SQLite UTC-day counter. The atomic upsert prevents more than the cap slipping through concurrent requests. Recreating the limiter on a limit change is the smallest way to honor "effective values on every request" without rewriting the Phase 1 limiter.

**Alternatives considered**: A second in-memory daily counter (lost on restart, fails F10 AC2 persistence); counting only after a successful model call (a failing provider could be hammered without limit); a new rate-limiting library (no need, new dependency).

## D11 — Provider adapter: `fetch`, bounded timeout, injected for tests

**Decision**: `src/lib/ai-provider.mjs` posts to `<baseUrl>/chat/completions` with `Authorization: Bearer <apiKey>`, `{model, messages, temperature: 0.2, max_tokens: 500, stream: false}`, and an `AbortController` timeout (`AI_TIMEOUT_MS`, default 30,000, capped at 30,000 for production; tests may lower it). It returns the first `choices[0].message.content` string. Non-2xx, network errors, malformed JSON, and empty content map to a typed `{kind:'upstream'}` error; an abort maps to `{kind:'timeout'}`. Errors carry no response body, header, URL credential, or key. The ask service receives the provider function as a dependency; the route injects the real one.

**Rationale**: PRD §9 names an OpenAI-compatible endpoint, and Node 22 has built-in `fetch` and `AbortController`; no SDK is needed. Typed errors let the route map 502/504 without leaking upstream detail. Dependency injection is the existing test pattern (`contact-service.mjs`).

**Alternatives considered**: The OpenAI SDK (new dependency, more surface than one POST); unbounded fetch (a hung provider would hold a request slot and fail F8's bounded timeout); parsing streamed responses (the feature needs one complete answer).

## D12 — SMTP: effective settings resolved per send

**Decision**: `src/lib/mailer.mjs` stops caching a transport built from env at module load. `status()` asks `settings.getEffectiveSmtp()` and reports `configured` when host and user and password are present. `send()` resolves the same effective settings, computes a fingerprint of `{host, port, secure, user, pass}`, reuses a cached transport only while the fingerprint matches, and otherwise builds a new one. A blank/invalid SMTP set leaves delivery disabled with one warning, never a crash. The existing `resetTransport()` remains for tests.

**Rationale**: F21 requires saved SMTP settings to take effect with no restart; the fingerprint cache keeps the "no restart" promise without opening a new connection on every message when nothing changed. The contact service already calls `status()` and `send()` separately, so no contact code changes are needed beyond the mailer.

**Alternatives considered**: A new transport per send (simple but pays a connection per message); watching the database for changes (no event source in SQLite); restarting the process (fails the AC).

## D13 — Admin UI: server-rendered, no-JS form, noindex

**Decision**: `/admin/login` is a prerendered public page with a password form and `noindex, nofollow`. `/admin` is an SSR page: without a session it returns a 401 HTML response; with a session it renders the settings form and a logout form. The settings form posts `application/x-www-form-urlencoded` to `/api/admin/settings` and the login form posts to `/api/admin/login`; both work without client JavaScript. Field errors re-render the page with the submitted non-secret values, the field errors, and no secret values. `BaseLayout` gains an optional `noindex` prop, used only by the admin pages.

**Rationale**: F21 requires `/admin` itself to be 401 without a session, which a prerendered page cannot do; SSR is already enabled (`output: 'server'`). A native form keeps the admin surface free of client JavaScript, consistent with the F12 baseline, and avoids a second island. Re-rendering on error is required for a usable no-JS form.

**Alternatives considered**: A static `/admin` that redirects to login (violates "`/admin` returns 401"); a client-side settings form (adds an island and fails the no-JS baseline); JSON-only errors (unusable in a browser form without JS).

## D14 — Static-output check: allow one module script on `/ask` only

**Decision**: `scripts/check-static-output.mjs` and `scripts/check-agent-output.mjs` keep the rule that every built HTML page has exactly one `application/ld+json` block and no other scripts, with one exception: `dist/client/ask/index.html` may contain exactly one `<script type="module" src="/_astro/...">` (the ask island) and no other script. Both checks are updated in the same build-gate unit as the page (T013–T015). The static check asserts `/ask` contains the form, the 1,000-character `maxlength`, the exact disclaimer, and the ARIA live region; the admin noindex and artifact assertions land with the admin pages (T025); the sitemap contains `/ask` and no admin path.

**Rationale**: F12 AC1 says static content must not need client JS; `/ask` is the one interactive feature the parent permits to use "one minimal island". The check must distinguish that one bundle from arbitrary scripts, otherwise the Phase 2 guarantee silently weakens. Astro emits the island as a hashed module bundle, so a `type="module"` + `/_astro/` allow-list is narrow and testable.

**Alternatives considered**: Allowing any script on `/ask` (would let an inline or third-party script slip in); no island (cannot meet the thinking-state/disabled-submit AC without a full page reload); excluding `/ask` from the walk (loses the single-`h1`, skip-link, and JSON-LD checks).

## D15 — Hermetic tests: local provider stub, sinks, injected clocks

**Decision**: Add `scripts/ai-stub.mjs`, a dependency-free HTTP server exposing `POST /v1/chat/completions` (and any path ending `/chat/completions`), recording each request's `{model, messages}` to a JSONL file passed with `--log`, and returning a canned `choices[0].message.content` (the `--answer <text>` value when supplied). It supports `--delay-ms` for timeout tests and `--self-test`. Unit tests inject fake providers, DB handles, clocks, and `fetch`; integration tests spawn `dist/server/entry.mjs` with a temporary `DATA_DIR`, a random port, a stub base URL, and an admin hash/key, and read the stub log to prove model/base-URL switches or the absence of calls. SMTP continues to use `scripts/smtp-sink.mjs`.

**Rationale**: The parent's locked decision 17 requires no external AI call and no real key. The SMTP sink is the established pattern; a matching AI stub keeps parity. A JSONL log proves what the provider received without adding an HTTP introspection endpoint. Injectable clocks make the 8-hour expiry and 15-minute lockout testable without waiting.

**Alternatives considered**: Mocking `fetch` only in unit tests (does not prove the route wiring); a real provider key (forbidden and unavailable); a heavy mock server library (new dependency).

## D16 — No new dependencies

**Decision**: The feature uses `node:crypto` (scrypt, AES-256-GCM, randomBytes, timingSafeEqual), built-in `fetch`/`AbortController`, `node:sqlite`, `node:test`, and the existing Astro/nodemailer stack. The stub and sinks use `node:http`/`node:net`. No package is added to `package.json`.

**Rationale**: Every capability the phase needs exists in Node 22 or the current stack. The PRD §9 stack is fixed and the parent requires written justification for any addition; there is none to justify.

**Alternatives considered**: `bcrypt`, `jsonwebtoken`, `openai`, `zod`, `express-rate-limit` — all duplicate a core or existing capability.

## D17 — Question logging: best effort, no IP, no answer

**Decision**: After a question passes validation, the ask service calls `db.insertQuestion(question)`. A logging failure is caught and logged as one warning; it never blocks an answer and never changes the response. The row is `{id, created_at, question}` only. Rate-limited, capped, policy-declined, and model-answered valid questions are all logged; invalid (400/415) questions are not.

**Rationale**: PRD change log 1.2 requires the full question text and no answers; privacy says no analytics and no unnecessary personal data, so the IP is omitted. Best-effort logging keeps a logging outage from taking down the assistant, while the daily counter (which must be authoritative) remains fail-closed.

**Alternatives considered**: Logging only answered questions (loses the record of what visitors asked when the cap hit); logging the IP (privacy cost with no requirement); failing the request on a log error (availability cost).

## D18 — Discovery surfaces: add `/ask`, exclude admin

**Decision**: Add `/ask` to the header navigation and to `PUBLIC_PAGE_PATHS`, and have `buildSitemap` iterate `PUBLIC_PAGE_PATHS` (plus published studies) instead of a hardcoded list, so `/ask` appears once. `llms.txt`, `resume.json`, `/api/profile`, and JSON-LD keep their Phase 2 content and gain nothing about Ask or Admin. `/admin` and `/admin/login` are noindex and absent from the sitemap, navigation, and every agent output.

**Rationale**: The parent's locked decision 2 says "Add Ask to the public nav; add nothing for Admin to nav/sitemap/`llms.txt`/`resume.json`/JSON-LD". `/ask` is a public page and a sitemap entry is correct; the profile-oriented agent outputs should not grow site-navigation facts. Making the sitemap builder use the registry removes the Phase 2 duplication that would otherwise need a second hardcoded edit.

**Alternatives considered**: Adding `/ask` to `llms.txt` (not a profile fact; the card says add nothing for admin but says nothing about ask — the conservative choice is to leave the agent outputs unchanged); leaving the sitemap hardcoded (two sources of truth).

## D19 — Admin form field names and semantics

**Decision**: Form fields: `aiBaseUrl`, `aiModel`, `aiApiKey`, `askDailyCap`, `askRateLimitPerHour`, `smtpHost`, `smtpPort`, `smtpSecure` (checkbox `on`), `smtpUser`, `smtpPass`, `smtpFrom`, `generatorEndpoint`. Non-secret fields render the admin-stored value or blank, with the effective inherited value as a placeholder; blank means "delete the override". Secret fields always render blank, with a masked last-four placeholder when a secret exists; blank means "keep". Numeric fields are positive integers with the bounds in data-model.md.

**Rationale**: A single consistent form maps directly to the settings keys and makes the precedence rule visible without freezing inherited values into overrides. The blank semantics are the only way a no-JS form can express "inherit" and "unchanged" without extra controls.

**Alternatives considered**: Pre-filling effective values (a save would silently create overrides for every field); explicit "clear" checkboxes (more UI, more states); separate save buttons per section (partial validation conflicts with FR-712).

## D20 — Time: UTC day keys, absolute expiries, injected clocks

**Decision**: The daily key is the UTC date from `toISOString().slice(0,10)`. Session expiry and lockout windows are absolute millisecond timestamps; modules accept a `now()` dependency defaulting to `Date.now`. SQLite timestamps are ISO-8601 UTC strings with milliseconds. Display dates are not introduced by this feature.

**Rationale**: F10 AC2 specifies a UTC day; absolute expiry avoids drift and makes the 8-hour and 15-minute rules trivially testable. An injected clock keeps unit tests deterministic without changing production behavior.

**Alternatives considered**: Local-time day keys (fails the UTC requirement); relative/sliding session expiry (F21 says 8 hours absolute); sleeping in tests (slow and flaky).

## D21 — Audit logging without secrets

**Decision**: Log one line per rate-limit/cap event and per admin login failure/success/settings save, with event name and non-sensitive counters only (`event`, `day`, `count`, `cap`, `ip?` never, `fields` names never values). Provider failures log the HTTP status only. No key, password, hash, cookie id, question text, or answer is logged.

**Rationale**: F10 AC3 requires the cap event to be logged; F21's security posture requires failures to be visible. Keeping secrets and PII out of logs is a PRD §8 requirement and a testable invariant. Question text already lives in SQLite, so duplicating it in logs adds exposure without value.

**Alternatives considered**: Logging full request bodies (leaks secrets and PII); no logging (fails F10 AC3 and makes lockout opaque); structured JSON logs (nice, but the existing project uses plain `console` lines; no new logger).
