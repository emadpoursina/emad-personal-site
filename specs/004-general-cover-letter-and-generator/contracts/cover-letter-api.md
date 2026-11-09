# Contract: `POST /api/cover-letter` — Phase 4

**Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md) · **Data model**: [../data-model.md](../data-model.md) · **Routes**: [http-routes.md](./http-routes.md) · **Generator adapter**: [generator-adapter.md](./generator-adapter.md)

The endpoint is on demand (`prerender = false`), served by the Astro Node server. It makes no external call unless every gate passes. Examples use `http://127.0.0.1:4321`; the actual port is configuration.

## Request

```http
POST /api/cover-letter HTTP/1.1
Content-Type: application/json
Accept: application/json

{"jobDescription":"We are hiring a senior backend engineer to own our Node.js services…"}
```

Rules:

- Method `POST` only. `GET`/`HEAD`/other → 405 with `Allow: POST`; no state changes on any non-POST.
- `Content-Type` must be `application/json` (parameters such as `; charset=utf-8` allowed) → otherwise 415.
- Body must be a JSON object, not an array or scalar; malformed JSON → 400.
- `jobDescription` must be a string; extra fields are ignored.
- `jobDescription.trim()` length must be 1–8,000 characters. Exactly 8,000 is accepted; 8,001 is rejected.
- The body is never logged, echoed, or stored.

## Processing order (normative)

| Step | Action | Failure |
|---|---|---|
| 1 | Parse method/content type/body | 405 / 415 / 400 `validation` |
| 2 | Per-IP sliding window: every attempt counts, including invalid ones | 429 `rate_limited` + `Retry-After` |
| 3 | Trim and validate the job description (1–8,000) | 400 `validation` with `errors.jobDescription` |
| 4 | Resolve `getEffectiveGenerator()`; check endpoint **and** key | 503 `unconfigured`, no external call |
| 5 | Consume one unit of the **shared** UTC-day counter atomically | 429 `daily_cap` with paused message; DB failure → 503 `storage` |
| 6 | Call the generator adapter with a bounded timeout | 200 / 502 `generator_error` / 504 `generator_timeout` |
| 7 | Enforce the required authorization line and sign-off | 200 with `appended` flags |

Consequences:

- A request rejected at steps 2–5 never reaches the generator.
- A request that fails validation does not consume the daily cap; it does consume the per-IP window.
- A request made while unconfigured does not consume the daily cap and never calls out.
- A generator failure or timeout **does** consume one unit: the external service was called (same semantics as the assistant).
- If the counter cannot be read or written, the endpoint fails closed with 503 `storage`; it does not call out without the cap.
- The shared counter is the same row `/api/ask` uses; there is no separate cover-letter counter.

## Success response (200)

```json
{
  "ok": true,
  "letter": "Dear Hiring Manager,\n\n…\n\nRequires employer-sponsored work authorization.\n\nBest regards, Emad Poursina",
  "appended": { "authorization": false, "signoff": true }
}
```

| Field | Type | Rule |
|---|---|---|
| `ok` | boolean | always `true` on 200 |
| `letter` | string | non-empty, ≤ 12,000 characters after enforcement, contains both required lines exactly; rendered as text, never as HTML |
| `appended` | object | `authorization` and `signoff` booleans; `true` only when this response appended that line |

The endpoint never returns the generator key, the endpoint URL with credentials, the request body, the upstream response, the profile beyond what the letter contains, or any environment value.

## Error responses

Common shape:

```json
{
  "ok": false,
  "error": "code",
  "message": "human-readable message",
  "errors": { "jobDescription": "field message" },
  "retryAfterSeconds": 1234,
  "fallback": true,
  "generalLetter": "Dear Hiring Manager,\n\n…"
}
```

`errors` appears only for validation; `retryAfterSeconds` only for `rate_limited`; `fallback` and `generalLetter` only for `generator_error` and `generator_timeout`. `message` is safe to display.

| Status | `error` | When | Message (exact where fixed) | Headers |
|---|---|---|---|---|
| 400 | `validation` | empty/whitespace job description, wrong type, array body, malformed JSON | `Job description is required.` / `Job description must be 8,000 characters or fewer.` | `no-store` |
| 405 | `method_not_allowed` | non-POST | `Use POST.` | `Allow: POST`, `no-store` |
| 415 | `unsupported_media_type` | content type not JSON | `Send application/json.` | `no-store` |
| 429 | `rate_limited` | per-IP window exceeded | `Too many cover-letter requests from this address. Please try again later.` | `Retry-After`, `no-store` |
| 429 | `daily_cap` | shared UTC-day cap reached | `The cover-letter generator is paused for today. Please try again tomorrow or use the general cover letter.` | `no-store` |
| 503 | `unconfigured` | endpoint or key missing | `The cover-letter generator is unavailable right now` | `no-store` |
| 503 | `storage` | SQLite unavailable while checking the cap | `The cover-letter generator is unavailable right now` | `no-store` |
| 502 | `generator_error` | generator non-2xx, network error, malformed/empty/over-long response | `The cover-letter generator could not produce a letter right now. The general cover letter is available below.` | `no-store`; body also carries `fallback: true` and `generalLetter` |
| 504 | `generator_timeout` | generator call exceeded the bound | `The cover-letter generator took too long. The general cover letter is available below.` | `no-store`; body also carries `fallback: true` and `generalLetter` |
| 500 | `server` | unexpected failure | `Something went wrong. Please use the general cover letter or the contact form.` | `no-store` |

Never included in any error: the upstream status body, upstream headers, the request URL with credentials, the key, the job description, the generated letter (except the general-letter fallback), a stack trace, or a database path. The server log may carry the event name and, for generator failures, the upstream HTTP status only.

## Required-line enforcement

- Constants: `REQUIRED_AUTHORIZATION = 'Requires employer-sponsored work authorization.'`; `SIGNOFF = 'Best regards, Emad Poursina'`.
- After a successful generator response, `ensureRequiredLines(letter)` checks each exact string.
- Missing lines are appended as their own paragraphs in this order: authorization, then sign-off, separated from the letter and from each other by one blank line.
- Existing text is never edited, reordered, deduplicated, or re-capitalized. A near-miss (for example `requires employer-sponsored work authorization.`) does **not** count as present and gets the exact line appended.
- Running the function again on its own output appends nothing.
- The same constants and the same function are used to build and validate the general letter, so the two paths cannot disagree.

## Page behaviour (`/cover-letter`)

- Unconfigured: no form element at all, no script, the general letter only.
- Configured: the form is rendered below the general letter with `<textarea id="jobDescription" name="jobDescription" maxlength="8000">`, a visible label, a hint linked by `aria-describedby`, a submit button, a `role="status" aria-live="polite"` region, and an `role="alert"` error region.
- On submit, the page prevents the native submit, sets the status text `Writing your letter…`, disables the button, and POSTs JSON.
- On 200 it renders `letter` with `textContent` into the result region, announces `Your letter is ready.`, and re-enables the button; it never assigns the letter to `innerHTML`.
- On 502/504 it shows the error message plus a link to the general letter on the page, using the returned `generalLetter` only as a fallback if the page's own letter is missing.
- On 400/429/503 it shows the contract message and, for `rate_limited`, the retry seconds.
- The button is re-enabled in a `finally` block. A second submit while a request is in flight is ignored.
- With JavaScript disabled, a `<noscript>` note explains that the generator needs JavaScript and links `/contact`.

## Logging and privacy

- No job description, letter, IP address, or secret is written to SQLite, a file, or a log line.
- Server logs: one line per rate-limit event (`{event:'cover_letter_rate_limited'}`), one per daily-cap event (`{event:'daily_cap', day, feature:'cover_letter'}`), one per generator failure with the upstream status only.
- The only stored state is the shared counter row and at most one `daily_cap_events` row per UTC day and feature.
- Tests read the SQLite file bytes, the stub log, and the captured server output to prove the key, the job description, and the letter never appear.

## Test matrix (normative for the build)

| # | Scenario | Expected |
|---|---|---|
| 1 | Stub configured via env; valid 1,000-character job description | 200; non-empty `letter`; both required lines; `appended` both false when the stub letter already has them; stub received one request with the job description and the bearer key |
| 2 | Stub returns a letter without the authorization line | 200; exact line appended; `appended.authorization === true`; `appended.signoff === false`; body otherwise unchanged |
| 3 | Stub returns a letter without the sign-off | 200; exact sign-off appended; `appended.signoff === true` |
| 4 | Stub returns a letter with both lines | 200; `appended` both false; each line appears exactly once |
| 5 | Stub returns `200` with `{"letter":"  "}` | 502 `generator_error`; `fallback: true`; `generalLetter` equals `buildGeneralLetter(doc)` |
| 6 | Stub returns 500 / invalid JSON / 13,000-character letter | 502 `generator_error`; no upstream body or key in the response |
| 7 | Stub delays beyond `GENERATOR_TIMEOUT_MS` | 504 `generator_timeout`; `fallback: true`; no key in the response |
| 8 | No `GENERATOR_ENDPOINT` or no `GENERATOR_API_KEY` | page has no `<form`; `POST` → 503 exact message; stub log unchanged |
| 9 | Empty / whitespace / 8,001-char / non-string `jobDescription` | 400 `validation` with the exact messages; stub log unchanged |
| 10 | Exactly 8,000 characters | 200; stub received one request |
| 11 | `text/plain`, `GET`, malformed JSON, array body | 415 / 405 / 400 / 400; stub log unchanged |
| 12 | 11 requests from one IP in an hour | first 10 processed; 11th 429 `rate_limited` with `Retry-After`; stub receives no call for the 11th |
| 13 | Shared cap 3: two `/api/ask` questions (200, 200) then two cover-letter requests | first cover-letter is 200 (third unit); second is 429 `daily_cap`; the AI stub received exactly two calls and the generator stub exactly one |
| 14 | Restart on the same day after the cap | still 429; stub receives no call |
| 15 | New UTC day key (unit test with injected clock) | counter starts at zero |
| 16 | Admin saves a new `generator.endpoint` | the next request uses stub B with no restart; the previous request's in-flight endpoint is unaffected |
| 17 | Response bodies for every status | never contain the generator key, `ENCRYPTION_KEY`, `ADMIN_PASSWORD_HASH`, the job description, or an upstream body |
| 18 | SQLite file bytes and stub log after a configured call | no job description, no letter, no plaintext key |
| 19 | `daily_cap_events` after several rejected over-cap requests | exactly one row for the day and `cover_letter`; no IP or content column exists |
| 20 | Prompt-injection text in the job description | the stub receives it as data; the response letter is rendered as text; no system text or secret in the response |
