# Tasks: Phase 4 — General Cover Letter and Generator Path

**Input**: Design documents from `specs/004-general-cover-letter-and-generator/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cover-letter-api.md, contracts/generator-adapter.md, contracts/http-routes.md, quickstart.md

**Tests**: Required by FR-955/FR-957 and the parent card. Each task names the test or check that proves it. Write the proving test first where practical; the `proves:` command must fail before the implementation and pass after.

**Organization**: Setup → Foundational → US1 (F5 general letter) → US2 (F9 generator) → US3 (F10 limits) → Polish. Every task names the files it touches and a `proves:` command.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task).
- **[Story]**: US1 = visitor reads the general letter (P1); US2 = visitor gets a tailored letter (P2); US3 = generator use is cost-bounded (P3).
- Every task has a `proves:` line: the exact command(s) that demonstrate it.

## Path Conventions

Single Astro project at the repository root: `src/`, `tests/`, `scripts/`, `content/`, `specs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The content document and its library, the local generator stub, and the new environment names. These do not depend on each other.

- [x] T001 [P] Add `content/cover-letter.json` (greeting `Dear Hiring Manager,`; 3 paragraphs drafted from `content/profile.json`; the exact authorization line; the exact sign-off; LinkedIn then GitHub links; `lastUpdated`) and `src/lib/cover-letter.mjs` with `loadCoverLetter()` (`COVER_LETTER_PATH` → cwd → module-relative), `validateCoverLetter(doc, {profile})`, `BANNED_PHRASES`, `findBannedPhrases(text)`, `buildGeneralLetter(doc)`, `ensureRequiredLines(text)`, `REQUIRED_AUTHORIZATION`, `SIGNOFF`; add `tests/cover-letter-content.test.mjs` for the shipped content, every validation rule in data-model.md, the exact built text and ordering, append/idempotence for each required-line combination, and each banned phrase detected.
  - proves: `node --experimental-sqlite --test tests/cover-letter-content.test.mjs`
- [x] T002 [P] Add `scripts/generator-stub.mjs`: dependency-free `node:http`; `POST` on any path; parses JSON; appends a redacted record to `--log` (`method`, `path`, `authorizationPresent`, `authorizationScheme`, `keyLength`, `keyLast4`, `body`) and never the full key; returns `{"letter":"<--letter value>"}`; flags `--port`, `--log`, `--letter`, `--status`, `--delay-ms`, `--self-test`.
  - proves: `node scripts/generator-stub.mjs --self-test`
- [x] T003 [P] Extend `src/lib/env.mjs` with `GENERATOR_ENDPOINT`, `GENERATOR_API_KEY`, `GENERATOR_TIMEOUT_MS` (default 30000, cap 30000); warn once when the generator is partially configured (`GENERATOR_ENDPOINT, GENERATOR_API_KEY required`) and never log a value; extend `tests/env.test.mjs` for parsing, the cap, the warning count, and value-free output.
  - proves: `node --experimental-sqlite --test tests/env.test.mjs`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema v3, the shared cap wrapper, generator settings, the adapter, the build gate, and the cover-letter service. No user story can start until these exist.

**⚠️ CRITICAL**: US1, US2, and US3 all depend on this phase.

- [x] T004 Extend `src/lib/db.mjs` to schema version 3 with the exact DDL in data-model.md (`daily_cap_events` with `PRIMARY KEY (day, feature)` and the `feature` check), additive and idempotent; add `insertCapEvent(day, feature)` using `INSERT OR IGNORE`, `getCapEvent(day, feature)`, and `countCapEvents()`; extend `tests/db.test.mjs` for a fresh DB (six tables, `user_version=3`), a version-2 DB with a contact row, a setting, an ask question and a counter row (all survive), a second idempotent open, one event row per day/feature after repeated inserts, and counter atomicity at the cap boundary.
  - proves: `node --experimental-sqlite --test tests/db.test.mjs`
- [x] T005 [P] Add `src/lib/daily-cap.mjs`: `utcDayKey(now)`, `consumeDaily(db, day, cap, feature)` delegating to `db.consumeDailyAsk` and, on the first over-cap request for that day and feature, calling `db.insertCapEvent` and logging `{event:'daily_cap', day, feature}` once; a cap-event write failure logs a warning and never blocks the 429; add `tests/daily-cap.test.mjs` for allow/block at the boundary, event-once semantics, UTC rollover, and no IP or content in the log payload.
  - proves: `node --experimental-sqlite --test tests/daily-cap.test.mjs`
- [x] T006 [P] Add `getEffectiveGenerator()` to `src/lib/settings.mjs` returning `{endpoint, apiKey, timeoutMs, configured}` with the precedence and rules in data-model.md; the settings read is wrapped so a store failure logs one warning and returns the unconfigured shape; keep `SETTINGS_FIELDS`, `getEffectiveSettings`, `getMaskedSettings`, and `saveSettings` behavior unchanged; extend `tests/settings.test.mjs` for admin-over-env, env-only key (never in the masked view), configured matrix (endpoint/key/both/neither), timeout cap, per-call resolution after a settings write, and the fail-closed store error.
  - proves: `node --experimental-sqlite --test tests/settings.test.mjs`
- [x] T007 [P] Add `src/lib/generator-provider.mjs` with `buildGeneratorRequest(profile, jobDescription)`, `readGeneratorResponse(data)`, `callGenerator({endpoint, apiKey, jobDescription, candidate, timeoutMs, fetchImpl})`, and `GeneratorError` per contracts/generator-adapter.md; `AbortController` timeout with the timer cleared in `finally`; add `tests/generator-provider.test.mjs` for the exact request shape and header, success, non-2xx, malformed JSON, missing/empty/over-long `letter`, abort at the bound, and secret-free error messages.
  - proves: `node --experimental-sqlite --test tests/generator-provider.test.mjs`
- [x] T008 Add `scripts/check-cover-letter.mjs` (validate the content document, build the letter text, scan the six banned phrases case-insensitively, print `cover letter ok` or `FAIL: banned phrase "<phrase>" found in <field>`, exit 1) and wire it into `package.json` `prebuild` after `check-profile.mjs`; extend `tests/cover-letter-content.test.mjs` with a spawned-script fixture test per banned phrase via `COVER_LETTER_PATH` asserting exit 1 and the phrase in stderr, plus a pass case on the shipped content.
  - proves: `node --experimental-sqlite --test tests/cover-letter-content.test.mjs && node scripts/check-cover-letter.mjs`
- [x] T009 Add `src/lib/cover-letter-service.mjs` with `validateJobDescription(rawInput)` (object, string, trim, 1–8,000, exact messages) and `processCoverLetter(rawInput, clientIp, deps)` implementing the contract order with injected `{db, settings, limits, provider, now, profile, letterDoc}` and a pass-through `limits` for this story; unconfigured 503 with the exact message; success `{ok, letter, appended}`; 502/504 with `fallback` and `generalLetter`; add `tests/cover-letter-service.test.mjs` for validation, unconfigured-no-call, success, append combinations, error mapping, fallback body, and no secret.
  - proves: `node --experimental-sqlite --test tests/cover-letter-service.test.mjs`

**Checkpoint**: schema, cap wrapper, generator settings, adapter, build gate, and the service are ready; US1 can start.

---

## Phase 3: User Story 1 — Visitor reads the general cover letter (Priority: P1) 🎯 MVP

**Goal**: `/cover-letter` serves the complete general letter server-side, with the exact required lines and links, no form when unconfigured, in the nav and sitemap, and a build gate that fails on a banned phrase.

**Independent Test**: Boot `dist/server/entry.mjs` with no generator configuration; assert `/cover-letter` is 200 with one `<h1>`, the greeting first, the exact authorization line, the exact sign-off, both links after it, no `<form`, no banned phrase, and the letter still present with every `<script>` removed; assert the nav and sitemap entries.

- [x] T010 [US1] Add `src/components/CoverLetter.astro` (semantic `<article>`: greeting, paragraphs, authorization, sign-off, a list of the two links in order; existing tokens; no script) and `src/pages/cover-letter.astro` (`prerender = false`, `Astro.response.headers.set('Cache-Control','no-store')`, `<BaseLayout>`, one `<h1>Cover Letter</h1>`, intro, `<CoverLetter />`; the form is added in US2). This is the compile step of the T010–T012 build-gate unit; do not run `npm run build` before T012.
  - proves: `npx astro build`
- [x] T011 [US1] Add the `Cover Letter` nav entry in `src/components/Header.astro` (after Case Studies, before Ask) and `/cover-letter` to `PUBLIC_PAGE_PATHS` in `src/lib/site.mjs` after `/contact`; extend `tests/site.test.mjs` for the six-path list and the sitemap order. Part of the T010–T012 build-gate unit.
  - proves: `node --experimental-sqlite --test tests/site.test.mjs`
- [x] T012 [US1] Build-gate unit with T010+T011 — complete all three before any task whose proof runs `npm run build`. Extend `scripts/check-static-output.mjs` (assert `dist/client/cover-letter` and `dist/client/api/cover-letter` do not exist; sitemap expected paths gain `/cover-letter` after `/contact`), `scripts/check-agent-output.mjs` (`/cover-letter` exactly once after `/contact`; no admin facts), and `scripts/test-public-routes.mjs` (sitemap expected paths and the navigation page list gain `/cover-letter`).
  - proves: `npm run build && node scripts/check-static-output.mjs && node scripts/check-agent-output.mjs`
- [x] T013 [US1] Extend `scripts/test-public-routes.mjs` with the unconfigured `/cover-letter` probe: 200, `text/html`, one `<h1>`, the greeting as the first letter text, the exact authorization line, the exact sign-off, the LinkedIn and GitHub hrefs on separate `<li>` elements after the sign-off, no `<form`, no banned phrase in the letter region, and the letter text still present after stripping every `<script>`.
  - proves: `node scripts/test-public-routes.mjs`
- [x] T014 [US1] Add `{name:'cover-letter', path:'/cover-letter'}` to `PAGES` in `scripts/lighthouse-check.mjs` and update the summary; keep the existing pages and gates unchanged.
  - proves: `node scripts/lighthouse-check.mjs`
- [x] T015 [US1] Add a `/cover-letter` 200 + exact authorization line + exact sign-off probe to `scripts/verify-container.mjs`, keep every existing probe, and update the hardcoded `routesPassed === 11` to the new count.
  - proves: `node scripts/verify-container.mjs`

**Checkpoint**: US1 is a complete public page with the letter, the build gate, discovery, Lighthouse, and container proof. It does not need the generator.

---

## Phase 4: User Story 2 — Visitor gets a letter tailored to a job description (Priority: P2)

**Goal**: A configured `/cover-letter` shows the form and `POST /api/cover-letter` returns a generator letter with the required lines enforced, clean errors, and the general-letter fallback.

**Independent Test**: Boot the built server against the generator stub with `GENERATOR_ENDPOINT`/`GENERATOR_API_KEY`; submit a job description and assert 200 with both required lines and the stub's request body; return a letter without the sign-off and assert it is appended; return 500 and assert 502 with `fallback`; delay and assert 504; boot unconfigured and assert no form and 503.

- [x] T016 [US2] Add `src/components/CoverLetterForm.astro` (labelled `<textarea id="jobDescription" name="jobDescription" maxlength="8000">`, hint linked by `aria-describedby`, submit button, `role="status" aria-live="polite"` region, `role="alert"` error region, result region, `<noscript>` with a `/contact` link, exactly one module island that prevents the native submit, sets `Writing your letter…`, disables the button, POSTs JSON, renders `letter` with `textContent`, maps 400/429/502/503/504, ignores a second in-flight submit, and re-enables in `finally`) and render it from `src/pages/cover-letter.astro` only when `getEffectiveGenerator().configured`.
  - proves: `npx astro build`
- [x] T017 [US2] Add `src/pages/api/cover-letter.ts`: POST only (`Allow: POST` on 405), `application/json` only (415), JSON object body (400), client key with the same `TRUST_PROXY` rule as `/api/ask`, call `processCoverLetter`, map statuses/payloads, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Language: en`, `Retry-After` when present, no leaked detail on unexpected errors.
  - proves: `npx astro build`
- [x] T018 [US2] Add `tests/cover-letter-api.integration.test.mjs` (part 1): boot `dist/server/entry.mjs` against `scripts/generator-stub.mjs` with a temporary `DATA_DIR`; configured page has the form with `maxlength="8000"` and the live region; valid 1,000-character submission returns 200 with both required lines and `appended` both false; the stub log records the job description and shows the bearer scheme plus the key length and last four (never the full key); a letter missing the authorization line and a letter missing the sign-off each get exactly that line appended while the body is unchanged.
  - proves: `node --experimental-sqlite --test tests/cover-letter-api.integration.test.mjs`
- [x] T019 [US2] Extend `tests/cover-letter-api.integration.test.mjs` (part 2): unconfigured page has no `<form` and the exact letter; `POST` → 503 exact message with no stub call; empty/whitespace/8,001-character/non-string/array/malformed JSON → 400 with the exact messages; `text/plain` → 415; `GET` → 405; exactly 8,000 characters → 200; every rejection leaves the stub log unchanged.
  - proves: `node --experimental-sqlite --test tests/cover-letter-api.integration.test.mjs`
- [x] T020 [US2] Extend `tests/cover-letter-api.integration.test.mjs` (part 3): stub 500, invalid JSON, empty `letter`, and a 13,000-character `letter` each yield 502 `generator_error`; stub delay beyond a low `GENERATOR_TIMEOUT_MS` yields 504 `generator_timeout`; both carry `fallback: true` and `generalLetter` equal to `buildGeneralLetter(doc)`; assert no response body, no captured **server** log line, and no SQLite byte contains the key, the job description, or the upstream body (the stub's own request log is the test fixture and is excluded from this assertion).
  - proves: `node --experimental-sqlite --test tests/cover-letter-api.integration.test.mjs`
- [x] T021 [US2] Extend `tests/cover-letter-api.integration.test.mjs` (part 4): log in as admin, save `generatorEndpoint` = stub B, and assert the next `POST /api/cover-letter` reaches stub B with no restart while the previous stub receives no further call; assert the admin response and page still never expose `GENERATOR_API_KEY`.
  - proves: `node --experimental-sqlite --test tests/cover-letter-api.integration.test.mjs`
- [x] T022 [US2] Extend `scripts/test-public-routes.mjs` with a second server boot (configured generator): the form is present with `maxlength="8000"`, a `role="status"` + `aria-live="polite"` region, and at most one `<script type="module" src="/_astro/…">`; the general letter is unchanged beside it and is still fully present after stripping every `<script>`; the unconfigured boot keeps its no-form assertion.
  - proves: `node scripts/test-public-routes.mjs`

**Checkpoint**: US2 is functional against the stub with an environment- or admin-configured generator. Do not expose it without US3.

---

## Phase 5: User Story 3 — Generator use is cost-bounded by shared limits (Priority: P3)

**Goal**: The per-IP window and the shared SQLite UTC-day cap reject with 429 before any external call, survive restarts, reset on the next UTC day, and leave a bounded event row.

**Independent Test**: With the stub configured, send 10 cover-letter requests and assert the 11th is 429 `rate_limited`; boot with `ASK_DAILY_CAP=3`, send two `/api/ask` questions and two cover-letter requests and assert the fourth is 429 `daily_cap`; restart on the same `DATA_DIR` and assert it is still 429; assert the stubs never receive a call after either cap and exactly one `daily_cap_events` row exists.

- [x] T023 [US3] Add `src/lib/cover-letter-limits.mjs`: `DEFAULT_COVER_LETTER_RATE_LIMIT = 10`, one module-level `createRateLimiter({windowMs:3_600_000, limit:10})`, `checkPerIp(key)`, `consumeDaily(db, day, cap)` delegating to `daily-cap.mjs` with `feature:'cover_letter'`, and console events with no IP or body; add `tests/cover-letter-limits.test.mjs` for 10 allow / 11 block, retry seconds, separate state from the ask limiter, and the event payload.
  - proves: `node --experimental-sqlite --test tests/cover-letter-limits.test.mjs`
- [x] T024 [US3] Wire the real limits into `src/lib/cover-letter-service.mjs` and `src/pages/api/cover-letter.ts`: per-IP check before validation (every attempt counts), shared daily consume after configured and before the adapter, 429 `rate_limited` with `retryAfterSeconds`/`Retry-After`, 429 `daily_cap` with the paused message, no adapter call after either; extend `tests/cover-letter-service.test.mjs` for order, pass-through vs real limits, and no-call assertions.
  - proves: `node --experimental-sqlite --test tests/cover-letter-service.test.mjs`
- [x] T025 [US3] Extend `tests/cover-letter-api.integration.test.mjs` (part 5): 11 requests from one IP → the 11th is 429 `rate_limited` with `Retry-After` and the stub log stays at 10; a `/api/ask` request from the same IP is still allowed; the page shows the rate-limited message with retry seconds.
  - proves: `node --experimental-sqlite --test tests/cover-letter-api.integration.test.mjs`
- [x] T026 [US3] Extend `tests/cover-letter-api.integration.test.mjs` (part 6): shared cap `ASK_DAILY_CAP=3` with `scripts/ai-stub.mjs` and the generator stub — two `/api/ask` questions then two cover-letter requests → 200, 200, 200, 429 `daily_cap`; the AI stub has two calls and the generator stub one; restart on the same `DATA_DIR` → still 429 with no new stub call; a unit check with an injected clock proves the next UTC day starts at zero.
  - proves: `node --experimental-sqlite --test tests/cover-letter-api.integration.test.mjs`
- [x] T027 [US3] Extend `tests/cover-letter-api.integration.test.mjs` (part 7): after several rejected over-cap requests, exactly one `daily_cap_events` row exists for the UTC day and `cover_letter`, with no IP/content column; the SQLite bytes contain no job description or letter; the captured server output contains no IP, job description, or letter.
  - proves: `node --experimental-sqlite --test tests/cover-letter-api.integration.test.mjs`
- [x] T028 [US3] Change `src/lib/ask-limits.mjs` `consumeDaily` to delegate to `src/lib/daily-cap.mjs` with `feature:'ask'`, keeping its exports (`checkPerIp`, `utcDayKey`, `consumeDaily`) and behavior; re-run the Phase 3 suites to prove the assistant's limits are unchanged.
  - proves: `node --experimental-sqlite --test tests/ask-limits.test.mjs tests/ask-service.test.mjs tests/ask-api.integration.test.mjs`

**Checkpoint**: all three stories are independently functional; the endpoint is cost-bounded and the assistant is unaffected.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Shared-cap wording, environment documentation, secret hygiene, and the full validation gate.

- [x] T029 [P] Change the `askDailyCap` label in `src/lib/admin-page.mjs` to `Daily cap (assistant + cover letter)` (field name, order, and validation unchanged) and update `tests/admin-page.test.mjs` where it asserts the label; no new admin field and no admin discovery surface.
  - proves: `node --experimental-sqlite --test tests/admin-page.test.mjs`
- [x] T030 [P] Update `.env.example`: add `GENERATOR_ENDPOINT`, `GENERATOR_API_KEY`, `GENERATOR_TIMEOUT_MS` with empty values and one-line comments, and change the `ASK_DAILY_CAP` comment to state it is the shared assistant + cover-letter UTC-day cap; no value, no secret.
  - proves: `node --experimental-sqlite --test tests/secret-scan.test.mjs`
- [x] T031 [P] Extend `tests/secret-scan.test.mjs`: every new env name is documented with an empty value in `.env.example`; no generator key pattern, `v1:` envelope, or job-description fixture leaks into `src/`, `scripts/`, or `content/`; no `.env` file is created by the suite.
  - proves: `node --experimental-sqlite --test tests/secret-scan.test.mjs`
- [x] T032 Run the exact eight validation commands in order from a clean shell and record the output; fix any failure without changing the list.
  - proves: `npm ci && npm run build && npm test && node scripts/check-agent-output.mjs && node scripts/test-public-routes.mjs && node scripts/test-contact-api.mjs && node scripts/lighthouse-check.mjs && node scripts/verify-container.mjs`
- [x] T033 Final repository review: confirm only intended files changed, no secret or evidence is tracked, `PRD.phases.md` Phase 4's `**Spec:**` line is the only plan edit, and Phase 1/2/3/Deferred sections are untouched (`git status --short && git diff --check && git diff --stat`).
  - proves: `git status --short && git diff --check && git diff --stat`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T001–T003 can run in parallel.
- **Foundational (Phase 2)**: depends on Setup. T004, T005, T006, T007 can run in parallel; T008 depends on T001; T009 depends on T001 + T005 + T006 + T007.
- **US1 (Phase 3)**: depends on Foundational. T010 depends on T001 + T006; T011 is independent of T010; T010–T012 are one build-gate unit — T010 compiles with `npx astro build`, T011 adds the nav/sitemap with a unit-test proof, T012 updates the three checks and is the first `npm run build` proof; T013/T014/T015 depend on T010 + T012.
- **US2 (Phase 4)**: depends on Foundational + US1's page. T016 depends on T010 + T006; T017 depends on T009; T018 depends on T016 + T017; T019/T020/T021 depend on T018; T022 depends on T016 + T012.
- **US3 (Phase 5)**: depends on Foundational + US2's route. T023 depends on T004 + T005; T024 depends on T009 + T023; T025/T026/T027 depend on T017 + T024; T028 depends on T005 (and Phase 3's suites).
- **Polish (Phase 6)**: T029/T030/T031 can run in parallel after T026; T032 depends on all of T001–T031; T033 depends on T032.

### User Story Dependencies

- **US1 (P1)**: after Foundational; no dependency on US2/US3. Complete on its own with no generator configuration.
- **US2 (P2)**: after Foundational + US1's page; it owns the form, route, and generator proofs. It uses a pass-through limits default, so it is testable before US3.
- **US3 (P3)**: after US2's service and route; its shared-cap proof intentionally calls `/api/ask`, making it the only cross-story integration test.
- Stories are independently testable at their checkpoints.

### Within Each User Story

- Content/library → adapter/service → route/page → integration.
- No task depends on a task in a later phase except the shared-cap proof (T026) that uses `/api/ask`.
- Do not start T032 until every story checkpoint passes.

### Parallel Opportunities

- Setup: T001, T002, T003.
- Foundational: T004, T005, T006, T007; then T008 and T009.
- US1: T011 alongside T010; T013/T014/T015 after the T010–T012 unit.
- US2: T016 and T017 in parallel after Foundational; then T018 → T019/T020/T021; T022 after T012 + T016.
- US3: T023 first; T024 after T023; T025/T026/T027/T028 after T024.
- Polish: T029, T030, T031 in parallel; T032 serial; T033 last.

---

## Parallel Example: US1

```bash
# The letter page and the discovery/sitemap work can start together:
Task: "T010 Add CoverLetter.astro and cover-letter.astro (npx astro build)"
Task: "T011 Add the Cover Letter nav entry and PUBLIC_PAGE_PATHS (unit test only)"

# Then the build-gate unit (T012 is the first npm run build proof):
Task: "T012 Extend check-static-output.mjs, check-agent-output.mjs, test-public-routes.mjs sitemap/nav"
```

## Parallel Example: US2

```bash
# Independent building blocks after Foundational:
Task: "T016 Add CoverLetterForm.astro and the conditional render"
Task: "T017 Add src/pages/api/cover-letter.ts"

# Then the integration proofs, in order:
Task: "T018 Integration part 1 — page, success, appending"
Task: "T019 Integration part 2 — validation, media type, method, unconfigured"
Task: "T020 Integration part 3 — generator errors, timeout, fallback, leaks"
Task: "T021 Integration part 4 — admin endpoint switch without restart"
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Complete Setup (T001–T003) and Foundational (T004–T009).
2. Complete US1 (T010–T015).
3. **STOP and VALIDATE**: `node scripts/check-cover-letter.mjs`, `npm run build`, `node scripts/check-static-output.mjs`, `node scripts/test-public-routes.mjs`, `node scripts/lighthouse-check.mjs`.
4. US1 is the shippable general letter with no generator configured.

### Incremental Delivery

1. Setup + Foundational → content, gate, adapter, service ready.
2. US1 → general letter page, nav, sitemap, build gate → shippable.
3. US2 → generator form, API, required-line enforcement, fallback → demo-grade with a configured endpoint.
4. US3 → per-IP and shared daily caps → safe to expose.
5. Polish → shared-cap wording, env docs, secret scan, the eight-command gate.

### Parallel Team Strategy

1. Team completes Setup + Foundational together.
2. After Foundational: Developer A takes US1's page and discovery; Developer B takes US2's form and route; Developer C prepares US3's limiter tests.
3. US3 wires into the completed service and route.
4. T026/T032 are the integration gates.

---

## Coverage Map

| Requirement group | Tasks |
|---|---|
| FR-900–FR-908 (general letter) | T001, T008, T010–T015 |
| FR-920–FR-930 (generator) | T002, T003, T006, T007, T009, T016–T022 |
| FR-940–FR-946 (limits) | T004, T005, T023–T028 |
| FR-950–FR-958 (preservation/quality) | T010–T015, T022, T029–T032 |
| SC-900–SC-907 | T004, T008, T013, T014, T018–T022, T025–T027, T032 |

## Notes

- `[P]` means different files and no dependency on an incomplete task; it does not mean "run without the phase checkpoint".
- The general letter text must never be hardcoded in a component or a route; `buildGeneralLetter()` is the single source used by the page, the gate, and the fallback.
- The stub log and the SQLite bytes are the authorities for "no external call" and "nothing stored": assert no new line/row after a rejection or a cap.
- T010–T012 are one build-gate unit: no task whose proof runs `npm run build` may start before T012 updates `check-static-output.mjs`, `check-agent-output.mjs`, and the sitemap expectations.
- The eight validation commands are fixed; extend the checks inside them, never add a ninth.
- No task commits, pushes, tags, or deploys.
