# Research: Phase 2 — Case Studies, About, and Agent-Readable Layer

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md)

Phase 0 decisions for the plan. Each decision records what was chosen, why, and what was rejected. Evidence marked **measured** was produced in this worktree or read from the pinned sources; nothing here is assumed where a check was possible.

## D1 — Case studies are prerendered; the draft falls through to the 404 route

**Decision**: `src/pages/case-studies/[slug].astro` sets `export const prerender = true` and returns `getStaticPaths()` entries for **published** studies only. A request for a draft slug (`/case-studies/voicedash`) matches no generated route, so the Node adapter serves the prerendered `404.astro` with HTTP status 404. Flipping the study's `status` to `published` and rebuilding emits the page, index entry, sitemap entry and agent-output entries with no code change.

**Rationale**: Astro documents that in static output a dynamic route's pages exist only for the objects returned by `getStaticPaths()`, while unmatched paths fall to the custom 404 page. Keeping the page prerendered preserves the Phase 1 performance model (no client JS, no per-request render) and keeps the accessibility/LCP gates meaningful. It also satisfies the "real route that returns 404" requirement without hardcoding a slug: the route pattern is `/case-studies/[slug]`, and the draft is excluded by data.

**Alternatives considered**:
- *On-demand dynamic page with `Astro.response.status = 404` for drafts.* Rejected as the default: it makes every case-study page SSR, losing prerendering for published studies and adding a runtime dependency for static content. Kept as the fallback if the adapter ever returns 200 for the generated 404 (the build test asserts the status, so this would fail loudly, not silently).
- *A hardcoded `voicedash.astro` that returns 404.* Rejected: violates the parent's "draft status is data, not a hardcoded 404" decision and would need code surgery to publish.
- *Filter drafts inside a single catch-all SSR route.* Rejected for the same prerender reason.

**Evidence**: Astro routing reference (dynamic routes require `getStaticPaths()` in static mode; SSR routes serve any match) and endpoints reference (extension-bearing files such as `sitemap.xml.ts` produce `/sitemap.xml`), fetched 2026-11-08. The new route test asserts `GET /case-studies/voicedash` is exactly 404, so the fallback is only taken if the default is proven wrong.

## D2 — JSON Resume schema is pinned to v1.0.0 and vendored; validation uses a draft-04 validator

**Decision**: Vendor the official schema at `schemas/jsonresume-v1.0.0.json` from `https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json`. Pinned facts: **14,945 bytes**, **sha256 `ff6e39e79cfe6dedddf7c1e313ddb4da346bde8b055a884d7f6d849965dc27a6`**, `$schema: http://json-schema.org/draft-04/schema#`, top-level `additionalProperties: false`. Validate with dev-only `ajv@8` plus `ajv-draft-04@1` in `scripts/check-agent-output.mjs`.

**Rationale**: The PRD requires conformance, not resemblance (parent clarify note). The schema is draft-04, which Ajv 8 does not support without the `ajv-draft-04` companion; that companion is the maintained way to validate a draft-04 document with current Ajv. Vendoring removes network access from builds and makes the check reproducible; the sha256 makes tampering visible. `additionalProperties: false` at the top level is the reason `/api/profile` (not `resume.json`) is the surface that carries `last_updated` — a top-level `last_updated` in `resume.json` would fail its own schema. `meta.version` inside the schema's allowed `meta` object carries the resume format version.

**Alternatives considered**:
- *`ajv@6` (native draft-04).* Rejected: end-of-life major; adding an EOL validator to a new check is worse than one maintained companion package.
- *Hand-rolled structural validator.* Rejected: it would only check the fields this project emits, so it cannot honestly claim "conforms to the JSON Resume schema".
- *Fetching the schema at test time.* Rejected: the validation suite must run offline and deterministically; a remote fetch also makes the pinned hash meaningless.
- *`resume-schema` npm package.* Rejected: it bundles its own validator and version drift; vendoring the exact document plus a pinned validator is more explicit.

**Scope note**: JSON Resume v1.0.0 has no `required` arrays, so conformance alone does not prove the content is present. The check therefore does both: schema validation **and** an exact deep-equal against the generator's output plus field-presence assertions (name, label, email, summary, profiles, work, skills, languages, education, projects).

## D3 — Content lives in two committed JSON sources: profile and case studies

**Decision**: Extend `content/profile.json` with `skills[].category`, optional `experience[].context`, and a top-level `lastUpdated` date. Add `content/case-studies.json` with a `studies[]` array. Both are validated by shared lib code; no Markdown/frontmatter content type is introduced.

**Rationale**: The profile is already the single source for the home page, CV, and (now) About and the agent outputs; adding fields is backwards-compatible and keeps the CV generator green. Case studies have a different lifecycle (draft/published, private/public, ordered list) and different facts; putting them in a sibling file keeps the profile schema honest and makes "publish a draft" a one-field edit. Both live under `content/`, so "single source of truth" is satisfied by one content directory with two typed documents, not by duplicated facts.

**Alternatives considered**:
- *Everything in `content/profile.json`.* Rejected: mixes a person profile with a publishable-content lifecycle; the profile validator would grow draft/visibility rules that the CV does not need.
- *One Markdown file per study with frontmatter.* Rejected: no typed validation without another parser, and the draft/404 rule would depend on file presence rather than data.
- *Hardcoded page copy in `.astro` files.* Rejected: violates the single-source requirement and makes cross-output consistency untestable.

## D4 — Skill categories are exactly the seven groups in the approved matrix (61/61 mapped, measured)

**Decision**: Use the seven `###` groups of `master-profile.md` Part B §1, in source order: **Backend (16), Databases (5), Frontend (5), DevOps & Infrastructure (17), Testing (3), Other Technical Skills (9), Agentic Coding & AI Tooling (6)**. Store the category on every skill. Levels are stored exactly as recorded; the single mapping is source `Beginner` → the project enum `Beginner / Learning` (established in Phase 1). `Beginner / Learning` displays as **Learning**; `knowsAbout` uses only `Intermediate`, `Advanced`, `Expert`.

**Rationale**: The card forbids inventing categories. A scratch parser read the approved matrix and compared it with `content/profile.json`: **61 master rows, 61 profile skills, 7 categories, 0 unmapped skills, 0 level mismatches**. That result is the authority for the category field; no human re-typing is needed.

**Alternatives considered**: deriving categories from skill names heuristically (rejected: invents groupings); leaving skills flat and grouping only in the page template (rejected: the category would then be code, not content, and could not be tested against the source).

## D5 — One derivation module feeds every agent-readable output

**Decision**: Add `src/lib/agent-output.mjs` with pure functions: `buildResume(profile, studies)`, `buildProfileApi(profile, studies)`, `buildLlmsTxt(profile, studies)`, `buildPersonJsonLd(profile)`, `buildSitemapEntries(...)`. Pages and endpoints call them; `scripts/check-agent-output.mjs` calls the same functions to compare generated files with expected output. `/api/profile` imports `content/profile.json` and `content/case-studies.json` at module scope (Vite inlines them into the server bundle) and calls `validateProfile`/`validateCaseStudies` once, so runtime correctness does not depend on reading the filesystem.

**Rationale**: A single implementation makes cross-output consistency structural rather than aspirational. The Dockerfile already copies `content/` into the runtime image, but import-time bundling makes the endpoint independent of working directory and file presence. `last_updated` comes from `profile.lastUpdated`, so a rebuild without content changes produces byte-identical output.

**Alternatives considered**: separate builders per endpoint (rejected: drift is exactly what F7 AC3 tests for); generating `resume.json` and `llms.txt` only at runtime (rejected: they should be static files with correct content types and no server cost).

## D6 — Person JSON-LD is injected by the shared layout; the static-output check learns the difference between data and executable script

**Decision**: `BaseLayout.astro` renders exactly one `<script type="application/ld+json">` block built by `buildPersonJsonLd(profile)`, with `<` escaped as `\u003c` to keep the JSON from closing the element. `scripts/check-static-output.mjs` is amended: `<script src=…>` and any `<script>` without `type="application/ld+json"` still fail; exactly one JSON-LD block is required per HTML page; its parsed object must equal the expected Person object. The check's HTML walk becomes recursive so nested pages (`case-studies/rousta-tv/index.html`) are covered.

**Rationale**: Every rendered page means every page that uses `BaseLayout` — `/`, `/about`, `/case-studies`, study details, `/contact`, and `/404.html`. Injecting at the layout is the only way to guarantee it once. The current Phase 1 check rejects *any* `<script>` tag (INV-2), so adding JSON-LD without amending it would break the build; the amendment keeps the no-executable-JS guarantee while allowing a data block. The current check also only scans top-level `.html` files for the single-`<h1>` rule, which would miss the new nested pages; the recursive walk closes that gap.

**Alternatives considered**: putting JSON-LD only on selected pages (rejected: PRD says every rendered page); injecting per page (rejected: duplication and easy to forget).

## D7 — Absolute URLs come from one configurable site URL, defaulting to localhost

**Decision**: `src/lib/site.mjs` exports `siteUrl()` = `process.env.SITE_URL` (trimmed, no trailing slash) or `http://localhost:4321`. `llms.txt` and `sitemap.xml` use it for absolute URLs. `.env.example` documents `SITE_URL=` with an empty value. No Astro `site` config is added.

**Rationale**: Sitemaps require absolute URLs; the site has no domain until deployment (PRD F18 deferred). A single setting changes every absolute URL, and the local default keeps the build deterministic and testable. The check asserts paths and the absence of drafts, not the host, so the default does not weaken the test.

**Alternatives considered**: relative URLs in the sitemap (rejected: invalid for sitemap consumers); hardcoding a domain (rejected: no domain exists); `Astro.site` (rejected: adds a second configuration surface for the same value).

## D8 — Validation command list grows from six to eight commands

**Decision**: `.ainative/project.yaml` must end up with, in this order:

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

**Rationale**: The four new check families in the parent decision split cleanly into a build-output check (JSON Resume conformance, JSON-LD, `llms.txt`, sitemap, draft exclusion in generated files) and a live-server check (draft 404, `/api/profile`, content types, About and case-study HTML, Phase 1 route regression). Keeping them separate makes a failure point at the right layer. Both run offline and from the worktree root. `npm run build` keeps its Phase 1 pre/post checks; the new build-output check is explicit in the list rather than hidden in `postbuild`, so the tester sees it run.

**Alternatives considered**: one mega-script (rejected: a static-content failure and a server failure would be indistinguishable); folding into `npm test` (rejected: `npm test` must stay unit-only and fast); folding into `postbuild` (rejected: the acceptance check should be visible in the validation list).

## D9 — Lighthouse audits `/`, `/about`, and one case-study detail page

**Decision**: Extend `scripts/lighthouse-check.mjs` from one page to three: `/`, `/about`, `/case-studies/rousta-tv`. Same pinned versions and mobile profile, same gates (Performance ≥ 95, Accessibility 100, LCP < 2000 ms), three runs per page with the median reported.

**Rationale**: The parent's accessibility/performance baseline applies to every new page, and these two are the representative new templates (About and a case-study detail). Auditing every page would add no new template. The Phase 1 toolchain (Playwright Chromium + `lighthouse@11.7.1`) is already proven and pinned in that script.

**Alternatives considered**: only `/` (rejected: does not prove the new pages); every page including `/case-studies` (rejected: the index uses the same layout and card pattern as the detail page's list; runtime cost without new coverage).

## D10 — About presentation rules are data-driven, not copy-driven

**Decision**: A shared `formatMonth()`/`formatRange()` helper renders `YYYY-MM` as `Mon YYYY` and `present` as `Present`. `displayLevel('Beginner / Learning')` returns `Learning`. Roles with `context: "team"` render a "Team context" label and a one-line statement that the work was within a team; the About page has **no** headline or strengths list at all, so the "Learning skills never appear in a strengths list" rule is satisfied by construction and asserted by a test that no Learning skill name appears in the page's header/summary block.

**Rationale**: F3 AC3 and AC4 are presentation rules over recorded data. Keeping them in shared helpers makes them unit-testable and prevents the page from hand-writing dates or levels. Villion is the only role marked team context by the approved profile; the flag is optional so existing roles are unchanged.

**Alternatives considered**: hardcoding date strings in the template (rejected: drift and duplication); a free-text "strengths" section (rejected: would create exactly the place Learning skills must not appear).

## D11 — Container and static-output impact

**Decision**: No Dockerfile change is required for the new pages or endpoints: prerendered pages and `llms.txt`/`resume.json`/`sitemap.xml` land in `dist/client`, `/api/profile` is part of the server bundle, and `content/` is already copied into the runtime image. `scripts/verify-container.mjs` gains probes for `/about`, `/case-studies`, `/llms.txt`, `/resume.json`, `/api/profile`, and the VoiceDash 404, after its existing health check.

**Rationale**: The Phase 1 image already serves `dist/` and copies `content/`; the new surfaces are build output plus one bundled route. Probing them inside the container is the only way to prove F11 still holds for the new pages.

**Alternatives considered**: rebuilding the image with a new stage (rejected: no new dependency at runtime); skipping container probes (rejected: parent requires the container check to stay green and cover the extraction).

## Measured environment notes

- Node v26.7.0 / npm 12.0.2 on the host; the container target remains Node 22 (`package.json` engines `>=22 <23`). `npm ci` prints EBADENGINE warnings and exits 0 (Phase 1 record).
- This worktree has no `node_modules`; `npm ci` is the first validation command and is required before any build/check run.
- The Phase 1 Lighthouse script bootstraps its own Playwright Chromium; no system Chrome is needed.
- Docker 26.1.5 + Compose v2.29.7 with a live daemon; `verify-container.mjs` already handles the containerized-host proxy path.
- The skill-category cross-check (D4) was run in this worktree on 2026-11-08 with a scratch script and reported 61/61 mapped, 0 mismatches.
