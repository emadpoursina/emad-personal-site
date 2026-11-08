# Implementation Plan: Phase 1 — Public Home, CV Download, and Contact

**Branch**: `emad-personal-site/t_cb4978b7-phase-1-public-home-cv-and-contact` | **Date**: 2026-11-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-phase-1-public-home-cv-contact/spec.md`; scope authority `PRD.phases.md` § Phase 1; requirements `PRD.md` v1.3 F1/F4/F6/F11/F12.

## Summary

Ship the first public slice of the site: a prerendered home page and contact page, a build-time CV PDF, a server-side contact endpoint that validates, stores in SQLite, emails over SMTP, and rate-limits per IP, and one Docker image behind `docker compose up` with the database on a named volume — gated by real build checks for the CV text layer, color contrast, static output, and a pinned mobile Lighthouse run (≥95 Performance, 100 Accessibility, LCP < 2.0 s).

The approach is deliberately the smallest thing that satisfies every acceptance criterion in scope: Astro 5's Node adapter for the two dynamic routes, everything else prerendered; no client-side JavaScript at all (the form posts natively); one SQLite file through `node:sqlite` so no native module is compiled; all content from one `content/profile.json` that refuses to build with missing facts.

## Technical Context

**Language/Version**: Node.js 22 LTS in the container (host runs 26.7.0); TypeScript for `.astro` pages/components (Astro's built-in support), plain ESM JavaScript (`.mjs`) for shared runtime logic, build scripts, and tests so they run under plain `node` without a transform.

**Primary Dependencies**: `astro@5.18.2` (existing, locked), `@astrojs/node` (Astro 5 adapter line, standalone mode), `nodemailer` (SMTP), `pdfkit` (build-time PDF). Dev-only: `pdfjs-dist` (CV text extraction with coordinates). Tooling invoked via `npx` and pinned in scripts: `playwright@1.65.0` (browser download), `lighthouse@11.7.1` (audit). Exact resolved versions are recorded by `package-lock.json` when the tasks run.

**Storage**: SQLite file at `${DATA_DIR}/site.sqlite` through `node:sqlite` (`DatabaseSync`), one table `contact_messages`; schema via `PRAGMA user_version`. Named Docker volume `app-data` at `/app/data`.

**Testing**: `node:test` for unit tests (validation, rate limiter, contrast math, CV heading order); `scripts/test-contact-api.mjs` for end-to-end HTTP against the built server and a local SMTP sink; `scripts/lighthouse-check.mjs` for the Lighthouse/LCP gate; `scripts/verify-container.mjs` for compose, volume persistence, and disabled-mode behaviour.

**Target Platform**: Linux (arm64 host, `node:22-bookworm-slim` container), single process, plain HTTP locally.

**Project Type**: web application — one Node server serving prerendered pages, two on-demand routes, and one static PDF.

**Performance Goals**: LCP < 2.0 s on the mobile Lighthouse profile (simulated 4G, 4× CPU); no client JS on content pages; API responses (excluding SMTP) < 500 ms.

**Constraints**: PRD §9 stack only — no framework swap, no Astro major upgrade, no second runtime; secrets only in `.env`; every acceptance check runnable from `.ainative/project.yaml`; no evidence or secrets committed.

**Scale/Scope**: 3 public routes + 2 endpoints + 1 static file; 100 concurrent visitors in year 1; single container.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unratified Spec Kit template: every principle is still `[PRINCIPLE_N_NAME]`/`[PRINCIPLE_N_DESCRIPTION]` with no version or ratification date. It therefore states no normative rule that this plan could violate, and this plan does not invent one (ratifying a constitution is a separate job, not a side effect of a feature).

The governing constraints used as gates instead, all taken from sources that do bind this work:

| Gate | Source | Status |
|---|---|---|
| Stack is PRD §9 only (Astro 5.18.2 + Node adapter, Node 22, SQLite, nodemailer, build-time PDF, Docker/Compose) | parent card locked decision 1, `AGENTS.md` | PASS — no new runtime, no major upgrade; two dev-only tools justified below |
| Paths exactly `/`, `/contact`, `POST /api/contact`, `/cv.pdf`, `GET /healthz` | parent locked decision 2, PRD §6 | PASS — contracts/http-routes.md |
| Table is `contact_messages` with timestamp, name, email, message, delivery status | parent locked decision 3, PRD F6 AC2 | PASS — data-model.md |
| `.ainative/project.yaml` is the single source of validation commands | parent locked decision 4 | PASS — exact command list below; the build card writes it (this card is barred from editing it) |
| Secrets only in `.env`, `.env.example` documents keys empty, `.dockerignore` excludes `.env`/`node_modules`/`dist`/`.git` | parent locked decision 5, PRD F11 AC2 | PASS — D9/D10 |
| Content fence: only PRD strings + `master-profile.md` facts | parent locked decision 6, PRD F1 AC4 | PASS — `content/profile.json` validation (D12); build fails when the profile is missing |
| Build checks are real and exit non-zero naming the offender | parent locked decision 7, PRD F4 AC3/F12 AC4 | PASS — `check-cv.mjs`, `check-contrast.mjs` |
| No evidence or secrets in git | parent card "What to produce" | PASS — `.evidence/` and `public/cv.pdf` gitignored (task T004) |

Post-design re-check: unchanged. The two dev-only dependencies and the `.mjs` choice are recorded in Complexity Tracking, not waived.

## Project Structure

### Documentation (this feature)

```text
specs/001-phase-1-public-home-cv-contact/
├── spec.md              # this feature's requirements
├── plan.md              # this file
├── research.md          # Phase 0 decisions + measured environment evidence
├── data-model.md        # contact_messages, profile model, config keys
├── quickstart.md        # run/validate guide the tester follows
├── contracts/
│   ├── contact-api.md   # POST /api/contact request/response contract
│   └── http-routes.md   # every public route, caching, static-output invariants
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # written by /speckit.tasks
```

### Source Code (repository root)

```text
content/
└── profile.json              # single content source (transcribed from master-profile.md; OQ-1)

src/
├── pages/
│   ├── index.astro           # / — prerendered home (FR-001…FR-005)
│   ├── contact.astro         # /contact — prerendered form or disabled notice (FR-020, FR-026)
│   ├── 404.astro             # static 404
│   ├── healthz.ts            # GET /healthz — on demand (FR-035)
│   └── api/
│       └── contact.ts        # POST /api/contact — on demand (FR-021…FR-027)
├── layouts/BaseLayout.astro  # html lang, landmarks, skip link, meta
├── components/
│   ├── Header.astro          # name + nav links
│   ├── Footer.astro          # contact email, links
│   ├── ContactForm.astro     # native form, no JS
│   └── ContactOutcome.astro  # server-rendered HTML outcomes
├── styles/
│   ├── tokens.css            # color tokens + declared fg/bg pairs per theme (FR-043)
│   └── global.css            # base styles, :focus-visible (FR-041)
└── lib/
    ├── env.mjs               # config parsing + disabled-feature warnings (D9)
    ├── profile.mjs           # load + validate the content fence (D12)
    ├── db.mjs                # node:sqlite open, schema, insert, update (D2)
    ├── validation.mjs        # field rules shared by route and tests
    ├── rate-limit.mjs        # in-memory window (D8)
    ├── mailer.mjs            # nodemailer transport + disabled state (D3)
    ├── contact-service.mjs   # store-then-send orchestration (data-model write path)
    ├── http.mjs              # Accept negotiation + HTML/JSON outcome rendering
    └── contrast.mjs          # WCAG relative luminance/ratio (shared with tests)

scripts/
├── check-profile.mjs         # CLI: validate content/profile.json, exit 1 naming the field
├── build-cv.mjs              # profile.json → public/cv.pdf (FR-010…FR-014)
├── check-cv.mjs              # text layer, headings, single column, no images (FR-012)
├── check-contrast.mjs        # token pairs ≥ 4.5:1, names the offender (FR-043)
├── check-static-output.mjs   # prerender/no-JS/route invariants (FR-040, contracts/http-routes.md)
├── smtp-sink.mjs             # local SMTP capture for integration tests (OQ-2 default)
├── test-contact-api.mjs      # F6 AC1–AC5 end to end
├── lighthouse-check.mjs      # pinned mobile Lighthouse + LCP gate (FR-042/FR-044)
├── verify-container.mjs      # compose up/healthz/disabled/rebuild persistence (FR-030…FR-034)
├── db-count.mjs              # prints the contact_messages count (used via compose exec)
└── healthcheck.mjs           # COPYed into the runtime image for Docker HEALTHCHECK

tests/
├── profile.test.mjs
├── validation.test.mjs
├── rate-limit.test.mjs
├── db.test.mjs
├── contact-service.test.mjs
├── contrast.test.mjs
├── cv-headings.test.mjs
└── home-content.test.mjs

public/                       # favicon; cv.pdf is generated and gitignored
Dockerfile
compose.yaml
.dockerignore
.env.example
package.json / package-lock.json
```

**Structure Decision**: single Astro project at the repository root (Option 1). Pages own rendering and request handling; `src/lib/*.mjs` holds every rule that a test or build script must also run, which is why shared logic is plain ESM instead of TS: `node --test` and `node scripts/*.mjs` execute it directly with no loader, while Astro/Vite imports it unchanged.

## Implementation approach

### A. Rendering and pages

- `astro.config.mjs`: `output: 'server'`, `adapter: node({ mode: 'standalone' })`. Each content page sets `export const prerender = true`; `healthz.ts` and `api/contact.ts` stay on demand. If Astro 5.18 warns that `output: 'server'` is deprecated, switch to `output: 'static'` with the same adapter and `prerender = false` on the two dynamic routes — the static-output check asserts the same invariant either way (research D1).
- `index.astro` renders from `profile.json`: headline (h1), availability + authorization line, target roles, target countries, short bio, and three primary links (Case Studies → `/case-studies`, CV → `/cv.pdf`, Contact → `/contact`).
- `contact.astro` renders a native `<form action="/api/contact" method="post">` with labelled fields and always shows the direct email address as a fallback. No environment value is baked into the page: the endpoint re-checks configuration at request time, so a prerendered page can never display the wrong state.
- No client-side scripts on either page: no Astro islands, no hydration directive.
- `BaseLayout.astro`: `lang="en"`, skip link, `<header>/<main>/<footer>` landmarks, `<meta name="viewport">`, canonical title/description from the profile.

### B. CV pipeline

- `scripts/build-cv.mjs` (invoked by `prebuild`): reads `content/profile.json`, writes `public/cv.pdf` with PDFKit at A4, single column, left margin, standard-14 Helvetica/Times (real text operators, no images, no tables). Sections in fixed order: Summary, Experience, Skills, Projects, Education, Languages; the authorization line verbatim in the Summary block.
- `scripts/check-cv.mjs` (invoked by `postbuild` against `dist/client/cv.pdf`): (1) raw-byte scan fails on any `/Subtype /Image`; (2) `pdfjs-dist` text extraction; (3) headings present in order; (4) authorization line present; (5) lines grouped by baseline, fail if any line shows a horizontal gap > 24 pt between consecutive runs (multi-column signature), naming the offending line's text.
- Build order in `package.json`: `prebuild` = `node scripts/build-cv.mjs && node scripts/check-contrast.mjs`; `build` = `astro build`; `postbuild` = `node scripts/check-cv.mjs && node scripts/check-static-output.mjs`. A failure in any step makes `npm run build` exit non-zero with the offending section named.

### C. Contact pipeline

- `src/pages/api/contact.ts`: POST only; parses urlencoded/multipart/JSON; calls `contact-service.mjs`; renders JSON or HTML per `Accept` (`http.mjs`); always `Cache-Control: no-store`.
- `contact-service.mjs`: validate → rate limit → enabled check → pessimistic insert (`failed`) → send with 30 s ceiling → update (`sent`/`failed`) → outcome; exact ordering and status codes in `contracts/contact-api.md` and `data-model.md`.
- `db.mjs`: opens `site.sqlite` under `DATA_DIR`, applies schema version 1 on open, exposes `insertMessage`, `markSent`, `markFailed`, `countMessages`, `isHealthy`. Opens lazily so the server boots and `/healthz` can report a broken database instead of crashing.
- `rate-limit.mjs`: sliding window map, 5/hour default, `Retry-After` computed from the oldest timestamp in the window.
- `mailer.mjs`: builds the transport from `env.mjs` on first use, caches it, exposes `send({name,email,message})` and `status()`; disabled when host/user/pass are missing, logging one warning.
- `env.mjs`: parses and caches; resolves the client IP with `TRUST_PROXY` semantics; never logs secret values.
- `/healthz`: 200 `{status:'ok',db:'ok',smtp:…}`; 503 `{status:'degraded',db:'error'}` when the DB cannot be opened.

### D. Container

- `Dockerfile`, four stages on `node:22-bookworm-slim`: `deps` (`npm ci`) → `build` (`npm run build`) → `prod-deps` (`npm ci --omit=dev`) → `runtime` (dist + prod deps + `scripts/healthcheck.mjs`, `USER node`, `ENV DATA_DIR=/app/data`, `EXPOSE 4321`, `HEALTHCHECK` via the healthcheck script, `CMD ["node","--experimental-sqlite","dist/server/entry.mjs"]`).
- `compose.yaml`: `build: .`, `env_file: .env`, `ports: ["8080:4321"]`, `volumes: [app-data:/app/data]`, `extra_hosts: ["host.docker.internal:host-gateway"]`, `restart: unless-stopped`.
- `.dockerignore`: `.env`, `.env.*`, `node_modules`, `dist`, `.git`, `.evidence`, `specs`, `tests`, `*.sqlite`, `data`.
- `.env.example`: every key from data-model.md with empty values and a one-line comment.
- `scripts/verify-container.mjs`: writes a throwaway `.env` from `.env.example` (sink on host port), builds, ups, waits for `/healthz` (≤60 s), posts one message, reads the row count with `docker compose exec -T site node --experimental-sqlite scripts/db-count.mjs`, rebuilds, restarts, re-reads the count, then starts without SMTP to prove the disabled notice + log warning, and finally `docker compose down -v`.

### E. Accessibility and performance

- `tokens.css` declares light and dark palettes and explicit pairs (`--pair-body: --fg on --bg`, …); `check-contrast.mjs` computes WCAG ratios and fails below 4.5:1 for every text pair — no large-text exception, matching PRD F12 AC4 literally — naming theme + pair.
- `global.css` provides a `:focus-visible` outline with ≥3:1 contrast against both surfaces, a skip link, reduced-motion handling, and a single-column layout below 768 px.
- `lighthouse-check.mjs` implements research D6 exactly: pinned versions, derived browser path, default mobile emulation with simulated throttling, gate on Performance ≥95, Accessibility =100, LCP < 2000 ms; three runs, median reported.

### F. Validation layer and ownership

`.ainative/project.yaml` must end up carrying exactly:

```yaml
validation_commands:
  - npm ci
  - npm run build
  - npm test
  - node scripts/test-contact-api.mjs
  - node scripts/lighthouse-check.mjs
  - node scripts/verify-container.mjs
```

Two ownership notes for the build card (this card is barred from both edits):

1. Replace the bootstrap placeholder in `.ainative/project.yaml` with the list above (parent locked decision 4, `AGENTS.md`).
2. Fill `**Spec:** specs/001-phase-1-public-home-cv-contact` in `PRD.phases.md` § Phase 1 (the ready script's phased-PRD rule expects the phase's own specify step to fill it on the branch; this card's bans reserve the edit for the build card).

`package.json` scripts this plan requires: `dev`, `build` (+ `prebuild`/`postbuild`), `preview`, `start` (`node --experimental-sqlite dist/server/entry.mjs`), `test` (`node --experimental-sqlite --test tests/`), and the four `check`/verify scripts as direct file paths.

## Complexity Tracking

| Addition | Why needed | Simpler alternative rejected because |
|---|---|---|
| `pdfjs-dist` (dev-only) | F4 AC3 needs measured column geometry and heading order from the real PDF | Regex over content streams cannot measure horizontal gaps honestly; `pdf-parse` hides the coordinates |
| `playwright@1.65.0` via `npx` (no package) | only way to obtain a headless Chrome without root in this container (verified) | system Chrome absent and no sudo; `@puppeteer/browsers` failed: no `unzip` in the image |
| `lighthouse@11.7.1` via `npx` | F12 AC3/F44 require the actual audit score | hand-rolled LCP measurement is not comparable to the PRD metric |
| `node:test` instead of Vitest | zero dependencies, runs the same `.mjs` modules the pages import | Vitest adds a transform/config layer for no capability this phase needs (PRD §9 lists it as a suggestion, not a constraint) |
| Shared logic as `.mjs` rather than `.ts` | build scripts and tests must import it under plain `node` | a TS loader (`tsx`) is a dependency and a second execution path |
| `extra_hosts: host.docker.internal` in compose | lets the container test reach the host SMTP sink on Linux | hard-coding a bridge IP is brittle; publishing the sink on the host network is less isolated |
| `502` for stored-but-undelivered | distinguishes "message saved, email failed" from "message lost" for the tester and the visitor | returning `200` would hide F6 AC4; returning `500` would suggest nothing was stored |
