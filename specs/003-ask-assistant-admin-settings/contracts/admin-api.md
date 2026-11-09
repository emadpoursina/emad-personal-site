# Contract: Admin authentication, sessions, and settings — Phase 3

**Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md) · **Data model**: [../data-model.md](../data-model.md) · **Routes**: [http-routes.md](./http-routes.md)

The admin surface is one owner, one password, one session model. Every admin route except `/admin/login` and `POST /api/admin/login` requires a valid session. The settings page works without client-side JavaScript.

## Cookie contract

Name: `admin_session` (constant; recorded in the spec's clarifications).

```http
Set-Cookie: admin_session=<64-hex-id>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
Set-Cookie: admin_session=<64-hex-id>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800; Secure   (HTTPS only)
```

- `HttpOnly`, `SameSite=Strict`, `Path=/` always.
- `Secure` when the request URL is HTTPS, or when `TRUST_PROXY=1` and `X-Forwarded-Proto` is `https`.
- `Max-Age=28800` (8 hours) and a server-side `expires_at` eight hours after creation; the server-side value is authoritative.
- Logout: `Set-Cookie: admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0[; Secure]` and the row is deleted.
- The cookie value is an opaque 32-byte random hex id; it carries no user, role, or expiry data.

## Session lookup (every protected request)

1. Parse the `Cookie` header; find `admin_session`.
2. Missing or malformed → no session.
3. Select the row; missing → no session.
4. `expires_at <= now` → delete the row, no session.
5. Otherwise the request is authenticated.

No session → `/admin` returns 401 HTML; `/api/admin/*` returns 401 JSON. The 401 body contains no settings, key hints, or session data.

## `POST /api/admin/login`

Public. Accepts `application/x-www-form-urlencoded` (native form) or `application/json`.

Request:

```http
POST /api/admin/login
Content-Type: application/x-www-form-urlencoded
Origin: http://127.0.0.1:4321

password=<password>
```

```json
{ "password": "<password>" }
```

Rules:

- `password` required, string, 1–1024 characters.
- The per-IP lockout is checked first. While blocked: 429 `locked`, `Retry-After`, no password verification, no cookie.
- Verify against `ADMIN_PASSWORD_HASH` (scrypt, constant-time). Missing/malformed hash → 401 (fail closed), one warning.
- Wrong password: record the failure; 401 `invalid_credentials`.
- Correct password: clear the failure record; create the session; set the cookie.
- Response:
  - Form/non-JSON `Accept`: `303 See Other`, `Location: /admin`, `Set-Cookie: …`, empty body.
  - `Accept: application/json`: `200`, `Set-Cookie: …`, `{"ok":true,"expiresAt":"<ISO>"}`.
- All responses: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.

Errors:

| Status | `error` | When | Message |
|---|---|---|---|
| 400 | `validation` | missing/empty password or body | `Enter your password.` |
| 401 | `invalid_credentials` | wrong password or no usable hash | `Incorrect password.` |
| 429 | `locked` | 5 failures in 15 minutes from this IP | `Too many failed attempts. Try again later.` + `Retry-After` |

The response never says whether `ADMIN_PASSWORD_HASH` is configured, and never includes the hash.

## `POST /api/admin/logout`

Requires a session (otherwise 401 `unauthorized`).

- Deletes the session row.
- Clears the cookie (`Max-Age=0`).
- Form/non-JSON: `303` to `/admin/login`. JSON: `200` `{"ok":true}`.
- Idempotent from the browser's point of view; a second logout without a cookie is 401.

## `POST /api/admin/settings`

Requires a session (401). Requires a same-origin request (403).

### Same-origin check

- If `Origin` is present, its origin must equal the request URL origin.
- Else if `Referer` is present, its origin must equal the request URL origin.
- Else 403 `cross_origin`.
- Astro's built-in `security.checkOrigin` also runs; this check is defense in depth.
- Only `POST` mutates; `GET`/`HEAD` on this path return 405 or 404 without a write.

### Request body

`application/x-www-form-urlencoded` (native form) or `application/json`.

| Field | Type | Blank meaning | Validation |
|---|---|---|---|
| `aiBaseUrl` | string | delete override → inherit env/default | URL; HTTPS, or HTTP only for `localhost`/`127.0.0.1`/`[::1]`; no credentials; ≤500; trailing slash trimmed |
| `aiModel` | string | delete override → inherit | non-empty when present; ≤200; no control chars |
| `aiApiKey` | string | keep the stored secret | ≤4096; no CR/LF/control; encrypted before write |
| `askDailyCap` | string integer | delete override → inherit | 1–100000 |
| `askRateLimitPerHour` | string integer | delete override → inherit | 1–1000 |
| `smtpHost` | string | delete override → inherit | ≤255; no spaces/control |
| `smtpPort` | string integer | delete override → inherit | 1–65535 |
| `smtpSecure` | checkbox `on` / absent | explicit `true` / `false` override | stored as `true`/`false` |
| `smtpUser` | string | delete override → inherit | ≤320; no control |
| `smtpPass` | string | keep the stored secret | ≤1024; no CR/LF/control; encrypted before write |
| `smtpFrom` | string | delete override → inherit | `addr` or `Name <addr>`; ≤320 |
| `generatorEndpoint` | string | delete override → inherit | blank allowed; otherwise URL rule as `aiBaseUrl` |

- All fields are validated before any write. If any field fails, every field error is returned and nothing is written (transaction rollback).
- Blank non-secret deletes only that key; other keys are left as they were. A form submission therefore expresses both "set" and "inherit" per field.
- Blank secret keeps the stored envelope; a non-blank secret is encrypted with a fresh IV.
- `smtpSecure` is a checkbox: every form submission with the checkbox present writes `true`; absent writes `false`. It is not an "inherit" field because an unchecked checkbox cannot express absent vs. false.
- On success:
  - Form: `303` to `/admin?saved=1`.
  - JSON: `200` `{"ok":true,"settings":{...masked view...}}`.
- The masked view contains non-secret values plus `hasApiKey`, `apiKeyMasked`, `hasSmtpPass`, `smtpPassMasked`; it never contains a full secret.

Errors:

| Status | `error` | When | Body |
|---|---|---|---|
| 400 | `validation` | one or more field errors | JSON `{ok:false,error:'validation',errors:{field:message}}` or HTML settings page with per-field errors, status 400 |
| 401 | `unauthorized` | no session | JSON/HTML, no settings |
| 403 | `cross_origin` | Origin/Referer missing or mismatched | JSON/HTML |
| 405 | `method_not_allowed` | non-POST | `Allow: POST` |
| 500 | `server` | store/encryption failure | no secret, no stack |

Encryption failure (missing/invalid `ENCRYPTION_KEY`) is a field error on the secret field: `Secret storage is unavailable.` Nothing is written.

## Page contracts

### `GET /admin/login` (public, prerendered)

- 200 HTML; `<h1>Admin login</h1>`; one labelled password input; one submit button; a link back to `/`.
- `<meta name="robots" content="noindex, nofollow">`.
- Posts to `/api/admin/login` with `method="post"` and `enctype="application/x-www-form-urlencoded"`.
- No client JavaScript, no settings, no secret.
- If the visitor already has a session, the page may still render the form; logging in again replaces the session. (A redirect is optional and not tested.)

### `GET /admin` (protected, on demand)

Without a session:

- 401 HTML with `<meta name="robots" content="noindex, nofollow">`, a short message, and a link to `/admin/login`.
- No settings, no masked secret, no session data.

With a session:

- 200 HTML; `<h1>Admin settings</h1>`; `noindex, nofollow`.
- One native form posting to `/api/admin/settings`.
- Non-secret fields show the admin-stored value or blank, with the effective inherited value as a placeholder.
- Secret fields are blank, with `••••<last4>` as the placeholder when a secret exists; the full value is never in the HTML.
- Shows the effective source (`admin` or `environment`/`default`) as a hint per field; this is not a secret.
- Logout is a separate native form posting to `/api/admin/logout`.
- On `?saved=1`, shows a success notice. On a 400 re-render, shows field errors and the submitted non-secret values.
- No client JavaScript.

### `GET /admin/*` catch-all

- No session → 401 HTML, `noindex`, link to `/admin/login`.
- Session → 404 HTML with the standard not-found content (may use the site layout; it must not include settings).

### `GET /api/admin/*` catch-all

- No session → 401 JSON `{ok:false,error:'unauthorized'}`.
- Session → 404 JSON `{ok:false,error:'not_found'}`.

## Masking contract

- `maskSecret(plaintext)` returns `••••` + the last four characters when the plaintext length is at least 8; otherwise `••••`.
- The admin page and JSON responses use the mask only. The plaintext exists only inside the encryption/decryption boundary and the outbound SMTP/provider call.
- A test reads the rendered page and every admin JSON response and asserts the full key/password never appears; it also reads the SQLite file bytes and asserts the plaintext never appears while the envelope does.
- A blank secret field on save leaves the envelope byte-for-byte unchanged (same IV/ciphertext/tag).

## Lockout contract

- Per IP, in memory: five wrong passwords within 15 minutes → block for 15 minutes from the fifth failure.
- While blocked: 429 `locked`, `Retry-After` = remaining seconds; no verification; no cookie.
- A successful login before the fifth failure clears the record.
- The block is per IP, not global; a different IP is unaffected.
- Restart clears the block (documented; sessions and counters are unaffected).

## Test matrix (normative for the build)

| # | Scenario | Expected |
|---|---|---|
| 1 | `GET /admin` no cookie | 401; noindex; no settings; link to login |
| 2 | `GET /api/admin/settings` no cookie | 401 JSON; no settings |
| 3 | `GET /admin/login` | 200; password form; noindex; no settings |
| 4 | Login wrong password ×5, then correct | 5×401; 6th 429 `locked` with `Retry-After`; no cookie |
| 5 | Login correct after fewer than 5 failures | 303/200; cookie with HttpOnly, SameSite=Strict, Path=/, Max-Age=28800 |
| 6 | Use cookie on `GET /admin` | 200; settings form; masked secrets only |
| 7 | Expired session row | 401; row deleted |
| 8 | Logout | 303/200; old cookie 401 on `GET /admin`; row gone |
| 9 | Save valid AI base URL/model/key | 303/200; next `/api/ask` uses them; page shows masked last4 |
| 10 | Save blank key | stored envelope unchanged |
| 11 | Save non-HTTPS non-localhost base URL | 400; `errors.aiBaseUrl`; nothing written |
| 12 | Save invalid daily cap/rate/port/from | 400; all field errors; nothing written |
| 13 | Cross-origin POST | 403; nothing written |
| 14 | Encrypted at rest | DB contains `v1:` envelope; plaintext absent from DB bytes; page/JSON contain only last4 |
| 15 | Missing `ENCRYPTION_KEY`; save a key | 400 field error; no plaintext; one warning |
| 16 | Missing/wrong `ENCRYPTION_KEY` with an existing secret | `/api/ask` 503 unconfigured; contact delivery disabled; no external call |
| 17 | Save SMTP host/port/secure/user/pass/from | next contact message reaches the new sink; no restart |
| 18 | `GET /sitemap.xml`, `/llms.txt`, `/resume.json`, `/api/profile`, JSON-LD, nav | no admin path or admin fact |
| 19 | `GET /admin` after session deletion | 401 |
| 20 | 200 admin page HTML | no full key/password; no `ENCRYPTION_KEY`; no `ADMIN_PASSWORD_HASH` |
