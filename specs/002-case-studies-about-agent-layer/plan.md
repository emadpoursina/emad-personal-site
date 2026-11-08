# Implementation Plan: Phase 2 — Case Studies, About, and Agent-Readable Layer

**Branch**: `emad-personal-site/t_49492acb-phase-2-case-studies-about-and-agent-rea` | **Date**: 2026-11-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-case-studies-about-agent-layer/spec.md`; scope authority `PRD.phases.md` § Phase 2; requirements `PRD.md` v1.4 F2/F3/F7 and §8/§9.

## Summary

Add the three surfaces Phase 2 promises, from the content the site already owns: a case-studies index plus two published study pages (VoiceDash stays a data-driven draft that returns 404), an About page that renders the profile's experience, categorised skills, education and languages honestly, and an agent-readable layer — `/llms.txt`, `/resume.json`, `/api/profile`, and a Person JSON-LD block on every rendered page.

The approach is the smallest one that satisfies every acceptance criterion without a new runtime or framework: two committed JSON content documents feed one pure derivation module; case-study pages are prerendered for published studies only, so the draft falls to the existing 404 route; the three agent files are build-time static output (the profile API is the single on-demand route, bundled from the same JSON); and every new fact is checked against the approved content by two new validation commands while the six Phase 1 commands stay green.

## Technical Context

**Language/Version**: Node.js 22 LTS in the container (host 26.7.0); TypeScript inside `.astro` pages/components (Astro's built-in support); plain ESM JavaScript (`.mjs`) for shared content logic, builders, build scripts and tests, so `node --test` and `node scripts/*.mjs` run them without a transform.

**Primary Dependencies**: existing `astro@5.18.2` + `@astrojs/node` (standalone), `nodemailer`, `pdfkit`; no new runtime dependency. Dev-only additions: `ajv@8` + `ajv-draft-04@1` for JSON Resume schema validation (vendored schema, no network at check time).

**Storage**: unchanged — SQLite `contact_messages` via `node:sqlite`. This feature adds no table and no migration.

**Testing**: `node:test` unit suites for content validation and output builders; `scripts/check-agent-output.mjs` for build-output conformance and cross-output equality; `scripts/test-public-routes.mjs` for live HTTP behaviour (draft 404, About, agent endpoints, Phase 1 regression); the existing `test-contact-api.mjs`, `lighthouse-check.mjs` (extended to three pages) and `verify-container.mjs` (extended probes).

**Target Platform**: Linux, single `node:22-bookworm-slim` container, plain HTTP locally.

**Project Type**: web application — static content pages plus one on-demand JSON endpoint.

**Performance Goals**: LCP < 2.0 s on the mobile Lighthouse profile for `/`, `/about`, `/case-studies/rousta-tv`; no client JS; `/api/profile` < 500 ms; `resume.json`/`llms.txt`/`sitemap.xml` served as static files.

**Constraints**: PRD §9 stack only; no Astro major upgrade; secrets only in `.env`; every acceptance check runnable from `.ainative/project.yaml` in order; no evidence or secrets committed; VoiceDash stays draft.

**Scale/Scope**: 3 new HTML routes (+ index), 1 new on-demand endpoint, 3 new static files, 2 content documents, 2 new check scripts; 100 concurrent visitors in year 1; single container.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unratified Spec Kit template: principles are still `[PRINCIPLE_N_NAME]`/`[PRINCIPLE_N_DESCRIPTION]` with no version or ratification date, so it states no normative rule this plan could violate. The plan does not invent one (ratifying a constitution is a separate job). The binding gates used instead:

| Gate | Source | Status |
|---|---|---|
| Stack is PRD §9 only; no framework swap, no runtime change, no Astro major upgrade | parent locked decision 1, `AGENTS.md` | PASS — only dev-only Ajv packages added, justified in Complexity Tracking |
| Routes exactly `/case-studies`, `/case-studies/{rousta-tv,namehamal,voicedash}`, `/about`, `/llms.txt`, `/resume.json`, `/api/profile`, plus `/sitemap.xml` | parent locked decision 2 + 11, PRD §6 | PASS — contracts/http-routes.md |
| Content from `content/profile.json` and the approved case-study facts only; no invented career facts; VoiceDash draft/404 | parent locked decision 3, AGENTS.md | PASS — data-model.md records the exact approved strings; no other fact is stored |
| Skill levels exact; `Beginner / Learning` → "Learning"; `knowsAbout` ≥ Intermediate; categories from the approved matrix only | parent locked decision 4, PRD F3 AC2/AC3, F7 AC4 | PASS — 61/61 mapping measured, 7 categories |
| Single source of truth; no duplicated facts; CV generator stays green | parent locked decision 5 | PASS — one derivation module; profile schema extended additively |
| Draft status is data, not a hardcoded 404; publishing needs no code change | parent locked decision 6 | PASS — status field + `getStaticPaths` filter |
| `.ainative/project.yaml` is the single test source; no placeholders | parent locked decision 7 | PASS — exact 8-command list below; the **build card** writes it |
| Accessibility/performance baseline on every new page | parent locked decision 8, PRD §8/F12 | PASS — same tokens, same checks, Lighthouse extended to the two new templates |
| Secrets/hygiene; no private profile committed | parent locked decision 9, AGENTS.md | PASS — no secret or private file is added; `content/profile.json` stays the approved in-repo copy |
| Phase 2's `**Spec:**` line set to the new feature dir; nothing else in the plan/PRD edited | parent locked decision 10 | PASS — done by this card's specify state (one-line diff) |
| Sitemap criterion addressed explicitly | parent locked decision 11 | PASS — deterministic `/sitemap.xml`, contract in contracts/http-routes.md |
| No evidence or secrets in git | parent card | PASS — `specs/*/evidence*` stays gitignored |

Post-design re-check: unchanged. The two dev-only Ajv packages are recorded in Complexity Tracking, not waived.

## Project Structure

### Documentation (this feature)

```text
specs/002-case-studies-about-agent-layer/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-routes.md
│   └── agent-outputs.md
├── checklists/
│   └── requirements.md
└── tasks.md             # written by /speckit.tasks
```

### Source Code (repository root)

```text
content/
├── profile.json                 # extended: skills[].category, experience[].context, lastUpdated
└── case-studies.json            # new: ordered studies with status/visibility and approved facts

schemas/
└── jsonresume-v1.0.0.json       # new: vendored official schema (sha256 pinned in research D2)

src/
├── pages/
│   ├── about.astro              # new: /about
│   ├── case-studies/
│   │   ├── index.astro          # new: /case-studies
│   │   └── [slug].astro         # new: /case-studies/<published slug> (prerendered via getStaticPaths)
│   ├── llms.txt.ts              # new: /llms.txt (prerendered)
│   ├── resume.json.ts           # new: /resume.json (prerendered)
│   ├── sitemap.xml.ts           # new: /sitemap.xml (prerendered)
│   └── api/
│       └── profile.ts           # new: /api/profile (on demand)
├── layouts/BaseLayout.astro     # changed: injects the Person JSON-LD block
├── components/
│   ├── Header.astro             # changed: About + Case Studies nav entries
│   ├── CaseStudyCard.astro      # new: index card (title, problem, stack, link)
│   └── SkillGroup.astro         # new: one category heading + skill list with levels
├── lib/
│   ├── profile.mjs              # changed: category, lastUpdated, context validation
│   ├── case-studies.mjs         # new: load/validate/filter studies
│   ├── skills.mjs               # new: category order, displayLevel, knowsAbout filter
│   ├── dates.mjs                # new: month/range formatting for the timeline
│   ├── site.mjs                 # new: site URL + public page registry
│   └── agent-output.mjs         # new: buildResume/buildProfileApi/buildLlmsTxt/buildPersonJsonLd/buildSitemap
└── styles/                      # unchanged tokens; no new colour pairs

scripts/
├── check-profile.mjs            # changed: validates both content files
├── check-static-output.mjs      # changed: JSON-LD allowance, recursive HTML walk, new pages
├── check-agent-output.mjs       # new: schema + JSON-LD + llms + sitemap + cross-output equality
├── test-public-routes.mjs       # new: live server checks incl. draft 404 and /api/profile
├── lighthouse-check.mjs         # changed: three pages
└── verify-container.mjs         # changed: new-route probes inside compose

tests/
├── profile.test.mjs             # changed: category/lastUpdated/context rules
├── case-studies.test.mjs        # new
├── skills.test.mjs              # new
├── agent-output.test.mjs        # new
└── (Phase 1 suites unchanged)

package.json                     # dev deps ajv + ajv-draft-04; no script changes required
.env.example                     # documents SITE_URL with an empty value
```

**Structure Decision**: single Astro project at the repository root (unchanged from Phase 1). Pages own rendering; `src/lib/*.mjs` owns every rule a test or build script must also run, which is why shared logic stays plain ESM. The agent-output builders are pure functions of the two content documents, so the pages, the static endpoints, the on-demand API and the checks cannot drift.

## Implementation approach

### A. Content model

- Extend `content/profile.json` additively: `skills[].category` on all 61 skills (the measured assignment in data-model.md), `experience[].context: "team"` on Villion only, and top-level `lastUpdated: "2026-11-08"`. No existing field changes; the CV generator reads the same keys it always did.
- Add `content/case-studies.json` with the three records in data-model.md. Rousta TV and NamehAmal are published; VoiceDash is `status: "draft"` with no narrative.
- Extend `validateProfile` to require a valid category per skill, a valid `lastUpdated` date, and an allowed `context` value when present. Add `src/lib/case-studies.mjs` with `validateCaseStudies`, `publishedStudies`, `findStudy`.

### B. Case-study pages

- `src/pages/case-studies/index.astro`: prerendered; maps `publishedStudies(...)` to `CaseStudyCard` (title, problem, stack, link). Empty state: "No case studies are published yet."
- `src/pages/case-studies/[slug].astro`: `prerender = true`; `getStaticPaths()` returns `publishedStudies(...).map(s => ({ params: { slug: s.slug }, props: { study: s } }))`, which in this phase emits `/case-studies/rousta-tv` and `/case-studies/namehamal`. The template renders `<h1>{title}</h1>` and `<h2>` sections in the fixed order Problem → My Contribution → Outcome → Stack → Public Link. Public studies link their URL with `rel="noopener"`; private studies state "Private personal project — no public link." and render no anchor. A draft slug is never generated, so the request reaches `404.astro` with status 404 (research D1).
- `src/components/CaseStudyCard.astro` and `SkillGroup.astro` use only existing colour tokens; no client JS.

### C. About page

- `src/pages/about.astro`: prerendered; summary (`profile.bio`) first, then the experience timeline (role, company, formatted date range via `dates.mjs`, points), then skills grouped by `SKILL_CATEGORY_ORDER` (each group renders `displayLevel`, so `Beginner / Learning` shows as "Learning"), then education, then languages. Roles with `context: "team"` render a "Team context" label and a sentence that the work was within a team. The page has no headline/strengths list, so Learning skills cannot appear as strengths; a test asserts no Learning skill name appears before the experience section.
- Dates use the recorded month precision (`Mar 2019 – Dec 2023`) and `Present` for ongoing roles; no date is invented or rounded.

### D. Agent-readable layer

- `src/lib/agent-output.mjs` implements the five builders exactly as specified in data-model.md and contracts/agent-outputs.md.
- `src/pages/llms.txt.ts`, `resume.json.ts`, `sitemap.xml.ts`: `prerender = true`, return a `Response` with the declared `Content-Type`; Astro writes `dist/client/llms.txt`, `resume.json`, `sitemap.xml`.
- `src/pages/api/profile.ts`: `prerender = false`; imports both JSON documents at module scope (Vite bundles them into the server build), validates once, returns `buildProfileApi(...)` with `application/json; charset=utf-8` and `Cache-Control: public, max-age=300`.
- `src/layouts/BaseLayout.astro` injects one `<script type="application/ld+json" set:html={jsonLd}>` built by `buildPersonJsonLd(profile)` with `<` escaped. Every page using the layout (including 404) gets it.
- `src/lib/site.mjs` resolves `SITE_URL` (default `http://localhost:4321`, trailing slash trimmed) for absolute URLs in `llms.txt` and the sitemap.

### E. Checks and validation layer

- `scripts/check-static-output.mjs`: allow exactly one `application/ld+json` script per page and continue rejecting `src` scripts and other `<script>` types; walk `dist/client` recursively; assert the new pages exist and `case-studies/voicedash` does not.
- `scripts/check-profile.mjs`: validate profile and case studies, naming file and field, and wire it into `prebuild` in `package.json` (before `build-cv.mjs`) so an invalid content document fails `npm run build` rather than reaching a page.
- `scripts/check-agent-output.mjs`: load content and builders; validate `dist/client/resume.json` with Ajv draft-04 against the vendored schema **and** deep-equal it to `buildResume`; deep-equal `llms.txt` and `sitemap.xml` to their builders; walk every built HTML page, parse its single JSON-LD block and deep-equal it to `buildPersonJsonLd`; assert no draft slug in any of them. Exit non-zero naming the output.
- `scripts/test-public-routes.mjs`: boot `dist/server/entry.mjs` on a free port with a temporary `DATA_DIR`; assert every row of contracts/http-routes.md's behavioural table, including the exact 404 status for the draft and the `resume.json` ↔ `/api/profile` equality; shut the server down and remove the temp dir.
- `scripts/lighthouse-check.mjs`: audit `/`, `/about`, `/case-studies/rousta-tv` with the existing pinned toolchain, three runs each, same gates.
- `scripts/verify-container.mjs`: after its health check, probe `/about`, `/case-studies`, `/llms.txt`, `/resume.json`, `/api/profile` (200) and `/case-studies/voicedash` (404); keep every existing assertion.

### F. Validation commands and ownership

`.ainative/project.yaml` must end up carrying exactly, in order:

```yaml
validation_commands:
  - npm ci
  - npm run build
  - npm test
  - node scripts/check-agent-output.mjs
  - node scripts/test-public-routes.mjs
  - node scripts/test-contact-api.mjs
  - node scripts/lighthouse-check.mjs
  - node scripts/verify-container.mjs
```

Ownership notes: the **build card** owns `.ainative/project.yaml` and `README.md` (this card is barred from both). Phase 2's `**Spec:**` line in `PRD.phases.md` was already set by this card's specify state, per locked decision 10; the build card only verifies it. `package.json` gains the two dev dependencies and one `prebuild` addition (`node scripts/check-profile.mjs`); no npm script otherwise changes because the new checks are invoked by file path from the validation list.

## Complexity Tracking

| Addition | Why needed | Simpler alternative rejected because |
|---|---|---|
| `ajv@8` + `ajv-draft-04@1` (dev-only) | the JSON Resume schema is draft-04 and F7 AC2 requires conformance, not resemblance | `ajv@6` is EOL; a hand-rolled validator cannot honestly claim schema conformance; fetching the schema at test time breaks offline determinism |
| Vendored `schemas/jsonresume-v1.0.0.json` | reproducible, offline validation against the exact pinned document | a remote URL makes builds network-dependent and the pinned hash meaningless |
| Two new check scripts instead of one | separates build-output failures (schema/JSON-LD/static files) from live-server failures (status codes/API equality) | one mega-script makes a failure point at the wrong layer and slows diagnosis |
| `content/case-studies.json` (second content file) | case studies have a draft/publish lifecycle and different facts from the person profile | one mixed file grows profile validation with rules the CV never uses; Markdown frontmatter has no typed validation without another parser |
| `src/lib/site.mjs` site-URL setting | sitemaps and `llms.txt` require absolute URLs and no domain exists yet | relative sitemap URLs are invalid; hardcoding a domain would be a fabricated deployment fact |
| Extended `check-static-output.mjs` | Phase 1 forbids every `<script>`, which would reject the required JSON-LD | dropping the check would allow executable client JS; excluding all scripts would let the JSON-LD requirement silently regress |
