# Tasks: Phase 1 — Public Home, CV Download, and Contact

**Input**: Design documents from `specs/001-phase-1-public-home-cv-contact/`
**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: included deliberately — this phase's acceptance criteria are mostly executable checks (F4 AC3, F6 AC1–AC5, F11, F12 AC3–AC4), so the checks are tasks, not an afterthought.

**Format**: `- [ ] T### [P?] [US?] Description with file path — proves: <command>`

- `[P]` = parallelisable (different files, no dependency on an incomplete task)
- `[US#]` = the user story from spec.md; setup/foundational/polish tasks carry no story label
- Every task lists the files it touches and the command that demonstrates it

## Phase 1: Setup

- [ ] T001 Add runtime dependencies and dev dependencies and the npm script skeleton in `package.json` (`@astrojs/node` from the Astro 5 adapter line, `nodemailer`, `pdfkit`; dev `pdfjs-dist`; scripts `dev`, `build`+`prebuild`+`postbuild`, `preview`, `start`, `test`) — proves: `npm install` exits 0 and `npm ls --depth=0` lists them
- [ ] T002 Configure the Node adapter in `astro.config.mjs` (`output: 'server'`, `adapter: node({ mode: 'standalone' })`) — proves: `npm run build` writes `dist/server/entry.mjs` and `dist/client/`
- [ ] T003 Write `.env.example` with every key from `data-model.md` (empty values, one comment each) and add `.evidence/`, `public/cv.pdf`, `.cache/` to `.gitignore` — proves: `git check-ignore -v .env public/cv.pdf .evidence/x` names each rule
- [ ] T004 Write `.dockerignore` (`.env`, `.env.*`, `node_modules`, `dist`, `.git`, `.evidence`, `specs`, `tests`, `data`, `*.sqlite`) and a `compose.yaml` skeleton (service `site`, `ports: ["8080:4321"]`, `volumes: [app-data:/app/data]`, `env_file: .env`, `extra_hosts: [host.docker.internal:host-gateway]`) — proves: `docker compose config -q` exits 0
- [ ] T005 Implement `src/lib/profile.mjs` (load `content/profile.json`, require every key from data-model.md, enforce the five approved strings and the skill-level enum, throw an error naming the missing/invalid field), a thin CLI `scripts/check-profile.mjs`, and `tests/profile.test.mjs` — proves: `npm test` passes and `node scripts/check-profile.mjs` exits 1 naming the file when it is absent
- [ ] T006 Record the intended shape in `content/profile.json` **only after OQ-1 is answered** — transcription from `master-profile.md`, never invention. **OQ-1 ANSWERED (2026-11-07):** `master-profile.md` (v3.0 combined) and `content/profile.json` are supplied in the worktree; transcribe only from them, do not re-invent — proves: `node scripts/check-profile.mjs` prints `profile ok` and the six sections are populated

## Phase 2: Foundational (blocking prerequisites)

- [ ] T007 Create `src/layouts/BaseLayout.astro` (lang, title/description from the profile, skip link, `<header>/<main>/<footer>` landmarks, meta viewport, single `<h1>` slot) — proves: `npm run build` emits HTML containing one `<h1>` and the skip link
- [ ] T008 Create `src/styles/tokens.css` (light + dark palettes, explicit `--pair-*` declarations naming foreground and background tokens) and `src/styles/global.css` (base typography, single column < 768 px, `:focus-visible` outline, reduced motion) — proves: `npm run build` succeeds and the CSS is present in `dist/client/_astro/`
- [ ] T009 Implement `src/lib/env.mjs` (parse/cache `PORT`, `HOST`, `DATA_DIR`, `CONTACT_TO`, `CONTACT_RATE_LIMIT_PER_HOUR`, `TRUST_PROXY`, `SMTP_*`; expose `smtpStatus()` and `clientKey(request)`; one warning per disabled feature, never log values) with cases added to `tests/validation.test.mjs` — proves: `npm test`
- [ ] T010 Implement `src/lib/db.mjs` (open `${DATA_DIR}/site.sqlite`, `PRAGMA user_version` schema step creating `contact_messages` exactly as data-model.md, `insertMessage`, `markSent`, `markFailed`, `countMessages`, `isHealthy`, lazy open so a broken DB does not crash boot) with `tests/db.test.mjs` on a temp dir — proves: `npm test`
- [ ] T011 Implement `src/lib/rate-limit.mjs` (sliding 3600 s window, configurable limit, `check(key)` returning `{allowed, retryAfterSeconds}`, prune on access) with `tests/rate-limit.test.mjs` — proves: `npm test`
- [ ] T012 Implement `src/lib/validation.mjs` (name 1–200, email regex with `@` and a dotted domain, message 1–5,000 after trim, field-level error map) with `tests/validation.test.mjs` — proves: `npm test`
- [ ] T013 Implement `src/lib/mailer.mjs` (nodemailer transport from env, `status()`, `send({name,email,message})` with 10 s/10 s/30 s timeouts, From/To/Reply-To exactly as `contracts/contact-api.md`) — proves: `npm test` (unit, disabled state) and `node scripts/test-contact-api.mjs` later in T030
- [ ] T014 Implement `src/lib/http.mjs` (JSON vs HTML outcome by `Accept`, `Cache-Control: no-store`, `nosniff`, HTML pages for 200/400/429/502/503/500 per the contract) — proves: `npm test` (pure function over status → body) plus T028
- [ ] T015 Implement `src/lib/contact-service.mjs` (validate → rate limit → enabled → pessimistic insert → send → update → outcome, exact ordering from data-model.md) with `tests/contact-service.test.mjs` using an injected db/mailer — proves: `npm test`
- [ ] T016 Implement `src/pages/healthz.ts` (on demand, `GET` only, `{status,db,smtp,uptimeSeconds}`, 503 `degraded` when the DB cannot open, never secrets) — proves: `node scripts/test-contact-api.mjs` asserts `200` and the JSON keys
- [ ] T017 Create `src/pages/404.astro` with links to `/` and `/contact` — proves: `npm run build` emits `dist/client/404.html`
- [ ] T018 Implement `scripts/check-static-output.mjs` (the six invariants in `contracts/http-routes.md`: prerendered `/` and `/contact`, no client script bundles, `cv.pdf` present and `%PDF-`, no prerendered `healthz`/`api/contact`, native interactive elements only, `:focus-visible` present) — proves: `node scripts/check-static-output.mjs` exits 0 after T020/T028
- [ ] T019 Implement `scripts/smtp-sink.mjs` (dependency-free SMTP server on a chosen port: records envelope recipients, subject, and body to `.evidence/smtp-sink.jsonl`, prints each message) — proves: `node scripts/smtp-sink.mjs --port 2525 --self-test` sends and receives one message, exit 0

## Phase 3: User Story 1 — Recruiter reads the home page (P1) 🎯 MVP

**Goal**: `/` presents headline, bio, target roles, authorization, availability, and one-click links.
**Independent Test**: `node scripts/check-static-output.mjs` plus HTML assertions on `dist/client/index.html`.

- [ ] T020 [US1] Implement `src/pages/index.astro` with `export const prerender = true`: h1 headline, availability, authorization line, target roles, target countries, short bio, and the three primary links (`/case-studies`, `/cv.pdf`, `/contact`) using `src/layouts/BaseLayout.astro` and the profile — proves: `node scripts/check-static-output.mjs` and `grep` assertions in `tests/home-content.test.mjs`
- [ ] T021 [US1] Implement `src/components/Header.astro` and `src/components/Footer.astro` (name as home link, CV and Contact links, contact email in the footer) and wire them into the layout — proves: `node scripts/check-static-output.mjs`
- [ ] T022 [US1] Add `tests/home-content.test.mjs` asserting the exact headline, authorization line, availability string, the three link targets, and that no link has a `target="_blank"` without `rel="noopener"` — proves: `npm test`
- [ ] T023 [US1] Content review pass over `content/profile.json` bio/target roles against `master-profile.md` (FR-005): every claim present in the profile, nothing embellished — proves: reviewer sign-off recorded in the PR body; **blocked by T006/OQ-1**

## Phase 4: User Story 2 — Recruiter downloads and parses the CV (P1)

**Goal**: `/cv.pdf` is a single-column text PDF with the six headings and the authorization line, and the build fails otherwise.
**Independent Test**: `node scripts/check-cv.mjs dist/client/cv.pdf` after `npm run build`.

- [ ] T024 [P] [US2] Implement `scripts/build-cv.mjs` (PDFKit, A4, single column, fixed section order Summary/Experience/Skills/Projects/Education/Languages, authorization line verbatim, no images, no tables) writing `public/cv.pdf` — proves: `node scripts/build-cv.mjs && head -c 5 public/cv.pdf` prints `%PDF-`
- [ ] T025 [US2] Implement `scripts/check-cv.mjs` (byte scan for `/Subtype /Image`; `pdfjs-dist` text extraction; heading order; authorization line; per-baseline horizontal-gap > 24 pt fails naming the line) — proves: `node scripts/check-cv.mjs` exits 0 on the good PDF and exits 1 with a named section on a fixture with a second column
- [ ] T026 [US2] Add `tests/cv-headings.test.mjs` (heading-order and gap logic against synthetic text runs) — proves: `npm test`
- [ ] T027 [US2] Wire `prebuild`/`postbuild` in `package.json` and assert the ordering (`build-cv`, `check-contrast`, `astro build`, `check-cv`, `check-static-output`) — proves: `npm run build` fails when `public/cv.pdf` is corrupted and passes when regenerated

## Phase 5: User Story 3 — Recruiter sends a contact message (P1)

**Goal**: `/contact` + `POST /api/contact` honour every F6 acceptance criterion, including the failure and rate-limit paths.
**Independent Test**: `node scripts/test-contact-api.mjs`.

- [ ] T028 [US3] Implement `src/components/ContactForm.astro` and `src/pages/contact.astro` with `prerender = true`: labelled name/email/message fields, `action="/api/contact" method="post"`, no JavaScript-dependent behaviour (the form posts and the response is a rendered page), and the direct email address always shown as a fallback — no build-time environment value is baked in — proves: `node scripts/check-static-output.mjs` and T030
- [ ] T029 [US3] Implement `src/pages/api/contact.ts` (`POST` only, parse urlencoded/multipart/JSON, delegate to `contact-service.mjs`, render via `http.mjs`, `no-store`) — proves: `node scripts/test-contact-api.mjs`
- [ ] T030 [US3] Implement `scripts/test-contact-api.mjs`, which runs two server instances against the built `dist/server/entry.mjs` with a temp `DATA_DIR`. **Instance A (sink on a random port):** valid send (`200`, one row `sent`, sink recipient `emad.poursina.work@gmail.com`, body and subject per contract), malformed email (`400`, `errors.email`, zero rows), empty message (`400`, zero rows), 5,001 characters (`400`, zero rows), then a sixth POST from the same IP (`429` + `Retry-After`, still one row). **Instance B (SMTP pointed at a closed port):** one valid submission (`502`, one row `failed`, direct email in the body) — proves: `node scripts/test-contact-api.mjs` prints `sent=1 rows=1 invalid=0 rate_limited=429 failed_row=1` and exits 0
- [ ] T031 [US3] Add the no-JavaScript content assertion for `/contact` (form present, labels associated, no script tags) to `scripts/check-static-output.mjs` — proves: `node scripts/check-static-output.mjs`

## Phase 6: User Story 4 — Owner runs the whole site from one command (P2)

**Goal**: one image, compose up, named volume, disabled mode without SMTP, data survives rebuild.
**Independent Test**: `node scripts/verify-container.mjs`.

- [ ] T032 [US4] Implement `Dockerfile` (four stages per plan D10, `USER node`, `HEALTHCHECK` via `scripts/healthcheck.mjs`, `CMD ["node","--experimental-sqlite","dist/server/entry.mjs"]`) and `scripts/healthcheck.mjs` (fetches `/healthz`, exits 0/1 within 5 s) — proves: `docker build -t emad-site:test .` exits 0; the healthcheck itself is exercised by T034
- [ ] T033 [US4] Implement `scripts/db-count.mjs` (prints `contact_messages` count from `DATA_DIR`) and copy it into the runtime image — proves: `docker compose exec -T site node --experimental-sqlite scripts/db-count.mjs` prints a number
- [ ] T034 [US4] Implement `scripts/verify-container.mjs`: writes `.env` from `.env.example` with the sink on `host.docker.internal:<port>`, `docker compose build`, `up -d`, poll `/healthz` ≤60 s, post one message, assert `200` + count 1, `docker compose up -d --build`, assert count still 1, then restart without SMTP and assert the `503` response naming the direct email and the warning line in `docker compose logs`, finish with `down -v` — proves: `node scripts/verify-container.mjs` prints `healthz=200 rows_before=1 rows_after_rebuild=1 disabled=503 warning=present`
- [ ] T035 [US4] Confirm `.dockerignore` keeps `.env`, `node_modules`, `dist`, `.git`, `.evidence` out of the image and add a secret scan assertion to `scripts/verify-container.mjs` (`docker history`/`docker run find` finds no `.env`, no `SMTP_PASS` value) — proves: `node scripts/verify-container.mjs` prints `secrets=none`

## Phase 7: User Story 5 — Accessible, fast page on any device (P2)

**Goal**: prerendered pages, visible focus, Lighthouse ≥95/100, LCP < 2.0 s, contrast build gate.
**Independent Test**: `node scripts/lighthouse-check.mjs` and `node scripts/check-contrast.mjs`.

- [ ] T036 [P] [US5] Implement `src/lib/contrast.mjs` (WCAG relative luminance and ratio) and `scripts/check-contrast.mjs` (parse `src/styles/tokens.css` theme blocks and `--pair-*` declarations; fail below 4.5:1 for every text pair, naming theme + pair; no large-text exception) — proves: `node scripts/check-contrast.mjs` exits 0 on the palette and exits 1 naming a deliberately darkened token in a fixture
- [ ] T037 [US5] Add `tests/contrast.test.mjs` (known-value ratios: black/white 21:1, `#777` on white ≈4.48 fails, `#767676` passes) — proves: `npm test`
- [ ] T038 [US5] Implement `scripts/lighthouse-check.mjs` exactly as research D6 (pinned `playwright@1.65.0` install when missing, glob-resolved headless shell, `lighthouse@11.7.1`, mobile simulate, gate ≥95 / =100 / LCP <2000, three runs with median, server always killed) — proves: `node scripts/lighthouse-check.mjs` prints the three run scores and the gate result; exits 1 when the gate is lowered in a self-test flag
- [ ] T039 [US5] Audit focus and keyboard order on `/` and `/contact`: `:focus-visible` on every interactive element, tab order equals document order, skip link first, no `tabindex > 0` (asserted in `scripts/check-static-output.mjs`) — proves: `node scripts/check-static-output.mjs` plus the manual tab-through recorded in the PR body
- [ ] T040 [US5] Verify the home page reads with JavaScript disabled and record the outcome in `quickstart.md` manual checks — proves: `node scripts/check-static-output.mjs` (no script tags) plus a manual fetch with JS off

## Phase 8: Polish & cross-cutting

- [ ] T041 Replace the bootstrap placeholder in `.ainative/project.yaml` with exactly the six commands in plan.md §F — **owner: build card** (this card must not edit the file) — proves: the file lists exactly those six commands in order and one full run of the list passes
- [ ] T042 Fill `**Spec:** specs/001-phase-1-public-home-cv-contact` in `PRD.phases.md` § Phase 1 — **owner: build card** — proves: `grep '^\*\*Spec:\*\*' PRD.phases.md` on the branch
- [ ] T043 Update `README.md`: stack, `npm run dev`, `.env` setup, the validation command list, and the OQ-1/OQ-2 gates — proves: commands in the README run as written
- [ ] T044 Run the full validation list in order from the worktree root and archive evidence under `.evidence/` (gitignored) — proves: all six commands exit 0; `git status --porcelain` shows no evidence, no `.env`, no `public/cv.pdf`

---

## Dependencies & execution order

### Phase dependencies

- **Setup (T001–T006)**: T001→T002; T005 independent; **T006 is blocked by OQ-1** and blocks every content-bearing task (T020, T023, T024).
- **Foundational (T007–T019)**: depends on Setup; T010/T011/T012 are independent files and can run in parallel; T015 depends on T010/T012/T013/T014; T018 depends on T007 and is completed by T020/T028.
- **US1 (T020–T023)**: needs Foundational + T006.
- **US2 (T024–T027)**: needs T006; T025 needs T024.
- **US3 (T028–T031)**: needs Foundational (T010–T015) and T019; T030 needs T029.
- **US4 (T032–T035)**: needs US3 (the endpoint it exercises) and T018.
- **US5 (T036–T040)**: needs US1 (a page to audit) and T008 (tokens); T038 needs T027 (preview server) and T032 for parity.
- **Polish (T041–T044)**: last; T041/T042 are build-card edits, T044 runs everything.

### User story dependencies

- US1 and US3 are independent of each other; US2 is independent of both (only the profile).
- US4 exercises US3; US5 exercises US1 and US3.
- MVP = Setup + Foundational + US1 + US2 + US3 (the three P1 stories); US4 and US5 are release gates but not demo prerequisites.

### Parallel opportunities

- T010, T011, T012 (three independent `.mjs` modules with their own test files).
- T024, T036, T037 (CV generator, contrast math, contrast tests touch different files).
- T032 and T038 (Dockerfile vs Lighthouse script) once their inputs exist.

---

## Traceability matrix (FR → tasks)

| FR | Tasks | FR | Tasks |
|---|---|---|---|
| FR-001 | T020, T022 | FR-024 | T015, T030 |
| FR-002 | T020, T022 | FR-025 | T011, T030 |
| FR-003 | T006, T020, T022, T023 | FR-026 | T009, T028, T034 |
| FR-004 | T020, T022 | FR-027 | T014, T029, T031 |
| FR-005 | T005, T023 | FR-030 | T032, T034 |
| FR-010 | T024, T025, T027 | FR-031 | T010, T032, T034 |
| FR-011 | T024, T025, T026 | FR-032 | T003, T004, T035 |
| FR-012 | T025, T026, T027 | FR-033 | T009, T034 |
| FR-013 | T024, T025 | FR-034 | T033, T034 |
| FR-014 | T005, T024, T025 | FR-035 | T016, T032 |
| FR-020 | T028, T031 | FR-040 | T018, T020, T028, T040 |
| FR-021 | T013, T030 | FR-041 | T008, T039 |
| FR-022 | T010, T015, T030 | FR-042 | T038 |
| FR-023 | T012, T030 | FR-043 | T036, T037 |
| | | FR-044 | T038 |

## Blockers carried by this task list

- **T006 / T020 / T023 / T024** were gated on **OQ-1** (missing `master-profile.md`). **OQ-1 is answered (2026-11-07):** `master-profile.md` v3.0 combined and the transcribed `content/profile.json` are in the worktree; the headline string was switched to the v3.0 positioning (PRD 1.4). Content tasks may proceed; no placeholder content is permitted, and every claim must be traceable to `master-profile.md`.
- **T030** proves F6 AC1 against a local SMTP sink (OQ-2 default). **OQ-2 deferred by the owner (2026-11-07):** live delivery is skipped for now — the host exposes no SMTP relay, so the owner-signed live send stays a manual check in `quickstart.md`; do not add Gmail credentials.

## Notes

- `[P]` tasks touch different files and have no dependency on an incomplete task.
- Commit only with owner approval (`AGENTS.md`); this task list does not authorise commits.
- Evidence (Lighthouse JSON, sink log, compose logs) lives in `.evidence/` and is never committed.
