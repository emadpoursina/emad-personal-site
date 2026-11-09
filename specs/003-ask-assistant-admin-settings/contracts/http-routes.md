# HTTP route contract — Phase 3

**Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md) · **Data model**: [../data-model.md](../data-model.md)

All routes are served by the single Astro Node server. Phase 1/2 pages keep their render mode and behavior. New pages are marked **new**; new on-demand routes are marked **new, on demand**.

## Route table

| Method | Path | Source | Render | Status | Content-Type | Cache |
|---|---|---|---|---|---|---|
| GET | `/` | `src/pages/index.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/about` | `src/pages/about.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies` | `src/pages/case-studies/index.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/rousta-tv` | `src/pages/case-studies/[slug].astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/namehamal` | `src/pages/case-studies/[slug].astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/voicedash` | — | falls to `404.astro` | 404 | `text/html; charset=utf-8` | static default |
| GET | `/ask` | `src/pages/ask.astro` | **prerendered (new)** | 200 | `text/html; charset=utf-8` | static default |
| POST | `/api/ask` | `src/pages/api/ask.ts` | **on demand (new)** | 200/400/415/429/502/503/504/500 | `application/json; charset=utf-8` | `no-store` |
| GET | `/admin` | `src/pages/admin/index.astro` | **on demand (new)** | 401 or 200 | `text/html; charset=utf-8` | `no-store` |
| GET | `/admin/login` | `src/pages/admin/login.astro` | **prerendered (new)** | 200 | `text/html; charset=utf-8` | static default |
| POST | `/api/admin/login` | `src/pages/api/admin/login.ts` | **on demand (new)** | 200/303/400/401/429 | JSON or empty redirect body | `no-store` |
| POST | `/api/admin/logout` | `src/pages/api/admin/logout.ts` | **on demand (new)** | 200/303/401 | JSON or empty redirect body | `no-store` |
| POST | `/api/admin/settings` | `src/pages/api/admin/settings.ts` | **on demand (new)** | 200/303/400/401/403/500 | JSON or HTML | `no-store` |
| * | `/api/admin/*` | `src/pages/api/admin/[...path].ts` | **on demand (new)** | 401 or 404 | `application/json; charset=utf-8` | `no-store` |
| * | `/admin/*` | `src/pages/admin/[...path].astro` | **on demand (new)** | 401 or 404 | `text/html; charset=utf-8` | `no-store` |
| GET | `/llms.txt` | `src/pages/llms.txt.ts` | prerendered | 200 | `text/plain; charset=utf-8` | static default |
| GET | `/resume.json` | `src/pages/resume.json.ts` | prerendered | 200 | `application/json; charset=utf-8` | static default |
| GET | `/api/profile` | `src/pages/api/profile.ts` | on demand | 200 | `application/json; charset=utf-8` | `public, max-age=300` |
| GET | `/sitemap.xml` | `src/pages/sitemap.xml.ts` | prerendered | 200 | `application/xml` | static default |
| GET | `/cv.pdf` | build artifact | static | 200 | `application/pdf` | static default |
| GET | `/contact` | `src/pages/contact.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| POST | `/api/contact` | `src/pages/api/contact.ts` | on demand | unchanged | per `Accept` | `no-store` |
| GET | `/healthz` | `src/pages/healthz.ts` | on demand | 200/503 | `application/json` | `no-store` |

Catch-all precedence: Astro's file-based routes match the more specific file before `[...path]`, so the three defined admin API routes keep their behavior; the catch-all only serves undefined paths. The catch-all checks the session first: no session → 401 JSON; valid session → 404 JSON. The `/admin/*` page catch-all mirrors it with HTML.

## Headers

- Every `/api/ask` and `/api/admin/*` response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Language: en`.
- Every `/admin` page response: `Cache-Control: no-store`.
- `/api/ask` 429: `Retry-After: <seconds>` (per-IP case); the daily-cap case does not send `Retry-After` because the wait is until the next UTC day.
- `/api/admin/login` 429: `Retry-After: <seconds>`.
- The session cookie is set only by a successful login and cleared only by logout.

## Discovery surfaces

| Surface | `/ask` | `/admin`, `/admin/login` |
|---|---|---|
| Header navigation | included, labelled `Ask` | absent |
| `/sitemap.xml` | included once | absent |
| `llms.txt` | unchanged (no site-navigation facts added) | absent |
| `resume.json` | unchanged | absent |
| `/api/profile` | unchanged | absent |
| Person JSON-LD | unchanged | absent |
| `<meta name="robots">` | not set (indexable) | `noindex, nofollow` |

`src/lib/site.mjs` `PUBLIC_PAGE_PATHS` becomes `['/', '/about', '/case-studies', '/ask', '/contact']`; `buildSitemap` iterates that list and then appends published studies. The sitemap therefore contains `/`, `/about`, `/case-studies`, `/ask`, `/contact`, `/case-studies/rousta-tv`, `/case-studies/namehamal` in that order, and no draft or admin path.

## Prerender invariants (extend `scripts/check-static-output.mjs`)

1. All Phase 2 HTML artifacts still exist; `dist/client/ask/index.html` and `dist/client/admin/login/index.html` exist; `dist/client/admin/index.html` does **not** exist (the admin settings page is on demand).
2. Every `.html` under `dist/client` contains exactly one `<h1>`, exactly one `<script type="application/ld+json">`, the skip link first in `<body>`, and `id="main"`.
3. No page has a `<script src=…>` or a non-JSON-LD `<script>` **except** `dist/client/ask/index.html`, which may contain exactly one `<script type="module" src="/_astro/…">` and no other script.
4. `/ask` contains a `<form`, a labelled `<textarea>` with `maxlength="1000"`, a submit `<button>`, an element with `role="status"` and `aria-live="polite"`, and the exact disclaimer `AI assistant. The CV and case studies are the source of record.`
5. `/admin/login` contains `noindex` and a password input; it contains no settings value.
6. `dist/client/sitemap.xml` contains `/ask` and contains no `/admin`.
7. `dist/client/healthz`, `dist/client/api/contact`, `dist/client/api/profile`, `dist/client/api/ask`, and `dist/client/api/admin/login` do not exist (all remain on demand).
8. `dist/client/cv.pdf`, `llms.txt`, `resume.json`, and `sitemap.xml` still exist with their Phase 2 content rules.

## Behavioural contract (proven by the existing scripts and the new integration tests)

| Assertion | Expected |
|---|---|
| `GET /ask` | 200; contains the form, the 1,000 limit, the live region, the disclaimer, and exactly one island |
| `GET /admin` without cookie | exactly 401; `noindex`; no settings or secret in the body; link to `/admin/login` |
| `GET /admin/login` | 200; password form; `noindex`; no settings |
| `POST /api/ask` configured, valid question | 200 JSON with `answer`, exact `disclaimer`, non-empty `sources` with valid hrefs, and the effective `model` |
| `POST /api/ask` without an AI key | 503 JSON with exact message `The assistant is unavailable right now`; stub log unchanged |
| `POST /api/ask` 1,001-character question | 400 JSON with `errors.question`; stub log unchanged |
| `POST /api/ask` 11th request in an hour from one IP | 429 `rate_limited`, `Retry-After` present; stub log unchanged |
| `POST /api/ask` after the daily cap | 429 `daily_cap` with paused message; stub log unchanged; still 429 after restart on the same day |
| `POST /api/ask` salary / visa / private-codebase question | 200 with the `assistantPolicy` string; no number; visa contains the exact authorization line; stub log unchanged |
| `POST /api/admin/login` correct password | 303 (form) or 200 (JSON) with `Set-Cookie: admin_session=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` |
| `POST /api/admin/login` five wrong passwords then correct | 429 with `Retry-After`; no cookie |
| `POST /api/admin/settings` without cookie | 401; no write |
| `POST /api/admin/settings` cross-origin | 403; no write |
| `POST /api/admin/settings` valid | 303/200; next `/api/ask` uses the new base URL and model; next contact uses the new SMTP settings |
| `POST /api/admin/logout` with cookie | 303/200; the old cookie is 401 on the next request |
| `GET /`, `/about`, `/case-studies`, `/contact`, `/cv.pdf`, `/healthz`, `/llms.txt`, `/resume.json`, `/api/profile`, `/sitemap.xml` | Phase 1/2 behavior unchanged |
