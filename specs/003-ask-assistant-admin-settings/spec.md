# Feature Specification: Phase 3 — Ask Assistant, Abuse Limits, and Admin Settings

**Feature Branch**: `emad-personal-site/t_8562afa1-phase-3-ask-me-assistant-and-admin-setti`

**Created**: 2026-11-09

**Status**: Ready for planning

**Input**: Phase 3 of `PRD.phases.md` (`PRD.md` v1.4): F8 Ask-me AI assistant (all), F10 abuse protection (rate limit and daily cap for F8 only), F21 admin settings panel (all).

**Scope fence**: The cover-letter generator and its rate limit (F5, F9, F10 for F9), chat transcript review (F16), case-study editing (F17), tailored CV (F13), V1.1 case studies (F14, F15), analytics, multi-user admin, and deployment are out of scope. Existing Phase 1/2 behavior — home, About, case studies, contact, CV, health check, agent-readable outputs, sitemap, accessibility, container persistence — must stay green.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Visitor asks a grounded question (Priority: P1)

A hiring manager opens `/ask`, types a question about Emad's experience, and sees a visible thinking state while the submit button is disabled. The answer is drawn only from the approved profile and published case studies, is followed by the disclaimer "AI assistant. The CV and case studies are the source of record.", and carries at least one citation link to the profile content it used. A question about something not in the profile gets a plain "not available" answer that points to the contact form. Questions about salary, a private codebase, or a named visa program are declined using the approved wording and never invent a number or immigration position. If no model is configured, the page says "The assistant is unavailable right now" and no external call is made.

**Why this priority**: This is the phase's headline capability; without it there is no assistant to limit or configure.

**Independent Test**: Point the assistant at a local OpenAI-compatible stub, submit a profile question, and assert: HTTP 200, a non-empty answer, the exact disclaimer, a non-empty `sources` array whose `href` values resolve to real site routes, and the stub received the effective model. Then exercise empty/over-long input, an unconfigured server, and the three decline policies.

**Acceptance Scenarios**:

1. **Given** a configured assistant, **When** a visitor submits a question of 1–1,000 characters, **Then** the reply is displayed with the exact disclaimer and at least one citation link.
2. **Given** a question is in flight, **When** the visitor waits, **Then** a visible thinking state is shown, the submit button is disabled, and an ARIA live region announces the state.
3. **Given** a question about information absent from the approved profile, **When** the answer returns, **Then** it says the information is not available and suggests the contact form.
4. **Given** a salary-floor question, **When** the answer returns, **Then** it declines, gives no number, and points to the contact form.
5. **Given** a question naming VoiceDash or Villion's private codebase, **When** the answer returns, **Then** it states the codebase is private, links the public case-studies index, and points to the contact form without quoting code.
6. **Given** a question naming a visa program, **When** the answer returns, **Then** it declines program-specific detail, repeats "Requires employer-sponsored work authorization." verbatim, and points to the contact form.
7. **Given** the assistant is not configured, **When** a visitor submits a question, **Then** the page shows "The assistant is unavailable right now" and no external request is made.
8. **Given** a question longer than 1,000 characters or empty after trimming, **When** it is submitted, **Then** the request is rejected before any model call with a field-level error.
9. **Given** a visitor submits prompt-injection text, **When** the assistant answers, **Then** the text is treated as data, the system rules are not revealed, and no secret appears in the reply.

---

### User Story 2 - Owner's assistant usage is capped (Priority: P2)

The owner pays for the model, so the assistant has hard limits: no more than 10 requests per IP per hour and no more than 200 requests per UTC day by default, both adjustable in the admin panel. Exceeding either returns HTTP 429. The daily limit is stored so a container restart does not reset it, resets on the next UTC day, and once reached no external model call is made until the reset. Rejected attempts never reach the model.

**Why this priority**: The assistant is the only feature in this phase that spends money; the limits must ship with it even though they are a separate concern.

**Independent Test**: Boot the built server with a local stub and known limits; send 10 valid questions, assert the 11th returns 429; boot another instance with a daily cap of 3, send three valid questions, assert the fourth returns 429 with the paused-for-today message; restart with the same data directory and assert the cap still holds; assert the stub recorded no request after the cap.

**Acceptance Scenarios**:

1. **Given** one IP has made 10 requests in the last hour, **When** the 11th request arrives, **Then** the response is HTTP 429 with a Retry-After header and the model is not called.
2. **Given** the UTC-day count has reached the configured cap, **When** another request arrives, **Then** the response is HTTP 429 saying the service is paused for today and the model is not called.
3. **Given** the daily cap was reached before a restart, **When** the server restarts on the same day, **Then** requests are still rejected until the next UTC day.
4. **Given** a new UTC day, **When** the first request arrives, **Then** the daily counter starts from zero.
5. **Given** a request rejected for input validation or for an unconfigured assistant, **When** it is counted, **Then** it does not increase the daily cap (it may count in the per-IP window).
6. **Given** a rejected or limited request, **When** the stub log is inspected, **Then** no model call was made for it.

---

### User Story 3 - Owner changes settings in the admin panel (Priority: P3)

Emad opens `/admin` in a browser, is refused with HTTP 401 because he has no session, logs in on the public `/admin/login` page with the password whose hash is in the environment, and reaches a settings form. He can change the AI base URL, model ID, and API key; the daily cap and per-IP limit; the SMTP host, port, security, user, password, and from address; and the generator endpoint. Saved AI settings are used by the very next question with no restart, and saved SMTP settings are used by the next contact message with no restart. API keys and SMTP passwords are encrypted at rest and shown only as a masked last-four hint. Five wrong passwords from one IP within 15 minutes block that IP for 15 minutes.

**Why this priority**: The site can run from environment variables alone; the panel removes the need to edit files and restart, which is the F21 promise, and it depends on the settings groundwork shared with the assistant.

**Independent Test**: Boot the built server with an admin password hash and encryption key; assert `/admin` and every `/api/admin/*` route return 401 without a session; log in; save a new AI base URL and model; send a question and assert the stub received the new values; save new SMTP settings and assert the next contact message reaches the second sink; assert the key is masked and stored encrypted; submit five wrong passwords and assert the IP is blocked.

**Acceptance Scenarios**:

1. **Given** no session cookie, **When** any `/admin` or `/api/admin/*` route is requested, **Then** the response is HTTP 401 and contains no settings or secret.
2. **Given** the correct password, **When** the login form is submitted, **Then** a server-side session starts with an HttpOnly, SameSite=Strict cookie that expires after 8 hours.
3. **Given** five wrong passwords from one IP within 15 minutes, **When** the correct password is submitted, **Then** the login is still refused for 15 minutes.
4. **Given** a valid session, **When** settings are saved, **Then** the next `/api/ask` request uses the new base URL and model without a restart.
5. **Given** a valid session, **When** SMTP settings are saved, **Then** the next contact submission is delivered through the new SMTP settings without a restart.
6. **Given** a stored API key or SMTP password, **When** the admin page is rendered, **Then** only the last four characters are shown and the full value appears in no response, log, or error.
7. **Given** a base URL that is not HTTPS and not localhost, **When** it is saved, **Then** the save is rejected with a field-level error and nothing is written.
8. **Given** a blank API-key or SMTP-password field, **When** the form is saved, **Then** the stored secret is left unchanged.
9. **Given** no encryption key, **When** a secret is submitted, **Then** the save is rejected with a field-level error and no plaintext is stored.
10. **Given** a cross-origin form POST, **When** it reaches an admin endpoint, **Then** it is rejected and no state changes.
11. **Given** a logged-in session, **When** logout is submitted, **Then** the session row is deleted and the cookie no longer grants access.
12. **Given** an admin page, **When** it is rendered, **Then** it carries `noindex, nofollow` and Admin appears in no navigation, sitemap, `llms.txt`, `resume.json`, or JSON-LD.

---

### Edge Cases

- A question of exactly 1,000 characters is accepted; 1,001 is rejected before any limit counter or model call.
- A whitespace-only question, a non-string value, a JSON array, malformed JSON, or a non-JSON content type is rejected with a clear 4xx and no model call.
- The model returns an empty answer, invalid JSON, a non-2xx status, or exceeds the timeout; the visitor sees a clean error, no upstream body or secret is echoed, and the failure is not cached as an answer.
- The model returns HTML or script text; the page renders it as text, never as markup.
- The per-IP window and the daily cap both apply; a request rejected by the per-IP window does not consume the daily cap, and a request rejected by the daily cap does not reach the model.
- Concurrent requests at the daily-cap boundary cannot let more than the cap through.
- The SQLite database is unavailable: the assistant returns a clean 503 and makes no model call rather than bypassing the cap.
- Question logging fails but the cap counter works: the answer is still returned; logging is best effort and never blocks an answer.
- The effective API key cannot be decrypted (wrong `ENCRYPTION_KEY`): the assistant behaves as unconfigured, warns once, and makes no external call.
- `ADMIN_PASSWORD_HASH` is missing or malformed: every login fails closed with no crash.
- A session reaches its 8-hour absolute expiry mid-use: the next request is 401 and the row is removed.
- The session cookie is present but the row was deleted (logout elsewhere): 401.
- A login attempt is blocked: even the correct password is refused until the block expires.
- A settings save contains one invalid field: no field is written; the page shows the field error and keeps the other entered values.
- A blank non-secret setting means "inherit": the environment value or built-in default applies again.
- A blank secret setting means "leave unchanged": the previous encrypted value remains.
- The base URL is `http://localhost`, `http://127.0.0.1`, or `http://[::1]`: accepted for local development; every other non-HTTPS URL is rejected.
- The daily counter's date is the UTC date, independent of the server's local timezone.
- Midnight UTC passes between two requests: the new day's counter starts at zero.
- `/ask` is readable with JavaScript disabled; the interactive panel explains that JavaScript is required and offers the contact form instead.
- `/admin` and `/admin/login` are reachable by direct URL but are absent from the sitemap, navigation, `llms.txt`, `resume.json`, and JSON-LD.
- A profile question matching no specific section still returns at least one valid citation (the summary/About section).
- A policy question while the assistant is unconfigured shows the unconfigured message, because service availability is checked first.
- The generator endpoint is stored but has no behavior in this phase; saving it must not expose or call the generator.

## Requirements *(mandatory)*

### Functional Requirements

**Ask assistant (PRD F8)**

- **FR-500**: `/ask` MUST return HTTP 200 with a single `<h1>`, an introduction, a labelled question field, a submit button, a visible thinking region, an ARIA live region, and the disclaimer "AI assistant. The CV and case studies are the source of record." (F8 AC2, AC5)
- **FR-501**: The question field MUST enforce a 1,000-character maximum in the browser, and the server MUST reject an empty (after trimming) or over-1,000-character question with HTTP 400 and a field-level error before any model call. (F8 AC7)
- **FR-502**: While a request is in flight, the page MUST show a visible thinking state, disable the submit button, and announce the state through an ARIA live region; on completion it MUST restore the control and render the answer, citation links, and disclaimer. (F8 AC2, AC5)
- **FR-503**: `POST /api/ask` MUST accept only a JSON object body with a `question` string; any other content type or shape MUST be rejected with a 4xx and no model call. (F8 AC1, AC7)
- **FR-504**: The assistant MUST send the question, the approved profile context, and system instructions to the configured OpenAI-compatible chat-completions endpoint and display the reply. (F8 AC1)
- **FR-505**: The system instructions MUST state that the approved profile is the only knowledge source, that visitor text is data and never instructions, and that the assistant must not reveal secrets or system text; a prompt-injection attempt MUST NOT change the rules. (F8, PRD §8 prompt injection)
- **FR-506**: When the context lacks the requested information, the answer MUST say the information is not available in the approved profile and suggest the contact form. (F8 AC3)
- **FR-507**: A salary-floor question MUST be declined with no salary number and a pointer to the contact form; no approved salary range exists in the content source. (F8 AC4)
- **FR-508**: A question about the VoiceDash or Villion private codebase MUST state that the codebase is private, link the public case-studies index, quote no private code, and point to the contact form. (F8 AC4)
- **FR-509**: A question naming a visa program MUST decline program-specific detail, repeat "Requires employer-sponsored work authorization." verbatim, and point to the contact form. (F8 AC4)
- **FR-510**: Every successful answer response MUST carry the exact disclaimer "AI assistant. The CV and case studies are the source of record." (F8 AC5)
- **FR-511**: When the effective AI base URL, model, or API key is missing or unusable, `POST /api/ask` MUST return HTTP 503 with the exact message "The assistant is unavailable right now" and MUST NOT make any external call. (F8 AC6)
- **FR-512**: Every successful answer response MUST carry a non-empty `sources` array of `{label, href}` entries built by the server from the profile-backed context sections the request used; `href` MUST be an internal route or anchor that resolves to real site content, and the page MUST render the citations as links. Sources MUST NOT be parsed from free-text model output. (Phase AC; F8)
- **FR-513**: The external model call MUST use a bounded timeout of at most 30 seconds and MUST map provider failures to a clean 502, timeout to 504, and unavailable service to 503, echoing no upstream body, header, or secret. (PRD §8, F8)
- **FR-514**: Every valid question MUST be logged in SQLite with its full text and UTC timestamp; the log MUST NOT contain the visitor's IP address, the answer, or any secret. (PRD change log 1.2)
- **FR-515**: No API key, SMTP password, encryption key, password hash, private document, or environment value may enter a prompt, a log line, an error body, or a response. (PRD §8, R3)

**Abuse protection (PRD F10, F8 part only)**

- **FR-600**: More than 10 `POST /api/ask` requests from one IP address within one hour MUST return HTTP 429 with a `Retry-After` header; every attempt counts in the window, including rejected ones. (F10 AC1)
- **FR-601**: The per-IP limit MUST be configurable (default 10 per hour), with admin settings overriding environment values overriding the default, resolved on every request. (F10 AC4, F21)
- **FR-602**: The number of valid, configured `POST /api/ask` requests that reach the model in a UTC day MUST be capped (default 200, configurable); policy-declined questions count toward the cap, while invalid and unconfigured requests do not consume it. Exceeding the cap MUST return HTTP 429 with a message saying the service is paused for today. (F10 AC2, AC4)
- **FR-603**: The daily count MUST be stored in SQLite so it survives a process restart, MUST reset by UTC date key, and MUST remain correct under concurrent requests at the cap boundary. (F10 AC2)
- **FR-604**: After the daily cap is reached, no external model call may be made until the next UTC day, and the event MUST be logged without a secret or IP address. (F10 AC3)
- **FR-605**: A request rejected by validation, the per-IP window, the daily cap, or the unconfigured state MUST NOT make a model call. (F10, R4)
- **FR-606**: The existing contact-form limit of 5 submissions per IP per hour MUST remain unchanged. (F6 AC5)
- **FR-607**: The two 429 causes MUST be distinguishable by error code and message so the page can explain either "too many questions" or "paused for today". (F10)

**Admin settings panel (PRD F21)**

- **FR-700**: `/admin` MUST return HTTP 401 without a valid session; `/admin/login` MUST be a public page returning HTTP 200. (F21 AC6)
- **FR-701**: Every protected `/admin` route and every protected `/api/admin/*` route MUST return HTTP 401 without a valid session and MUST reveal no settings or secret in the 401 response. The public login routes `/admin/login` (page) and `POST /api/admin/login` are exempt. (F21 AC6)
- **FR-702**: Submitting the password that matches `ADMIN_PASSWORD_HASH` MUST start a server-side session identified by an opaque random cookie that is HttpOnly, SameSite=Strict, `Path=/`, Secure when served over HTTPS, and expires absolutely after 8 hours. (F21 AC1)
- **FR-703**: Five wrong passwords within 15 minutes from one IP MUST block login from that IP for 15 minutes, even when the correct password is then supplied. (F21 AC2)
- **FR-704**: Logout MUST delete the server-side session row and clear the cookie. (F21 AC1)
- **FR-705**: The settings form MUST cover the AI base URL, model ID, API key; the ask daily cap and per-IP rate limit; the SMTP host, port, secure flag, user, password, and from address; and the generator endpoint. (F21 AC3, parent scope)
- **FR-706**: Saved AI settings MUST take effect on the next `/api/ask` request with no process restart. (F21 AC3)
- **FR-707**: Saved SMTP settings MUST take effect for the next contact delivery with no process restart. (F21, F6)
- **FR-708**: Stored API keys and SMTP passwords MUST be encrypted with AES-256-GCM using `ENCRYPTION_KEY`, with a fresh random IV per write and a stored authentication tag, in a versioned envelope; the system MUST fail closed when the key is missing, invalid, or wrong, and MUST never fall back to plaintext. (F21 AC7)
- **FR-709**: Stored secrets MUST be displayed only as a masked last-four hint and the full value MUST never be returned to the browser, written to a log, or included in an error. (F21 AC4)
- **FR-710**: A blank API-key or SMTP-password field on save MUST leave the stored secret unchanged. (F21 AC4)
- **FR-711**: A saved AI base URL MUST use HTTPS unless its host is `localhost`, `127.0.0.1`, or `[::1]`; an invalid URL MUST be rejected with a field-level error and nothing written. (F21 AC5)
- **FR-712**: All settings MUST be validated in one pass; if any field is invalid, no field is written. (F21)
- **FR-713**: State-changing admin requests MUST be same-origin POSTs, checked via Origin or Referer in addition to SameSite=Strict, and no GET request may mutate state. (F21, security)
- **FR-714**: `/admin` and `/admin/login` MUST carry `noindex, nofollow`, and Admin MUST appear in no navigation, sitemap, `llms.txt`, `resume.json`, or JSON-LD. (parent decision 2)
- **FR-715**: The admin settings page MUST work without client-side JavaScript, using a native form POST and server-rendered field errors. (F12 baseline)
- **FR-716**: `ADMIN_PASSWORD_HASH` MUST use the documented versioned format `scrypt$N$r$p$salt$hash`, be verified with Node's scrypt and a constant-time comparison, and fail closed with a warning when absent or malformed. (parent decision 9)
- **FR-717**: The repository MUST provide an offline way to generate the password hash and `ENCRYPTION_KEY` without committing real values. (parent decision 9)
- **FR-718**: Session rows MUST be rejected and removed after their absolute expiry; a cookie whose row is gone MUST be treated as no session. (F21 AC1)

**Preservation and quality (PRD F11, F12)**

- **FR-800**: `/`, `/about`, `/case-studies`, `/case-studies/*`, `/contact`, `/cv.pdf`, `/healthz`, `/llms.txt`, `/resume.json`, `/api/profile`, and `/sitemap.xml` MUST keep their Phase 1/2 status codes and content. (regression)
- **FR-801**: The contact form MUST keep its validation, rate limit, delivery, failure, and persistence behavior, including the local-sink and delivery-failure proofs. (F6)
- **FR-802**: `/ask` MUST score at least 95 Performance and 100 Accessibility in the standard mobile Lighthouse audit with LCP under 2.0 seconds; every new text/background pair MUST meet 4.5:1 contrast. (F12, PRD §8)
- **FR-803**: `/ask` MUST be the only page with executable client JavaScript, and exactly one module script; every other page, including `/admin/login`, MUST remain script-free apart from the JSON-LD data block. (F12 AC1)
- **FR-804**: Every new page MUST use semantic landmarks, labelled controls, a visible focus indicator, reduced-motion handling, and keyboard-complete interaction. (F12)
- **FR-805**: The container MUST serve `/ask`, `/admin`, `/admin/login`, and the new API routes; a rebuild MUST preserve existing SQLite data, and the schema upgrade MUST be additive and idempotent for both a fresh and an existing database. (F11 AC4)
- **FR-806**: The eight existing validation commands listed in `.ainative/project.yaml` MUST stay green; new unit and integration tests MUST run under `npm test`, and route/security checks MUST extend the existing scripts rather than add commands. (parent decision 13)
- **FR-807**: The site MUST add no analytics, tracker, third-party request, or new runtime dependency for this feature. (PRD §8 privacy, stack)
- **FR-808**: `.env.example` MUST document the new configuration names with empty values and no real secret. (F11 AC2)
- **FR-809**: The tests and builds MUST be hermetic: no external AI provider call and no real API key, using a local OpenAI-compatible stub and injected collaborators. (parent decision 17)

### Key Entities

- **Assistant policy block**: the owner-editable reply strings in `content/profile.json` — disclaimer, unconfigured message, not-available message, salary decline, private-codebase decline, and visa decline; the disclaimer and unconfigured string are fixed by the PRD, the others are owner-editable.
- **Context section**: one profile-backed block of approved facts with an id, a label, an internal href, and text; the request selects sections deterministically and turns each into a citation.
- **Citation**: a server-built `{label, href}` pair naming the profile-backed content used for an answer; never model-generated.
- **Question log record**: the full question text and a UTC timestamp; no IP address, answer, or secret.
- **Ask daily counter**: a UTC date key and a request count, stored in SQLite, reset by date key.
- **Settings record**: a named setting with a non-secret value or an encrypted secret envelope, plus its update timestamp; admin values override environment values, which override built-in defaults.
- **Secret envelope**: a versioned AES-256-GCM payload carrying the IV, authentication tag, and ciphertext for an API key or SMTP password.
- **Admin session**: an opaque random session id, creation time, and absolute expiry time, stored server-side and referenced by an HttpOnly cookie.
- **Login failure record**: per-IP failure timestamps and a block-until time used to enforce five failures in 15 minutes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-500**: A visitor can ask a profile question and receives an answer with at least one citation whose link opens real profile content and the exact disclaimer; the same response never contains a secret.
- **SC-501**: Salary, private-codebase, and named-visa questions always receive the approved decline wording; no salary number and no program-specific position is ever produced.
- **SC-502**: The 11th request from one IP in an hour returns HTTP 429; the request after a configurable daily cap returns HTTP 429 with the paused message; the cap survives a restart, resets on the next UTC day, and no model call occurs after the cap.
- **SC-503**: `/admin` and every `/api/admin/*` route return 401 without a session; the correct password yields a session; five wrong passwords block the IP for 15 minutes; logout ends access.
- **SC-504**: Changing the model ID or base URL in the admin panel changes what the next `/api/ask` request sends to the provider, with no restart.
- **SC-505**: Stored API keys and SMTP passwords appear in the database only as AES-256-GCM envelopes, in the browser only as a masked last-four hint, and in no response, log, or error in full.
- **SC-506**: The full validation list still passes, `/ask` meets the Performance 95 / Accessibility 100 / LCP < 2.0 s gate, and `/admin*` is noindex and absent from every public discovery surface.
- **SC-507**: Every valid question appears in the SQLite question log with its full text; the log contains no IP address and no answer.

## Assumptions

- No approved salary range is on disk (the referenced master-profile §9 is Working Style and the earlier §9 is not on this host), so salary questions are declined without a number; this is recorded as an operator-review item.
- VoiceDash remains a draft and no published case study exists for VoiceDash or Villion; the private-codebase decline therefore links the public case-studies index and the contact form rather than a nonexistent detail page.
- `ADMIN_PASSWORD_HASH` and `ENCRYPTION_KEY` are owner-supplied bootstrap secrets; when absent, admin login and secret storage are unavailable while the public site still runs.
- The admin is one owner; there are no user accounts, roles, or multi-user permissions.
- Session lockout state is in-memory per IP (the PRD §9 in-memory limiter pattern); sessions and daily counters are in SQLite.
- The daily cap key is the UTC calendar date.
- The model endpoint is OpenAI-compatible and expects a bearer token; the default base URL and model are the PRD §9 values.
- The test provider is a local stub; no real provider key exists on this host and none is needed.
- Admin-stored values override environment values, which override built-in defaults; a blank non-secret field returns to the inherited value.
- `/ask` is a public page and belongs in the sitemap; `/admin*` is not public and belongs nowhere in the discovery surfaces.
- The public site is served over HTTP locally and over HTTPS once deployed; the session cookie gains the Secure attribute under HTTPS.

## Clarifications

### Session 2026-11-09

- Q: What facts and wording may the salary, private-codebase, and named-visa declines use, and where do they live? → A: Salary gives no number and points to the contact form because no approved range is on disk; the private-codebase decline states the codebase is private, links `/case-studies` and the contact form, and quotes no code; the visa decline repeats "Requires employer-sponsored work authorization." verbatim and points to the contact form. All three strings live in the owner-editable `assistantPolicy` block of the committed content source.
- Q: How does the owner generate `ADMIN_PASSWORD_HASH` and `ENCRYPTION_KEY`, and what are the effective admin defaults and cookie name? → A: A documented offline script, `scripts/admin-credentials.mjs`, prints a `scrypt$N$r$p$salt$hash` hash and a base64 32-byte key; the defaults are a 200 daily cap, 10 requests per IP per hour, the PRD §9 base URL and model, and the session cookie name `admin_session`.
- Q: Does the ask question log store the visitor's IP address, and where does login-lockout state live? → A: The question log stores the full question text and UTC timestamp only, with no IP and no answer; lockout state is in memory per IP, while sessions and the ask daily counter live in SQLite.
- Q: What HTTP status should the unconfigured assistant return, and should `/ask` appear in the sitemap? → A: HTTP 503 carrying the exact message "The assistant is unavailable right now" with no external call; `/ask` is a public page and belongs in the sitemap, while `/admin` and `/admin/login` are excluded from the sitemap, navigation, and every agent-readable output.
- Q: What happens when `ENCRYPTION_KEY` is missing or wrong? → A: Secret saves are rejected with a field-level error, one warning is logged, existing undecryptable secrets make the affected feature behave as unconfigured, and the system never falls back to plaintext.

## Open Questions

None blocking. The operator-review items are recorded in the Clarifications above: the exact decline wording and the absent salary range, credential generation, effective defaults, the session cookie name, and the question-log IP decision. The owner may change the non-fixed reply strings in `assistantPolicy` without a code change; the disclaimer and unconfigured string are fixed by the PRD.

