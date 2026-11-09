# HTTP route contract — Phase 4

**Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md) · **Data model**: [../data-model.md](../data-model.md)

All routes are served by the single Astro Node server. Phase 1/2/3 routes keep their render mode and behavior. New rows are marked **new**.

## Route table

| Method | Path | Source | Render | Status | Content-Type | Cache |
|---|---|---|---|---|---|---|
| GET | `/` | `src/pages/index.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/about` | `src/pages/about.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies` | `src/pages/case-studies/index.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/rousta-tv` | `src/pages/case-studies/[slug].astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/namehamal` | `src/pages/case-studies/[slug].astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/voicedash` | — | falls to `404.astro` | 404 | `text/html; charset=utf-8` | static default |
| GET | `/cover-letter` | `src/pages/cover-letter.astro` | **on demand (new)** | 200 | `text/html; charset=utf-8` | `no-store` |
| POST | `/api/cover-letter` | `src/pages/api/cover-letter.ts` | **on demand (new)** | 200/400/405/415/429/502/503/504/500 | `application/json; charset=utf-8` | `no-store` |
| GET | `/ask` | `src/pages/ask.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| POST | `/api/ask` | `src/pages/api/ask.ts` | on demand | unchanged | `application/json; charset=utf-8` | `no-store` |
| GET | `/admin` | `src/pages/admin/index.astro` | on demand | unchanged | `text/html; charset=utf-8` | `no-store` |
| GET | `/admin/login` | `src/pages/admin/login.astro` | prerendered | unchanged | `text/html; charset=utf-8` | static default |
| POST | `/api/admin/login` | `src/pages/api/admin/login.ts` | on demand | unchanged | JSON or empty redirect body | `no-store` |
| POST | `/api/admin/logout` | `src/pages/api/admin/logout.ts` | on demand | unchanged | JSON or empty redirect body | `no-store` |
| POST | `/api/admin/settings` | `src/pages/api/admin/settings.ts` | on demand | unchanged | JSON or HTML | `no-store` |
| * | `/api/admin/*` | `src/pages/api/admin/[...path].ts` | on demand | unchanged | `application/json; charset=utf-8` | `no-store` |
| * | `/admin/*` | `src/pages/admin/[...path].astro` | on demand | unchanged | `text/html; charset=utf-8` | `no-store` |
| GET | `/llms.txt` | `src/pages/llms.txt.ts` | prerendered | 200 (unchanged content) | `text/plain; charset=utf-8` | static default |
| GET | `/resume.json` | `src/pages/resume.json.ts` | prerendered | 200 (unchanged content) | `application/json; charset=utf-8` | static default |
| GET | `/api/profile` | `src/pages/api/profile.ts` | on demand | 200 (unchanged content) | `application/json; charset=utf-8` | `public, max-age=300` |
| GET | `/sitemap.xml` | `src/pages/sitemap.xml.ts` | prerendered | 200 | `application/xml` | static default |
| GET | `/cv.pdf` | build artifact | static | 200 | `application/pdf` | static default |
| GET | `/contact` | `src/pages/contact.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| POST | `/api/contact` | `src/pages/api/contact.ts` | on demand | unchanged | per `Accept` | `no-store` |
| GET | `/healthz` | `src/pages/healthz.ts` | on demand | 200/503 | `application/json` | `no-store` |

`/cover-letter` is on demand because the generator form's presence depends on the effective configuration at request time (F9 AC4). Its `Cache-Control: no-store` prevents a shared cache from serving a configured page to an unconfigured deployment or the reverse.

## Headers

- Every `/api/cover-letter` response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Language: en`.
- `/api/cover-letter` `rate_limited` 429: `Retry-After: <seconds>`. The `daily_cap` 429 sends no `Retry-After` because the wait is until the next UTC day (same rule as `/api/ask`).
- `/cover-letter` page response: `Cache-Control: no-store`, `Content-Type: text/html; charset=utf-8`.
- No new cookie, no CORS header, no `Set-Cookie`.

## Discovery surfaces

| Surface | `/cover-letter` | `/admin`, `/admin/login` |
|---|---|---|
| Header navigation | included, labelled `Cover Letter` | absent (unchanged) |
| `/sitemap.xml` | included exactly once, after `/contact` | absent |
| `llms.txt` | unchanged (no new facts; the CV and case studies remain the source of record) | absent |
| `resume.json` | unchanged | absent |
| `/api/profile` | unchanged | absent |
| Person JSON-LD | unchanged | absent |
| `<meta name="robots">` | not set (indexable) | `noindex, nofollow` (unchanged) |

`src/lib/site.mjs` `PUBLIC_PAGE_PATHS` becomes `['/', '/about', '/case-studies', '/ask', '/contact', '/cover-letter']`; `buildSitemap` iterates that list and then appends published studies. The sitemap therefore contains `/`, `/about`, `/case-studies`, `/ask`, `/contact`, `/cover-letter`, `/case-studies/rousta-tv`, `/case-studies/namehamal` in that order, and no draft or admin path.

The navigation order becomes `About`, `Case Studies`, `Cover Letter`, `Ask`, `CV`, `Contact`.

## Prerender invariants (extend `scripts/check-static-output.mjs`)

1. All Phase 1/2/3 HTML artifacts still exist, including `dist/client/ask/index.html` and `dist/client/admin/login/index.html`.
2. `dist/client/cover-letter/` does **not** exist: the page is on demand. `dist/client/api/cover-letter` does not exist either.
3. Every `.html` under `dist/client` keeps exactly one `<h1>`, exactly one `<script type="application/ld+json">`, the skip link first in `<body>`, and `id="main"`.
4. No prerendered page gains a `<script src=…>` or a non-JSON-LD `<script>`; `dist/client/ask/index.html` keeps its single module island allowance. Because `/cover-letter` is not in `dist`, its script allowance is proven at runtime (below) rather than here.
5. `dist/client/sitemap.xml` contains `/cover-letter` exactly once, immediately after `/contact`, and contains no `/admin`.
6. `dist/client/healthz`, `dist/client/api/contact`, `dist/client/api/profile`, `dist/client/api/ask`, `dist/client/api/admin/login`, and `dist/client/api/cover-letter` do not exist (all remain on demand).
7. `dist/client/cv.pdf`, `llms.txt`, `resume.json`, and `sitemap.xml` still exist with their Phase 2 content rules.

## Behavioural contract (proven by the existing scripts and the new integration tests)

| Assertion | Expected |
|---|---|
| `GET /cover-letter` unconfigured | 200; one `<h1>`; the full letter text; exact authorization line; exact sign-off; LinkedIn and GitHub links on separate lines after the sign-off; no `<form`; no banned phrase |
| `GET /cover-letter` with all scripts stripped | the full letter text is still present |
| `GET /cover-letter` configured | 200; the same letter **plus** a form with `maxlength="8000"`, a labelled textarea, a submit button, and a `role="status"` + `aria-live="polite"` region |
| `GET /cover-letter` page scripts | at most one `<script type="module" src="/_astro/…">`; no inline executable script |
| `POST /api/cover-letter` configured, valid job description | 200 JSON with a non-empty `letter` containing both required lines; stub received exactly one request |
| `POST /api/cover-letter` letter missing the sign-off | 200 with the sign-off appended; `appended.signoff === true` |
| `POST /api/cover-letter` letter with both lines | 200 with no append; both lines appear exactly once |
| `POST /api/cover-letter` without an endpoint or key | 503 `unconfigured` with the fixed message; stub log unchanged |
| `POST /api/cover-letter` empty / 8,001-character / non-string job description | 400 `validation` with `errors.jobDescription`; stub log unchanged |
| `POST /api/cover-letter` `text/plain`, `GET`, malformed JSON | 415 / 405 / 400; stub log unchanged |
| `POST /api/cover-letter` generator 500 | 502 `generator_error`; `fallback: true`; `generalLetter` equals the built general letter; no upstream body or key |
| `POST /api/cover-letter` generator delay beyond the bound | 504 `generator_timeout`; same fallback fields |
| `POST /api/cover-letter` 11th request in an hour from one IP | 429 `rate_limited` with `Retry-After`; stub log unchanged |
| `POST /api/cover-letter` after the shared daily cap, with ask requests counted first | 429 `daily_cap` with paused message; stub log unchanged; still 429 after restart on the same day |
| `GET /ask` and `/admin*` | Phase 3 behavior unchanged |
| `GET /`, `/about`, `/case-studies`, `/case-studies/*`, `/contact`, `/cv.pdf`, `/healthz`, `/llms.txt`, `/resume.json`, `/api/profile`, `/sitemap.xml` | Phase 1/2 behavior unchanged |
