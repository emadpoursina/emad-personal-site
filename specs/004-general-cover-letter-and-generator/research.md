# Research: Phase 4 — General Cover Letter and Generator Path

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Data model**: [data-model.md](./data-model.md)

Each decision below is resolved in this phase; none remains "NEEDS CLARIFICATION". The PRD, the parent card's locked decisions, and the existing Phase 1/2/3 code are the authorities. Research records how the design satisfies them without adding a dependency or a second runtime.

## D1 — The general letter is a committed content document, not page copy

**Decision**: Add `content/cover-letter.json` beside `content/profile.json` with exactly six keys: `greeting`, `paragraphs` (2–6 strings), `authorization`, `signoff`, `links` (`[{label, href}]`, exactly `LinkedIn` then `GitHub`), and `lastUpdated`. `src/lib/cover-letter.mjs` loads it (with a `COVER_LETTER_PATH` env override, matching the `CASE_STUDIES_PATH` pattern used by the assistant), validates it, and exposes `buildGeneralLetter(doc)` plus `ensureRequiredLines(text)`.

**Rationale**: The parent's locked decision 2 requires the letter to live in a committed content file, not in page code, and every fact to trace to `content/profile.json`. A structured document (rather than one blob) lets the build check name the field a banned phrase was found in and lets the page render the sign-off links as real anchors. `authorization` and `signoff` are validated against `profile.workAuthorization` and `Best regards, ${profile.name}`, so the trace is enforced, not asserted in prose.

**Alternatives considered**: Markdown with front matter (needs a parser and makes field-level errors vague); hardcoding the paragraphs in `cover-letter.astro` (violates the locked decision and makes the build check meaningless); one long string (cannot place the links after the sign-off or validate the greeting separately).

## D2 — `/cover-letter` is server-rendered; the general letter is still JS-free

**Decision**: `src/pages/cover-letter.astro` sets `prerender = false`. It renders `<CoverLetter />` (an Astro component fed by the content document) and, only when `getEffectiveGenerator().configured` is true, `<CoverLetterForm />`. It sets `Cache-Control: no-store` because form visibility depends on runtime settings. The form's module script is the page's only executable script; the general letter is in the initial HTML.

**Rationale**: PRD F9 AC4 requires the form to be hidden when the generator is unconfigured, which cannot be decided at build time, so the page cannot be prerendered (the phase plan's exit criterion depends on runtime configuration). The general letter itself is static content, so F5's no-JS requirement is satisfied by server rendering alone; only the submission is enhanced. The page uses the same pattern as `/ask` (one island), so the no-JS baseline stays a single allowed exception per page.

**Alternatives considered**: Prerendering and hiding the form with CSS/JS (would show the form to crawlers and no-JS visitors, and would fail the "hidden" AC); a separate always-visible form posting to an endpoint that 503s (poor UX and a visible dead form); a second static route for the letter (duplicate URLs and no single page for Journey 4).

## D3 — The banned-phrase gate is a prebuild content check over the rendered letter text

**Decision**: Add `scripts/check-cover-letter.mjs`, run from `npm run prebuild` after `check-profile.mjs`. It loads the content document, runs the full validation, builds the exact letter text with `buildGeneralLetter()`, and scans for the six phrases case-insensitively. On failure it prints `FAIL: banned phrase "<phrase>" found in <field>` (or the schema error) and exits 1. `npm run build` therefore fails before Astro compiles. A unit test writes a temporary content file containing `synergy` (via `COVER_LETTER_PATH`) and asserts the script exits 1 and names the phrase.

**Rationale**: PRD F5 AC3 is a build gate and the parent's locked decision 3 says it must scan the letter content, not page chrome. The page is server-rendered, so there is no `dist` artifact to scan; scanning the rendered text of the same content the page renders is the strongest statically checkable surface and fails the build in the same command. The fixture test proves the gate actually fails rather than merely existing.

**Alternatives considered**: postbuild scan of `dist/client/cover-letter/index.html` (impossible: the page is on-demand); a runtime check (the PRD explicitly says build check); scanning `content/cover-letter.json` raw JSON (works, but reports field names poorly and would not catch a banned phrase introduced by the renderer).

## D4 — `POST /api/cover-letter` contract and processing order

**Decision**: JSON-only endpoint taking `{"jobDescription": "<string>"}`. Processing order: (1) method/content-type/body parse → 405/415/400; (2) per-IP window, every attempt counts → 429 `rate_limited` with `Retry-After`; (3) trim and validate 1–8,000 chars → 400 `validation` with `errors.jobDescription`; (4) resolve the generator configuration, unconfigured → 503 `unconfigured`, no call; (5) consume one shared daily unit → 429 `daily_cap`, DB failure → 503 `storage`; (6) call the adapter with a 30-second bound → 200 / 502 `generator_error` / 504 `generator_timeout`. The 502 and 504 bodies carry `fallback: true` and the full general letter text.

**Rationale**: The order mirrors `/api/ask` (Phase 3, FR-600–FR-605), so the "invalid and unconfigured requests do not consume the cap" rule and the "every attempt counts in the window" rule are identical and already understood. Including the general letter in failure bodies is what makes the phase AC "an unavailable generator falls back to the general letter" machine-testable without scraping the page. Stable codes and fixed messages keep the page simple and the contract testable.

**Alternatives considered**: Consuming the daily unit before validation (would burn quota on bad input); returning 200 with an error field (hides failures from monitoring and from the client's retry logic); omitting the fallback letter from the response (leaves the AC provable only by reading the page HTML).

## D5 — Generator adapter: one module, one documented contract, 30-second bound

**Decision**: `src/lib/generator-provider.mjs` exports `callGenerator({ endpoint, apiKey, jobDescription, candidate, timeoutMs, fetchImpl })`. It POSTs to the configured endpoint exactly as given (no path appended), with `Authorization: Bearer <key>`, `Content-Type: application/json`, `Accept: application/json`, and a body of `{job_description, candidate: {name, headline, work_authorization, availability, contact_email, linkedin, github, bio}, required: {work_authorization, signoff, banned_phrases}, max_characters}`. It reads only `letter` from a 2xx JSON response, trims it, rejects a missing/non-string/empty/over-12,000-character letter, and maps non-2xx, network, and JSON/shape failures to `GeneratorError{kind:'upstream'}` and aborts to `GeneratorError{kind:'timeout'}`. The timeout comes from `GENERATOR_TIMEOUT_MS` (default and maximum 30,000 ms), enforced with `AbortController`.

**Rationale**: PRD R11 leaves the real service's contract open, so the site must fix its own boundary and keep it in exactly one module — the parent's locked decision 6. Sending the candidate facts and the required phrases makes the service's job unambiguous and lets it honour the same rules; reading a single field keeps the site robust to extra fields. The 12,000-character cap bounds memory and response size. Errors never carry the upstream body or the key (same discipline as `ai-provider.mjs`).

**Alternatives considered**: Reusing `ai-provider.mjs` with a different base URL (its `/chat/completions` path and message shape are wrong and would couple two contracts); letting the page call the service directly (would leak the key to the browser); appending `/cover-letter` to the configured endpoint (invents a path the real service may not have).

## D6 — Generator configuration: admin endpoint, env-only key, per-request resolution

**Decision**: `src/lib/settings.mjs` gains `getEffectiveGenerator()` returning `{endpoint, apiKey, timeoutMs, configured}`. `endpoint` is the existing effective `generatorEndpoint` (admin `generator.endpoint` > env `GENERATOR_ENDPOINT` > `''`, already implemented in Phase 3). `apiKey` is `process.env.GENERATOR_API_KEY.trim()` only. `configured` is `endpoint !== '' && apiKey !== ''`. `timeoutMs` reads `GENERATOR_TIMEOUT_MS` (default/max 30,000). The key is never added to `SETTINGS_FIELDS`, `getMaskedSettings`, or any admin response; the 12-field admin form is unchanged except the daily-cap label. `src/lib/env.mjs` parses the three new names and warns once when the generator is partially configured, without logging values.

**Rationale**: PRD §9 and F9 AC1 say the key comes from `.env`; adding an admin secret field would expand F21 beyond the PRD, change the admin form and its tests, and require an encryption migration for no phase benefit. The parent's decision 5 allows either and names this one as the default. Per-request resolution preserves F21 AC3 for the endpoint (a save takes effect on the next request) and keeps the key out of the database.

**Alternatives considered**: An admin secret `generator.apiKey` (more surface, more tests, beyond the PRD); caching the resolved configuration at module load (would break the no-restart AC for the endpoint); reading the env directly inside the route (untestable and duplicated).

## D7 — Shared daily cap with schema version 3 and bounded cap events

**Decision**: Both endpoints call the existing `db.consumeDailyAsk(day, cap)` through `src/lib/daily-cap.mjs` (a thin shared wrapper that also writes the cap event). The table and key names stay (`ask_daily_counters`, `ASK_DAILY_CAP`, `ask.dailyCap`). Schema version 3 adds one bounded table:

```sql
CREATE TABLE IF NOT EXISTS daily_cap_events (
  day        TEXT NOT NULL,
  feature    TEXT NOT NULL CHECK (feature IN ('ask','cover_letter')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (day, feature)
);
```

`INSERT OR IGNORE` keeps at most one row per UTC day and feature no matter how many rejected requests arrive. `ask-limits.mjs` keeps `checkPerIp`, `utcDayKey`, and `consumeDaily(db, day, cap)` (delegating with `feature:'ask'`) so its Phase 3 tests and the ask service stay unchanged; `cover-letter-limits.mjs` adds its own limiter and a `consumeDaily(db, day, cap)` that delegates with `feature:'cover_letter'`.

**Rationale**: F10 AC2 says the cap covers both endpoints, and the parent's decision 9 forbids renaming the env name or key. A single counter is the only design that cannot double the spend. The cap-event row makes F10 AC3's "log the event" durable and machine-testable, bounded to 366×2 rows a year. Version 3 is additive and idempotent like version 2, so existing rows survive and a fresh database runs 1 → 2 → 3 in one open.

**Alternatives considered**: Two counters summed at read time (race-prone and not atomic); an unbounded `cap_hits` log (write amplification under abuse); keeping the event console-only (not provable after a restart and not queryable); renaming the setting to `ai.dailyCap` (breaks the existing key and the admin form for no gain).

## D8 — A separate per-IP window for the cover-letter endpoint

**Decision**: `src/lib/cover-letter-limits.mjs` creates its own `createRateLimiter({windowMs: 3_600_000, limit: 10})` instance and exposes `checkPerIp(key)` returning `{allowed, retryAfterSeconds}`. The limit is a fixed 10 per hour; it adds no setting and no admin field.

**Rationale**: F10 AC1 names a per-endpoint limit of 10 per hour for each AI endpoint. Sharing the ask limiter instance would make the two endpoints consume each other's window and would silently halve the allowed assistant usage — a Phase 3 regression. A separate instance is one line of the existing pattern. Not making it configurable keeps the admin form at twelve fields, which this phase is not chartering to change.

**Alternatives considered**: One shared limiter across both endpoints (couples unrelated features and breaks F10's per-request reading); a new admin field (schema/validation/UI churn outside the phase scope); reusing `ASK_RATE_LIMIT_PER_HOUR` for both (would let an owner tuning one endpoint change the other).

## D9 — Required-line enforcement: append only, idempotent

**Decision**: `src/lib/cover-letter.mjs` exports `REQUIRED_AUTHORIZATION = 'Requires employer-sponsored work authorization.'`, `SIGNOFF = 'Best regards, Emad Poursina'`, and `ensureRequiredLines(letter)` → `{ letter, appended: { authorization, signoff } }`. It normalizes the letter's trailing whitespace, checks for each exact string, and appends the missing ones as their own paragraphs (authorization before sign-off) separated by a blank line. It never edits, reorders, or dedupes the body. Running it twice is a no-op.

**Rationale**: PRD F9 AC2 says "append them before display", not rewrite. Exact matching keeps the guarantee honest: a near-miss capitalization gets the correct line appended rather than being treated as compliant. The function is pure and unit-testable, and the same required strings feed the build check so the two paths cannot disagree.

**Alternatives considered**: Case-insensitive or fuzzy matching (would let a wrong line pass); regenerating the letter with a stricter prompt (non-deterministic, cannot guarantee the AC); HTML post-processing (the letter is text; the page escapes it).

## D10 — Hermetic proof: a local generator stub and injected collaborators

**Decision**: Add `scripts/generator-stub.mjs` — dependency-free `node:http`, `POST` on the configured path, records `{method, path, headers minus authorization value, body}` to `--log` JSONL with a redacted authorization marker and a `keyLast4` field, and returns `{"letter": "<--letter value>"}`. Flags: `--port`, `--log`, `--letter`, `--delay-ms`, `--status`, `--self-test`. `processCoverLetter` and `callGenerator` accept injected `{db, settings, limits, provider, now, profile, letterDoc, fetchImpl}` so unit tests never open a socket; the integration suite boots `dist/server/entry.mjs` against the stub with a temporary `DATA_DIR`. The stub never records the full key; tests assert the recorded `Authorization` header equals `Bearer <test key>` in the stub's own memory but that no response, log line, or SQLite byte contains it.

**Rationale**: Parent decision 12 requires a stub plus an injectable client and forbids a real key. The existing `scripts/ai-stub.mjs` and `tests/ask-api.integration.test.mjs` prove this pattern works on this host. A `--status` flag makes the 502 path as easy to prove as the 200 path, and `--delay-ms` proves the 504 map with a low `GENERATOR_TIMEOUT_MS`.

**Alternatives considered**: Mocking `fetch` globally in integration tests (does not prove the real HTTP path or the route wiring); recording the full key in the stub log (would put a secret in evidence files); a Node test server per suite (works, but a shared stub script matches the project convention and is reusable by `verify-container`).

## D11 — Accessibility and the Lighthouse gate

**Decision**: `/cover-letter` uses the existing layout, tokens, and focus styles: one `<h1>`, a labelled `<textarea id="jobDescription" maxlength="8000" aria-describedby="job-description-hint">`, a submit `<button type="submit">`, a `role="status" aria-live="polite"` region for the working state, a separate result region that receives text via `textContent`, an error region with `role="alert"`, a `<noscript>` note linking `/contact`, and reduced-motion-safe transitions (none). `scripts/lighthouse-check.mjs` gains `{name:'cover-letter', path:'/cover-letter'}` with the same Performance ≥ 95 / Accessibility 100 gate; the home and `/ask` entries are unchanged. `scripts/check-contrast.mjs` needs no new pair because no new colour is introduced, and the build runs it as before.

**Rationale**: PRD F12/§8 set the targets; Phase 3 established the pattern of adding a page to `PAGES` without changing the gate. Keeping the same tokens avoids a new contrast matrix. The `role="status"` + `aria-live="polite"` pair is the same construct the Phase 3 `/ask` page uses, so the existing checks and the new runtime probe look for one known shape.

**Alternatives considered**: A separate Lighthouse threshold for the new page (the PRD sets one target); a client-side copy button (extra JS for a non-required nicety); inline styles (breaks the token discipline and the contrast check).

## D12 — No new dependency

**Decision**: Everything uses the current stack: `node:crypto` is not even needed here, `fetch`/`AbortController` come from Node 22, `node:sqlite` covers the counter and cap events, and `node:test` covers the suites. `package.json` keeps its scripts; `npm test` already globs `tests/*.test.mjs`.

**Rationale**: PRD §9 and the parent's decision 1 forbid a new dependency without a written justification; none is needed. The stub is 60 lines of `node:http`, and the adapter is a `fetch` call.

**Alternatives considered**: An HTTP client library (no capability gained); a validation library (the project already hand-validates content and settings); a test double library (Node's built-in test runner is the convention).
