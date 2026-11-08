# Tasks: Phase 2 — Case Studies, About, and Agent-Readable Layer

**Input**: Design documents from `specs/002-case-studies-about-agent-layer/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: test tasks are included because the PRD's acceptance criteria and the parent card require runnable proof for every check.

**Organization**: tasks are grouped by user story (US1 = F2 case studies, US2 = F3 About, US3 = F7 agent-readable layer). Every task names the file path(s) it touches and ends with a `proves:` command that must be run from the worktree root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1, US2, US3 for story phases; no label in Setup, Foundational, Polish
- Every task line contains at least one exact file path and a `proves:` command

## Path Conventions

Single Astro project at the repository root: `src/`, `scripts/`, `tests/`, `content/`, `schemas/` — as captured in plan.md.

---

## Phase 1: Setup (Shared content and libraries)

**Purpose**: the two content documents, the pinned schema, and the pure libraries every story uses.

- [x] T001 Extend `content/profile.json` with `skills[].category` on all 61 skills using the exact assignment in `specs/002-case-studies-about-agent-layer/data-model.md` § Skill categories, top-level `"lastUpdated": "2026-11-08"`, and `"context": "team"` on the Villion experience entry only; change no existing value — proves: `node scripts/check-profile.mjs` (after T008)
- [x] T002 Create `content/case-studies.json` with the three records exactly as specified in `specs/002-case-studies-about-agent-layer/data-model.md` § Approved records (Rousta TV published/public, NamehAmal published/private with `publicLink: null`, VoiceDash draft with no narrative fields); do not add facts beyond that table — proves: `node scripts/check-profile.mjs` (after T008)
- [x] T003 [P] Vendor the pinned schema at `schemas/jsonresume-v1.0.0.json` from `https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json` and add dev-only `ajv` and `ajv-draft-04` to `package.json`/`package-lock.json` — proves: `sha256sum schemas/jsonresume-v1.0.0.json` prints `ff6e39e79cfe6dedddf7c1e313ddb4da346bde8b055a884d7f6d849965dc27a6` and `npm ci` exits 0
- [x] T004 [P] Extend `src/lib/profile.mjs` to require a valid `skills[].category` (seven-name enum), a `lastUpdated` matching `^\d{4}-\d{2}-\d{2}$`, and `experience[].context` only `"team"` when present; update `tests/profile.test.mjs` with a missing-category, bad-category, bad-date, and bad-context case — proves: `node --test tests/profile.test.mjs`
- [x] T005 [P] Add `src/lib/case-studies.mjs` (`validateCaseStudies`, `publishedStudies`, `findStudy`) implementing every rule in `data-model.md` § Entity: case study, plus `tests/case-studies.test.mjs` covering duplicate slug, draft-with-narrative rejection, published-missing-field rejection, public-without-https rejection, private-with-link rejection, and the published filter — proves: `node --test tests/case-studies.test.mjs`
- [x] T006 [P] Add `src/lib/skills.mjs` (`SKILL_CATEGORY_ORDER`, `displayLevel`, `isAtLeastIntermediate`, `knowsAbout`) and `src/lib/dates.mjs` (`formatMonth`, `formatRange`), plus `tests/skills.test.mjs` asserting the seven categories in source order, all 61 skills assigned exactly once, `Beginner / Learning` → `Learning`, and `knowsAbout` excludes both `Beginner / Learning` and any `Beginner` — proves: `node --test tests/skills.test.mjs`
- [x] T007 [P] Add `src/lib/site.mjs` (site URL resolution from `SITE_URL`, default `http://localhost:4321`, trailing slash trimmed; public page registry) and `src/lib/agent-output.mjs` (`buildResume`, `buildProfileApi`, `buildLlmsTxt`, `buildPersonJsonLd`, `buildSitemap`), plus `tests/agent-output.test.mjs` asserting the mapping table in `contracts/agent-outputs.md` (no skill levels in resume, no empty URLs, `present` end dates omitted, degree split, year split, draft absent everywhere, api = resume + levels + `last_updated`) — proves: `node --test tests/agent-output.test.mjs`
- [x] T008 Extend `scripts/check-profile.mjs` to validate both `content/profile.json` and `content/case-studies.json` and to name the file, study slug, and field on failure; add `node scripts/check-profile.mjs` to the `prebuild` script in `package.json` before `build-cv.mjs` so invalid content fails the build — proves: `node scripts/check-profile.mjs && npm run build`

**Checkpoint**: content and pure libraries validated by `node scripts/check-profile.mjs` and `npm test`.

---

## Phase 2: Foundational (Blocking prerequisites)

**Purpose**: the layout change that puts JSON-LD on every page, the Phase 1 check that must learn to allow it, and the navigation entry.

- [x] T009 Inject exactly one Person JSON-LD block in `src/layouts/BaseLayout.astro` using `buildPersonJsonLd(loadProfile())`, serialized with `<` escaped as `\u003c`, and amend `scripts/check-static-output.mjs` so `<script src=…>` and any non-`application/ld+json` `<script>` still fail while exactly one JSON-LD block per page is required; make its HTML walk recursive — proves: `npm run build` (Phase 1 pages build and pass the amended static-output check)
- [x] T010 [P] Add About and Case Studies links to `src/components/Header.astro` (nav order: About, Case Studies, CV, Contact), leaving no draft link anywhere — proves: `npm run build` (nav markup present in the built pages)

**Checkpoint**: `npm run build` and `npm test` green with the existing Phase 1 routes plus JSON-LD.

---

## Phase 3: User Story 1 — Hiring manager reads the case studies (Priority: P1) 🎯 MVP

**Goal**: the home page's Case Studies link resolves to an index of published studies and two detail pages whose sections are in the required order; VoiceDash is a data-driven 404.

**Independent Test**: build the site, then `GET /case-studies`, `/case-studies/rousta-tv`, `/case-studies/namehamal`, `/case-studies/voicedash`; assert index contents, the five `<h2>` headings in order on each detail page, and exactly 404 for the draft.

- [x] T011 [P] [US1] Create `src/components/CaseStudyCard.astro` (title, problem, stack list, link; existing colour tokens only, no client JS) — proves: `npm run build`
- [x] T012 [US1] Create `src/pages/case-studies/index.astro` rendering `publishedStudies(...)` through `CaseStudyCard`, with the empty state "No case studies are published yet." — proves: `npm run build` (page emitted at `dist/client/case-studies/index.html`)
- [x] T013 [US1] Create `src/pages/case-studies/[slug].astro` with `prerender = true` and `getStaticPaths()` over published studies only; render `<h1>` then `<h2>` sections exactly `Problem`, `My Contribution`, `Outcome`, `Stack`, `Public Link`; public studies link their URL with `rel="noopener"`, private studies render "Private personal project — no public link." with no anchor — proves: `npm run build` (both published pages emitted; no `dist/client/case-studies/voicedash` directory)
- [x] T014 [US1] Create `src/pages/sitemap.xml.ts` with `prerender = true`, emitting the fixed URL order from `contracts/agent-outputs.md` § 5 with absolute URLs from `src/lib/site.mjs` — proves: `npm run build` and `node scripts/check-static-output.mjs`
- [x] T015 [US1] Extend `scripts/check-static-output.mjs` with the US1 assertions: the index and both published detail pages exist; the five `<h2>` texts appear in the required order; `dist/client/case-studies/voicedash/` is absent; `dist/client/sitemap.xml` lists exactly the public pages plus published study URLs and contains no draft slug — proves: `npm run build`

**Checkpoint**: `npm run build` green; US1 independently testable from static output.

---

## Phase 4: User Story 2 — Recruiter reads the About page (Priority: P1)

**Goal**: `/about` renders the summary, dated experience timeline, all skills grouped in seven categories with honest levels, education, languages, and team-context wording.

**Independent Test**: `GET /about` and assert summary, every role with dates, seven category headings, all 61 skill names, the string `Learning`, education, languages, and `Team context` for Villion.

- [x] T016 [US2] Create `src/pages/about.astro` with the summary first and the experience timeline second (role, company, `formatRange` dates, points); label roles with `context: "team"` as "Team context" with a sentence that the work was within a team — proves: `npm run build`
- [x] T017 [P] [US2] Create `src/components/SkillGroup.astro` and render the skills section in `about.astro` in `SKILL_CATEGORY_ORDER`, each skill with `displayLevel` (so `Beginner / Learning` reads "Learning"); include no headline or strengths list — proves: `npm run build`
- [x] T018 [US2] Add education and languages sections to `src/pages/about.astro`, then extend `scripts/check-static-output.mjs` with the About assertions: all seven category headings in order, all 61 skill names present, `Learning` present, every education and language entry present, `Team context` present, and no `Beginner / Learning` skill name inside the page's summary block — proves: `npm run build`

**Checkpoint**: `npm run build` green; US1 and US2 both readable without JavaScript.

---

## Phase 5: User Story 3 — AI screening agent reads the profile (Priority: P1)

**Goal**: `/llms.txt`, `/resume.json`, `/api/profile`, and Person JSON-LD carry the same approved facts, exclude the draft, and validate against the pinned JSON Resume schema.

**Independent Test**: `node scripts/check-agent-output.mjs` and `node scripts/test-public-routes.mjs`.

- [x] T019 [P] [US3] Create `src/pages/llms.txt.ts` with `prerender = true` returning `text/plain; charset=utf-8` from `buildLlmsTxt(...)` — proves: `npm run build` and `node scripts/check-agent-output.mjs` (after T021)
- [x] T020 [P] [US3] Create `src/pages/resume.json.ts` with `prerender = true` returning `application/json; charset=utf-8` from `buildResume(...)` — proves: `npm run build` and `node scripts/check-agent-output.mjs` (after T021)
- [x] T021 [P] [US3] Create `src/pages/api/profile.ts` with `prerender = false`, importing both content JSON documents at module scope, validating once, returning `buildProfileApi(...)` with `application/json; charset=utf-8` and `Cache-Control: public, max-age=300` — proves: `node scripts/test-public-routes.mjs` (after T022)
- [x] T022 [US3] Create `scripts/check-agent-output.mjs`: validate `dist/client/resume.json` against `schemas/jsonresume-v1.0.0.json` with `ajv-draft-04` and deep-equal it to `buildResume(...)`; deep-equal `dist/client/llms.txt` and `dist/client/sitemap.xml` to their builders; walk every built HTML file, parse its single JSON-LD block and deep-equal it to `buildPersonJsonLd(...)`; assert no draft slug in any of the four outputs; exit non-zero naming the output — proves: `node scripts/check-agent-output.mjs`
- [x] T023 [US3] Create `scripts/test-public-routes.mjs`: boot `dist/server/entry.mjs` on a free port with a temporary `DATA_DIR`; assert every row of `contracts/http-routes.md` § Behavioural contract (including exactly 404 for `/case-studies/voicedash`, `resume.json` ↔ `/api/profile` equality, `last_updated`, content types, and Phase 1 route regression); shut down and clean up — proves: `node scripts/test-public-routes.mjs`

**Checkpoint**: all three stories independently functional; `node scripts/check-agent-output.mjs` and `node scripts/test-public-routes.mjs` green.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: the release gates and the single validation list.

- [x] T024 [P] Extend `scripts/lighthouse-check.mjs` from `/` to `/`, `/about`, `/case-studies/rousta-tv`, same pinned toolchain, three runs each, same gates (Performance ≥ 95, Accessibility 100, LCP < 2000 ms) — proves: `node scripts/lighthouse-check.mjs`
- [x] T025 [P] Extend `scripts/verify-container.mjs` with probes for `/about`, `/case-studies`, `/llms.txt`, `/resume.json`, `/api/profile` (200) and `/case-studies/voicedash` (404), keeping every existing assertion — proves: `node scripts/verify-container.mjs`
- [x] T026 [P] **Build card ownership**: write the exact eight-command list from plan.md § F into `.ainative/project.yaml` and update `README.md`'s route/validation documentation; verify Phase 2's `**Spec:**` line in `PRD.phases.md` is `specs/002-case-studies-about-agent-layer` — proves: `npm ci && npm run build && npm test && node scripts/check-agent-output.mjs && node scripts/test-public-routes.mjs && node scripts/test-contact-api.mjs && node scripts/lighthouse-check.mjs && node scripts/verify-container.mjs`
- [x] T027 [P] Run the quickstart manual checks (`specs/002-case-studies-about-agent-layer/quickstart.md` § Manual checks): JS-disabled reading, keyboard focus on `/about` and a study page, VoiceDash not-found page, JSON/text content types, one JSON-LD block and no executable script in view-source — proves: `node scripts/test-public-routes.mjs` plus the recorded manual checklist (evidence under `specs/002-case-studies-about-agent-layer/evidence/`, gitignored)
- [x] T028 [P] Final consistency sweep: no `voicedash` slug or URL in `dist/client` outputs or agent files; no `Beginner / Learning` in `knowsAbout`; no new colour pair in `src/styles/`; `git status` shows only the intended files and no evidence/secrets — proves: `node scripts/check-agent-output.mjs && npm run build`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T001/T002 depend on T008 for their proof command, T003–T007 are independent.
- **Foundational (Phase 2)**: depends on T001–T008; blocks every story because the layout JSON-LD and the amended static check affect all pages.
- **US1 (Phase 3)**: depends on Foundational; T012→T013→T014→T015 in that order (T015 asserts the pages T012–T014 create).
- **US2 (Phase 4)**: depends on Foundational; T016→T017→T018 (T018 asserts the page built by T016–T017). Can run in parallel with US1.
- **US3 (Phase 5)**: depends on Foundational and on US1's content model (T002/T005); T019–T021 can run in parallel, T022 depends on T019/T020, T023 depends on T021 and on US1's routes.
- **Polish (Phase 6)**: depends on all stories; T026 is the build card's, not the builder's.

### User Story Dependencies

- **US1**: no dependency on US2/US3; delivers the home page's dead-link fix.
- **US2**: no dependency on US1/US3; delivers the CV cross-check.
- **US3**: uses the same content sources as US1/US2 but its endpoints are independently testable.

### Within Each User Story

- Component before page; page before the static-output assertions that inspect it.
- Builders and unit tests before the scripts that consume them.
- The build-output check before the live-server check (the latter assumes a green build).

### Parallel Opportunities

- T003–T007 (schema, profile validator, case-study lib, skills/dates, site/agent-output) are independent files and can run in parallel.
- T009 and T010 are independent.
- US1, US2, and US3 can be developed in parallel once Foundational is done; within US3, T019, T020, and T021 touch different files.
- T024, T025, T026, T027, T028 are independent polish tasks.

---

## Parallel Example: Setup libraries

```bash
# Launch the independent library tasks together:
Task: "Extend src/lib/profile.mjs and tests/profile.test.mjs (T004)"
Task: "Add src/lib/case-studies.mjs and tests/case-studies.test.mjs (T005)"
Task: "Add src/lib/skills.mjs, src/lib/dates.mjs and tests/skills.test.mjs (T006)"
Task: "Add src/lib/site.mjs, src/lib/agent-output.mjs and tests/agent-output.test.mjs (T007)"
```

## Parallel Example: User Story 3 endpoints

```bash
Task: "Create src/pages/llms.txt.ts (T019)"
Task: "Create src/pages/resume.json.ts (T020)"
Task: "Create src/pages/api/profile.ts (T021)"
```

---

## Implementation Strategy

### MVP First

All three stories are P1. Ship US1 first because it fixes a link the home page already renders, then US2 (the human cross-check), then US3 (the machine layer). Each story has its own checkpoint and can be demonstrated alone.

1. Complete Setup → `node scripts/check-profile.mjs` and `npm test` green.
2. Complete Foundational → `npm run build` green.
3. Complete US1 → `npm run build` green, case-study pages present, draft absent.
4. Complete US2 → `npm run build` green, About assertions pass.
5. Complete US3 → both new check scripts green.
6. Complete Polish → the eight validation commands green.

### Incremental Delivery

Each checkpoint is a demonstrable increment: case studies → About → agent layer → release gates. No story requires a later story's code to be useful.

### Parallel Team Strategy

One developer can follow the order above. With two, split US1 and US2 after Foundational and take US3 after the content model lands; with three, US1/US2/US3 in parallel, with T022/T023 last.

---

## Traceability matrix (FR → tasks)

| FR | Tasks | FR | Tasks | FR | Tasks |
|---|---|---|---|---|---|
| FR-100 | T012 | FR-201 | T016 | FR-302 | T021, T023 |
| FR-101 | T013 | FR-202 | T017 | FR-303 | T009, T022 |
| FR-102 | T013, T023 | FR-203 | T017 | FR-304 | T022, T023 |
| FR-103 | T012, T014, T022, T023 | FR-204 | T017, T018 | FR-305 | T007, T022 |
| FR-104 | T013 | FR-205 | T018 | FR-306 | T019, T020 |
| FR-105 | T013 | FR-206 | T018 | FR-307 | T023 |
| FR-106 | T013 | FR-207 | T016, T018 | FR-308 | T001, T007 |
| FR-107 | T002, T005 | FR-208 | T001, T004 | FR-400 | T023 |
| FR-108 | T014, T022 | FR-300 | T019, T022 | FR-401 | T026 |
| FR-109 | T010, T012 | FR-301 | T020, T022 | FR-402 | T009 |
| FR-110 | T002, T013 | | | FR-403 | T017, T026 |
| FR-200 | T016 | | | FR-404 | T024 |
| | | | | FR-405 | T025 |
| | | | | FR-406 | T026, T027 |

Every FR in `spec.md` maps to at least one task; every task maps to a story or to a named cross-cutting concern.

## Notes

- [P] tasks touch different files and have no dependency on an incomplete task.
- T001/T002 are content transcription tasks: the only permitted facts are in `data-model.md`; do not add metrics, clients, dates, or URLs.
- T026 is owned by the build card; this spec card is barred from `.ainative/project.yaml`, `README.md`, `PRD.md`, and `AGENTS.md`.
- Evidence belongs under `specs/002-case-studies-about-agent-layer/evidence/`, which is gitignored.
- Verify each task's `proves:` command before moving on; do not mark a task complete on inspection alone.
