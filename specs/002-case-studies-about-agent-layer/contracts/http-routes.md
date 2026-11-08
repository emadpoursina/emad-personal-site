# HTTP route contract — Phase 2

**Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md) · **Data model**: [../data-model.md](../data-model.md)

All routes are served by the single Astro Node server behind `docker compose up` on the configured port. Content routes are prerendered (`dist/client`); `/api/profile` is on demand. No route requires client-side JavaScript.

## Route table

| Method | Path | Source | Render | Status | Content-Type | Cache |
|---|---|---|---|---|---|---|
| GET | `/` | `src/pages/index.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| GET | `/about` | `src/pages/about.astro` | **prerendered (new)** | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies` | `src/pages/case-studies/index.astro` | **prerendered (new)** | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/rousta-tv` | `src/pages/case-studies/[slug].astro` | **prerendered (new)** | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/namehamal` | `src/pages/case-studies/[slug].astro` | **prerendered (new)** | 200 | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/voicedash` | — (draft excluded from `getStaticPaths`) | falls through to `404.astro` | **404** | `text/html; charset=utf-8` | static default |
| GET | `/case-studies/<unknown>` | — | falls through to `404.astro` | 404 | `text/html; charset=utf-8` | static default |
| GET | `/llms.txt` | `src/pages/llms.txt.ts` | **prerendered (new)** | 200 | `text/plain; charset=utf-8` | static default |
| GET | `/resume.json` | `src/pages/resume.json.ts` | **prerendered (new)** | 200 | `application/json; charset=utf-8` | static default |
| GET | `/sitemap.xml` | `src/pages/sitemap.xml.ts` | **prerendered (new)** | 200 | `application/xml` (UTF-8 declared in the XML prolog) | static default |
| GET | `/api/profile` | `src/pages/api/profile.ts` | **on demand (new)** | 200 | `application/json; charset=utf-8` | `public, max-age=300` |
| GET | `/cv.pdf` | generated build artifact | static | 200 | `application/pdf` | static default |
| GET | `/contact` | `src/pages/contact.astro` | prerendered | 200 | `text/html; charset=utf-8` | static default |
| POST | `/api/contact` | `src/pages/api/contact.ts` | on demand | unchanged (200/400/429/502/503/500) | per `Accept` | `no-store` |
| GET | `/healthz` | `src/pages/healthz.ts` | on demand | 200/503 | `application/json` | `no-store` |

`/api/profile` accepts `GET` only; other methods fall to the default 404 behaviour (no write surface is introduced).

## Prerender invariants (extend `scripts/check-static-output.mjs`)

1. `dist/client/index.html`, `dist/client/contact/index.html`, `dist/client/about/index.html`, `dist/client/case-studies/index.html`, `dist/client/case-studies/rousta-tv/index.html`, and `dist/client/case-studies/namehamal/index.html` exist.
2. `dist/client/case-studies/voicedash/` does **not** exist; `dist/client/llms.txt`, `dist/client/resume.json`, and `dist/client/sitemap.xml` do exist.
3. Every `.html` file under `dist/client` (recursive walk) contains exactly one `<h1>` and exactly one `<script type="application/ld+json">` block; no `<script src=…>` and no `<script>` with any other `type`.
4. `dist/client/healthz`, `dist/client/api/contact`, and `dist/client/api/profile` do not exist (all three remain on demand).
5. `dist/client/cv.pdf` still starts with `%PDF-`, is > 10 KB, and every interactive element remains native with `tabindex` ≤ 0 and a `:focus-visible` rule in the shipped CSS.

## Behavioural contract (proven by `scripts/test-public-routes.mjs` against the built server)

| Assertion | Expected |
|---|---|
| `GET /case-studies` | 200; contains both published titles and links; does not contain `voicedash` |
| `GET /case-studies/rousta-tv` | 200; `<h2>` texts in document order are exactly `Problem`, `My Contribution`, `Outcome`, `Stack`, `Public Link`; contains `https://roustatv.com/` |
| `GET /case-studies/namehamal` | 200; same five headings in order; says the product is private with no public link; contains no outbound `http` link in the study body |
| `GET /case-studies/voicedash` | exactly 404 |
| `GET /about` | 200; contains summary, all 7 category headings, every skill name, `Learning`, education, languages, `Team context` for Villion |
| `GET /llms.txt` | 200; `text/plain`; contains headline, all target roles, authorization line, availability, both study URLs, `/cv.pdf`, `/contact`; no `voicedash` |
| `GET /resume.json` | 200; `application/json`; parses; no `voicedash`; matches the profile facts |
| `GET /api/profile` | 200; `application/json`; `last_updated` present; every skill has `level` and `category`; non-skill keys deep-equal `resume.json`; no `voicedash` |
| `GET /sitemap.xml` | 200; XML; exactly the four public page URLs plus the two published study URLs; no `voicedash` |
| `GET /`, `/contact`, `/cv.pdf`, `/healthz` | 200 with their Phase 1 content/status (regression) |
| Navigation on every page | contains `/about` and `/case-studies`; contains no draft slug |
