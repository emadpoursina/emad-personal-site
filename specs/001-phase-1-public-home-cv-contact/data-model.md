# Data Model: Phase 1 — Public Home, CV Download, and Contact

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

## Storage engine

One SQLite file per deployment: `${DATA_DIR}/site.sqlite`, created on first open, in a named Docker volume at `/app/data` (F11 AC1). Access goes through `src/lib/db.mjs` (`node:sqlite` `DatabaseSync`), which owns the schema version and every statement. No ORM, no migration framework: `PRAGMA user_version` plus an ordered list of idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` steps, applied on open.

## Entity: contact_messages

One row per accepted contact submission (PRD F6 AC2, locked decision 3).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | stable row id for tests and manual review |
| `created_at` | TEXT | NOT NULL, default `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | UTC ISO-8601 with milliseconds; the "timestamp" of F6 AC2 |
| `name` | TEXT | NOT NULL, length 1–200 after trim | visitor display name |
| `email` | TEXT | NOT NULL, length 3–320 after trim | validated address; stored as given (trimmed) |
| `message` | TEXT | NOT NULL, length 1–5000 after trim | plain text, never HTML-escaped on write, escaped on render |
| `delivery_status` | TEXT | NOT NULL, `CHECK (delivery_status IN ('sent','failed'))` | F6 AC2/AC4 |
| `delivery_error` | TEXT | NULL | short reason for a failed send (SMTP code / class name); never contains credentials or the SMTP password |

Deliberately **not** stored: IP address, user agent, or any other visitor identifier (PRD §8 privacy: "contact messages only"). Rate limiting is in memory and leaves no trace.

Indexes: `CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages(created_at DESC)` — supports the owner's manual review ordering; no query in this phase filters by anything else.

### Write path (ordering matters)

1. Validate the request. Invalid ⇒ `400`, nothing written (F6 AC3).
2. Apply the rate-limit check. Exceeded ⇒ `429`, nothing written (F6 AC5).
3. If the contact feature is disabled (no SMTP settings) ⇒ `503`, nothing written (F11 AC3, FR-026).
4. `INSERT` the row with `delivery_status = 'failed'` and `delivery_error = 'pending'`. A failure here ⇒ `500`, no email attempted (no orphan email for a lost message).
5. Send the email with a 30 s ceiling.
6. `UPDATE` the row: `delivery_status='sent', delivery_error=NULL` on success; on failure keep `failed` and store the reason.
7. Respond: `200` when sent, `502` when stored-but-failed (both tell the visitor where the message stands; the failure response also names the direct email address).

The pessimistic insert is deliberate: a crash between 4 and 6 leaves a `failed` row and the visitor sees an error, which is recoverable; the reverse order could email a message that was never stored.

### State transitions

```
(no row) --validate+limit+enabled--> 'failed' (pending) --smtp ok--> 'sent' (terminal)
                                                  \--smtp err--> 'failed' (terminal, reason set)
```

## Entity: profile (content, not a table)

`content/profile.json` is committed content, loaded at build time by `src/lib/profile.mjs` and by `scripts/build-cv.mjs`. Required shape (extra keys allowed, unknown keys ignored):

```jsonc
{
  "name": "Emad Poursina",
  "headline": "AI and Agentic Systems Engineer with a strong foundation in software development",
  "workAuthorization": "Requires employer-sponsored work authorization.",
  "availability": "one month notice",
  "targetRoles": ["…"],                  // from master-profile.md, never invented
  "targetCountries": ["Canada", "Ireland", "United Kingdom", "Netherlands", "Portugal"],
  "bio": "…",                            // short, factual, from the profile
  "contactEmail": "emad.poursina.work@gmail.com",
  "links": { "linkedin": "https://…", "github": "https://…" },
  "experience": [{ "role": "…", "company": "…", "start": "YYYY-MM", "end": "YYYY-MM|present", "points": ["…"] }],
  "skills": [{ "name": "…", "level": "Expert|Advanced|Intermediate|Beginner / Learning" }],
  "projects": [{ "name": "…", "description": "…", "url": "…" }],
  "education": [{ "degree": "…", "institution": "…", "year": "…" }],
  "languages": [{ "name": "…", "level": "…" }]
}
```

Validation enforced at build (exit non-zero, naming the field): required keys present and non-empty; `headline`, `workAuthorization`, `availability`, `contactEmail`, and `targetCountries` exactly equal to the approved strings above; every `skills[].level` in the allowed set. The file itself is produced by transcribing `master-profile.md` (OQ-1) — this feature never invents or infers a value.

## Entity: CV artifact

Not stored; generated per build by `scripts/build-cv.mjs` → `public/cv.pdf` (copied to `dist/client/cv.pdf`). Properties the check asserts: PDF 1.3+, no `/Subtype /Image` XObject, text operators present, headings in order, authorization line verbatim, no line with a >24 pt horizontal gap between runs (single column). `public/cv.pdf` is gitignored; the PDF is reproducible from the profile.

## Entity: rate-limit window (in memory)

`Map<string, number[]>` — client key ⇒ ascending POST timestamps (ms). Window 3600 s, limit `CONTACT_RATE_LIMIT_PER_HOUR` (default 5). Pruned on each access; entries older than the window are dropped when the key is touched. Process-local by design (one container, F11); a restart resets the window, which is acceptable at this scale and documented in the spec's assumptions.

## Configuration keys

Read by `src/lib/env.mjs` at request time; `.env.example` lists all of them with empty values.

| Key | Required | Default | Effect when absent |
|---|---|---|---|
| `PORT` | no | `4321` | — |
| `HOST` | no | `0.0.0.0` | — |
| `DATA_DIR` | no | `./data` | directory created on first open |
| `CONTACT_TO` | no | `emad.poursina.work@gmail.com` | — |
| `CONTACT_RATE_LIMIT_PER_HOUR` | no | `5` | — |
| `TRUST_PROXY` | no | `0` | `X-Forwarded-For` ignored |
| `SMTP_HOST` | yes for delivery | — | contact disabled + warning |
| `SMTP_PORT` | no | `587` | — |
| `SMTP_SECURE` | no | `false` | — |
| `SMTP_USER` | yes for delivery | — | contact disabled + warning |
| `SMTP_PASS` | yes for delivery | — | contact disabled + warning |
| `SMTP_FROM` | no | `Emad Poursina <emad.poursina.work@gmail.com>` | — |
