# Contract: public HTTP routes (Phase 1)

**Owner**: FR-001…FR-035, PRD §6 · **Rendering**: [research.md](../research.md) D1 · **Data**: [data-model.md](../data-model.md)

| Route | Method | Rendering | Content-Type | Contract |
|---|---|---|---|---|
| `/` | GET | prerendered at build (`prerender = true`) | `text/html; charset=utf-8` | headline, availability, authorization line, target roles/countries, bio, and one-click links to Case Studies, CV, Contact (FR-001…FR-004) |
| `/contact` | GET | prerendered at build | `text/html; charset=utf-8` | labelled form (name, email, message) with `action="/api/contact"` and `method="post"`; the direct email address `emad.poursina.work@gmail.com` is always shown as a fallback, so the page is accurate whether or not SMTP is configured at runtime (FR-020, FR-026) |
| `/api/contact` | POST | on demand | per `Accept` | see [contact-api.md](./contact-api.md) |
| `/cv.pdf` | GET | static file, generated at build | `application/pdf` | single-column text PDF with the six headings and the authorization line (FR-010…FR-014); also served with the same bytes at `/cv.pdf` |
| `/healthz` | GET | on demand, never prerendered | `application/json; charset=utf-8` | `200 {"status":"ok","db":"ok","smtp":"configured"|"disabled","uptimeSeconds":<n>}`; `503 {"status":"degraded","db":"error",…}` when the database cannot be opened; never contains secrets, paths, or versions of dependencies |
| anything else | any | — | `text/html` | `404` page with a link to `/` |

## Caching headers

- `/` and `/contact`: `Cache-Control: public, max-age=0, must-revalidate` (prerendered but content may change with a deploy).
- `/cv.pdf`: `Cache-Control: public, max-age=3600`.
- `/healthz` and `/api/contact`: `Cache-Control: no-store`.
- All responses: `X-Content-Type-Options: nosniff`.

## Static-output invariants (checked by `scripts/check-static-output.mjs`)

1. `dist/client/index.html` and `dist/client/contact/index.html` exist and contain the required strings.
2. Neither page references a client-side script bundle (`<script src=…>`), so both read with JavaScript disabled (FR-040).
3. `dist/client/cv.pdf` exists, is larger than 10 KB, and starts with `%PDF-`.
4. No `dist/client/healthz` or `dist/client/api/contact` artifact exists (both must stay on demand; a prerendered health endpoint would lie forever).
5. Every interactive element on `/` and `/contact` is a native `<a>`, `<button>`, `<input>`, `<textarea>`, or `<label>`; no `tabindex` above 0 (keyboard order follows the document).
6. A focus style is declared for `:focus-visible` in the shipped CSS (FR-041) and the token check confirms its contrast.

## Error pages

- `404`: static page, links to `/` and `/contact`.
- `500` from the SSR routes: minimal HTML/JSON with a link back; no stack trace in production (`NODE_ENV=production`).
