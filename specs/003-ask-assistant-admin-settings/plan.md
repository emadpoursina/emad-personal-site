# Implementation Plan: Phase 3 — Ask Assistant, Abuse Limits, and Admin Settings

**Branch**: `emad-personal-site/t_8562afa1-phase-3-ask-me-assistant-and-admin-setti` | **Date**: 2026-11-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-ask-assistant-admin-settings/spec.md`; scope authority `PRD.phases.md` § Phase 3; requirements `PRD.md` v1.4 F8/F10/F21, §8, §9, §12, §13.

## Summary

Add the visitor-facing assistant (`/ask` + `POST /api/ask`), its cost guards (per-IP window and a SQLite UTC-day cap), and the owner's password-protected settings panel (`/admin`, `/admin/login`, `/api/admin/*`) on the existing Astro 5 + Node 22 + `node:sqlite` + `nodemailer` stack. The assistant answers only from `content/profile.json` and published `content/case-studies.json`; citations are server-built from the context sections the request used; salary, private-codebase, and named-visa questions are intercepted before the model with owner-editable policy strings. Settings are one row per key over environment over defaults, with AES-256-GCM-encrypted secrets, masked last-four display, and per-request resolution so a save takes effect on the next ask or contact message with no restart. The database gains four additive tables (schema version 2). No dependency is added; the model call uses built-in `fetch`, secrets use `node:crypto`, and a local OpenAI-compatible stub keeps every test hermetic.

## Technical Context

**Language/Version**: Node.js 22 LTS in the container (host 26.7.0); TypeScript inside `.astro` pages and API routes (Astro's built-in support); plain ESM JavaScript (`.mjs`) for shared logic, adapters, settings, secrets, scripts, and tests so `node --test` and `node scripts/*.mjs` run without a transform.

**Primary Dependencies**: existing `astro@5.18.2` + `@astrojs/node` (standalone), `nodemailer`, `pdfkit`; Node core `node:crypto`, `node:sqlite`, `fetch`/`AbortController`, `node:test`. **No new runtime or dev dependency.** Dev-only Ajv packages from Phase 2 remain unchanged.

**Storage**: SQLite via `node:sqlite` `DatabaseSync`, schema version 2. Existing `contact_messages` unchanged; new `settings`, `admin_sessions`, `ask_questions`, `ask_daily_counters`. `DATA_DIR/site.sqlite` on the existing named volume.

**Testing**: `node:test` unit suites for secrets, settings, admin auth, context/policy, prompt, provider, ask service, limits, admin page, and DB migration; `node:test` integration suites that spawn `dist/server/entry.mjs` against `scripts/ai-stub.mjs` and `scripts/smtp-sink.mjs`; existing `test-public-routes.mjs`, `test-contact-api.mjs`, `check-agent-output.mjs`, `check-static-output.mjs`, `lighthouse-check.mjs`, `verify-container.mjs` extended in place.

**Target Platform**: Linux, single `node:22-bookworm-slim` container, plain HTTP locally, HTTPS later.

**Project Type**: web application — prerendered content pages, one interactive island on `/ask`, and on-demand API/admin routes.

**Performance Goals**: `/ask` LCP < 2.0 s and Lighthouse Performance ≥ 95 / Accessibility 100 on the mobile profile; API response time < 500 ms excluding model latency; no client JS on any page except the single `/ask` island; `/api/ask` no-store.

**Constraints**: PRD §9 stack only; no AI SDK, Express, ORM, framework swap, or Astro major upgrade; secrets only in `.env`; admin-stored secrets encrypted; every acceptance check runnable from the existing eight validation commands in order; no evidence or secrets committed; VoiceDash stays draft; `/admin*` noindex and undiscoverable.

**Scale/Scope**: 3 new HTML routes (`/ask`, `/admin`, `/admin/login`), 6 new on-demand route files (1 ask API + 3 admin APIs + 2 catch-alls), 4 new SQLite tables with 2 indexes, 1 content block, 9 new `src/lib` modules, 1 component, 2 scripts, and the corresponding tests; single container; 100 concurrent visitors in year 1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unratified Spec Kit template: principles are `[PRINCIPLE_N_NAME]`/`[PRINCIPLE_N_DESCRIPTION]` with no version or ratification date, so it states no normative rule this plan could violate. The plan does not invent one (ratifying a constitution is a separate job). The binding gates used instead:

| Gate | Source | Status |
|---|---|---|
| Stack is PRD §9 only; no framework, runtime, Astro-major, AI-SDK, Express, or ORM change | parent locked decision 1, `AGENTS.md` | PASS — zero new packages; `node:crypto` + built-in `fetch`; `node:sqlite` reused |
| Routes exactly `/ask`, `POST /api/ask`, `/admin`, `/admin/login`, `POST /api/admin/login`, `POST /api/admin/logout`, `POST /api/admin/settings` (+ catch-alls) | parent locked decision 2, PRD §6 | PASS — contracts/http-routes.md; `/admin` 401 without session, login separate |
| One content source: committed `content/profile.json` + published `content/case-studies.json`; private profile and case-study notes never read at runtime | parent locked decision 3 | PASS — context builder consumes only the two committed JSON documents; no private document path exists in code |
| Ask body `{question}`, trim, empty 400, >1000 400 before model, gates before model, exact disclaimer/unconfigured text, injection rules, bounded timeout, clean errors | parent locked decision 4, PRD F8 | PASS — contracts/ask-api.md; processing order fixed |
| Server-built citations to profile-backed content; non-empty; href resolves to a real site route/anchor; never parsed from model output | parent decision 5, phase AC | PASS — deterministic section selection; sources and context from the same structure |
| Decline policy for salary/private codebase/named visa; no invented positions; strings in the content source; no salary number | parent decision 6, PRD F8 AC4 | PASS — server-side policy match before the model; `assistantPolicy` block; salary gives no number |
| Settings precedence admin > env > default; per-request resolution; no restart; "configured" = base URL + model + key | parent decision 7 | PASS — settings module resolves on every read; contract test matrix items 9, 10, 17 |
| AES-256-GCM at rest, versioned envelope, fresh IV, auth tag, fail closed, masked last-4, blank secret keeps | parent decision 8, PRD F21 AC7 | PASS — secrets module; admin page/JSON only ever receive the mask |
| Admin auth scrypt/versioned/constant-time, server-side sessions, HttpOnly/SameSite=Strict/8 h, 5-failure 15-min block, same-origin POST, no GET mutation, offline credential script | parent decision 9, PRD F21 AC1/AC2 | PASS — admin-auth + admin-credentials; lockout per IP; origin check |
| Limits: reuse `createRateLimiter` for 10/hour, SQLite UTC-day cap 200, rejected attempts counted, no external call after cap, contact limiter untouched | parent decision 10, PRD F10 | PASS — ask-limits; atomic upsert counter; contact service unchanged |
| SQLite: additive, idempotent migrations for question log, settings, sessions, daily counters; existing data survives; tests cover fresh and upgraded DBs | parent decision 11 | PASS — schema v2 DDL; migration tests |
| SMTP: effective settings per send, no restart, Phase 1 sink/failure/validation behavior stays green | parent decision 12 | PASS — mailer fingerprint cache |
| `.ainative/project.yaml` remains the single test source; existing eight commands extended in place; build card owns the file | parent decision 13 | PASS — exact list below; this card does not edit it |
| Accessibility/performance baseline; one minimal island; `/ask` Lighthouse; `/admin` validated by its own 401/200/noindex checks | parent decision 14, PRD F12 | PASS — no new colour pairs; one module script allow-listed on `/ask` only |
| Privacy/hygiene: full question text only, no answers, no IP, no analytics, `.env.example` documents names with no values | parent decision 15 | PASS — `ask_questions` schema; no tracker; env docs |
| Model-switch proof: new model/base URL observable on the next ask, no restart | parent decision 16 | PASS — per-request resolution + stub-log assertion |
| Testability/hermetic: local OpenAI-compatible stub + injectable client; configured/unconfigured, success, error, timeout, limits, lockout, 401s, encryption, masking, leak probes, citations, model switch | parent decision 17 | PASS — `scripts/ai-stub.mjs`; injected provider/clock; two integration suites |
| Phase/plan edits: only Phase 3's `**Spec:**` line in `PRD.phases.md`; no `PRD.md`, `AGENTS.md`, `.ainative/project.yaml`, `README.md`, or Phase 1/2/4 edits | parent decision 18 | PASS — one-line edit by the specify state; build card verifies |
| No secret, evidence, or private document committed; `specs/*/evidence*` stays out of git | parent card, AGENTS.md | PASS — no secret in any artifact; `.evidence/` remains ignored |

Post-design re-check: unchanged. There are no violations and no new dependency to justify.

## Project Structure

### Documentation (this feature)

```text
specs/003-ask-assistant-admin-settings/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-routes.md
│   ├── ask-api.md
│   └── admin-api.md
├── checklists/
│   └── requirements.md
└── tasks.md             # written by /speckit.tasks
```

### Source Code (repository root)

```text
content/
└── profile.json                     # changed: assistantPolicy block (6 strings)

src/
├── lib/
│   ├── db.mjs                       # changed: schema v2 + settings/session/question/counter accessors
│   ├── env.mjs                      # changed: admin/ask/AI env names, warnings, no value logs
│   ├── secrets.mjs                  # new: ENCRYPTION_KEY parse, AES-256-GCM envelope, mask
│   ├── settings.mjs                 # new: defaults, precedence, validation, save, masked view
│   ├── admin-auth.mjs               # new: scrypt verify, sessions, cookie, lockout, same-origin
│   ├── admin-page.mjs               # new: 401/login/settings HTML renderers (escaped, no-JS)
│   ├── assistant-context.mjs        # new: sections, selection, citations, policy matcher
│   ├── assistant-prompt.mjs         # new: system prompt, context message, injection escaping
│   ├── ai-provider.mjs              # new: OpenAI-compatible fetch client, timeout, typed errors
│   ├── ask-service.mjs              # new: ordered pipeline, validation, policy, provider, logging
│   ├── ask-limits.mjs               # new: per-IP limiter holder + SQLite daily counter wrapper
│   ├── mailer.mjs                   # changed: effective SMTP per send, fingerprint cache
│   ├── site.mjs                     # changed: PUBLIC_PAGE_PATHS gains /ask
│   └── agent-output.mjs             # changed: buildSitemap iterates PUBLIC_PAGE_PATHS
├── pages/
│   ├── ask.astro                    # new: /ask (prerendered)
│   ├── api/
│   │   ├── ask.ts                   # new: POST /api/ask
│   │   └── admin/
│   │       ├── login.ts             # new: POST /api/admin/login
│   │       ├── logout.ts            # new: POST /api/admin/logout
│   │       ├── settings.ts          # new: POST /api/admin/settings
│   │       └── [...path].ts         # new: 401-or-404 catch-all for /api/admin/*
│   └── admin/
│       ├── index.astro              # new: /admin (on demand, 401 or settings form)
│       ├── login.astro              # new: /admin/login (prerendered, noindex)
│       └── [...path].astro          # new: 401-or-404 catch-all for /admin/*
├── components/
│   ├── AskPanel.astro               # new: form, live region, thinking state, one island
│   └── Header.astro                 # changed: Ask nav entry
├── layouts/
│   └── BaseLayout.astro             # changed: optional noindex prop
└── styles/                          # existing tokens; admin/ask styles use them (no new pairs)

scripts/
├── ai-stub.mjs                      # new: local OpenAI-compatible stub + --self-test + --log/--delay-ms/--answer
├── admin-credentials.mjs            # new: --hash (stdin) and --key (base64 32 bytes)
├── check-static-output.mjs          # changed: island allowance, /ask assertions, sitemap, /admin/login+admin absence
├── check-agent-output.mjs           # changed: one-island allowance on /ask, no admin, sitemap /ask, no draft regression
├── test-public-routes.mjs           # changed: /ask, /admin 401, /admin/login 200, noindex, discovery
├── test-contact-api.mjs             # changed: SMTP-settings-take-effect proof
├── lighthouse-check.mjs             # changed: /ask page
└── verify-container.mjs             # changed: /ask, /admin, /admin/login probes

tests/
├── secrets.test.mjs                 # new
├── settings.test.mjs                # new
├── admin-auth.test.mjs              # new
├── admin-page.test.mjs              # new
├── assistant-context.test.mjs       # new
├── assistant-prompt.test.mjs        # new
├── ai-provider.test.mjs             # new
├── ask-service.test.mjs             # new
├── ask-limits.test.mjs              # new
├── ask-api.integration.test.mjs     # new
├── admin-api.integration.test.mjs   # new
├── db.test.mjs                      # changed: schema v2 fresh/upgrade
├── profile.test.mjs                 # changed: assistantPolicy validation
├── mailer.test.mjs                  # changed: effective settings + fingerprint
├── site.test.mjs                    # new: PUBLIC_PAGE_PATHS + sitemap input
└── (Phase 1/2 suites unchanged)

.env.example                         # changed: new names, empty values
package.json                         # unchanged scripts; zero new dependencies
Dockerfile / compose.yaml            # unchanged (dist, content, named volume already correct)
```

**Structure Decision**: single Astro project at the repository root (unchanged from Phase 1). Pages own rendering; `src/lib/*.mjs` owns every rule a test, a route, or a build script must also run, which is why shared logic stays plain ESM. The assistant pipeline is a pure-ish service with injected collaborators (DB, provider, clock, limits), so unit tests never touch the network and the route stays a thin adapter, matching `contact-service.mjs`.

## Concrete contracts (the build must not re-decide these)

### `POST /api/ask`

Request: `Content-Type: application/json`, body `{"question": "<string>"}` only.

Success 200:

```json
{
  "ok": true,
  "answer": "…",
  "disclaimer": "AI assistant. The CV and case studies are the source of record.",
  "sources": [{ "label": "About — Experience", "href": "/about#experience" }],
  "model": "anthropic/claude-haiku-5.5"
}
```

Failure:

```json
{ "ok": false, "error": "validation|rate_limited|daily_cap|unconfigured|provider_error|timeout|storage|server", "message": "…", "errors": {"question": "…"}, "retryAfterSeconds": 1234 }
```

Statuses: 400 validation, 405 method, 415 media type, 429 `rate_limited` / `daily_cap`, 502 `provider_error`, 503 `unconfigured` / `storage`, 504 `timeout`, 500 `server`. Exact messages are in `contracts/ask-api.md`.

### `POST /api/admin/login`, `logout`, `settings`

- Login: form or JSON `{password}`; 303 (form) / 200 (JSON); 401 wrong; 429 locked with `Retry-After`; cookie `admin_session` HttpOnly, SameSite=Strict, Path=/, Max-Age=28800, Secure on HTTPS.
- Logout: session required; deletes the row and clears the cookie; 303/200.
- Settings: session + same-origin required; fields in `contracts/admin-api.md`; all-or-nothing validation; 303 to `/admin?saved=1` (form) or 200 masked JSON; 400 field errors; 403 cross-origin.
- Masked view: non-secret effective/admin values plus `hasApiKey`, `apiKeyMasked`, `hasSmtpPass`, `smtpPassMasked`; never a full secret.

### Settings keys and precedence

`ai.baseUrl`, `ai.model`, `ai.apiKey` (encrypted), `ask.dailyCap`, `ask.rateLimitPerHour`, `smtp.host`, `smtp.port`, `smtp.secure`, `smtp.user`, `smtp.pass` (encrypted), `smtp.from`, `generator.endpoint`. `effective = admin row if non-empty, else env, else default`. Defaults: `https://openrouter.ai/api/v1`, `anthropic/claude-haiku-5.5`, daily cap 200, 10/hour, SMTP port 587, secure false, from `Emad Poursina <emad.poursina.work@gmail.com>`.

### Content policy block

`content/profile.json.assistantPolicy` with `disclaimer` (exact), `unavailable` (exact), `notAvailable`, `salary`, `privateCodebase` (with `{caseStudiesPath}`), `visa` (contains the exact authorization line). Details in `data-model.md`.

## Implementation approach

### A. Content and policy

- Add `assistantPolicy` to `content/profile.json` with the six strings in `data-model.md`; extend `validateProfile` to require the object, all six non-empty strings, and exact `disclaimer`/`unavailable` values.
- `src/lib/assistant-context.mjs` derives sections and citations from the profile and published studies as specified; `selectSections(question)` returns ordered sections; `matchPolicy(question)` returns the first salary/visa/private-codebase match; `buildPolicyAnswer(policy, match)` replaces `{caseStudiesPath}` and returns the fixed sources.
- No private document is read; no fact is duplicated from About/CV/agent outputs.

### B. Database schema version 2

- `src/lib/db.mjs`: keep the lazy open and health behavior; add the version-2 DDL block, the four tables, and the two indexes; set `user_version = 2` after a successful block.
- Accessors: `getSetting`, `getAllSettings`, `setSetting`, `deleteSetting`, `applySettings(entries)` (transaction), `createSession`, `getSession`, `deleteSession`, `deleteExpiredSessions`, `insertQuestion`, `countQuestions`, `consumeDailyAsk(day, cap)` (atomic upsert with `RETURNING`), `getSchemaVersion`.
- Fresh and upgraded database tests; a contact row inserted under version 1 survives.

### C. Secrets and settings

- `src/lib/secrets.mjs`: key parsing (base64/hex, exactly 32 bytes), AES-256-GCM encrypt/decrypt with `v1:iv:tag:ciphertext`, `maskSecret`, typed errors, one warning for a missing/invalid key.
- `src/lib/settings.mjs`: the key table, defaults, env fallbacks, per-read resolution, validation (URL rules, numeric bounds, SMTP fields), all-or-nothing save, masked view. It reads the DB through `db.mjs` and the environment through `env.mjs`; it has no process-lifetime settings cache.
- `src/lib/env.mjs`: add `ADMIN_PASSWORD_HASH`, `ENCRYPTION_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `ASK_DAILY_CAP`, `ASK_RATE_LIMIT_PER_HOUR`, `AI_TIMEOUT_MS`; warn once per disabled feature; never log values.

### D. Admin authentication and sessions

- `src/lib/admin-auth.mjs`: `verifyPassword` (versioned scrypt, constant-time), `createSession`, `getSessionFromRequest`, `destroySession`, `isBlocked`, `recordFailure`, `clearFailures`, `isSameOrigin`, `buildSessionCookie`, `clearSessionCookie`. Clock injectable.
- Session ids are 32 random bytes hex; the row is the authority; expiry is absolute 8 hours; expired rows are removed on lookup.
- Lockout is in memory per IP (research D6); five failures in 15 minutes block for 15 minutes; a correct password during the block is still 429.
- `/api/admin/*` handlers call the same guard; no route trusts the cookie alone.

### E. Assistant pipeline

- `src/lib/ai-provider.mjs`: as in research D11; typed `{kind:'upstream'|'timeout'}` errors; no upstream body in the message; timeout from `AI_TIMEOUT_MS`, capped at 30,000 in production.
- `src/lib/assistant-prompt.mjs`: the system prompt and the labelled context/question message; escapes the question delimiters; inserts only the selected sections.
- `src/lib/ask-service.mjs`: the ordered pipeline (parse/validate are partly in the route; the service owns the rest), per-IP gate, configured check, question log, daily cap, policy, provider, response assembly. Collaborators injected: `{db, settings, limits, provider, now}`. The service returns `{status, payload}` like `contact-service.mjs`.
- `src/pages/api/ask.ts`: method/content-type/body parsing, client IP extraction (same `TRUST_PROXY` rule as contact), `no-store` headers, `Retry-After`, and no leaked detail on unexpected errors.

### F. Ask page and island

- `src/pages/ask.astro` (prerendered): title/intro, `<AskPanel />`, `noscript` guidance with a contact link, and the static disclaimer.
- `src/components/AskPanel.astro`: the labelled textarea with `maxlength="1000"`, submit button, a `role="status" aria-live="polite"` region, an answer container, and exactly one Astro-processed module script. The script prevents the default submit, sets the thinking text, disables the button, `fetch`es `/api/ask` with JSON, renders the answer via `textContent`, builds citation links only for hrefs starting with `/`, shows the disclaimer, maps 400/429/503/502/504 to the contract messages, and restores the button in `finally`. No other page gets a script.
- `/ask` uses existing tokens and focus styles; the island is small enough to keep Lighthouse Performance ≥ 95.

### G. Admin pages and API

- `src/lib/admin-page.mjs`: pure HTML renderers for the 401 page, the login page shell, and the settings page (form, errors, notices, masked placeholders, `noindex`). All interpolated values are HTML-escaped; no full secret is ever passed in.
- `src/pages/admin/login.astro` (prerendered): the login form and noindex; posts urlencoded to `/api/admin/login`.
- `src/pages/admin/index.astro` (`prerender = false`): session check; 401 HTML or the settings page; posts to `/api/admin/settings`; separate logout form.
- `src/pages/api/admin/login.ts`, `logout.ts`, `settings.ts`: contracts above; same-origin check in `settings.ts` (and login/logout accept same-origin browser forms; Astro's `security.checkOrigin` already rejects cross-site POSTs, and the explicit check is added to every mutating handler for defense in depth).
- Catch-alls: `/api/admin/[...path].ts` (401 JSON or 404 JSON) and `/admin/[...path].astro` (401 HTML or 404 HTML).
- `BaseLayout.astro`: optional `noindex` prop emits `<meta name="robots" content="noindex, nofollow">`; admin pages set it; public pages do not.

### H. SMTP effective settings

- `src/lib/mailer.mjs`: `status()` uses `settings.getEffectiveSmtp()`; `send()` resolves effective settings, fingerprints `{host, port, secure, user, pass}`, reuses the transport only while the fingerprint matches, and rebuilds otherwise. Missing/invalid settings keep delivery disabled with one warning. `resetTransport()` remains.
- `contact-service.mjs` and `src/pages/api/contact.ts` stay unchanged; their tests stay green.

### I. Checks and tests

- `scripts/ai-stub.mjs`: dependency-free HTTP stub; logs `{model, messages}` per request to `--log`; `--delay-ms` for timeout; `--answer <text>` to vary the returned content; `--self-test`; returns `choices[0].message.content`.
- `scripts/admin-credentials.mjs`: `--hash` reads the password from stdin and prints `ADMIN_PASSWORD_HASH=scrypt$…`; `--key` prints `ENCRYPTION_KEY=<base64>`; no password echo.
- New unit suites (see Project Structure) and two integration suites:
  - `tests/ask-api.integration.test.mjs`: stub configured via env; success/citations/disclaimer/model; 400/415; 503 unconfigured; 502/504; policy; limits (11th, cap+restart); log; no-secret probes.
  - `tests/admin-api.integration.test.mjs`: 401s, login/logout, lockout, expiry, settings validation, masking, encryption-at-rest, cross-origin 403, model switch, SMTP switch, noindex.
- Existing scripts extended:
  - `check-static-output.mjs`: island allowance on `/ask` only; `/ask` content; sitemap `/ask` and no admin; on-demand artifacts absent; `/admin/login` noindex and `/admin` artifact absent (T025).
  - `check-agent-output.mjs`: the same one-island allowance on `/ask` only; sitemap `/ask`; no admin in any agent output; no draft regression.
  - `test-public-routes.mjs`: `/ask` 200 + form/disclaimer; `/admin` 401 + noindex; `/admin/login` 200 + noindex; nav/discovery assertions; Phase 1/2 regression.
  - `test-contact-api.mjs`: after the existing contact proof, log in, save SMTP to a second sink, send a second message, assert it reaches the new sink with no restart; keep the delivery-failure instance.
  - `lighthouse-check.mjs`: add `{name:'ask', path:'/ask'}` to `PAGES`.
  - `verify-container.mjs`: probe `/ask` 200, `/admin` 401, `/admin/login` 200, `POST /api/ask` 503 unconfigured, `POST /api/admin/login` 401; keep existing probes and the volume-persistence assertion.
- `check-contrast.mjs` needs no new pair because the new components reuse the existing tokens; the build must run it and the plan's tests assert no new hard-coded colours (a grep in review).

### J. Validation commands and ownership

`.ainative/project.yaml` must remain exactly, in order (the **build card** owns the file; this card does not edit it):

```yaml
validation_commands:
  - npm ci
  - npm run build
  - npm test
  - node scripts/check-agent-output.mjs
  - node scripts/test-public-routes.mjs
  - node scripts/test-contact-api.mjs
  - node scripts/lighthouse-check.mjs
  - node scripts/verify-container.mjs
```

Ownership notes:

- The build card owns `.ainative/project.yaml` and `README.md`; this card is barred from both. The build card verifies the eight commands and that `npm test` picks up the new suites.
- `.env.example` is not in the ban list; the build card adds the new names with empty values.
- `package.json` keeps its current scripts; `npm test` already runs `node --experimental-sqlite --test tests/*.test.mjs`, which picks up the new unit and integration files. No dependency is added.
- `Dockerfile` and `compose.yaml` need no change: `dist/` and `content/` are already copied, `DATA_DIR` is already the volume, and the runtime entry already uses `--experimental-sqlite`.
- Phase 3's `**Spec:**` line in `PRD.phases.md` is set by this card's specify state; the build card only verifies it.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Model invents a fact despite the prompt | High | Profile-only context selected per question; `notAvailable` instruction; policy interception for the sensitive classes; monthly review remains an owner task (F16 is V1.1) |
| Prompt injection reveals system text or secrets | High | No secret ever enters the prompt; question escaped and labelled data; system rules forbid following visitor text; leak probes in integration tests |
| Citation points at a page that does not exist | Medium | Href allow-list derived from real routes; static check and integration tests assert each href; published-only study sections |
| Admin key decryption fails after an `ENCRYPTION_KEY` change | High | Fail closed, warn once, treat as unconfigured, allow overwrite from the panel; never plaintext |
| Daily counter race lets extra calls through | Medium | Single atomic upsert with `RETURNING`; concurrency test at the cap boundary |
| Admin session fixation or CSRF | High | Random server-side session id, HttpOnly/SameSite=Strict, origin check, no GET mutations, logout revocation |
| Lockout memory growth from many IPs | Low | Prune on access; entries are tiny; single-container scale |
| `/ask` island regresses the no-JS baseline | Medium | Static-output check allows exactly one module script on `/ask` only; every other page stays script-free; Lighthouse on `/ask` |
| SMTP transport cache serves stale credentials | Medium | Fingerprint includes host/port/secure/user/pass; a change rebuilds; test proves the second sink receives the message |
| Stub/SMTP tests collide over shared `.evidence` logs | Low | Stub takes a `--log` path; integration tests use temporary logs; the SMTP sink test runs in its own script |
| Existing Phase 1/2 behavior regresses | High | Every existing check stays in the eight-command list; new tests assert the old statuses/content; container probe and Lighthouse keep the old pages |

## Complexity Tracking

> No Constitution Check violations. The items below are design choices worth recording, not waivers.

| Choice | Why needed | Simpler alternative rejected because |
|---|---|---|
| Four new tables instead of one | settings, sessions, question log, and daily counters have different lifetimes and access patterns | one JSON/settings blob cannot express atomic daily increments or session revocation cleanly |
| Server-side sessions + opaque cookie | logout and 8-hour absolute expiry must be authoritative | a signed stateless cookie cannot be revoked; an in-memory session is lost on restart |
| Deterministic context/citation selection | the AC forbids model-generated citations and requires real hrefs | asking the model for citations is fabricatable and needs parsing; citing everything is noisy and not "used" |
| Server-side policy interception | the decline wording and the no-salary-number rule must be guaranteed | prompt-only enforcement is model-dependent and untestable |
| One island on `/ask` only | the thinking state and disabled submit require client JS, while static content must not | a no-JS form cannot show an in-flight state; adding islands to other pages breaks the baseline |
| In-memory lockout, SQLite sessions/counter | the PRD's limiter pattern is in-memory; the lockout is short-lived | a fifth table adds schema and cleanup for a 15-minute signal; a restart clearing the block is not attacker-controlled |
| Fingerprint-cached SMTP transport | saved settings must apply without restart, but per-message transports add connection cost | a module-load transport fails the no-restart AC; a per-send transport is unnecessarily chatty |
| No new dependency | every capability exists in Node 22 or the current stack | bcrypt/JWT/OpenAI SDK/Express-rate-limit duplicate core or existing behavior and violate the stack rule |
