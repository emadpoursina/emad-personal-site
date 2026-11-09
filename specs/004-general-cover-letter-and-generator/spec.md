# Feature Specification: Phase 4 — General Cover Letter and Generator Path

**Feature Branch**: `emad-personal-site/t_0ca1a753-phase-4-general-cover-letter-and-generat`

**Created**: 2026-11-09

**Status**: Ready for planning

**Input**: Phase 4 of `PRD.phases.md` (`PRD.md` v1.4): F5 General cover letter (all), F9 cover-letter generator (all), F10 abuse protection (rate limit and daily cap for F9 only).

**Scope fence**: The tailored CV per job (F13, V1.1), chat transcript review (F16), case-study editing (F17), V1.1 case studies (F14, F15), analytics, multi-user admin, and deployment are out of scope. Existing Phase 1/2/3 behavior — home, About, case studies, contact, CV, health check, agent-readable outputs, sitemap, ask assistant, admin settings and sessions, contact limiter, assistant limiter, shared admin settings, accessibility, container persistence — must stay green.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Visitor reads the general cover letter (Priority: P1)

A recruiter opens `/cover-letter`, either from the navigation or from a link in an application, and reads a complete general letter. The letter begins with a greeting and has no city or date letterhead. It states the work-authorization position verbatim ("Requires employer-sponsored work authorization."), signs off "Best regards, Emad Poursina", and lists LinkedIn and GitHub on separate lines after the sign-off. The whole letter is in the server-rendered HTML and is readable with JavaScript disabled. A build check fails if any of the six PRD-banned phrases ever appears in the letter.

**Why this priority**: This is the phase's only guaranteed-available artifact. The generator may stay unconfigured for a long time (PRD R11), and the phase exit criteria require the general letter to work on its own.

**Independent Test**: Build the site, boot `dist/server/entry.mjs` with no generator configuration, open `/cover-letter`, and assert: HTTP 200, exactly one `<h1>`, the greeting is the first letter text with no city/date line above it, the exact authorization line and sign-off, the two profile links on separate lines after the sign-off, no banned phrase anywhere in the letter, no `<form` on the page (unconfigured hides it), and the letter text present with every `<script>` element removed (no-JS readability). Then run the build check against a temporary content file containing a banned phrase and assert it fails naming the phrase.

**Acceptance Scenarios**:

1. **Given** the site is built, **When** a visitor opens `/cover-letter`, **Then** the response is HTTP 200 with one `<h1>` and the general letter in the initial HTML.
2. **Given** a visitor reads the letter, **When** it is displayed, **Then** it starts with the greeting and contains no city, country, or date line before it.
3. **Given** the letter is rendered, **When** its text is inspected, **Then** it contains the exact string `Requires employer-sponsored work authorization.` and the exact sign-off `Best regards, Emad Poursina`.
4. **Given** the letter is rendered, **When** the links after the sign-off are inspected, **Then** `https://www.linkedin.com/in/emadpoursina/` and the GitHub profile link each appear in their own element on separate lines, in that order.
5. **Given** a letter content file that contains `synergy`, **When** the build runs, **Then** the build fails and the error names `synergy` and the field it was found in.
6. **Given** the letter is rendered, **When** all `<script>` elements are removed from the HTML, **Then** the full letter text is still present.
7. **Given** the header and sitemap, **When** they are inspected, **Then** Cover Letter appears in the public navigation and in `/sitemap.xml` exactly once.

---

### User Story 2 - Visitor gets a letter tailored to a job description (Priority: P2)

With the generator configured, `/cover-letter` shows a job-description form under the general letter. The visitor pastes a job description (up to 8,000 characters) and submits it; the page shows a visible working state, disables the button, and displays the returned letter. The backend calls the external generator service through the site's adapter with the key from `.env` and a bounded 30-second timeout. Before display the server guarantees the exact authorization line and the exact sign-off, appending only what the generator omitted. A generator error or timeout shows a clean error and the general letter remains available as the fallback; a job description that is empty, over-long, or not a string is rejected before any external call.

**Why this priority**: F9 is the phase's differentiator, but it is blocked on an external service that does not exist yet and must degrade cleanly to the P1 letter.

**Independent Test**: Boot the built server against `scripts/generator-stub.mjs` with a temporary `DATA_DIR`; submit a 1,000-character job description and assert HTTP 200, a non-empty `letter`, both required lines present, and the stub received the job description and the bearer key. Point the stub at a mode that returns a letter without the required lines and assert both are appended. Return a 500 and assert 502 with the general letter in the response; delay beyond the timeout and assert 504 with the same fallback. Boot with no generator endpoint and assert the page has no form and `POST /api/cover-letter` is 503 with no stub call.

**Acceptance Scenarios**:

1. **Given** a configured generator, **When** a visitor opens `/cover-letter`, **Then** a form with a labelled job-description textarea (`maxlength="8000"`), a submit button, and a live status region is rendered below the general letter.
2. **Given** the unconfigured state, **When** the page is rendered, **Then** no generator form appears and the general letter is shown unchanged.
3. **Given** a valid submission, **When** the generator returns a letter, **Then** the response is HTTP 200 with the letter text and the page displays it as text, never as HTML.
4. **Given** a returned letter missing the authorization line, **When** the response is assembled, **Then** the exact line is appended before display and the returned letter body is otherwise unchanged.
5. **Given** a returned letter missing the sign-off, **When** the response is assembled, **Then** the exact sign-off is appended before display.
6. **Given** a returned letter containing both lines, **When** the response is assembled, **Then** nothing is appended and both lines appear exactly once.
7. **Given** the generator returns a non-2xx status, malformed JSON, or an empty letter, **When** the request completes, **Then** the response is HTTP 502 with a clean message and the general letter as fallback, no upstream body or secret is echoed, and nothing is stored.
8. **Given** the generator exceeds 30 seconds, **When** the request completes, **Then** the response is HTTP 504 with a clean message and the general letter as fallback, and nothing is stored.
9. **Given** an empty or whitespace-only job description, **When** it is submitted, **Then** HTTP 400 with a field-level error and no external call.
10. **Given** a job description of 8,001 characters, **When** it is submitted, **Then** HTTP 400 before any external call; exactly 8,000 characters is accepted.
11. **Given** no generator endpoint or no generator key, **When** `POST /api/cover-letter` is called, **Then** HTTP 503 with the fixed message and no external call.
12. **Given** the generator is configured in the admin panel, **When** the next request arrives, **Then** the new endpoint is used with no restart.

---

### User Story 3 - Generator use is cost-bounded by shared limits (Priority: P3)

The owner pays for the generator service, so the cover-letter endpoint has the same hard limits as the assistant. More than 10 requests from one IP within an hour returns HTTP 429 with `Retry-After`. The SQLite-backed UTC-day cap is shared across `/api/ask` and `/api/cover-letter`, so the two features cannot double the day's spend; exceeding it returns HTTP 429 with a paused-for-today message, writes one operational event, and makes no external call until the next UTC day. The counter survives a restart. Invalid and unconfigured requests never consume a unit.

**Why this priority**: The endpoint spends money on every configured call and ships in the same phase; the guard must be part of it even though it is a separate concern.

**Independent Test**: With the stub configured and a daily cap of 3, send two assistant questions and two cover-letter requests and assert the fourth call (whichever endpoint it hits) is 429 `daily_cap`; restart on the same `DATA_DIR` and assert it is still 429; assert the stub logs show no call after the cap. Separately send 11 cover-letter requests from one IP and assert the 11th is 429 `rate_limited` with `Retry-After`, and one `daily_cap_events` row exists for the day.

**Acceptance Scenarios**:

1. **Given** one IP has made 10 requests to `/api/cover-letter` in the last hour, **When** the 11th arrives, **Then** HTTP 429 with `Retry-After` and no external call.
2. **Given** the shared UTC-day count has reached the configured cap, **When** another cover-letter request arrives, **Then** HTTP 429 with the paused-for-today message and no external call.
3. **Given** assistant requests consumed most of the cap, **When** a cover-letter request would exceed it, **Then** it is rejected with the same shared cap, proving one counter.
4. **Given** the cap was reached before a restart, **When** the server restarts on the same day, **Then** requests are still rejected until the next UTC day.
5. **Given** a new UTC day, **When** the first request arrives, **Then** the shared counter starts from zero.
6. **Given** an invalid, rate-limited, or unconfigured request, **When** the counter is inspected, **Then** it did not increase.
7. **Given** the cap is reached, **When** the event is recorded, **Then** one operational event row exists for that UTC day and feature, with no IP, job description, or letter.
8. **Given** the contact form's limiter, **When** this phase ships, **Then** its 5-per-hour behavior is unchanged.

---

### Edge Cases

- A job description of exactly 8,000 characters is accepted; 8,001 is rejected before any limit counter is consumed beyond the per-IP window.
- A whitespace-only, non-string, JSON array, `null`, malformed JSON, or non-JSON content type is rejected with a stable 4xx and no external call.
- A job description containing HTML, script text, or prompt-injection instructions is sent as data; the returned letter is rendered as text and never as markup.
- The generator returns extra fields or an unknown content type; only a `letter` string is read, and a missing or non-string `letter` is an upstream error.
- The generator returns a letter longer than the accepted maximum (12,000 characters); the response is a clean 502 and nothing is stored.
- The generator returns a letter that already contains the authorization line twice; the server appends nothing and does not dedupe the body, so the page states the position but the letter is not rewritten.
- The returned letter ends with the sign-off in a different capitalization; the exact required sign-off is appended because the match is exact.
- The daily-cap counter is unavailable (SQLite failure); the endpoint fails closed with 503 `storage` and makes no external call.
- The settings store cannot be read when resolving the generator configuration; the page renders the general letter with no form and the API returns 503 `unconfigured`, never a 500.
- The per-IP window is exhausted; the request does not consume the daily cap.
- Concurrent requests at the daily-cap boundary cannot let more than the cap through.
- The generator endpoint is saved but the key is missing; the feature is unconfigured (endpoint AND key required), the form stays hidden, and the API returns 503.
- The generator key is present but the endpoint is blank; same unconfigured behavior.
- The generator endpoint points at `http://localhost`; accepted for local development and tests, every non-HTTPS non-loopback endpoint rejected by settings validation (unchanged Phase 3 rule).
- The generator times out at exactly the 30-second bound; the request maps to 504, not 502.
- `/cover-letter` is requested with JavaScript disabled; the general letter is complete and the form area explains that JavaScript is required, offering the contact form.
- The visitor submits twice quickly; the button is disabled while a request is in flight and the second submit is ignored by the page (the server contract still applies).
- A generator response includes a secret-like token in its error body: the API returns only the fixed message, never the upstream body.
- The sitemap is generated at build time; `/cover-letter` appears once even though the page is server-rendered.
- An admin save changes the generator endpoint while a request is in flight; the in-flight request keeps the endpoint it resolved, the next request uses the new one.

## Requirements *(mandatory)*

### Functional Requirements

**General cover letter (PRD F5)**

- **FR-900**: `/cover-letter` MUST return HTTP 200, contain exactly one `<h1>`, and include the complete general letter in the initial server-rendered HTML. (F5 AC1)
- **FR-901**: The letter text MUST come from a committed content file next to `content/profile.json` (`content/cover-letter.json`), not from page code, and every fact in it MUST trace to `content/profile.json`; the page MUST render it server-side with no client JavaScript required to read it. (F5, F12 AC1)
- **FR-902**: The letter MUST begin with a greeting and MUST NOT contain a city, country, or date letterhead line before it. (F5 AC1)
- **FR-903**: The rendered letter MUST contain the exact string `Requires employer-sponsored work authorization.`, identical to `profile.workAuthorization`. (F5 AC2)
- **FR-904**: The rendered letter MUST contain the exact sign-off `Best regards, Emad Poursina`. (F5 AC2)
- **FR-905**: The rendered letter MUST show the LinkedIn (`https://www.linkedin.com/in/emadpoursina/`) and GitHub links on separate lines after the sign-off, in that order, with hrefs identical to `profile.links`. (F5 AC4)
- **FR-906**: The build MUST fail, naming the offending phrase and field, when the rendered general letter contains any of `I am writing to express my interest`, `passionate`, `dynamic`, `synergy`, `results-driven`, or `team player` (case-insensitive). The check MUST be wired into the `npm run build` chain and MUST scan the letter content rather than unrelated page chrome. (F5 AC3)
- **FR-907**: The content file MUST be validated at build time: known keys only; a greeting matching `^Dear [A-Za-z][A-Za-z .'-]*,$` with no digits and no month name; 2–6 non-empty paragraphs each ≤ 1,500 characters and ≤ 5,000 in total; no URL or email address inside the paragraphs; exactly two links labelled `LinkedIn` and `GitHub` matching the profile; the authorization line and sign-off matching the profile-derived exact values.
- **FR-908**: `Cover Letter` MUST appear in the public navigation and `/cover-letter` MUST appear exactly once in `/sitemap.xml`, in the public-page order after `/contact`; no admin route or setting may become discoverable. (PRD §6)

**Cover-letter generator (PRD F9)**

- **FR-920**: WHEN the generator is configured, `/cover-letter` MUST render a form with a labelled job-description `<textarea maxlength="8000">`, a submit button, and a status region carrying `role="status"` and `aria-live="polite"`. WHEN it is unconfigured, the page MUST render no generator form and show the general letter only. (F9 AC4)
- **FR-921**: `POST /api/cover-letter` MUST accept only `application/json` with a JSON object body containing a `jobDescription` string; other content types → 415, malformed JSON or wrong shape → 400, non-POST → 405. (F9 AC1)
- **FR-922**: The job description MUST be trimmed; empty → HTTP 400 with `errors.jobDescription`; longer than 8,000 characters → HTTP 400; exactly 8,000 is accepted. Both rejections MUST happen before any external call. (F9 AC5)
- **FR-923**: A valid, configured request MUST call the external generator through the site adapter using the key from `.env`, with a bounded timeout of at most 30 seconds, and return the letter. (F9 AC1, Journey 4)
- **FR-924**: After a successful generator response the server MUST ensure the exact authorization line and the exact sign-off are present, appending only the missing ones as separate text and never rewriting the letter body. (F9 AC2)
- **FR-925**: A generator error or timeout MUST produce a clean JSON error (HTTP 502 or 504) that includes the general letter as the fallback, and MUST store nothing. (F9 AC3)
- **FR-926**: WHEN the generator is not configured (endpoint or key absent), `POST /api/cover-letter` MUST return HTTP 503 with the fixed message and MUST NOT make an external call. (F9 AC4)
- **FR-927**: The tailored letter MUST be returned as plain text and rendered by the page as text, never as HTML; no script from the generator may execute. (F9, security)
- **FR-928**: The effective endpoint MUST resolve as admin setting `generator.endpoint` > env `GENERATOR_ENDPOINT` > empty, and the effective key as env `GENERATOR_API_KEY` only; `configured` means both are non-empty; values MUST resolve on every request with no restart, and a failure to read the settings store MUST fail closed to unconfigured (503, no external call) with one warning rather than a 500. (parent decision 5, F21 AC3)
- **FR-929**: The adapter request/response contract (method, headers, body, response shape, timeout, error mapping) MUST be documented as the single integration point and MUST be confirmable against the real service before production enablement. (PRD R11)
- **FR-930**: No upstream error body, upstream header, generator key, environment value, job description, or generated letter may appear in any response body, error body, or new log line. (R3, R4)

**Abuse protection (PRD F10, F9 part only)**

- **FR-940**: More than 10 `POST /api/cover-letter` requests from one IP address within one hour MUST return HTTP 429 with a `Retry-After` header; every attempt counts, including rejected ones. (F10 AC1)
- **FR-941**: The SQLite UTC-day cap MUST be shared by `/api/ask` and `/api/cover-letter`, default 200, configured through the existing `ASK_DAILY_CAP` env name and `ask.dailyCap` setting key without rename; exceeding it MUST return HTTP 429 with a paused-for-today message. (F10 AC2, AC4)
- **FR-942**: The shared count MUST persist in SQLite across restarts, MUST reset by UTC date key, and MUST remain correct under concurrent requests at the cap boundary. (F10 AC2)
- **FR-943**: When the cap is reached, the event MUST be logged once per UTC day and feature (one bounded operational row plus one console line), with no IP, job description, or letter, and no external call may be made until the next UTC day. (F10 AC3)
- **FR-944**: One unit MUST be consumed per valid, configured request that reaches the external service; invalid, rate-limited, and unconfigured requests MUST NOT consume the daily cap. (Phase 3 semantics)
- **FR-945**: The two 429 causes MUST be distinguishable by error code and message so the page can explain either "too many requests" or "paused for today". (F10)
- **FR-946**: The contact form's 5-per-hour limiter and the assistant's per-IP window, cap enforcement path, question log, and response behavior MUST remain unchanged; the shared daily cap in FR-941 is the only intended change to the assistant's accounting. (F6 AC5, F8)

**Preservation and quality (PRD F11, F12)**

- **FR-950**: `/`, `/about`, `/case-studies`, `/case-studies/*`, `/contact`, `/cv.pdf`, `/healthz`, `/llms.txt`, `/resume.json`, `/api/profile`, `/sitemap.xml`, `/ask`, `/admin`, `/admin/login`, `POST /api/ask`, `POST /api/contact`, the assistant and contact limiters, and shared admin settings MUST keep their Phase 1/2/3 status codes and content. (regression)
- **FR-951**: `/cover-letter` MUST score at least 95 Performance and 100 Accessibility in the standard mobile Lighthouse audit with LCP under 2.0 seconds; the home and `/ask` pages MUST stay at their current scores; every new text/background pair MUST meet 4.5:1 contrast. (F12, PRD §8)
- **FR-952**: Only `/ask` and `/cover-letter` may ship executable client JavaScript, each with at most one module script; every other page MUST remain script-free apart from the JSON-LD block, and the general letter MUST be readable with all scripts removed. (F12 AC1)
- **FR-953**: Every new page and control MUST use semantic landmarks, labelled controls, a visible focus indicator, reduced-motion handling, and keyboard-complete interaction. (F12, PRD §10)
- **FR-954**: The database MUST move to an additive, idempotent schema version 3; existing rows MUST survive; tests MUST cover a fresh database and a version-2 database upgrade inside the container's named volume. (F11 AC4, parent decision 1)
- **FR-955**: The eight existing validation commands in `.ainative/project.yaml` MUST stay green; new unit and integration tests MUST run under `npm test`, and route/security checks MUST extend the existing scripts rather than add commands. (parent decision 13)
- **FR-956**: `.env.example` MUST document `GENERATOR_ENDPOINT`, `GENERATOR_API_KEY`, and `GENERATOR_TIMEOUT_MS` with empty values, and MUST state that `ASK_DAILY_CAP` is the shared daily cap for the assistant and the cover-letter generator. (F11 AC2, F10 AC4)
- **FR-957**: Tests and builds MUST be hermetic: no real generator call and no real key, using a local generator stub and injected collaborators. (parent decision 12)
- **FR-958**: The site MUST add no analytics, tracker, third-party browser request, or new runtime dependency for this feature. (PRD §8, §9)

### Key Entities

- **Cover-letter content document**: the committed `content/cover-letter.json` with the greeting, 2–6 paragraphs, the exact authorization line, the exact sign-off, the two profile links in order, and a last-updated date.
- **General letter**: the deterministic text built from the content document, used for the page, the build check, the API fallback, and the no-JS proof.
- **Generator configuration**: the effective endpoint (admin override, else env, else empty), the env-only key, the timeout, and the derived `configured` flag; resolved per request.
- **Generator request**: the adapter's outbound JSON — job description, candidate facts, required phrases, and length bound — sent with a bearer key.
- **Generator response**: the adapter's inbound JSON with a single non-empty `letter` string and nothing else read.
- **Generation result**: the letter after required-line enforcement, plus which required line, if any, was appended.
- **Shared daily counter**: one row per UTC date with the combined assistant and cover-letter count, shared by both endpoints.
- **Cap event**: one bounded operational row per UTC date and feature when the cap is hit; no personal data.
- **Cover-letter rate window**: the in-memory per-IP sliding window of 10 requests per hour for `/api/cover-letter`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-900**: A visitor opening `/cover-letter` reads a complete general letter with the exact authorization line, the exact sign-off, both profile links on separate lines, no letterhead, and no banned phrase; the same text is present with every script removed.
- **SC-901**: The build fails, naming the phrase and field, whenever any of the six banned phrases is introduced into the letter content, and passes on the shipped content.
- **SC-902**: With the generator unconfigured, the page has no form and the API returns 503 without any external request; with it configured, a valid job description returns a letter carrying both required lines, and only the missing ones are appended.
- **SC-903**: A generator error returns 502 and a timeout returns 504, each with the general letter available as fallback, no upstream detail or secret, and nothing stored.
- **SC-904**: The 11th `/api/cover-letter` request from one IP in an hour returns 429; the first request past the shared daily cap returns 429 with the paused message; the cap survives a restart, resets on the next UTC day, and no external call occurs after the cap.
- **SC-905**: The full validation list still passes, `/cover-letter` meets Performance 95 / Accessibility 100 / LCP < 2.0 s, the home and `/ask` scores are unchanged, and no new client script appears on any other page.
- **SC-906**: No job description or generated letter is persisted; the only new stored rows are the shared counter and at most one cap event per day and feature, and no log line contains a job description, a letter, an IP address, or a secret.
- **SC-907**: The database upgrade from schema version 2 to 3 keeps every existing row and table, and a fresh database reaches version 3 in one open.

## Assumptions

- The real generator service's API documentation is still pending (PRD R11, §13). The site-side adapter contract is this project's own design and is the single point to remap when the real contract arrives; enabling it in production is an operator-review item, not a blocker for this phase.
- The general-letter copy is drafted from the approved `content/profile.json` and the PRD F5 rules. The owner approves the final wording at UAT; changing it is a content edit, not a code change.
- The generator key lives in the environment only (`GENERATOR_API_KEY`), as PRD §9 and F9 AC1 say ("the key from `.env`"); this phase adds no admin secret field and leaves the 12-field admin form unchanged.
- No job description or generated letter is stored; counters and one bounded cap-event row are operational state, not content.
- The daily-cap name stays `ASK_DAILY_CAP` / `ask.dailyCap` for compatibility; only its meaning widens to both AI endpoints, documented in `.env.example`, the admin label, and the contract.
- The greeting is "Dear Hiring Manager," because the visitor may not be the hiring manager and no recipient name can be known; there is no city/date letterhead.
- The generator endpoint is a full URL used as-is (no path is appended), must be HTTPS unless it is a loopback host (existing settings URL rule), and the key is sent as an `Authorization: Bearer` header.
- The site is served over plain HTTP locally and HTTPS once deployed; no transport change is introduced.
- The test generator is a local stub; no real generator service or key exists on this host and none is needed.
- `/cover-letter` is a public page and belongs in the navigation and sitemap; `/admin*` stays undiscoverable.

## Clarifications

### Session 2026-11-09

- Q: What is the general-letter copy, and which greeting should it use? → A: Drafted from the approved profile and the PRD F5 rules — opened by `Dear Hiring Manager,`, no city or date letterhead, authorization and sign-off exact, no banned phrase — and committed as `content/cover-letter.json`; the owner approves the final wording at UAT and can edit the content file without a code change.
- Q: What is the generator integration contract while the real service's API docs are still missing? → A: The site fixes its own adapter contract (documented outbound request with job description, candidate facts, required phrases and a length bound; bearer auth; a single `letter` string response; 30-second bound; 502/504 mapping) and treats it as the one integration point to remap when PRD R11 is answered; production enablement stays an operator-review item.
- Q: Where does the generator key live — env only or also as an admin secret? → A: Environment only (`GENERATOR_API_KEY`), matching PRD §9 and F9 AC1; the admin form keeps its 12 fields and the generator endpoint remains the only admin-editable generator setting.
- Q: Does the site store job descriptions or generated letters, and what may it keep? → A: Nothing content-bearing is stored. Only the shared UTC-day counter increments and, when the cap is hit, one bounded cap-event row per UTC day and feature is written; logs carry no IP, job description, letter, or secret.
- Q: How is the shared daily cap named and explained? → A: The existing `ASK_DAILY_CAP` env name and `ask.dailyCap` setting key are kept and now mean the combined assistant plus cover-letter cap (default 200); each endpoint explains the cap in its own message, and `.env.example`, the admin label, and the API contract document the shared meaning.

## Open Questions

None blocking. Operator-review items are recorded in the Clarifications above: the final general-letter wording, the real generator service's endpoint/request/auth, the env-only generator key, the no-storage decision, and the shared daily-cap naming. F9 remains behind the configuration gate until the real service contract is confirmed.
