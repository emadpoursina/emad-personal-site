# Tasks: Phase 3 — Ask Assistant, Abuse Limits, and Admin Settings

**Input**: Design documents from `specs/003-ask-assistant-admin-settings/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ask-api.md, contracts/admin-api.md, contracts/http-routes.md, quickstart.md

**Tests**: Required by FR-806/FR-809 and the parent card. Each task names the test or check that proves it. Write the proving test first where practical; the `proves:` command must fail before the implementation and pass after.

**Organization**: Setup → Foundational → US1 (F8) → US2 (F10) → US3 (F21) → Polish. Every task names the files it touches and a `proves:` command.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task).
- **[Story]**: US1 = visitor asks a grounded question (P1); US2 = owner's assistant usage is capped (P2); US3 = owner changes settings in the admin panel (P3).
- Every task has a `proves:` line: the exact command(s) that demonstrate it.

## Path Conventions

Single Astro project at the repository root: `src/`, `tests/`, `scripts/`, `content/`, `specs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the content policy block, configuration names, the offline credential generator, and the local AI stub. These do not depend on each other.

- [x] T001 [P] Add `assistantPolicy` to `content/profile.json` with the six strings in data-model.md and extend `validateProfile` in `src/lib/profile.mjs` to require the object, exact `disclaimer` (`AI assistant. The CV and case studies are the source of record.`), exact `unavailable` (`The assistant is unavailable right now`), non-empty `notAvailable`/`salary`/`privateCodebase` (must contain `{caseStudiesPath}`)/`visa` (must contain `Requires employer-sponsored work authorization.`); add cases to `tests/profile.test.mjs`.
  - proves: `node --experimental-sqlite --test tests/profile.test.mjs`
- [x] T002 [P] Extend `src/lib/env.mjs` with `ADMIN_PASSWORD_HASH`, `ENCRYPTION_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `ASK_DAILY_CAP` (default 200), `ASK_RATE_LIMIT_PER_HOUR` (default 10), `AI_TIMEOUT_MS` (default 30000, cap 30000); warn once per disabled feature and never log a value; document every new name in `.env.example` with an empty value; add `tests/env.test.mjs`.
  - proves: `node --experimental-sqlite --test tests/env.test.mjs`
- [x] T003 [P] Add `scripts/admin-credentials.mjs`: `--hash` reads a password from stdin (strip one trailing newline), prints `ADMIN_PASSWORD_HASH=scrypt$16384$8$1$<salt-b64>$<hash-b64>` using a 16-byte salt and a 64-byte scrypt key; `--key` prints `ENCRYPTION_KEY=<base64 of 32 random bytes>`; never echo the password; add `tests/admin-credentials.test.mjs` that parses the output and re-derives the hash with `node:crypto`.
  - proves: `node --experimental-sqlite --test tests/admin-credentials.test.mjs`
- [x] T004 [P] Add `scripts/ai-stub.mjs`: dependency-free `node:http` server; accepts `POST` on any path ending `/chat/completions`; reads JSON `{model, messages}`; appends `{model, messages}` to the `--log` JSONL path; returns an OpenAI-compatible `{choices:[{message:{content}}]}` whose content is the `--answer <text>` value when supplied (otherwise a default canned answer); supports `--port`, `--log`, `--delay-ms`, `--answer <text>`, `--self-test`.
  - proves: `node scripts/ai-stub.mjs --self-test`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema v2, secrets, settings, context/policy, prompt, and provider adapter. No user story can start until these exist.

**⚠️ CRITICAL**: US1, US2, and US3 all depend on this phase.

- [x] T005 Extend `src/lib/db.mjs` to schema version 2 with the exact DDL in data-model.md (`settings`, `admin_sessions`, `ask_questions`, `ask_daily_counters`, `idx_admin_sessions_expires_at`, `idx_ask_questions_created_at`), additive and idempotent; add `getSetting`, `getAllSettings`, `setSetting`, `deleteSetting`, `applySettings` (transaction), `createSession`, `getSession`, `deleteSession`, `deleteExpiredSessions`, `insertQuestion`, `countQuestions`, `consumeDailyAsk(day, cap)` using `INSERT ... ON CONFLICT(day) DO UPDATE ... RETURNING count`; extend `tests/db.test.mjs` for a fresh DB, a version-1 DB with one contact row upgraded (row survives, four tables exist, `user_version=2`), a second idempotent open, and counter atomicity.
  - proves: `node --experimental-sqlite --test tests/db.test.mjs`
- [x] T006 [P] Add `src/lib/secrets.mjs`: parse `ENCRYPTION_KEY` as exactly 32 bytes from base64 or 64 hex characters; AES-256-GCM with a 12-byte random IV and 16-byte tag; envelope `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`; `encryptSecret`, `decryptSecret`, `maskSecret` (`••••` + last four when length ≥ 8, else `••••`), typed decrypt error, one warning for a missing/invalid key; add `tests/secrets.test.mjs` for round-trip, tamper, wrong key, invalid key forms, mask, and no plaintext in the envelope.
  - proves: `node --experimental-sqlite --test tests/secrets.test.mjs`
- [x] T007 Add `src/lib/settings.mjs`: the 12 keys, defaults, and precedence in data-model.md (`admin row → env → default`, resolved on every call, no settings cache); validation for `aiBaseUrl` (HTTPS or localhost `http`, no credentials, ≤500), `aiModel` (≤200, no control), `aiApiKey` (≤4096, no CR/LF), `askDailyCap` 1–100000, `askRateLimitPerHour` 1–1000, `smtpHost` ≤255, `smtpPort` 1–65535, `smtpSecure` true/false, `smtpUser` ≤320, `smtpPass` ≤1024 (no CR/LF), `smtpFrom` addr or `Name <addr>` ≤320, `generatorEndpoint` URL rule; `saveSettings` all-or-nothing with blank non-secret = delete override and blank secret = unchanged; `getEffectiveSettings`, `getEffectiveSmtp`, `getMaskedSettings`; extend `tests/settings.test.mjs` for precedence, blank semantics, invalid values, encryption at rest, wrong-key fail-closed, and masking.
  - proves: `node --experimental-sqlite --test tests/settings.test.mjs`
- [x] T008 [P] Add `src/lib/assistant-context.mjs`: build the sections in data-model.md (`summary`/`experience`/`skills`/`education`/`languages`/`projects`/`study:<slug>`/`contact` with labels and hrefs) from `content/profile.json` and published `content/case-studies.json`; `selectSections(question)` with the deterministic keyword/token rules, `summary` always, and `summary+experience+skills` fallback; `buildCitations` deduped in section order; `matchPolicy(question)` salary → visa → private codebase with the exact regexes; `buildPolicyAnswer` replaces `{caseStudiesPath}`; add `tests/assistant-context.test.mjs` for every section, skill/study matching, fallback, every policy pattern, precedence, and the href allow-list.
  - proves: `node --experimental-sqlite --test tests/assistant-context.test.mjs`
- [x] T009 Add `src/lib/assistant-prompt.mjs`: the exact system prompt in contracts/ask-api.md with `<notAvailable>` replaced by `assistantPolicy.notAvailable`; `buildMessages(sections, question)` produces the labelled context and `<visitor_question>` message; escape `<`/`>` in the question; only selected sections appear; add `tests/assistant-prompt.test.mjs` for the rules, escaping, injection-as-data, and absence of secrets/environment values.
  - proves: `node --experimental-sqlite --test tests/assistant-prompt.test.mjs`
- [x] T010 [P] Add `src/lib/ai-provider.mjs`: POST to `<baseUrl without trailing slash>/chat/completions` with `Authorization: Bearer <key>` and `{model, messages, temperature:0.2, max_tokens:500, stream:false}`; `AbortController` timeout from `AI_TIMEOUT_MS` (default and cap 30000); return `choices[0].message.content`; typed `{kind:'upstream'|'timeout'}` errors with no upstream body/header/key; injectable `fetch`; add `tests/ai-provider.test.mjs` for success, non-2xx, malformed JSON, empty content, abort, and secret-free errors.
  - proves: `node --experimental-sqlite --test tests/ai-provider.test.mjs`

**Checkpoint**: schema, secrets, settings, context, prompt, and provider are ready; US1 can start.

---

## Phase 3: User Story 1 — Visitor asks a grounded question (Priority: P1) 🎯 MVP

**Goal**: `/ask` and `POST /api/ask` answer only from the approved profile, with citations, the exact disclaimer, the decline policy, and the exact unconfigured message.

**Independent Test**: Boot `dist/server/entry.mjs` with `scripts/ai-stub.mjs` as `AI_BASE_URL` and a test key; ask a skill question and a salary question; assert the answer, the exact disclaimer, a non-empty `sources` array with valid hrefs, the policy string with no number, and the stub log; then boot with no key and assert the exact 503 message with no stub call.

- [x] T011 [US1] Add `src/lib/ask-service.mjs`: `validateQuestion` (trimmed 1–1000), `processAsk(rawInput, clientIp, {db, settings, limits, provider, now})` implementing the contract order with a pass-through `limits` for this story; unconfigured 503 exact message; policy 200 with disclaimer and fixed sources; context/prompt/provider; success `{ok, answer, disclaimer, sources, model}`; best-effort question log; add `tests/ask-service.test.mjs` for validation, unconfigured-no-call, policy-no-call, citations, disclaimer, log, provider error mapping, and no secret.
  - proves: `node --experimental-sqlite --test tests/ask-service.test.mjs`
- [x] T012 [US1] Add `src/pages/api/ask.ts`: POST only, `application/json` only (415), body parse (400), client IP with the same `TRUST_PROXY` rule as contact, call `processAsk`, map statuses/payloads, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Retry-After` when present, no leaked detail on unexpected errors; add `tests/ask-api.integration.test.mjs` booting `dist/server/entry.mjs` with `scripts/ai-stub.mjs` and a temporary `DATA_DIR` for success/citations/disclaimer/model, 400/415, 503 unconfigured, 502 provider down, 504 with a small `AI_TIMEOUT_MS` and stub delay, policy, a `--answer` notAvailable passthrough (stub returns exactly `assistantPolicy.notAvailable`; the API returns it unchanged with the exact disclaimer and a non-empty valid source list), and no-secret probes.
  - proves: `node --experimental-sqlite --test tests/ask-api.integration.test.mjs`
- [x] T013 [US1] Add `src/components/AskPanel.astro` and `src/pages/ask.astro`: labelled textarea with `maxlength="1000"`, submit button, `role="status" aria-live="polite"` region, answer container, static disclaimer, `noscript` contact link, and exactly one Astro module script that prevents the default submit, shows `Thinking…`, disables submit, POSTs JSON, renders the answer with `textContent`, renders only internal citation links, maps 400/415/429/503/502/504, and restores the button in `finally`; prerender the page. This is the compile step of the T013–T015 build-gate unit; do not run `npm run build` before T015.
  - proves: `npx astro build`
- [x] T014 [US1] Add the Ask nav entry in `src/components/Header.astro`; add `/ask` to `PUBLIC_PAGE_PATHS` in `src/lib/site.mjs`; make `buildSitemap` in `src/lib/agent-output.mjs` iterate `PUBLIC_PAGE_PATHS` then append published studies (order `/`, `/about`, `/case-studies`, `/ask`, `/contact`, studies); add `tests/site.test.mjs`. Part of the T013–T015 build-gate unit (no full `npm run build` until T015).
  - proves: `node --experimental-sqlite --test tests/site.test.mjs`
- [x] T015 [US1] Build-gate unit with T013+T014 — complete all three before any task whose proof runs `npm run build`. Extend BOTH `scripts/check-static-output.mjs` and `scripts/check-agent-output.mjs` so `dist/client/ask/index.html` may contain exactly one `<script type="module" src="/_astro/…">` island in addition to its one ld+json block, while every other page keeps exactly one ld+json block and no executable script; assert `/ask` has the form, `maxlength="1000"`, `role="status"` + `aria-live="polite"`, and the exact disclaimer; update the hardcoded sitemap expected paths to include `/ask` and exclude admin. Leave the `/admin/login` and `/admin` static assertions to T025.
  - proves: `npm run build && node scripts/check-static-output.mjs && node scripts/check-agent-output.mjs`
- [x] T016 [US1] Add `{name:'ask', path:'/ask'}` to `PAGES` in `scripts/lighthouse-check.mjs` and update its summary; keep the existing pages and gates.
  - proves: `node scripts/lighthouse-check.mjs`
- [x] T017 [US1] Add a `/ask` 200 + form + disclaimer probe to `scripts/verify-container.mjs` and include it in the summary/routes count; keep every existing probe.
  - proves: `node scripts/verify-container.mjs`
- [x] T018 [US1] Extend `scripts/test-public-routes.mjs` with `/ask` 200 + form + 1,000 limit + exact disclaimer, the sitemap `/ask` entry, and the unchanged Phase 1/2 regression assertions.
  - proves: `node scripts/test-public-routes.mjs`

**Checkpoint**: US1 is independently functional against the stub with an environment-configured model. Do not deploy without US2.

---

## Phase 4: User Story 2 — Owner's assistant usage is capped (Priority: P2)

**Goal**: The per-IP window and the SQLite UTC-day cap reject with 429 before any model call, survive restarts, and reset on the next UTC day.

**Independent Test**: With the stub configured, send 10 valid questions and assert the 11th is 429 `rate_limited`; boot with `ASK_DAILY_CAP=3`, send three and assert the fourth is 429 `daily_cap`; restart on the same data directory and assert it is still 429; assert the stub log never grows after either cap.

- [x] T019 [US2] Add `src/lib/ask-limits.mjs`: a per-IP holder that recreates the `createRateLimiter` instance when the effective limit changes (`windowMs: 3_600_000`); `checkPerIp(key, limit)`; `utcDayKey(now)` = `YYYY-MM-DD`; `consumeDaily(db, day, cap)` calling `db.consumeDailyAsk`; event logging with no IP and no question; add `tests/ask-limits.test.mjs` for 10 allow / 11 block, limit change, retry seconds, UTC midnight, cap boundary, and atomic count.
  - proves: `node --experimental-sqlite --test tests/ask-limits.test.mjs`
- [x] T020 [US2] Wire the real limits into `src/lib/ask-service.mjs` and `src/pages/api/ask.ts`: per-IP check before validation (every attempt counts), daily consume after configured + question log, 429 `rate_limited` with `retryAfterSeconds`/`Retry-After`, 429 `daily_cap` with the paused-for-today message, no provider call after either, event logs without IP/question; extend `tests/ask-service.test.mjs`.
  - proves: `node --experimental-sqlite --test tests/ask-service.test.mjs`
- [x] T021 [US2] Add the two 429 outcomes to `src/components/AskPanel.astro`: show the rate-limited message with retry seconds and the paused-for-today message; keep the ARIA live announcements and restore the submit button.
  - proves: `npm run build && node scripts/check-static-output.mjs`
- [x] T022 [US2] Extend `tests/ask-api.integration.test.mjs`: 11th request 429 with `Retry-After` and no stub call; `ASK_DAILY_CAP=3` → three 200 and a fourth 429 `daily_cap` with the exact paused message and no stub call; restart the same `DATA_DIR` → still 429; valid questions in `ask_questions`; UTC rollover unit check; contact limiter regression.
  - proves: `node --experimental-sqlite --test tests/ask-api.integration.test.mjs`

**Checkpoint**: US1 + US2 are independently functional; the assistant is cost-bounded.

---

## Phase 5: User Story 3 — Owner changes settings in the admin panel (Priority: P3)

**Goal**: 401-protected `/admin` and `/api/admin/*`, an 8-hour session, a 15-minute per-IP lockout after five failures, encrypted/masked secrets, validated all-or-nothing settings, and next-request effect for AI and SMTP with no restart.

**Independent Test**: Boot with `ADMIN_PASSWORD_HASH` and `ENCRYPTION_KEY`; assert 401s; log in; save a new base URL/model and see the next ask hit the new stub; save SMTP to a second sink and see the next contact arrive there; assert the page/JSON show only last-four masks and the DB holds only `v1:` envelopes; submit five wrong passwords and assert 429 with the correct password still refused.

- [x] T023 [US3] Add `src/lib/admin-auth.mjs`: parse/verify `scrypt$N$r$p$salt$hash` with `crypto.scrypt` and `timingSafeEqual`, fail closed with one warning; `createSession`, `getSessionFromRequest`, `destroySession` over `db` sessions with an 8-hour absolute expiry; cookie builder `admin_session` HttpOnly/SameSite=Strict/Path=//Max-Age=28800/Secure on HTTPS; in-memory per-IP failure map with 5 failures in 15 minutes → 15-minute block and `Retry-After`; `isSameOrigin` using Origin then Referer; injectable `now`; add `tests/admin-auth.test.mjs` for hash verify, wrong password, malformed hash, cookie attributes, expiry, revocation, lockout window, per-IP isolation, and same-origin cases.
  - proves: `node --experimental-sqlite --test tests/admin-auth.test.mjs`
- [x] T024 [P] [US3] Add `src/lib/admin-page.mjs`: `render401`, `renderLogin`, `renderSettings` (values, masked placeholders, field errors, saved notice, effective-source hints) with HTML escaping, `noindex`, native forms posting to `/api/admin/*`, and no full secret; add `tests/admin-page.test.mjs` for escaping, mask-only output, noindex, the 12 form fields, and the error re-render.
  - proves: `node --experimental-sqlite --test tests/admin-page.test.mjs`
- [x] T025 [US3] Add an optional `noindex` prop to `src/layouts/BaseLayout.astro`; add `src/pages/admin/login.astro` (prerendered, no-JS password form, noindex) and `src/pages/admin/[...path].astro` (401 HTML without a session, 404 with one); extend `scripts/check-static-output.mjs` to assert `dist/client/admin/login/index.html` exists with `noindex` and `dist/client/admin/index.html` is absent (these assertions moved out of T015); leave public pages unchanged.
  - proves: `npm run build && node scripts/check-static-output.mjs`
- [x] T026 [US3] Add `src/pages/admin/index.astro` (`prerender = false`): session check; 401 HTML without a session; with a session the settings form (native POST to `/api/admin/settings`, masked secret placeholders, effective-source hints, separate logout form, `?saved=1` notice), noindex, and no secret in the HTML.
  - proves: `node --experimental-sqlite --test tests/admin-api.integration.test.mjs`
- [x] T027 [US3] Add `src/pages/api/admin/login.ts`, `logout.ts`, `settings.ts`, and `[...path].ts` per contracts/admin-api.md: content-type/body parsing, lockout first, scrypt verify, session cookie, 303 (form) / 200 (JSON), logout delete + clear, settings session + same-origin + validation + all-or-nothing save + encrypted secrets + masked JSON, catch-all 401/404, no GET mutation.
  - proves: `node --experimental-sqlite --test tests/admin-api.integration.test.mjs`
- [x] T028 [US3] Add `tests/admin-settings.test.mjs`: every field validation, the HTTPS/localhost rule, numeric bounds, blank non-secret deletes the override, blank secret keeps the envelope byte-identical, one invalid field writes nothing, the transaction rolls back, the DB holds `v1:` envelopes and no plaintext, the masked view exposes only last-four, and a missing/wrong key is a field error.
  - proves: `node --experimental-sqlite --test tests/admin-settings.test.mjs`
- [x] T029 [P] [US3] Change `src/lib/mailer.mjs` to resolve `getEffectiveSmtp()` in `status()` and `send()`, cache by the fingerprint `{host, port, secure, user, pass}`, rebuild on change, warn once when disabled, and keep `resetTransport`; extend `tests/mailer.test.mjs` for env/admin precedence, fingerprint rebuild, disabled behavior, and no secret in logs.
  - proves: `node --experimental-sqlite --test tests/mailer.test.mjs`
- [x] T030 [US3] Extend `tests/admin-api.integration.test.mjs`: `/admin` and every `/api/admin/*` 401 without a cookie; `/admin/login` 200 with noindex; login 303/200 with the exact cookie attributes; wrong password 401; five failures → 429 even with the correct password; expired session row → 401 and removed; logout revokes; `/admin` 200 noindex with a session; 401 bodies contain no settings.
  - proves: `node --experimental-sqlite --test tests/admin-api.integration.test.mjs`
- [x] T031 [US3] Extend `tests/admin-api.integration.test.mjs`: save valid settings → 303/200; the page shows the masked last four; the SQLite file has a `v1:` envelope and no plaintext; a blank secret leaves the envelope unchanged; an invalid URL/cap/port/from yields 400 with all field errors and no write; a cross-origin POST is 403; a missing `ENCRYPTION_KEY` yields a field error and no plaintext.
  - proves: `node --experimental-sqlite --test tests/admin-api.integration.test.mjs`
- [x] T032 [US3] Add the model-switch proof to `tests/admin-api.integration.test.mjs`: start with stub A and ask (model A); log in, save `aiBaseUrl` = stub B and `aiModel` = `model-b`; ask again and assert the response model is `model-b` and stub B's log records `model-b`, with no restart.
  - proves: `node --experimental-sqlite --test tests/admin-api.integration.test.mjs`
- [x] T033 [US3] Extend `scripts/test-contact-api.mjs`: after the existing valid send, log in with the admin hash/key, save SMTP host/port to a second sink, send a second contact message from the same IP, and assert the second sink receives it with no restart; keep the delivery-failure instance and every existing assertion.
  - proves: `node scripts/test-contact-api.mjs`
- [x] T034 [US3] Extend `scripts/test-public-routes.mjs`: `/admin` 401 with noindex and a link to `/admin/login`; `/admin/login` 200 with noindex; the sitemap has `/ask` and no `/admin`; the nav has Ask and no Admin; `llms.txt`, `resume.json`, `/api/profile`, and JSON-LD contain no admin fact; every Phase 1/2 assertion unchanged.
  - proves: `node scripts/test-public-routes.mjs`
- [x] T035 [US3] Extend `scripts/verify-container.mjs`: probe `/admin` 401, `/admin/login` 200 with noindex, `/ask` 200, `POST /api/ask` with a JSON question → 503 `unconfigured` (the container has no AI env), and `POST /api/admin/login` with a form body → 401 (no `ADMIN_PASSWORD_HASH`); include them in the summary/routes count; keep health, volume persistence, disabled SMTP, and the image secret scan.
  - proves: `node scripts/verify-container.mjs`
- [x] T036 [US3] Extend `scripts/check-agent-output.mjs`: the sitemap contains `/ask`; no `/admin` in the sitemap, `llms.txt`, `resume.json`, `/api/profile`, or JSON-LD; no draft regression; `buildResume`/`buildProfileApi`/`buildLlmsTxt`/`buildPersonJsonLd` outputs are unchanged by `assistantPolicy`.
  - proves: `node scripts/check-agent-output.mjs`

**Checkpoint**: all three stories are independently functional; the admin panel is the last increment.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Styling, secret hygiene, and the full validation gate.

- [x] T037 [P] Add the ask/admin styling to `src/styles/global.css` and the component-scoped styles using existing tokens only (no new hex colours), honor reduced motion, and keep visible focus; run the contrast check.
  - proves: `node scripts/check-contrast.mjs`
- [x] T038 [P] Add `tests/secret-scan.test.mjs`: scan `src/`, `scripts/`, `content/`, `.env.example` for private-key blocks, long `sk-`-style tokens, real `v1:` envelopes outside test fixtures, and a tracked/created `.env`; assert every new env name is documented with an empty value.
  - proves: `node --experimental-sqlite --test tests/secret-scan.test.mjs`
- [x] T039 Run the exact eight validation commands in order from a clean shell and record the output; fix any failure without changing the list.
  - proves: `npm ci && npm run build && npm test && node scripts/check-agent-output.mjs && node scripts/test-public-routes.mjs && node scripts/test-contact-api.mjs && node scripts/lighthouse-check.mjs && node scripts/verify-container.mjs`
- [x] T040 Final repository review: confirm only intended files changed, no secret or evidence is tracked, `PRD.phases.md` Phase 3's `**Spec:**` line is the only plan edit, and Phase 1/2/4 sections are untouched.
  - proves: `git status --short && git diff --check && git diff --stat`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T001–T004 can run in parallel.
- **Foundational (Phase 2)**: depends on Setup; blocks all user stories. T005, T006, T008, T010 can run in parallel; T007 depends on T005 + T006 + T002; T009 depends on T008 + T001.
- **US1 (Phase 3)**: depends on Foundational. T011 depends on T007 + T008 + T009 + T010; T012 depends on T011; T013 depends on T001 + T012; T014 is independent of T011; T013–T015 are one build-gate unit — T013 compiles with `npx astro build`, T014 adds the nav/sitemap with a unit-test proof, T015 updates both output checks and is the first `npm run build` proof; T016/T017/T018 depend on T013 + T015.
- **US2 (Phase 4)**: depends on Foundational + US1's service. T019 depends on T005; T020 depends on T011 + T019; T021 depends on T013 + T020; T022 depends on T012 + T020.
- **US3 (Phase 5)**: depends on Foundational; can start in parallel with US1/US2 for T023/T024/T029. T025 depends on T024; T026 depends on T023 + T024; T027 depends on T023 + T024 + T007; T028 depends on T007 + T027; T030 depends on T026 + T027; T031 depends on T027 + T028; T032 depends on T012 + T031; T033 depends on T029 + T027; T034 depends on T025 + T026; T035 depends on T025 + T026 + T013; T036 depends on T014.
- **Polish (Phase 6)**: depends on the desired stories. T039 depends on all of T001–T038; T040 depends on T039.

### User Story Dependencies

- **US1 (P1)**: after Foundational; no dependency on US2/US3. Needs an env-configured model for its own tests.
- **US2 (P2)**: after Foundational + US1's service; its integration test reuses T012's suite.
- **US3 (P3)**: after Foundational; its model-switch proof needs US1's `/api/ask` (T032) and its SMTP proof needs the existing contact route (T033).
- Stories are independently testable at their checkpoints; the model-switch and SMTP-switch proofs are the only intentional cross-story integration tests.

### Within Each User Story

- Tests first where practical → models/adapters → service → route/page → integration.
- No task depends on a task in a later phase except the two cross-story proofs noted above.
- Do not start T039 until every story checkpoint passes.

### Parallel Opportunities

- Setup: T001, T002, T003, T004.
- Foundational: T005, T006, T008, T010; then T007 and T009.
- US1: T014 alongside T011/T012; T016/T017/T018 after the T013–T015 build-gate unit.
- US2: T019 first; T021 and T022 after T020.
- US3: T023, T024, T029 in parallel; then T025/T026/T027; then T028/T030/T031; then T032/T033/T034/T035/T036.
- Polish: T037 and T038 in parallel; T039 serial; T040 last.

---

## Parallel Example: US1

```bash
# After foundational, start the service and the sitemap library work together:
Task: "T011 Add src/lib/ask-service.mjs"
Task: "T014 Add the Ask nav entry and sitemap path (unit test only)"

# Then the route and the build-gate unit (T013 → T014 → T015, in order):
Task: "T012 Add src/pages/api/ask.ts"
Task: "T013 Add AskPanel.astro and ask.astro (npx astro build)"
Task: "T015 Extend check-static-output.mjs AND check-agent-output.mjs (first npm run build)"
```

## Parallel Example: US3

```bash
# Independent admin building blocks:
Task: "T023 Add src/lib/admin-auth.mjs"
Task: "T024 Add src/lib/admin-page.mjs"
Task: "T029 Wire effective SMTP into src/lib/mailer.mjs"

# Then the pages and API:
Task: "T025 Add BaseLayout noindex + admin/login + admin catch-all"
Task: "T026 Add src/pages/admin/index.astro"
Task: "T027 Add the four admin API routes"
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Complete Setup (T001–T004) and Foundational (T005–T010).
2. Complete US1 (T011–T018).
3. **STOP and VALIDATE**: `tests/ask-service.test.mjs`, `tests/ask-api.integration.test.mjs`, `node scripts/check-static-output.mjs`, `node scripts/test-public-routes.mjs`, `node scripts/lighthouse-check.mjs`.
4. US1 is a demo-grade assistant with an environment-configured model. Do not expose it without US2.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → grounded answers, citations, policy, unconfigured handling → demo.
3. US2 → per-IP and daily caps → safe to expose.
4. US3 → admin panel, encrypted settings, no-restart switches → owner-operable.
5. Polish → styling, secret scan, the eight-command gate.

### Parallel Team Strategy

1. Team completes Setup + Foundational together.
2. After Foundational: Developer A takes US1, Developer B takes US3's admin auth/page/mailer, Developer C can prepare US2's limiter tests.
3. US2 wires into the completed ask service.
4. T032/T033/T039 are the integration gates.

---

## Coverage Map

| Requirement group | Tasks |
|---|---|
| FR-500–FR-515 (ask) | T001, T008–T018, T020–T022 |
| FR-600–FR-607 (limits) | T005, T019–T022 |
| FR-700–FR-718 (admin) | T003, T005–T007, T023–T036 |
| FR-800–FR-809 (preservation/quality) | T013, T015–T018, T021, T029, T033–T040 |
| SC-500–SC-507 | T012, T016, T022, T028, T030–T032, T039 |

## Notes

- `[P]` means different files and no dependency on an incomplete task; it does not mean "run without the phase checkpoint".
- Every 200 `/api/ask` response must have a non-empty `sources` array; a test that only checks the answer text does not satisfy the citation AC.
- Every admin response and page is checked for the full secret, not just for the mask.
- The provider stub log is the authority for "no external call": assert no new line after a cap, policy, unconfigured, or validation rejection.
- The eight validation commands are fixed; extend the checks inside them, never add a ninth.
- T013–T015 are one build-gate unit: no task whose proof runs `npm run build` may start before T015 updates both `check-static-output.mjs` and `check-agent-output.mjs` for the one-island allowance.
- No task commits, pushes, tags, or deploys.
