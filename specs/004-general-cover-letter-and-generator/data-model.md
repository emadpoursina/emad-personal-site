# Data Model: Phase 4 — General Cover Letter and Generator Path

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

## Storage overview

The feature adds one additive table (schema version 3) and no content storage. The cover letter and every generated letter are stateless: they are built from a committed content file or returned from the external service and are never written to SQLite, logs, or the filesystem.

| Store | Purpose | Lifetime |
|---|---|---|
| `content/cover-letter.json` | the general letter content (committed) | until the owner edits it |
| `ask_daily_counters` (existing, shared) | combined assistant + cover-letter UTC-day count | one row per day |
| `daily_cap_events` (new, v3) | one operational row per day and feature when the cap is hit | retained; bounded by one row per day per feature |

Nothing else is written: no job description, no generated letter, no IP address in a new log line.

## Schema version 3 (exact DDL)

```sql
-- Applied when PRAGMA user_version < 3, after the version-2 DDL.
CREATE TABLE IF NOT EXISTS daily_cap_events (
  day        TEXT NOT NULL,
  feature    TEXT NOT NULL CHECK (feature IN ('ask','cover_letter')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (day, feature)
);
```

Migration algorithm in `src/lib/db.mjs`:

```text
version = PRAGMA user_version
if version < 1: run version-1 DDL (contact_messages + index)
if version < 2: run version-2 DDL (settings, admin_sessions, ask_questions, ask_daily_counters + indexes)
if version < 3: run version-3 DDL (daily_cap_events)
if version < 3: PRAGMA user_version = 3
```

Every statement is `IF NOT EXISTS`, so a re-run after a partial application is safe. No existing row is read, rewritten, or dropped. `SCHEMA_VERSION` in `src/lib/db.mjs` becomes `3`.

Tests cover: fresh database → version 3 and all six tables; version-2 database with a contact row, a setting, an ask question, and a counter row → version 3, all rows intact, `daily_cap_events` present; second open → no change and no error; `INSERT OR IGNORE` yields exactly one event row per day and feature; the counter is still atomic at the cap boundary.

## New database accessors (`src/lib/db.mjs`)

| Accessor | Signature | Behavior |
|---|---|---|
| `insertCapEvent` | `(day: string, feature: 'ask'\|'cover_letter') => void` | `INSERT OR IGNORE`; one row per day and feature |
| `getCapEvent` | `(day: string, feature: string) => {day, feature, created_at} \| null` | readback for tests and operations |
| `countCapEvents` | `() => number` | total rows (bounded) |

`consumeDailyAsk(day, cap)` is unchanged in name and behavior; both endpoints call it through the shared wrapper.

## Content document: `content/cover-letter.json`

| Field | Type | Rule |
|---|---|---|
| `greeting` | string | matches `^Dear [A-Za-z][A-Za-z .'-]*,$`; no digits; no month name (`January`…`December`, case-insensitive); ≤ 80 characters |
| `paragraphs` | string[] | 2–6 entries; each trimmed, 1–1,500 characters; total ≤ 5,000 characters; no `http://`, `https://`, or `@`; no control characters |
| `authorization` | string | exactly the value of `profile.workAuthorization` (`Requires employer-sponsored work authorization.`) |
| `signoff` | string | exactly `Best regards, ${profile.name}` (`Best regards, Emad Poursina`) |
| `links` | `{label, href}[]` | exactly 2, in order: `LinkedIn` → `profile.links.linkedin`, `GitHub` → `profile.links.github`; hrefs must start `https://` |
| `lastUpdated` | string | `YYYY-MM-DD`, not in the future |

Unknown top-level keys are rejected. Loading order for the path: `COVER_LETTER_PATH` (absolute or relative to `process.cwd()`) → `cwd/content/cover-letter.json` → module-relative `../../content/cover-letter.json`.

Derived values:

- `BANNED_PHRASES = ['I am writing to express my interest', 'passionate', 'dynamic', 'synergy', 'results-driven', 'team player']` (matched case-insensitively as substrings).
- `buildGeneralLetter(doc)` → the text in this exact order: greeting, blank line, paragraphs joined by blank lines, blank line, authorization, blank line, signoff, blank line, `LinkedIn: <url>`, newline, `GitHub: <url>`. It ends with a single newline.
- `ensureRequiredLines(text)` → `{letter, appended:{authorization:boolean, signoff:boolean}}`; appends only the missing exact lines, authorization before sign-off, separated by a blank line, and is idempotent.

## Effective generator configuration (`src/lib/settings.mjs`)

| Field | Source | Rule |
|---|---|---|
| `endpoint` | admin `generator.endpoint` > env `GENERATOR_ENDPOINT` > `''` | valid absolute URL, HTTPS unless loopback host (existing Phase 3 rule); trailing slashes trimmed |
| `apiKey` | env `GENERATOR_API_KEY` only | trimmed; never stored, never returned, never logged |
| `timeoutMs` | env `GENERATOR_TIMEOUT_MS` | integer > 0, default 30,000, capped at 30,000 |
| `configured` | derived | `endpoint !== '' && apiKey !== ''` |

Resolution happens on every call; there is no module-level cache. `getEffectiveGenerator()` is the only accessor; the value never enters `getMaskedSettings()` or the admin page. A failure to read the settings store is caught: the function logs one warning and returns `{endpoint:'', apiKey:'', timeoutMs:30000, configured:false}`, so the page renders the letter with no form and the API answers 503 `unconfigured` instead of 500.

## Relevant existing settings (unchanged names)

| Form field | DB key | Env | Meaning after Phase 4 |
|---|---|---|---|
| `generatorEndpoint` | `generator.endpoint` | `GENERATOR_ENDPOINT` | the generator's full endpoint URL |
| `askDailyCap` | `ask.dailyCap` | `ASK_DAILY_CAP` | **shared** assistant + cover-letter UTC-day cap, default 200 |
| `askRateLimitPerHour` | `ask.rateLimitPerHour` | `ASK_RATE_LIMIT_PER_HOUR` | assistant per-IP window only (unchanged) |

The cover-letter per-IP window is a fixed constant (10 per hour) in `src/lib/cover-letter-limits.mjs`; it has no setting and no form field.

## API data shapes

### Request — `POST /api/cover-letter`

```json
{ "jobDescription": "<trimmed string, 1–8000 characters>" }
```

Only `jobDescription` is read. Extra fields are ignored. A non-object body, a non-string value, or an array → 400.

### Success — 200

```json
{
  "ok": true,
  "letter": "<letter text after required-line enforcement>",
  "appended": { "authorization": false, "signoff": true }
}
```

`letter` is non-empty, ≤ 12,000 characters after enforcement, and rendered as text by the page. `appended` reports only what this response added; both false means the generator already supplied both lines.

### Failure — 4xx/5xx

```json
{
  "ok": false,
  "error": "validation|rate_limited|daily_cap|unconfigured|generator_error|generator_timeout|storage|server",
  "message": "<safe human-readable message>",
  "errors": { "jobDescription": "<field message>" },
  "retryAfterSeconds": 1234,
  "fallback": true,
  "generalLetter": "<the exact general letter text>"
}
```

`errors` appears only for validation; `retryAfterSeconds` only for `rate_limited`; `fallback` and `generalLetter` only for `generator_error` and `generator_timeout`. No field ever carries an upstream body, header, key, job description, or environment value.

## Cap event

| Field | Type | Rule |
|---|---|---|
| `day` | TEXT | UTC `YYYY-MM-DD`, part of the primary key |
| `feature` | TEXT | `ask` or `cover_letter`, part of the primary key |
| `created_at` | TEXT | ISO-8601 UTC timestamp, defaulted by SQLite |

Written once per day and feature on the first rejected-over-cap request (`INSERT OR IGNORE`), plus one `console.warn` line `{event:'daily_cap', day, feature}` with no IP and no content. A second rejected request the same day writes nothing and logs nothing new.

## State transitions

```text
POST /api/cover-letter
  → 405 / 415 / 400            (parse; per-IP window already counted)
  → 429 rate_limited           (window exhausted; no counter, no call)
  → 400 validation             (empty/over-long; no counter, no call)
  → 503 unconfigured           (no endpoint or key; no counter, no call)
  → 503 storage                (counter unavailable; no call)
  → 429 daily_cap              (counter over cap; event written once; no call)
  → 200                        (generator called once; letter enforced)
  → 502 generator_error        (generator called once; fallback returned)
  → 504 generator_timeout      (generator called once; fallback returned)
```

## Validation summary

| Rule | Where enforced |
|---|---|
| job description 1–8,000 after trim | `validateJobDescription` in `cover-letter-service.mjs`, before any counter or call |
| JSON object with string field | route + service |
| content document schema and banned phrases | `scripts/check-cover-letter.mjs` at `prebuild` and `validateCoverLetter` in `cover-letter.mjs` |
| required lines present | `ensureRequiredLines` after a successful generator call; build check for the general letter |
| endpoint/key presence | `getEffectiveGenerator()` on every request |
| shared cap and per-IP window | `daily-cap.mjs` and `cover-letter-limits.mjs` |
| no content stored | no insert path exists; tests read the SQLite file and logs |
