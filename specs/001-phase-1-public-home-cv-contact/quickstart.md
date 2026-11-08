# Quickstart & validation guide: Phase 1

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Contracts**: [contracts/](./contracts/)

This is the run guide a tester follows from the worktree root. It contains no implementation code; every command below is part of the acceptance evidence for FR-001…FR-044.

## Prerequisites

| Need | Check | Notes |
|---|---|---|
| Node 22+ (22.5 for `node:sqlite`) | `node --version` | host currently runs 26.7.0; container runs 22 |
| npm | `npm ci` exits 0 | EBADENGINE warnings on the host are expected and harmless |
| Docker + Compose v2 | `docker compose version` | live daemon required for step 6 |
| `content/profile.json` | `ls content/profile.json` | **blocks the build** until OQ-1 is answered; the build errors with the file name if missing |
| SMTP settings | `grep SMTP_ .env` | optional: absent ⇒ contact disabled (proves F11 AC3); a sink proves delivery (OQ-2) |

## Setup once

```bash
cp .env.example .env          # fill SMTP_* only if a real send is being tested
# .env is gitignored; never commit it
npm ci
```

For an automated delivery test without credentials, start the bundled sink (used by `scripts/test-contact-api.mjs` automatically; shown here for manual runs):

```bash
node scripts/smtp-sink.mjs --port 2525
# prints the received envelope to stdout and appends to .evidence/smtp-sink.jsonl
```

## The validation commands (exact order, from the worktree root)

These are the commands `.ainative/project.yaml` must carry — the tester runs exactly this list.

| # | Command | Proves | Expected |
|---|---|---|---|
| 1 | `npm ci` | reproducible install | exit 0 |
| 2 | `npm run build` | CV generation + contrast check + Astro build + CV check + static-output check | exit 0; prints `cv.pdf ok`, `contrast ok`, route table |
| 3 | `npm test` | unit tests (validation, rate limit, contrast math, CV heading order) | all pass, `# fail 0` |
| 4 | `node scripts/test-contact-api.mjs` | F6 AC1–AC5 end to end against the built server and the SMTP sink | `sent=1 stored=1 invalid_stored=0 rate_limited=6th failed_row=1` |
| 5 | `node scripts/lighthouse-check.mjs` | F12 AC3 + LCP NFR | `performance=… accessibility=100 lcp_ms=… (gate: ≥95, =100, <2000)` |
| 6 | `node scripts/verify-container.mjs` | F11 AC1–AC4 + `/healthz` + FR-026 disabled mode | `compose=up healthz=200 disabled=503 rows_before=1 rows_after_rebuild=1` |

Every script exits non-zero on failure and prints the failed assertion first. Evidence (Lighthouse JSON, sink log, compose logs) goes to `.evidence/`, which is gitignored.

**Deployment note:** `security.allowedDomains` in `astro.config.mjs` lists `localhost` and `127.0.0.1` only, for local dev, preview, and the container checks. A production hostname must be added to that list before deploy; without it, Astro's origin check rejects the native form's same-origin POST with `403`.

## What each step does, in words

1. **Build** turns `content/profile.json` into the home page, the contact page, and `cv.pdf`; it refuses to proceed if a required profile field is missing or if the headline/authorization/availability strings differ from the approved ones.
2. **Unit tests** exercise the validation rules, the 5-per-hour limiter, the WCAG contrast math, and the CV heading-order check without touching the network.
3. **Contact integration** boots the built server with a temporary `DATA_DIR` and an SMTP sink, then submits: one valid message, a malformed email, an empty message, a 5,001-character message, and a sixth message from one IP. It asserts exact status codes (`200`, `400`, `400`, `400`, `429`), the number of stored rows (1), and that the sink received one message addressed to `emad.poursina.work@gmail.com`. A second run points SMTP at a closed port and asserts `502` plus one row with `delivery_status='failed'`.
4. **Lighthouse** starts the preview server, audits `/` on the mobile profile with the pinned Lighthouse version, and fails below 95 Performance, 100 Accessibility, or 2,000 ms LCP.
5. **Container** builds the image, starts compose with a generated `.env` (sink on `host.docker.internal`), reads `/healthz`, sends one message, rebuilds the image, restarts, and confirms the message still exists; then starts once without SMTP settings and confirms the `503` response naming the direct email and the warning line in the logs; finally `docker compose down -v`.

## Manual checks that stay human

| Check | How | Owner-visible outcome |
|---|---|---|
| Keyboard focus | Tab through `/` and `/contact` | visible focus ring on every link, button, input, textarea |
| JavaScript disabled | load `/` and `/contact` with JS off | all content readable; form still submits and returns a readable outcome page |
| Live Gmail send (OQ-2) | fill `.env` with a real Gmail app password, submit one message, check the inbox | one email at `emad.poursina.work@gmail.com`; row `delivery_status='sent'` |
| Content fence (FR-005/FR-014) | read the home copy and the CV against `master-profile.md` | no claim that is not in the profile |

## Failure playbook

| Symptom | Likely cause | Action |
|---|---|---|
| `content/profile.json` missing or invalid | OQ-1 unanswered | supply the file; do not stub it |
| `npm run build` fails on contrast | a token pair below 4.5:1 | fix the token pair named in the error |
| `npm run build` fails on the CV check | heading order, image, or a wide gap | fix the generator section named in the error |
| Lighthouse cannot find Chrome | browser not installed and no network | run `npx --yes playwright@1.65.0 install chromium` with `PLAYWRIGHT_BROWSERS_PATH` set, then retry |
| Lighthouse Performance below 95 | host load or a regression | re-run three times, report the median; investigate a real regression before waiving |
| compose fails without `.env` | compose validates `env_file` | `verify-container.mjs` writes one from `.env.example`; a manual `docker compose up` also needs it |


## Manual checks recorded during Phase 1 build

- **Date:** 2026-11-08
- **Build under test:** `dist/server/entry.mjs` produced by `npm run build`, served at `http://127.0.0.1:4399`; browser Chrome for Testing 158.0.8127.18 (Playwright chromium-headless-shell build 1254), driven by Playwright 1.65.0. Raw observations: `.evidence/logs/build2-manual-check.json`.

### T039 — keyboard tab-through (`/` and `/contact`)

| Page | Focusable elements in DOM order | First Tab lands on | Focus indicator | Tab order |
|---|---|---|---|---|
| `/` | 10: skip link, site title, header CV, header Contact, Case Studies, CV, Contact, email link, footer Home, footer Contact | `a.skip-link[href="#main"]` ("Skip to main content") | `:focus-visible` true on all 10; computed `outline: 3px solid rgb(37, 99, 235)` | Tab sequence matched document order 1:1, then wrapped to browser chrome after the last footer link |
| `/contact` | 12: skip link, site title, header CV, header Contact, name, email, message, Send message, email link, email link, footer Home, footer Contact | `a.skip-link[href="#main"]` | `:focus-visible` true on all 12; same 3px solid blue outline | Tab sequence matched document order 1:1, then wrapped after the last footer link |

**Result: PASS.** The skip link receives focus first on both pages, every link, input, textarea and button shows the visible focus ring, and no focus trap or out-of-order stop was found. The `/case-studies` link returns `404` by design in Phase 1 (spec.md open question: the canonical destination ships in Phase 2).

### T040 — JavaScript-disabled read (`/`)

- `/` loaded in a Chromium context with `javaScriptEnabled: false` (also cross-checked with `curl` of the served HTML): `200`; title, `h1`, header/footer navigation, About/roles/countries sections and the `/cv.pdf` link are all present and readable; `document.querySelectorAll('script').length` is `0` and the served HTML contains no `<script>` tag.
- Navigation without JavaScript: clicking the header `Contact` link performed a normal server navigation to `http://127.0.0.1:4399/contact` (`200`), no client-side routing involved.
- `/contact` without JavaScript: `200`; `h1` and copy present; the form is a native `POST /api/contact` with `application/x-www-form-urlencoded` encoding and the expected `name`, `email`, `message` fields plus the submit button; zero `<script>` tags. The urlencoded same-origin submit is asserted end to end by `node scripts/test-contact-api.mjs` (see validation command 4).

**Result: PASS.** The home page is fully readable and navigable with JavaScript disabled.

### Lighthouse/LCP gate (T044-lh)

`node scripts/lighthouse-check.mjs` ran three mobile audits against the built server with Chrome for Testing 158.0.8127.18 (chromium-headless-shell 1254) and Lighthouse 11.7.1: run 1 `performance=100 accessibility=100 lcp_ms=764`, run 2 `100/100/756`, run 3 `100/100/757`; median `performance=100 accessibility=100 lcp_ms=757` → `lighthouse gate ok` (exit 0). Raw reports: `.evidence/lighthouse-run{1,2,3}.json`; console record: `.evidence/logs/build2-lighthouse-gate-after-fix.log`.

These entries are recordings of verification checks executed during the Phase 1 build card, not new project requirements.

