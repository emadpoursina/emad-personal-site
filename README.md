# Emad Poursina — personal site

A personal website for Emad Poursina: a public home page, case studies, an About page, a
downloadable plain-text CV, a contact form that stores messages in SQLite and forwards them by email,
and an agent-readable layer. The product spec is [PRD.md](PRD.md) (v1.4, approved); the phase plan
is [PRD.phases.md](PRD.phases.md).

**Status:** Phase 2 implemented — home, case studies (Rousta TV and NamehAmal published, VoiceDash a
404 draft), About page, CV download, contact form, and the agent-readable layer (`/llms.txt`,
`/resume.json`, `/api/profile`, Person JSON-LD on every page). Phase 3 (ask-me assistant, admin
settings) is later.

## Stack

- [Astro 5.18.2](https://astro.build) with `@astrojs/node` (`output: 'server'`, standalone adapter).
  The home page, About page, case-studies index, both published study pages (`/case-studies/rousta-tv`,
  `/case-studies/namehamal`), contact page, 404, `llms.txt`, `resume.json`, and `sitemap.xml` are
  prerendered; `/healthz`, `POST /api/contact`, and `GET /api/profile` are on demand. The only
  `<script>` on a page is the `application/ld+json` data block (no client JS).
- Node.js 22 in the container (the host may be newer; `engines` pins `>=22 <23`).
- SQLite through `node:sqlite` (`DATA_DIR/site.sqlite`), one table `contact_messages`.
- [nodemailer](https://nodemailer.com) for SMTP delivery; delivery is disabled (and the form
  reports it) when SMTP settings are absent.
- [PDFKit](https://pdfkit.org) to generate `public/cv.pdf` at build time; `pdfjs-dist` (dev only)
  to verify its text layer, heading order, and single-column geometry.
- [Ajv](https://ajv.js.org) with `ajv-draft-04` (dev only) to validate `dist/client/resume.json`
  against the vendored JSON Resume schema draft-04.

## Routes

- `/` — Home page (prerendered)
- `/about` — About page with experience, education, languages, and skills by honest level (prerendered)
- `/case-studies` — Case studies index listing published studies (prerendered)
- `/case-studies/rousta-tv` — Published Rousta TV case study (prerendered)
- `/case-studies/namehamal` — Published NamehAmal case study (prerendered)
- `/case-studies/voicedash` → 404 while the draft flag is set
- `/contact` — Contact form page (prerendered)
- `/cv.pdf` — Generated plain-text PDF CV (static build artifact)
- `/llms.txt` — Plain-text site summary and guidance for LLMs (prerendered)
- `/resume.json` — JSON Resume schema (draft-04) profile (prerendered)
- `/sitemap.xml` — XML sitemap listing public prerendered routes (prerendered)
- `/healthz` — Health check endpoint reporting database and SMTP status (on demand)
- `POST /api/contact` — Contact form submission endpoint (on demand)
- `GET /api/profile` — Profile endpoint matching `resume.json` with skill levels (on demand)

## Local development

```sh
npm ci
cp .env.example .env      # fill in SMTP_* only if you want email delivery
npm run dev               # http://localhost:4321
```

The pages read `content/profile.json` and `content/case-studies.json`, which are both validated at
build time. The build fails if either file is missing, a required field is empty, or one of the
approved strings differs. A study marked `status: draft` (currently VoiceDash) is excluded from the
case-studies index, the sitemap, and `llms.txt`, and returns 404 at its slug (`/case-studies/voicedash`).
Content in `content/profile.json` is transcribed from the owner's `master-profile.md`, which stays
local and is not in this repository — nothing is invented, and learning-level skills stay labelled
as such.

### Environment

Every key is documented with an empty value in [.env.example](.env.example). `.env` is gitignored
and excluded from the Docker build context. `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` must all be
set for delivery; otherwise the contact endpoint returns the documented disabled response (503)
and the site shows the direct email address instead. `CONTACT_TO` defaults to
`emad.poursina.work@gmail.com`, `DATA_DIR` to `./data`, and `CONTACT_RATE_LIMIT_PER_HOUR` to 5.

## Build and checks

`npm run build` runs the gates in order:

1. `prebuild` — `scripts/check-profile.mjs` validates `content/profile.json` and
   `content/case-studies.json`; `scripts/build-cv.mjs` writes `public/cv.pdf`;
   `scripts/check-contrast.mjs` verifies every declared colour pair in `src/styles/tokens.css` is at
   least 4.5:1.
2. `build` — `astro build`.
3. `postbuild` — `scripts/check-cv.mjs` extracts the PDF text with coordinates and fails on an
   embedded image, missing/out-of-order headings, a missing authorization line, or a horizontal
   gap wider than 24 pt (multi-column layout); `scripts/check-static-output.mjs` checks the
   prerendered files, the absence of client script tags (allowing only `application/ld+json`),
   `/cv.pdf`, the on-demand routes, native interactive elements, and `:focus-visible` CSS.

## Validation commands

These are the eight commands in [.ainative/project.yaml](.ainative/project.yaml), in order, and each
must exit 0 from a clean shell at the repository root:

```sh
npm ci
npm run build
npm test
node scripts/check-agent-output.mjs
node scripts/test-public-routes.mjs
node scripts/test-contact-api.mjs
node scripts/lighthouse-check.mjs
node scripts/verify-container.mjs
```

- `npm ci` — install the locked tree
- `npm run build` — prebuild content/CV/contrast gates, astro build, postbuild CV + static-output checks
- `npm test` — 132 unit tests with node:test
- `node scripts/check-agent-output.mjs` — resume schema conformance + builder equality, one Person JSON-LD per page, no draft in `llms.txt`/sitemap (needs `dist/client`, i.e. after the build)
- `node scripts/test-public-routes.mjs` — boots the built server on a free port and checks the Phase 2 route contract, including 404 for `/case-studies/voicedash` and `/api/profile` equality with `resume.json`
- `node scripts/test-contact-api.mjs` — unchanged Phase 1 contact end-to-end
- `node scripts/lighthouse-check.mjs` — Lighthouse 11.7.1 mobile, three runs on each of `/`, `/about`, `/case-studies/rousta-tv`, gates Performance ≥ 95, Accessibility = 100, LCP < 2000 ms (median)
- `node scripts/verify-container.mjs` — builds and runs the image, health, Phase 2 route probes incl. the draft 404, volume persistence, disabled SMTP, secret scan

## Docker

```sh
cp .env.example .env    # optional: SMTP settings for live delivery
docker compose up --build
```

The site is served on `http://localhost:8080` (override with `SITE_PORT`), the SQLite file lives on
the named volume `app-data` at `/app/data`, and `GET /healthz` reports database and SMTP state. The
image runs as the non-root `node` user on `node:22-bookworm-slim`.

Astro's origin check stays enabled: `astro.config.mjs` trusts `localhost` and `127.0.0.1` at any
port so the native no-JavaScript form can post to `/api/contact` during local development and
container checks. When the site gets a real domain, add its hostname to `security.allowedDomains`
there, or the browser's same-origin form submission will be rejected with 403.

## Known gates and deferred checks

- **OQ-1 (content source): answered.** `content/profile.json` is transcribed from the owner's
  `master-profile.md` v3.0, which stays local and is not in this repository; no placeholder content
  is permitted.
- **OQ-2 (live email): deferred by the owner.** This host has no SMTP relay, so automated checks use
  the local sink and the documented disabled path. A live send to Gmail remains an owner-signed
  manual check.
- Lighthouse evidence, SMTP sink logs, and other run artifacts live in the gitignored `.evidence/`
  directory and are never committed.
