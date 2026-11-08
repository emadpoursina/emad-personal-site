# Feature Specification: Phase 2 — Case Studies, About, and Agent-Readable Layer

**Feature Branch**: `emad-personal-site/t_49492acb-phase-2-case-studies-about-and-agent-rea`

**Created**: 2026-11-08

**Status**: Ready for planning

**Input**: Phase 2 of `PRD.phases.md` (`PRD.md` v1.4): F2 case studies (all), F3 About page (all), F7 agent-readable layer (all).

**Scope fence**: the Ask assistant (F8), the cover letter and generator (F5, F9, F10), the admin panel (F21), V1.1 case studies (F14, F15), analytics, multi-user admin, and deployment are out of scope for this feature. VoiceDash stays a draft and returns 404 throughout.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hiring manager reads the case studies (Priority: P1)

A hiring manager clicks Case Studies on the home page, sees the studies that are cleared for publication, opens Rousta TV and NamehAmal, and on each page reads the problem, what Emad personally contributed, the outcome, the stack, and where the product is public — in that order. VoiceDash is not advertised anywhere and its URL returns 404.

**Why this priority**: Case studies are the evidence a hiring manager uses to judge ownership; the home page already links to the index, so the link is currently dead.

**Independent Test**: Request `/case-studies`, `/case-studies/rousta-tv`, `/case-studies/namehamal`, and `/case-studies/voicedash` from a running site; assert the index lists exactly the published studies, each detail page shows the five sections in order, and the draft returns 404.

**Acceptance Scenarios**:

1. **Given** a visitor opens `/case-studies`, **When** the page renders, **Then** it lists every published study with a link to its page and lists no draft study.
2. **Given** a visitor opens a published study, **When** the page renders, **Then** the sections Problem, My Contribution, Outcome, Stack, and Public Link appear in that order.
3. **Given** a study is a private product, **When** its Public Link section renders, **Then** it states that the product is private with no public link and shows no repository or source link.
4. **Given** the VoiceDash study is in draft, **When** a visitor requests `/case-studies/voicedash`, **Then** the response status is 404.
5. **Given** a draft study exists, **When** navigation, the sitemap, `llms.txt`, `resume.json`, or `/api/profile` is inspected, **Then** the draft's slug and URL appear in none of them.
6. **Given** the owner changes a study's status from draft to published, **When** the site is rebuilt, **Then** its page, index entry, sitemap entry, and agent-readable references appear without any code change.

---

### User Story 2 - Recruiter reads the About page (Priority: P1)

A recruiter opens `/about` to verify the CV: a professional summary, an experience timeline with dates, every skill grouped by category with its honest level, education, and languages. Skills that are still being learned are labelled "Learning" and are never presented as strengths, and team-context work is described as team context rather than personal ownership.

**Why this priority**: The About page is the human cross-check for every claim in the CV and case studies; without it the site cannot substantiate its own facts.

**Independent Test**: Load `/about` with a static HTTP client and assert the summary, every experience entry with dates, all seven skill categories containing every skill with its recorded level, the "Learning" label for `Beginner / Learning` skills, education, languages, and the team-context wording for Villion.

**Acceptance Scenarios**:

1. **Given** a visitor opens `/about`, **When** the page renders, **Then** the professional summary appears before the experience timeline.
2. **Given** the experience timeline, **When** a role is rendered, **Then** its title, company, and start and end dates are shown, with "Present" for a role that has not ended.
3. **Given** the skills section, **When** it renders, **Then** every skill appears under exactly one category, in the recorded category order, with its recorded level.
4. **Given** a skill recorded as `Beginner / Learning`, **When** it renders, **Then** it is labelled "Learning" and does not appear in any headline or strengths list.
5. **Given** the Villion role, **When** it renders, **Then** it is explicitly labelled as team context and not as personal ownership.
6. **Given** the education and languages sections, **When** they render, **Then** each recorded entry is shown with its institution, years, and proficiency.

---

### User Story 3 - AI screening agent reads the profile (Priority: P1)

An AI screening tool fetches `/llms.txt`, `/resume.json`, and `/api/profile`, and reads the same approved facts a human sees, in machine-readable form, with no draft case study and no invented detail. Every rendered page also carries a Person JSON-LD block so a crawler can identify Emad, his title, email, profile links, and the technologies he knows at Intermediate level or above.

**Why this priority**: The PRD's tertiary persona is an AI screening agent; the site's differentiator is that it serves the same truth to humans and machines.

**Independent Test**: Fetch the three endpoints and one HTML page from a running site; validate `resume.json` against the pinned JSON Resume schema, compare its facts with `/api/profile`, assert the required lines in `llms.txt`, parse the JSON-LD block, and assert no draft slug appears in any of them.

**Acceptance Scenarios**:

1. **Given** an agent requests `/llms.txt`, **When** the response returns, **Then** it is plain text listing the headline, target roles, work authorization, availability, published case-study URLs, the CV URL, and the contact URL.
2. **Given** an agent requests `/resume.json`, **When** the response returns, **Then** it is JSON that validates against the pinned JSON Resume schema and matches the approved profile.
3. **Given** an agent requests `/api/profile`, **When** the response returns, **Then** it carries the same facts as `resume.json` plus every skill's level and a `last_updated` date.
4. **Given** any rendered page, **When** its HTML is parsed, **Then** exactly one Person JSON-LD block is present with name, job title, email, `sameAs` links to LinkedIn and GitHub, and `knowsAbout` values drawn only from skills at Intermediate level or above.
5. **Given** the VoiceDash study is in draft, **When** any of the four outputs is inspected, **Then** it contains no VoiceDash case-study fact, slug, or URL.
6. **Given** the profile content changes, **When** the site is rebuilt, **Then** About, the CV, `llms.txt`, `resume.json`, and `/api/profile` all reflect the same change with no duplicated hand-maintained copy.

---

### Edge Cases

- `/case-studies/voicedash` returns 404 while draft; if the status later becomes published, the same URL returns 200 and the study appears in the index, sitemap, and agent outputs.
- A study marked private has no public link; its Public Link section says so explicitly and never renders an empty anchor or an invented URL.
- A slug that does not exist returns 404 with the standard not-found page, exactly like any unknown path.
- A published study with an empty stack list fails the content check rather than rendering an empty section.
- A skill without a category fails the content check naming the skill; a category outside the recorded seven fails naming the category.
- A skill at `Beginner / Learning` is excluded from `knowsAbout` even though it appears on About.
- `last_updated` is a committed content value; rebuilding the site without content changes must not change it.
- No domain is configured yet, so absolute URLs in the sitemap and `llms.txt` use the configured site URL with a local default; changing the setting changes only those URLs.
- Adding the JSON-LD block must not add executable client JavaScript; a page containing any executable script still fails the static-output check.
- The draft's title may appear in the profile's project list (VoiceDash is also a project), but its case-study slug, URL, and narrative must not appear in any agent output.
- Unknown HTML paths keep returning 404 with the existing not-found page and its Person JSON-LD.

## Requirements *(mandatory)*

### Functional Requirements

**Case studies (PRD F2)**

- **FR-100**: `/case-studies` MUST list every published case study with its title and a link to its page, and MUST list no draft study. (F2 AC3)
- **FR-101**: `/case-studies/rousta-tv` and `/case-studies/namehamal` MUST return HTTP 200 and display the sections Problem, My Contribution, Outcome, Stack, and Public Link in that order. (F2 AC1)
- **FR-102**: `/case-studies/voicedash` MUST return HTTP 404 while its recorded status is draft. (F2 AC4)
- **FR-103**: A draft case study MUST be absent from navigation, the sitemap, `llms.txt`, `resume.json`, `/api/profile`, and JSON-LD. (F2 AC3, F7 AC5)
- **FR-104**: A private study's Public Link section MUST state that the product is private with no public link; a public study MUST show its recorded public URL as a link. (F2 AC2)
- **FR-105**: A private study MUST NOT show a repository or source-code link. (F2 AC2)
- **FR-106**: The Stack section MUST list only the technologies recorded for that study, with no invented technology. (F2 AC5)
- **FR-107**: Case-study content MUST come only from the approved case-study facts; no metrics, client names, user counts, dates, or URLs beyond those facts. (F2, PRD §8)
- **FR-108**: `GET /sitemap.xml` MUST return a deterministic XML sitemap listing only public pages and published case studies, and MUST contain no draft slug. (F2 AC3, parent decision 11)
- **FR-109**: Site navigation MUST include a Case Studies entry and MUST NOT link any draft study. (F2 AC3)
- **FR-110**: Publishing a draft MUST require only a data change to its status; the page, index entry, sitemap entry, and agent-readable references MUST follow without code changes. (parent decision 6)

**About page (PRD F3)**

- **FR-200**: `/about` MUST display the professional summary from the approved profile before the experience section. (F3 AC1)
- **FR-201**: `/about` MUST display an experience timeline with role, company, and start and end dates, using the recorded precision and "Present" for an ongoing role. (F3 AC1)
- **FR-202**: `/about` MUST group every skill under exactly one category, in the recorded category order, with its recorded level. (F3 AC2)
- **FR-203**: A skill recorded as `Beginner / Learning` MUST be displayed as "Learning". (F3 AC3)
- **FR-204**: A `Beginner / Learning` skill MUST NOT appear in any headline or strengths list. (F3 AC3)
- **FR-205**: `/about` MUST display the recorded education entries with degree, institution, and years. (F3 AC1)
- **FR-206**: `/about` MUST display the recorded languages with their proficiency. (F3 AC1)
- **FR-207**: A role recorded as team context MUST be labelled as team context and MUST NOT be described as personal ownership. (F3 AC4)
- **FR-208**: Every About fact MUST come from the approved profile; no fact may be inferred or invented. (F3, PRD §8)

**Agent-readable layer (PRD F7)**

- **FR-300**: `GET /llms.txt` MUST return `text/plain; charset=utf-8` listing the headline, target roles, work authorization, availability, published case-study URLs, the CV URL, and the contact URL. (F7 AC1)
- **FR-301**: `GET /resume.json` MUST return `application/json` that validates against the pinned JSON Resume schema version 1.0.0 and matches the approved profile. (F7 AC2)
- **FR-302**: `GET /api/profile` MUST return JSON containing the same facts as `resume.json` plus every skill's level and a `last_updated` field. (F7 AC3)
- **FR-303**: Every rendered HTML page MUST contain exactly one Person JSON-LD block with name, job title, email, `sameAs` links to LinkedIn and GitHub, and `knowsAbout` values drawn only from skills at Intermediate level or above. (F7 AC4)
- **FR-304**: The JSON-LD block MUST contain no draft case-study data. (F7 AC5)
- **FR-305**: `llms.txt`, `resume.json`, `/api/profile`, About, and the CV MUST derive from the same committed content sources; no fact may be hand-duplicated across outputs. (PRD §8 maintainability, parent decision 5)
- **FR-306**: `/resume.json` and `/llms.txt` MUST be served with their declared content types and MUST NOT require client-side JavaScript. (F7 AC1/AC2)
- **FR-307**: `/api/profile` MUST respond in under 500 ms excluding network latency. (PRD §8)
- **FR-308**: `last_updated` MUST be a deterministic ISO-8601 date taken from committed content, not from build or request time. (F7 AC3)

**Preservation and quality (PRD F12, F11)**

- **FR-400**: `/`, `/contact`, `POST /api/contact`, `/cv.pdf`, and `/healthz` MUST keep their Phase 1 behaviour and status codes.
- **FR-401**: The CV PDF MUST keep its text layer, heading order, single-column layout, and verbatim authorization line.
- **FR-402**: No content page may add executable client-side JavaScript; a JSON-LD data block is the only permitted `script` element, and the static-output check MUST enforce that distinction.
- **FR-403**: Every text/background pair on the new pages MUST meet 4.5:1 contrast; the existing contrast check MUST stay green with no new colour pairs below the threshold.
- **FR-404**: `/about` and `/case-studies/rousta-tv` MUST score at least 95 Performance and 100 Accessibility in the standard mobile Lighthouse audit and MUST keep LCP under 2.0 seconds.
- **FR-405**: The container MUST serve the new pages and endpoints, and a rebuild MUST preserve stored contact messages.
- **FR-406**: The six existing validation commands MUST stay green; the new acceptance checks MUST be added to the single validation command list and run in order.

### Key Entities

- **Case study**: one published or draft study — slug, title, status (`published` or `draft`), visibility (`public` or `private`), problem, contribution, outcome, stack technologies, and an optional public link. Draft studies carry no narrative facts.
- **Approved profile**: the committed professional content — identity, headline, availability, work authorization, target roles and countries, bio, contact email, links, experience (with optional team-context marker), skills (name, level, category), projects, education, languages, and the content's last-updated date.
- **Skill category**: one of the seven recorded groups (Backend, Databases, Frontend, DevOps & Infrastructure, Testing, Other Technical Skills, Agentic Coding & AI Tooling), with a fixed display order.
- **Agent-readable output**: the four machine-facing surfaces — `llms.txt`, `resume.json`, `/api/profile`, and the Person JSON-LD block — all generated from the approved content, all excluding drafts.
- **Sitemap**: the deterministic list of public page URLs and published case-study URLs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-100**: A hiring manager can read Problem, My Contribution, Outcome, Stack, and Public Link in that order on both published case studies; the draft URL returns 404 and appears in no navigation or agent output.
- **SC-101**: A reader of `/about` can find all 61 recorded skills under exactly one of the seven categories with their recorded levels; every `Beginner / Learning` skill is labelled "Learning" and none appears as a strength.
- **SC-102**: `/resume.json` validates against the pinned JSON Resume schema and shares every fact with `/api/profile`; no draft slug or draft URL appears in `llms.txt`, `resume.json`, `/api/profile`, the sitemap, or JSON-LD.
- **SC-103**: Every rendered HTML page carries exactly one Person JSON-LD block with name, job title, email, both profile links, and a `knowsAbout` list that contains no `Beginner / Learning` or `Beginner` skill.
- **SC-104**: All six Phase 1 validation commands still pass, and the new checks for JSON Resume conformance, JSON-LD fields, draft 404, and cross-output consistency pass in the same run.
- **SC-105**: `/about` and `/case-studies/rousta-tv` meet the Phase 1 accessibility and performance gates (Performance ≥ 95, Accessibility 100, LCP < 2.0 s) and all new pages read completely with JavaScript disabled.

## Assumptions

- The approved profile is the committed `content/profile.json`; the case-study facts are the owner-approved facts of 2026-11-08, encoded into the site's content model rather than copied as a document.
- Skill categories are exactly the seven groups in the approved master profile's technical skill matrix; no category is invented.
- The site has no public domain yet, so absolute URLs in the sitemap and `llms.txt` use a configured site URL whose local default is `http://localhost:4321`; setting a domain later changes only that setting.
- `/resume.json` follows the JSON Resume convention of listing skill names without proficiency; proficiency is the additional fact `/api/profile` carries, per F7 AC3.
- VoiceDash remains draft for this entire phase; no facts for it are needed or supplied.
- Case-study and About pages are prerendered static content like the Phase 1 content pages; only `/api/profile` is served on demand.
- The sitemap covers public HTML pages (`/`, `/about`, `/case-studies`, `/contact`, and published study pages) and excludes machine-readable endpoints and the CV PDF.
- Existing colour tokens cover the new pages; no new palette is introduced.

## Clarifications

### Session 2026-11-08

- Q: What absolute base URL should the sitemap and `llms.txt` use while the site has no domain? → A: A single configurable site URL with the local default `http://localhost:4321`; deployment changes the setting, not the code.
- Q: Does `resume.json` carry skill proficiency levels? → A: No — it lists skill names only, because F7 AC3 defines `/api/profile` as the same facts *plus* skill levels. Levels and categories appear in `/api/profile`.
- Q: What does the Public Link section show for NamehAmal, which has no public link? → A: An explicit statement that it is a private personal project with no public link; no anchor is rendered and no URL is invented.
- Q: Where does `/api/profile`'s `last_updated` come from? → A: A committed last-updated date in the profile content, so identical content always yields an identical value regardless of build time.
- Q: Which pages belong in `/sitemap.xml`? → A: The public HTML pages — `/`, `/about`, `/case-studies`, `/contact`, and each published study page — with drafts excluded; machine-readable endpoints and the CV PDF are not pages and are omitted.

## Open Questions

None blocking. VoiceDash's publication remains gated on the manager approval being recorded in `PRD.md`; this feature keeps it draft by instruction and does not re-ask.
