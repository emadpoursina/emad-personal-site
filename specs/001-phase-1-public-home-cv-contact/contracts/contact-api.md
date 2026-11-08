# Contract: `POST /api/contact`

**Owner**: FR-020…FR-027, PRD F6 AC1–AC5, F11 AC3 · **Data**: [data-model.md](../data-model.md)

## Request

- **Method / path**: `POST /api/contact`
- **Accepted content types**: `application/x-www-form-urlencoded` (plain HTML form, no JavaScript), `multipart/form-data` (same form encoded by a browser), `application/json`.
- **Body fields**: `name`, `email`, `message`. Unknown fields are ignored (never echoed back).
- **Response format**: JSON when the request's `Accept` header prefers `application/json` (`*/*` from `fetch` counts as JSON only when `Accept` is exactly `application/json`); otherwise an HTML document with the same information and a link back to `/contact`.
- **Headers on every response**: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Language: en`.

## Validation (before any write)

Trimmed values are used for length checks and storage.

| Field | Rule | Error key |
|---|---|---|
| `name` | required, 1–200 characters after trim | `name` |
| `email` | required, one `@`, a dot in the domain, 3–320 characters, no whitespace | `email` |
| `message` | required, 1–5,000 characters after trim | `message` |

A request may carry several errors at once. Nothing is stored for any validation failure.

## Responses

| Status | When | JSON body | HTML outcome |
|---|---|---|---|
| `200` | stored and the email was accepted by the SMTP server | `{"ok":true,"status":"sent","id":<id>}` | "Message sent" page, link back to `/` and `/contact` |
| `400` | one or more field errors | `{"ok":false,"error":"validation","errors":{"email":"…"}}` | same messages next to the fields, link back to `/contact` |
| `429` | more than `CONTACT_RATE_LIMIT_PER_HOUR` (default 5) POSTs from this client within 3600 s | `{"ok":false,"error":"rate_limited","retryAfterSeconds":<n>}` + `Retry-After` header | "Too many messages — try again later" + the direct email address |
| `502` | stored, but SMTP delivery failed (row keeps `delivery_status='failed'`) | `{"ok":false,"error":"delivery_failed","id":<id>,"contactEmail":"emad.poursina.work@gmail.com"}` | "Your message was saved but the email could not be sent — please write to …" |
| `503` | contact feature disabled because required SMTP settings are absent | `{"ok":false,"error":"disabled","contactEmail":"emad.poursina.work@gmail.com"}` | "The form is unavailable — please write to …" |
| `500` | the row could not be written (no email is attempted) | `{"ok":false,"error":"storage"}` | "Something went wrong — please write to …" |
| `404` | any other method on this path (e.g. `GET`) | — | plain 404 |

Every non-2xx response is non-cacheable and leaks no internal detail (no stack traces, no SMTP server text beyond a generic reason, never credentials).

## Order of effects

1. Parse and validate → `400`.
2. Rate-limit check → `429`.
3. Feature-enabled check → `503`.
4. `INSERT` with `delivery_status='failed'` → on error `500` (no email).
5. SMTP send with a 30 s ceiling (connection 10 s, greeting 10 s, socket 30 s).
6. `UPDATE` to `sent` or keep `failed` with a short reason.
7. Respond `200` or `502`.

Guarantees: at most one row per accepted request; a row never claims `sent` unless the SMTP server accepted the message; no row is written for `400`/`429`/`503`/`500`; a `502` response always corresponds to exactly one `failed` row.

## Email message (F6 AC1)

- **To**: `CONTACT_TO` (default and expected value `emad.poursina.work@gmail.com`).
- **From**: `SMTP_FROM` (default `Emad Poursina <emad.poursina.work@gmail.com>`).
- **Reply-To**: the visitor's validated address.
- **Subject**: `Contact form: <name>`.
- **Body**: plain text with name, email, UTC timestamp, and the message; no HTML part, no visitor-supplied headers.
- **Timing**: the SMTP transaction is bounded to 30 s; a timeout counts as a delivery failure.

## Client identity

Client key = the adapter's remote address. `X-Forwarded-For` is honored only when `TRUST_PROXY=1`; otherwise it is ignored (prevents spoofing the limit). The key is never stored.
