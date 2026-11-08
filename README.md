# Emad Poursina — personal site

A personal website for Emad Poursina: a public home page, a downloadable plain-text CV, and a
contact form that stores messages in SQLite and forwards them by email. The product spec is
[PRD.md](PRD.md) (v1.4, approved); the phase plan is [PRD.phases.md](PRD.phases.md).

**Status:** Phase 1 implemented (home, CV, contact, container packaging). Case studies, the About
page, the agent-readable layer, and the visitor Q&A assistant are later phases.

## Stack

- [Astro 5.18.2](https://astro.build) with `@astrojs/node` (`output: 'server'`, standalone adapter).
  The home page, contact page, and 404 are prerendered; `/healthz` and `POST /api/contact` are
  on demand. Neither content page ships client JavaScript.
- Node.js 22 in the container (the host may be newer; `engines` pins `>=22 <23`).
- SQLite through `node:sqlite` (`DATA_DIR/site.sqlite`), one table `contact_messages`.
- [nodemailer](https://nodemailer.com) for SMTP delivery; delivery is disabled (and the form
  reports it) when SMTP settings are absent.
- [PDFKit](https://pdfkit.org) to generate `public/cv.pdf` at build time; `pdfjs-dist` (dev only)
  to verify its text layer, heading order, and single-column geometry.

## Local development

```sh
npm ci
cp .env.example .env      # fill in SMTP_* only if you want email delivery
npm run dev               # http://localhost:4321
```

The pages read `content/profile.json`, which is validated on load. The build fails if the profile
is missing, a required field is empty, or one of the approved strings differs. Content in that
file is transcribed from the owner's `master-profile.md`, which stays local and is not in this
repository — nothing is invented, and learning-level skills stay labelled as such.

### Environment

Every key is documented with an empty value in [.env.example](.env.example). `.env` is gitignored
and excluded from the Docker build context. `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` must all be
set for delivery; otherwise the contact endpoint returns the documented disabled response (503)
and the site shows the direct email address instead. `CONTACT_TO` defaults to
`emad.poursina.work@gmail.com`, `DATA_DIR` to `./data`, and `CONTACT_RATE_LIMIT_PER_HOUR` to 5.

## Build and checks

`npm run build` runs the gates in order:

1. `prebuild` — `scripts/build-cv.mjs` writes `public/cv.pdf`; `scripts/check-contrast.mjs`
   verifies every declared colour pair in `src/styles/tokens.css` is at least 4.5:1.
2. `build` — `astro build`.
3. `postbuild` — `scripts/check-cv.mjs` extracts the PDF text with coordinates and fails on an
   embedded image, missing/out-of-order headings, a missing authorization line, or a horizontal
   gap wider than 24 pt (multi-column layout); `scripts/check-static-output.mjs` checks the
   prerendered files, the absence of client script tags, `/cv.pdf`, the on-demand routes, native
   interactive elements, and `:focus-visible` CSS.

## Validation commands

These are the six commands in [.ainative/project.yaml](.ainative/project.yaml), in order, and each
must exit 0 from a clean shell at the repository root:

```sh
npm ci
npm run build
npm test
node scripts/test-contact-api.mjs
node scripts/lighthouse-check.mjs
node scripts/verify-container.mjs
```

- `npm test` runs the unit tests with `node:test` (profile validation, env, database, rate limiter,
  contact service, HTTP outcomes, contrast maths, CV heading/gap logic, home content).
- `scripts/test-contact-api.mjs` boots two built-server instances with a temporary `DATA_DIR` and a
  local SMTP sink; it proves the sent, invalid, rate-limited, and failed-delivery paths and prints
  `sent=1 rows=1 invalid=0 rate_limited=429 failed_row=1`.
- `scripts/lighthouse-check.mjs` installs the pinned Playwright Chromium when missing, runs
  Lighthouse 11.7.1 three times with the mobile profile, and gates on Performance ≥ 95,
  Accessibility = 100, and LCP < 2000 ms (median).
- `scripts/verify-container.mjs` builds the image, runs `docker compose up`, checks `/healthz`,
  posts through the container against a host SMTP sink, rebuilds to prove the named-volume row
  survives, exercises the SMTP-disabled path, and scans the image for secrets. It needs the Compose
  v2 plugin; `scripts/verify-container.mjs` uses `docker compose`.

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
