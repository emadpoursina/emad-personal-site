# Research: Phase 1 — Public Home, CV Download, and Contact

**Date**: 2026-11-07
**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md)

Each decision below is either fixed by the parent card (`PRD.md` §9 stack lock) or was resolved by a spike that was actually run in this environment. Spike commands and their observed output are quoted so the tester can reproduce them; no result here is inferred.

## Environment facts (measured, 2026-11-07)

| Fact | Measured value | How |
|---|---|---|
| Host Node / npm | v26.7.0 / 12.0.2 | `node --version`, `npm --version` |
| Target runtime | Node 22 LTS (`package.json` engines `>=22 <23`) | `package.json`; `npm ci` warns EBADENGINE on the host, exit 0 (parent preflight) |
| Docker | 26.1.5 client, compose v2.29.7, live daemon | parent preflight; socket mounted |
| `node:sqlite` on host Node 26 | works with and without `--experimental-sqlite`; `DatabaseSync` + prepare/run/get OK | probe script `probe-sqlite.mjs` (spike) |
| Headless browser | none preinstalled; no root (`uid=10000`, no sudo) | `command -v chromium/google-chrome`, `sudo -n true` |
| Playwright browser install | **works without root** when `PLAYWRIGHT_BROWSERS_PATH` points at a writable dir; downloads `chromium-1254` + `chromium_headless_shell-1254` (arm64) | `PLAYWRIGHT_BROWSERS_PATH=… npx --yes playwright@latest install chromium` |
| Chrome runs | `Google Chrome for Testing 158.0.8127.18` — `--version` exits 0, so the container has the required shared libraries | `./chromium_headless_shell-…/chrome-headless-shell --version` |
| Lighthouse | `11.7.1`, runs headless against a local page with `CHROME_PATH=<headless shell>`; mobile + `simulate` throttling by default | `npx --yes lighthouse@11 http://127.0.0.1:4321/ --only-categories=performance,accessibility --output=json` → `{"performance":1,"accessibility":1,"lcp_ms":637,"throttling":"simulate","form_factor":"mobile"}` |

Consequence: the accessibility/LCP gate is implementable on this host with `npx`, no root, and no committed browser binaries. The plan pins the two CLI versions (`playwright@1.65.0`, `lighthouse@11.7.1`) and derives the browser path instead of hard-coding the `-1254` build suffix.

## Decisions

### D1 — Rendering: Astro 5 SSR adapter, content pages prerendered

- **Decision**: Astro 5.18.2 with `@astrojs/node` in `standalone` mode; `output: 'server'`, `export const prerender = true` on `/` and `/contact`; `/healthz` and `/api/contact` stay on demand.
- **Rationale**: PRD §9/§6 require server endpoints *and* static content pages; per-route `prerender` is the supported Astro 5 mechanism, and the standalone adapter serves both `dist/client` and `dist/server` from one process, which is what one container needs.
- **Alternatives**: `output: 'static'` + adapter + `prerender = false` on the two dynamic routes (Astro 5 also supports this; kept as fallback if 5.18 deprecates `server`); a separate static server in front of Node (rejected: two processes, no benefit at this scale).
- **Proof**: `scripts/check-static-output.mjs` asserts `dist/client/index.html` and `dist/client/contact/index.html` exist as HTML with no `<script src>` bundle for the page, and that `/healthz` was not prerendered.

### D2 — Database: `node:sqlite` (built-in), not `better-sqlite3`

- **Decision**: `node:sqlite` `DatabaseSync`, opened through one thin module; start command carries `--experimental-sqlite` (accepted by Node 22.5+ and harmless on newer Node, verified on v26.7.0).
- **Rationale**: zero native modules means no compiler in the runtime image and no ABI coupling between the host (Node 26) and the container (Node 22). PRD §9 explicitly allows `node:sqlite`.
- **Alternatives**: `better-sqlite3` (needs a build stage with python/g++ and a prebuild for each Node ABI; more image weight for no feature gain). Its API is a superset of what this phase uses.
- **Guards**: a version check rejects Node < 22.5 with an explicit error; all SQL lives in `src/lib/db.mjs`, so swapping to `better-sqlite3` later touches one file.

### D3 — Email: `nodemailer`, disabled mode instead of startup failure

- **Decision**: transport built from env on first use; `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` missing ⇒ contact disabled (503 on POST carrying the direct email address; `/contact` always shows that address as a fallback), with one warning in the log; connection/greeting/socket timeouts pinned at 10s/10s/30s so a hanging server fails inside the 30s AC window.
- **Rationale**: F6 AC4 (keep row, status `failed`) and F11 AC3 (feature disabled with warning) are different states and must not collapse into one.
- **Alternatives**: crash at boot without SMTP (rejected: F11 AC3 forbids it); queue/retry worker (out of scope for one container).

### D4 — CV: PDFKit at build time, checked with pdfjs-dist

- **Decision**: `prebuild` runs `scripts/build-cv.mjs` (PDFKit, single column, standard-14 fonts → real text operators, no font files) into `public/cv.pdf`; `postbuild` runs `scripts/check-cv.mjs` on `dist/client/cv.pdf`, which (a) scans the raw bytes for `/Subtype /Image` and fails if present, (b) extracts text with `pdfjs-dist`, (c) asserts the six headings appear in order and the authorization line appears verbatim, (d) groups text items by baseline and fails, naming the line, if any line has a horizontal gap larger than 24 pt between consecutive runs (the multi-column signature).
- **Rationale**: AC3 of F4 is a build gate, not a manual review; PDFKit keeps the build Node-only (no Typst binary), and pdfjs-dist gives real geometry rather than string matching.
- **Alternatives**: Typst (extra binary in the build image, fonts to vendor); `pdf-parse` (wraps pdf.js but hides coordinates); pure regex over content streams (cannot measure columns honestly).
- **Dependency note**: `pdfjs-dist` is a **devDependency**; it is never installed in the runtime image (`npm ci --omit=dev`) and never shipped. This is the one new dev dependency justified under locked decision 7.

### D5 — Contrast check: token-level WCAG math, backed by Lighthouse

- **Decision**: `scripts/check-contrast.mjs` parses `src/styles/tokens.css`, reads every `[data-theme="light"]` / `[data-theme="dark"]` block, and fails the build (exit 1, naming the theme and the pair) if any declared text/background pair is below 4.5:1. No large-text exception: PRD F12 AC4 sets one threshold for all text. Pairing is explicit: the token file declares pairs as `--pair-<name>: <fg-token> on <bg-token>` so no heuristic guesses which colors meet.
- **Rationale**: all page colors come from tokens (plain CSS, PRD §9), so token coverage is complete for text/background, and the rule is deterministic and dependency-free. Lighthouse Accessibility 100 is the DOM-level backstop.
- **Alternatives**: axe-core + Playwright in the build gate (heavier, needs the browser for every build; rejected as the gate but still exercised through Lighthouse).

### D6 — Lighthouse/LCP gate: pinned CLI, derived browser path, script owns the server

- **Decision**: `scripts/lighthouse-check.mjs` (a) installs the browser only if missing — `PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright-p1}" npx --yes playwright@1.65.0 install chromium`; (b) resolves `chromium_headless_shell-*/chrome-headless-shell-linux-*/chrome-headless-shell` by glob (never the build number); (c) starts `npm run preview` on a free port with `CHROME_PATH` set; (d) runs `npx --yes lighthouse@11.7.1 <url> --only-categories=performance,accessibility --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json`; (e) fails if Performance < 95, Accessibility < 100, or `largest-contentful-paint` ≥ 2000 ms; (f) always kills the server.
- **Rationale**: exactly the toolchain that was proven in this container (spike above), with every version and flag pinned so the tester's number is comparable to the build card's.
- **Phone profile**: Lighthouse's default mobile emulation + simulated throttling (`simulate`, 1.6 Mbps / 150 ms RTT / 4× CPU) is the declared stand-in for the PRD's mid-range phone; the report is archived by the tester, not committed.

### D7 — Contact endpoint: one route, HTML or JSON by `Accept`

- **Decision**: `POST /api/contact` returns JSON when the request `Accept` prefers `application/json`, otherwise a small server-rendered HTML outcome page with a link back to `/contact`. One status code per outcome: `200` stored and delivered, `502` stored but delivery failed (row status `failed`, visitor told to email directly), `400` validation errors, `429` rate limited, `503` feature disabled, `500` storage failure (no email attempted).
- **Rationale**: the page must work with JavaScript disabled (FR-027) and the tester needs machine-checkable outcomes; content negotiation gives both from one handler without a second endpoint or client JS.
- **Alternatives**: JS fetch + client-side errors (rejected: adds the only client JS on the site and breaks without JS); redirect to a static thank-you page (loses field-level errors).

### D8 — Rate limiting: in-process sliding window, proxy header off by default

- **Decision**: `Map<ip, number[]>` of POST timestamps, 5 per rolling 3600 s, all attempts counted, pruned on access; IP from the adapter's socket address; `X-Forwarded-For` honored only when `TRUST_PROXY=1`.
- **Rationale**: one container, one process (F11); a DB-backed counter adds a write per request for no benefit at this scale. Spoofable headers stay ignored by default.

### D9 — Configuration: env read at request time, one validation point

- **Decision**: `src/lib/env.mjs` validates `PORT`, `HOST`, `DATA_DIR`, `CONTACT_TO`, `CONTACT_RATE_LIMIT_PER_HOUR`, `SMTP_*`, `TRUST_PROXY` on first use, caches the result, and logs a single warning per disabled feature. `.env.example` documents every key with empty values; `.env` is gitignored and dockerignored.
- **Rationale**: request-time reading lets the integration test vary configuration without rebuilding; a single validation point keeps `/healthz`, the form, and the endpoint consistent.

### D10 — Container: multi-stage, non-root, named volume, healthcheck

- **Decision**: `node:22-bookworm-slim`; stages `deps` (full `npm ci`) → `build` (`npm run build`) → `prod-deps` (`npm ci --omit=dev`) → `runtime` (dist + prod deps + healthcheck script, `USER node`, `DATA_DIR=/app/data`); `compose.yaml` maps `8080:4321`, mounts named volume `app-data:/app/data`, `env_file: .env`, adds `extra_hosts: ["host.docker.internal:host-gateway"]` so the container test can reach a host mail sink.
- **Rationale**: build-time checks run where the toolchain exists; the runtime image carries no dev dependency, no browser, no `.env`, no source. `healthcheck` uses `node scripts/healthcheck.mjs` (slim images have no curl/wget).
- **Alternatives**: single-stage image (ships build tools and dev deps); alpine (node:sqlite is fine but prebuilt arm64 binaries and ICU differ — no gain here).

### D11 — Tests: `node:test` for units, real HTTP for integration

- **Decision**: unit tests with the built-in `node:test` runner over the `.mjs` lib modules (validation, rate limit, contrast math, CV heading order); integration via `scripts/test-contact-api.mjs`, which boots the built server on an ephemeral port with a temp `DATA_DIR` and a local SMTP sink, then asserts status codes, stored rows, and the sink's envelope.
- **Rationale**: zero test dependencies, runs on Node 22 and 26, and the same modules the pages import. PRD §9 suggests Vitest; it is not added because nothing here needs a transform (the shared logic is plain ESM). Revisit if component tests appear in a later phase.
- **Alternatives**: Vitest (transform, config, watch mode — no capability needed now); Playwright page tests (kept to the one Lighthouse gate; DOM assertions that matter are covered by `check-static-output.mjs` and Lighthouse).

### D12 — Content: one profile file, no invented facts

- **Decision**: `content/profile.json` is the only content source; `src/lib/profile.mjs` refuses to build if a required key is missing, if the headline or authorization line differs from the approved strings, or if `contactEmail` is not `emad.poursina.work@gmail.com`. The file is produced by transcribing `master-profile.md` once it is supplied (OQ-1).
- **Rationale**: PRD §8 maintainability + F1/F4 content fence (locked decision 6). A missing profile must break the build, not publish a placeholder.

## Risks carried into the plan

| Risk | Mitigation |
|---|---|
| `master-profile.md` never arrives (OQ-1) | build fails with a named-file error; build card is separately gated |
| Gmail app password unavailable (OQ-2) | SMTP path proven against a sink; live send is an owner-signed manual step |
| Astro 5.18 may warn on `output: 'server'` | documented fallback to `output: 'static'` + adapter; the static-output check asserts the same invariant either way |
| `node:sqlite` is experimental on Node 22 | flagged explicitly, one-module boundary, version guard |
| Lighthouse score varies with host load | pinned CLI/flags, mobile simulate, three-run minimum reported by the tester, gate on the median |
| Docker build on arm64 | base image is multi-arch; no native modules to compile |
