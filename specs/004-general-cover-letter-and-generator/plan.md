# Implementation Plan: Phase 4 — General Cover Letter and Generator Path

**Branch**: `emad-personal-site/t_0ca1a753-phase-4-general-cover-letter-and-generat` | **Date**: 2026-11-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-general-cover-letter-and-generator/spec.md`; scope authority `PRD.phases.md` § Phase 4; requirements `PRD.md` v1.4 F5/F9/F10, §4 Journey 4, §6, §8, §9, §12 R11, §13.

## Summary

Add the public general cover letter at `/cover-letter` and the optional job-description generator behind `POST /api/cover-letter` on the existing Astro 5 + Node 22 + `node:sqlite` stack. The letter is a committed content document (`content/cover-letter.json`) validated at build time and rendered server-side with no client JavaScript; a prebuild check fails the build, naming the phrase and field, if any of the six PRD-banned phrases appears. The page is on-demand because the generator form must be hidden when the generator is unconfigured (admin `generator.endpoint` > env `GENERATOR_ENDPOINT`, plus env-only `GENERATOR_API_KEY`). A valid, configured submission calls a single documented adapter with a 30-second bound; the server appends only the missing required authorization line and sign-off before display, and a generator error or timeout returns 502/504 with the general letter as the fallback. The cover-letter per-IP window is a separate 10-per-hour limiter, and the existing SQLite UTC-day cap becomes shared with `/api/ask` without renaming `ASK_DAILY_CAP` or `ask.dailyCap`; schema version 3 adds one bounded `daily_cap_events` table. No dependency is added; tests are hermetic against a local generator stub.

## Technical Context

**Language/Version**: Node.js 22 LTS in the container (host 26.7.0); TypeScript inside `.astro` pages and API routes; plain ESM JavaScript (`.mjs`) for shared logic, the adapter, limits, scripts, and tests so `node --test` and `node scripts/*.mjs` run without a transform.

**Primary Dependencies**: existing `astro@5.18.2` + `@astrojs/node` (standalone), `nodemailer`, `pdfkit`; Node core `node:sqlite`, `node:http` (stub), `fetch`/`AbortController`, `node:test`. **No new runtime or dev dependency.**

**Storage**: SQLite via `node:sqlite` `DatabaseSync`, schema version 3. Existing tables unchanged; new `daily_cap_events`. No content storage (no job description, no letter). `DATA_DIR/site.sqlite` on the existing named volume.

**Testing**: `node:test` unit suites for the content document, the letter builder/enforcer, the generator adapter, the cover-letter service, the limits, and the settings/env changes; one `node:test` integration suite that spawns `dist/server/entry.mjs` against `scripts/generator-stub.mjs` (and `scripts/ai-stub.mjs` for the shared-cap proof); existing `test-public-routes.mjs`, `check-static-output.mjs`, `check-agent-output.mjs`, `lighthouse-check.mjs`, `verify-container.mjs` extended in place.

**Target Platform**: Linux, single `node:22-bookworm-slim` container, plain HTTP locally, HTTPS later.

**Project Type**: web application — prerendered content pages, one interactive island on `/ask`, one on-demand page with one island on `/cover-letter`, and on-demand API/admin routes.

**Performance Goals**: `/cover-letter` LCP < 2.0 s and Lighthouse Performance ≥ 95 / Accessibility 100 on the mobile profile; API response time < 500 ms excluding generator latency; no client JS on any page except the `/ask` and `/cover-letter` islands; `/api/cover-letter` `no-store`.

**Constraints**: PRD §9 stack only; no generator SDK, HTTP client, validation library, Express, ORM, or Astro major upgrade; generator key only in `.env`; the admin form keeps its 12 fields; no job description or letter stored; every acceptance check runnable from the existing eight validation commands in order; no evidence or secrets committed; VoiceDash stays draft; `/admin*` stays undiscoverable.

**Scale/Scope**: 1 new HTML route (`/cover-letter`, on demand), 1 new API route, 1 new committed content file, 1 additive SQLite table, 5 new `src/lib` modules, 2 new components, 1 modified prebuild step, 2 new scripts, 6 new test files, and in-place extensions to 5 existing scripts. Single container; 100 concurrent visitors in year 1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unratified Spec Kit template (`[PRINCIPLE_N_NAME]`/`[PRINCIPLE_N_DESCRIPTION]`, no version or ratification date), so it states no normative rule this plan could violate. The plan does not invent one (ratifying a constitution is a separate job). The binding gates used instead:

| Gate | Source | Status |
|---|---|---|
| Stack is PRD §9 only; no framework, runtime, Astro-major, generator-SDK, HTTP-client, or ORM change | parent locked decision 1, `AGENTS.md` | PASS — zero new packages; built-in `fetch`, `node:sqlite`, `node:http` stub |
| Content source: committed `content/cover-letter.json`; every fact traces to `content/profile.json`; server-rendered with no client JS to read | parent decision 2, PRD F5 | PASS — content document + build validation + component render; no hardcoded letter copy |
| Banned-phrase gate in the `npm run build` chain, scans the rendered letter, names the phrase | parent decision 3, PRD F5 AC3 | PASS — `scripts/check-cover-letter.mjs` in `prebuild`; fixture test proves it fails |
| Routes exactly `/cover-letter` and `POST /api/cover-letter`; nav + sitemap; no new admin discovery surface | parent decision 4, PRD §6 | PASS — contracts/http-routes.md; admin untouched |
| Generator configuration precedence: admin endpoint > env > empty; env-only key; `configured` = endpoint AND key; per-request resolution; unconfigured hides the form and 503s | parent decision 5, F9 AC4 | PASS — `getEffectiveGenerator()` resolves on every call; no cache |
| Adapter contract fixed and documented as the single integration point; 30 s bound; no upstream body or secret echoed | parent decision 6, PRD R11 | PASS — contracts/generator-adapter.md; `generator-provider.mjs` is the only outbound module |
| Required lines enforced server-side; append only; never rewrite the body | parent decision 7, F9 AC2 | PASS — `ensureRequiredLines()` pure function; same constants feed the build check |
| Failure/fallback: 502/504 with the general letter in the response; nothing stored | parent decision 8, F9 AC3 | PASS — `fallback` + `generalLetter` fields; no insert path exists |
| Limits: per-IP 10/hour via `createRateLimiter`; shared SQLite UTC-day cap without renaming `ASK_DAILY_CAP`/`ask.dailyCap`; 429 + `Retry-After`; no call after cap | parent decision 9, F10 | PASS — `cover-letter-limits.mjs` + `daily-cap.mjs`; counter row unchanged |
| Validation: trim, empty 400, >8,000 400 before any external call; exactly 8,000 allowed; stable JSON errors | parent decision 10, F9 AC5 | PASS — `validateJobDescription` before the counter and the adapter |
| Privacy/storage: no job description or letter persisted; no IP or body in new logs; counters and one bounded cap event only | parent decision 11, F9 AC3 | PASS — schema has no content column; tests read the DB and logs |
| Testability/hermetic: local generator stub + injectable client; configured/unconfigured, success, appending, error/timeout, 429s, shared cap + restart, input limits, banned-phrase failure, leak probes | parent decision 12 | PASS — `scripts/generator-stub.mjs`; injected collaborators; one integration suite |
| `.ainative/project.yaml` remains the single test source; eight commands extended in place; build card owns the file | parent decision 13 | PASS — exact list below; this card does not edit it |
| Accessibility/performance: semantic HTML, labelled controls, keyboard-complete, focus, contrast, reduced motion; Lighthouse gate extended to `/cover-letter`; home and `/ask` unchanged | parent decision 14, PRD F12/§8 | PASS — existing tokens; one new page entry in `PAGES` |
| Plan edits: only Phase 4's `**Spec:**` line in `PRD.phases.md`; no `PRD.md`, `AGENTS.md`, `.ainative/project.yaml`, `README.md`, or other phase sections | parent decision 15 | PASS — one-line edit; build card verifies |
| Feature number 004; `.specify/feature.json` points at the feature dir | parent decision 16 | PASS — created; `specs/001`–`003` untouched |
| Phase of a phased PRD is a `feature` run | parent decision 17 | PASS — route stage reports `feature`, `SKILL: none` |
| No secret, evidence, or private document committed; `specs/*/evidence*` stays out of git | parent card, `AGENTS.md` | PASS — no secret in any artifact; `.evidence/` remains ignored |

Post-design re-check: unchanged. There are no violations and no new dependency to justify.

## Project Structure

### Documentation (this feature)

```text
specs/004-general-cover-letter-and-generator/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-routes.md
│   ├── cover-letter-api.md
│   └── generator-adapter.md
├── checklists/
│   └── requirements.md
└── tasks.md             # written by /speckit.tasks
```

### Source Code (repository root)

```text
content/
└── cover-letter.json                 # new: greeting, paragraphs, authorization, signoff, links, lastUpdated

src/
├── lib/
│   ├── cover-letter.mjs              # new: load/validate/build general letter, ensureRequiredLines, banned phrases
│   ├── cover-letter-service.mjs      # new: validateJobDescription, processCoverLetter (ordered pipeline)
│   ├── cover-letter-limits.mjs       # new: per-IP 10/hour for /api/cover-letter + shared consumeDaily
│   ├── daily-cap.mjs                 # new: shared UTC-day consume + one bounded cap event
│   ├── generator-provider.mjs        # new: outbound adapter, 30 s bound, typed GeneratorError
│   ├── settings.mjs                  # changed: getEffectiveGenerator() (endpoint/key/timeout/configured)
│   ├── env.mjs                       # changed: GENERATOR_ENDPOINT/API_KEY/TIMEOUT_MS, one warning, no values
│   ├── db.mjs                        # changed: schema v3 + insertCapEvent/getCapEvent/countCapEvents
│   ├── site.mjs                      # changed: PUBLIC_PAGE_PATHS gains '/cover-letter'
│   └── admin-page.mjs                # changed: daily-cap label states the shared meaning (no new field)
├── components/
│   ├── CoverLetter.astro             # new: semantic letter article (greeting, paragraphs, lines, links)
│   ├── CoverLetterForm.astro         # new: form, status/alert regions, one module island
│   └── Header.astro                  # changed: Cover Letter nav entry
├── pages/
│   ├── cover-letter.astro            # new: on-demand page, form only when configured
│   └── api/
│       └── cover-letter.ts           # new: POST /api/cover-letter
└── styles/                           # existing tokens only (no new colour pair)

scripts/
├── check-cover-letter.mjs            # new: content validation + banned-phrase gate (prebuild)
├── generator-stub.mjs                # new: local generator stub + --self-test
├── check-static-output.mjs           # changed: no /cover-letter artifact, sitemap path list
├── check-agent-output.mjs            # changed: /cover-letter exactly once after /contact, no admin
├── test-public-routes.mjs            # changed: unconfigured + configured page, POST probes, nav, sitemap
├── lighthouse-check.mjs              # changed: PAGES gains cover-letter
└── verify-container.mjs              # changed: /cover-letter 200, POST 503, route count

tests/
├── cover-letter-content.test.mjs     # new
├── generator-provider.test.mjs        # new
├── cover-letter-service.test.mjs      # new
├── cover-letter-limits.test.mjs       # new
├── cover-letter-api.integration.test.mjs # new
├── daily-cap.test.mjs                # new
├── db.test.mjs                       # changed: schema v3 fresh/upgrade, cap events
├── settings.test.mjs                 # changed: getEffectiveGenerator precedence and masking
├── env.test.mjs                      # changed: new names, warning once, no value in output
├── site.test.mjs                     # changed: PUBLIC_PAGE_PATHS + sitemap order
└── admin-page.test.mjs               # changed: shared-cap label (if it asserts the label text)

package.json                          # changed: prebuild adds check-cover-letter.mjs; no dependency change
.env.example                          # changed: three new names, empty values; shared-cap comment
Dockerfile / compose.yaml             # unchanged (dist, content, named volume already correct)
```

**Structure Decision**: single Astro project at the repository root (unchanged). Pages own rendering; `src/lib/*.mjs` owns every rule a test, a route, or a build script must also run — which is why the letter builder, the required-line enforcer, the adapter, and the limits are plain ESM. The cover-letter pipeline is a service with injected collaborators (`db`, `settings`, `limits`, `provider`, `now`, `profile`, `letterDoc`), so unit tests never open a socket and the route stays a thin adapter, matching `ask-service.mjs` and `contact-service.mjs`.

## Concrete contracts (the build must not re-decide these)

### `POST /api/cover-letter`

Request: `Content-Type: application/json`, body `{"jobDescription": "<string>"}` only.

Success 200:

```json
{ "ok": true, "letter": "…", "appended": { "authorization": false, "signoff": true } }
```

Failure:

```json
{
  "ok": false,
  "error": "validation|rate_limited|daily_cap|unconfigured|storage|generator_error|generator_timeout|server",
  "message": "…",
  "errors": { "jobDescription": "…" },
  "retryAfterSeconds": 1234,
  "fallback": true,
  "generalLetter": "…"
}
```

Statuses: 400 validation, 405 method, 415 media type, 429 `rate_limited`/`daily_cap`, 502 `generator_error`, 503 `unconfigured`/`storage`, 504 `generator_timeout`, 500 `server`. `fallback` and `generalLetter` appear only on 502/504. Exact messages are in `contracts/cover-letter-api.md`.

### `GET /cover-letter`

- Unconfigured: 200 HTML, one `<h1>`, the general letter (greeting → paragraphs → authorization → sign-off → LinkedIn → GitHub), no `<form`, no executable script, `Cache-Control: no-store`.
- Configured: the same letter plus `<form>` with `<textarea id="jobDescription" name="jobDescription" maxlength="8000">`, a `<label for="jobDescription">`, a submit button, a `role="status" aria-live="polite"` region, a `role="alert"` error region, and exactly one `<script type="module" src="/_astro/…">`.

### Generator configuration and precedence

`getEffectiveGenerator()` → `{ endpoint, apiKey, timeoutMs, configured }`.

- `endpoint` = admin `generator.endpoint` (non-empty, URL-valid) else env `GENERATOR_ENDPOINT` (URL-valid) else `''`; trailing slashes trimmed (existing Phase 3 rule).
- `apiKey` = env `GENERATOR_API_KEY` only, trimmed; never returned by `getMaskedSettings()` or any route.
- `timeoutMs` = env `GENERATOR_TIMEOUT_MS`, default 30,000, capped at 30,000.
- `configured` = `endpoint !== '' && apiKey !== ''`, resolved on every request.

### Generator adapter

`callGenerator({ endpoint, apiKey, jobDescription, candidate, timeoutMs, fetchImpl })` → `Promise<string>` (trimmed letter). Full request/response/mapping in `contracts/generator-adapter.md`; `GeneratorError{kind:'upstream'|'timeout', status?}` is the only error type.

### Content document

`content/cover-letter.json` with `greeting`, `paragraphs`, `authorization`, `signoff`, `links`, `lastUpdated`; rules and derived text in `data-model.md`. `buildGeneralLetter(doc)` is the single source of the letter text used by the page, the build check, and the API fallback.

### Shared daily cap

Both endpoints call `consumeDaily(db, day, cap)` from `src/lib/daily-cap.mjs`, which delegates to the unchanged `db.consumeDailyAsk(day, cap)` and, when the result is over cap, writes one `daily_cap_events` row (`INSERT OR IGNORE`) and one console line. `ASK_DAILY_CAP` / `ask.dailyCap` keep their names and mean the combined cap.

## Implementation approach

### A. Content document and letter library

- Add `content/cover-letter.json`: `Dear Hiring Manager,` greeting; 3 paragraphs drafted from `profile.bio`, the experience timeline, and the target roles/countries; the exact authorization line; the exact sign-off; the two links; `lastUpdated` `2026-11-09`. No city/date letterhead, no banned phrase, no URL or email inside the paragraphs.
- `src/lib/cover-letter.mjs`: `loadCoverLetter()` (`COVER_LETTER_PATH` → cwd → module-relative), `validateCoverLetter(doc, {profile})` returning field-level errors, `BANNED_PHRASES`, `findBannedPhrases(text)`, `buildGeneralLetter(doc)`, `ensureRequiredLines(text)`, `REQUIRED_AUTHORIZATION`, `SIGNOFF`. Pure: no Astro, no DB, no network.

### B. Banned-phrase build gate

- `scripts/check-cover-letter.mjs`: load and validate; build the letter text; scan the six phrases case-insensitively; print `cover letter ok` or `FAIL: banned phrase "<phrase>" found in <field>` / the validation error; exit 1 on failure.
- `package.json` `prebuild` becomes `node scripts/check-profile.mjs && node scripts/check-cover-letter.mjs && node scripts/build-cv.mjs && node scripts/check-contrast.mjs`, so `npm run build` fails before Astro compiles.
- `tests/cover-letter-content.test.mjs` includes a fixture test that writes a temporary content file containing each banned phrase (via `COVER_LETTER_PATH`) and spawns the script, asserting exit 1 and the phrase in stderr; plus a pass case on the shipped content.

### C. Schema version 3 and the shared cap

- `src/lib/db.mjs`: `SCHEMA_VERSION = 3`; after the version-2 block, `if (version < 3) { db.exec(SCHEMA_V3_SQL); db.exec('PRAGMA user_version = 3'); }`; add `insertCapEvent(day, feature)`, `getCapEvent(day, feature)`, `countCapEvents()`.
- `src/lib/daily-cap.mjs`: `utcDayKey(now)`, `consumeDaily(db, day, cap, feature)` → `{count, allowed}`, writing the event on the first over-cap request; `recordCapEvent` best effort (a failure logs a warning and never blocks the 429).
- `src/lib/ask-limits.mjs`: keep `checkPerIp`, `utcDayKey`, `consumeDaily(db, day, cap)`; delegate to `daily-cap.mjs` with `feature:'ask'`, so Phase 3 tests and `ask-service.mjs` stay unchanged.

### D. Generator configuration

- `src/lib/env.mjs`: parse `GENERATOR_ENDPOINT`, `GENERATOR_API_KEY`, `GENERATOR_TIMEOUT_MS` (default/max 30,000); warn once when the generator is partially configured (`GENERATOR_ENDPOINT, GENERATOR_API_KEY required`), never log values.
- `src/lib/settings.mjs`: add `getEffectiveGenerator()`; leave `SETTINGS_FIELDS`, `getEffectiveSettings`, `getMaskedSettings`, and `saveSettings` behavior unchanged (the endpoint already resolves admin → env → empty). The function wraps the settings read in `try/catch` and fails closed to unconfigured with one warning, so a broken database cannot turn `/cover-letter` or the API into a 500.
- `src/lib/admin-page.mjs`: change only the `askDailyCap` label to `Daily cap (assistant + cover letter)`; the field name, order, and validation stay identical.

### E. Generator adapter

- `src/lib/generator-provider.mjs`: as `contracts/generator-adapter.md`; `buildGeneratorRequest(profile, jobDescription)` and `readGeneratorResponse(data)` are separate pure helpers so a real-service remap touches one function. Timeout via `AbortController`, timer cleared in `finally`, error messages free of upstream bodies and secrets.

### F. Cover-letter service

- `src/lib/cover-letter-service.mjs`: `validateJobDescription(rawInput)` (object, string, trim, 1–8,000, exact messages) and `processCoverLetter(rawInput, clientIp, deps)` implementing the contract order with injected `{db, settings, limits, provider, now, profile, letterDoc, generalLetter}`; returns `{status, payload}` like `ask-service.mjs`.
- On success: `ensureRequiredLines(letter)`; return `{ok:true, letter, appended}`.
- On adapter error: 502/504 with `fallback:true` and `generalLetter` (built once per request); on any unexpected failure: 500 with the fixed message.

### G. Page, components, and island

- `src/components/CoverLetter.astro`: `<article>` with the greeting, paragraphs, authorization, sign-off, and a `<ul>` of the two links; text escaped by Astro; uses existing tokens.
- `src/components/CoverLetterForm.astro`: labelled textarea with `maxlength="8000"`, hint, submit, status/alert/result regions, `<noscript>` with a `/contact` link, and one module script that prevents native submit, sets `Writing your letter…`, disables the button, POSTs JSON, renders `letter` with `textContent`, maps statuses, re-enables in `finally`, and ignores a second in-flight submit.
- `src/pages/cover-letter.astro`: `prerender = false`; `Astro.response.headers.set('Cache-Control','no-store')`; `<BaseLayout>` + `<h1>Cover Letter</h1>` + intro + `<CoverLetter />` + conditional `<CoverLetterForm />` when `getEffectiveGenerator().configured`.
- `src/components/Header.astro`: insert `<li><a href="/cover-letter">Cover Letter</a></li>` after Case Studies and before Ask.

### H. Limits wiring

- `src/lib/cover-letter-limits.mjs`: `DEFAULT_COVER_LETTER_RATE_LIMIT = 10`; one module-level `createRateLimiter({windowMs:3_600_000, limit:10})`; `checkPerIp(key)`; `consumeDaily(db, day, cap)` delegating with `feature:'cover_letter'`; console events with no IP or body.
- `src/pages/api/cover-letter.ts`: method/content-type/body parsing, client key with the same `TRUST_PROXY` rule as `/api/ask`, `no-store`/`nosniff`/`Content-Language` headers, `Retry-After` when present, `Allow: POST` on 405, and a catch-all 500.

### I. Checks and tests

- `scripts/generator-stub.mjs`: dependency-free `node:http`; records a redacted request line (no full key) to `--log`; `--letter`, `--status`, `--delay-ms`, `--port`, `--self-test`.
- New unit suites: `cover-letter-content`, `generator-provider`, `cover-letter-service`, `cover-letter-limits`; extended `db`, `settings`, `env`, `site`, and `admin-page` suites.
- `tests/cover-letter-api.integration.test.mjs`: boots `dist/server/entry.mjs` with a temporary `DATA_DIR`, the generator stub, and (for the shared-cap proof) `scripts/ai-stub.mjs`; covers the contract test matrix 1–20 including the configured/unconfigured page, appending, 502/504 fallback, per-IP 429, shared cap with ask, restart persistence, and leak probes.
- Existing scripts extended in place:
  - `check-static-output.mjs`: `dist/client/cover-letter` and `dist/client/api/cover-letter` absent; sitemap expected paths gain `/cover-letter` after `/contact`.
  - `check-agent-output.mjs`: sitemap `/cover-letter` exactly once after `/contact`; no admin facts; draft regression unchanged.
  - `test-public-routes.mjs`: sitemap expected paths and nav page list gain `/cover-letter`; `/cover-letter` unconfigured probe (letter lines, links, no form, no banned phrase, no-JS text); a second boot with `GENERATOR_ENDPOINT`/`GENERATOR_API_KEY` asserting the form, `maxlength="8000"`, the live region, and at most one module script; `POST /api/cover-letter` 503 unconfigured and 400 empty.
  - `lighthouse-check.mjs`: `{name:'cover-letter', path:'/cover-letter'}`.
  - `verify-container.mjs`: `/cover-letter` 200 with the exact authorization line, `POST /api/cover-letter` → 503 `unconfigured`, and the hardcoded `routesPassed === 11` becomes the new count (13).

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
- `.env.example` is not in the ban list; the build card adds the three names with empty values and updates the `ASK_DAILY_CAP` comment to the shared meaning.
- `package.json` keeps its scripts except `prebuild`, which gains `check-cover-letter.mjs`. No dependency is added.
- `Dockerfile` and `compose.yaml` need no change: `dist/` and `content/` are already copied, `DATA_DIR` is already the volume, and the runtime entry already uses `--experimental-sqlite`.
- Phase 4's `**Spec:**` line in `PRD.phases.md` is set by this card's specify state; the build card only verifies it.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The real generator contract differs from the adapter | Medium | The adapter is one module with pure `buildGeneratorRequest`/`readGeneratorResponse` helpers; the operator checklist in contracts/generator-adapter.md is the remap procedure; production stays unconfigured until confirmed |
| A banned phrase slips into the letter through a content edit | High (PRD F5 AC3) | Prebuild check blocks the build and names the phrase and field; a fixture test proves the check fails |
| The generator returns a letter without the required lines | High | `ensureRequiredLines` appends exact missing lines; unit and integration tests cover each combination |
| Generator error/timeout leaves the visitor with nothing | Medium | 502/504 responses carry the general letter and the page always renders it; tests assert the fallback body |
| Go-live without the real key or endpoint | Medium | Unconfigured state is the default: form hidden, API 503, general letter unaffected |
| The shared cap breaks the assistant | High (regression) | Same table and function as Phase 3; ask-limits keeps its exports; the Phase 3 ask suites stay green; a shared-cap test proves two questions plus one generation equals three |
| Per-IP limiter shares state with the ask limiter | Medium | Separate limiter instance; a test sends 10 ask requests then a cover-letter request and asserts it is allowed |
| A second island breaks the no-JS baseline | Medium | Only `/ask` (prerendered) and `/cover-letter` (on-demand) carry a module script; the static check proves no other prerendered page gained one; the runtime probe strips scripts and re-asserts the letter |
| `/cover-letter` is accidentally prerendered and serves a stale form state | Medium | `check-static-output` asserts no `dist/client/cover-letter` artifact; the page sets `no-store` |
| Job description or letter leaks into a log or the DB | High | No insert path; logs carry only event names; leak tests read the SQLite bytes, stub log, and captured server output |
| A shared daily-cap event row grows without bound | Low | Primary key `(day, feature)` with `INSERT OR IGNORE`; at most 732 rows a year |
| The admin label change breaks its page test | Low | Only the label text changes; `tests/admin-page.test.mjs` is updated with the label |
| Existing Phase 1/2/3 behavior regresses | High | Every existing check stays in the eight-command list; new tests assert old statuses/content; container probe and Lighthouse keep the old pages |

## Complexity Tracking

> No Constitution Check violations. The items below are design choices worth recording, not waivers.

| Choice | Why needed | Simpler alternative rejected because |
|---|---|---|
| Structured content document instead of prose in the page | the build gate must name the field; links and sign-off must be real elements | hardcoded copy fails the locked content-source decision and makes the gate meaningless |
| On-demand page with a conditional form | F9 AC4 depends on runtime configuration | prerendering would ship a visible form to an unconfigured deployment and fail the AC |
| A prebuild content gate rather than a postbuild HTML gate | `/cover-letter` has no `dist` artifact | scanning `dist` is impossible for an on-demand page |
| A separate adapter module | the real service contract is unknown; one remap point | reusing the AI provider would couple two unrelated contracts |
| Shared counter, no rename | F10 AC2 says both endpoints count together; the parent forbids renaming | two counters can double the day's spend; renaming breaks the existing setting |
| A bounded cap-event table | F10 AC3's event must be durable and testable after restart | console-only events vanish; an unbounded log invites write amplification |
| Fixed 10/hour cover-letter window | F10 AC1 fixes the number for this endpoint | a new admin field expands F21 and its form beyond the phase |
| `ensureRequiredLines` append-only | F9 AC2 says append, never rewrite | prompt-only enforcement is non-deterministic; rewriting mutates the letter |
