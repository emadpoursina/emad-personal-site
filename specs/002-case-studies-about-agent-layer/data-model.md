# Data Model: Phase 2 — Case Studies, About, and Agent-Readable Layer

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

## Content sources

Two committed JSON documents under `content/` are the only sources of fact for this feature. Every rendered page, the CV, and all four agent-readable outputs derive from them.

| Source | Owns | Consumers |
|---|---|---|
| `content/profile.json` | identity, headline, availability, work authorization, target roles/countries, bio, contact email, links, experience, skills (with category), projects, education, languages, content last-updated date | Home, About, CV generator, `llms.txt`, `resume.json`, `/api/profile`, JSON-LD |
| `content/case-studies.json` | the ordered list of case studies with status, visibility, problem, contribution, outcome, stack, public link | `/case-studies`, study detail pages, sitemap, `llms.txt`, `resume.json` projects, `/api/profile` projects |

No fact is stored twice. The CV generator continues to read `profile.json` and ignores the new fields; the case-study file has no overlap with `profile.projects` (Rousta TV and NamehAmal are not in that list).

## Entity: profile (extended, backwards-compatible)

Existing fields and approved-string validation are unchanged (Phase 1 data model). Three additive fields:

| Field | Type | Required | Rule |
|---|---|---|---|
| `lastUpdated` | string | yes (new) | ISO date `YYYY-MM-DD`; the date the profile content was last approved/edited. `/api/profile` reports it as `last_updated`. Never derived from build or request time. |
| `skills[].category` | string | yes (new) | One of the seven category names below, exactly. A skill with a missing or unknown category fails the content check naming the skill. |
| `experience[].context` | string | no (new) | Only `"team"` is accepted. Present on the Villion role; absent everywhere else. |

Existing `skills[].level` stays in `{Expert, Advanced, Intermediate, Beginner / Learning}`; the approved master profile's `Beginner` maps to `Beginner / Learning` (Phase 1 mapping, unchanged).

### Skill categories (fixed order, from the approved matrix)

| Order | Category | Count |
|---|---|---|
| 1 | Backend | 16 |
| 2 | Databases | 5 |
| 3 | Frontend | 5 |
| 4 | DevOps & Infrastructure | 17 |
| 5 | Testing | 3 |
| 6 | Other Technical Skills | 9 |
| 7 | Agentic Coding & AI Tooling | 6 |
| | **Total** | **61** |

Level distribution (measured from `content/profile.json`): Expert 9 · Advanced 17 · Intermediate 10 · Beginner / Learning 25. `knowsAbout` therefore contains exactly **36** names; the 25 Learning skills are excluded.

The 61-skill assignment, measured against `master-profile.md` Part B §1 on 2026-11-08 (61 rows, 61 profile skills, 0 unmapped, 0 level mismatches):

| Category | Skills |
|---|---|
| Backend | Node.js · Express · NestJS · TypeScript · REST API Design · GraphQL · Authentication Systems · JWT Authentication · OAuth2 / Passport.js · Role-Based Access Control · WebSockets / Socket.IO · WebSockets / Real-time (SignalR) · Serverless Functions · Stripe Payments · AI Integration (LLM/STT/TTS) · Microservices |
| Databases | PostgreSQL · MongoDB · Redis · Prisma · TypeORM |
| Frontend | React · Next.js · React Native / Expo · Redux / Zustand / Jotai · HTML / CSS / Tailwind |
| DevOps & Infrastructure | Docker · Docker Compose · Release Management · Git Branching Workflows · Multi-environment Deployment · Nginx · Linux · GitHub Actions / CI/CD · Azure Functions · Azure Blob Storage · Azure SignalR · Azure Communication (Email/SMS) · Netlify · AWS EC2 · AWS S3 · AWS RDS · AWS Lambda |
| Testing | Jest (Unit) · Jest (Integration) · Supertest |
| Other Technical Skills | WordPress (Custom Development) · Electron · System Architecture · Agile / Scrum · Brownfield / Legacy Refactoring · Manual QA & Test Planning · Code Review & Pull Requests · Product & Release Judgment · Remote Team Collaboration |
| Agentic Coding & AI Tooling | Agentic Coding Workflows · specs.md (FIRE Flow) · Ponytail · RTK (rtk-ai) · Codebase Memory MCP · Model Selection & Harness Design |

Presentation rules: `Beginner / Learning` renders as **Learning**; `knowsAbout` uses only `Intermediate`, `Advanced`, `Expert`; no skill appears under two categories.

## Entity: case study (`content/case-studies.json`)

```jsonc
{
  "studies": [
    {
      "slug": "rousta-tv",              // kebab-case, unique, URL segment
      "title": "Rousta TV",
      "status": "published",             // "published" | "draft"
      "visibility": "public",            // "public" | "private"
      "problem": "…",                    // approved fact
      "contribution": "…",               // approved fact
      "outcome": "…",                    // approved fact
      "stack": ["MongoDB", "Express", "React", "Node.js"],
      "publicLink": { "url": "https://roustatv.com/" }   // null for private
    }
  ]
}
```

Rules enforced by `src/lib/case-studies.mjs`:

- `studies` is a non-empty array; `slug` matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` and is unique; `title` is non-empty.
- `status` is `published` or `draft`; `visibility` is `public` or `private` when present.
- A **published** study requires non-empty `problem`, `contribution`, `outcome`, a non-empty `stack` of non-empty strings, and a `visibility`.
- `visibility: "public"` requires `publicLink.url` to be an `https://` URL; `visibility: "private"` requires `publicLink` to be `null`.
- A **draft** study requires only `slug`, `title`, and `status`; narrative fields must be absent or empty and are never rendered.
- Array order is display order on the index.

### Approved records (the only permitted facts)

| Field | Rousta TV | NamehAmal | VoiceDash |
|---|---|---|---|
| `slug` | `rousta-tv` | `namehamal` | `voicedash` |
| `title` | Rousta TV | NamehAmal | VoiceDash |
| `status` | `published` | `published` | `draft` |
| `visibility` | `public` | `private` | — (draft) |
| `problem` | A Persian-language media and community platform for Iranian villages — rural news, village micro-sites, a marketplace, eco-tourism content, live streaming, chat rooms, and member profiles with a wallet. | A personal time-tracking web application for everyday use. | — |
| `contribution` | Sole fullstack developer over roughly three months. Built the entire application end to end — data model, server, APIs, and pages. Development only: did not own product design, content, or product management. | Built it end to end as a personal project. | — |
| `outcome` | Live in production and publicly used. | In personal use. | — |
| `stack` | MongoDB, Express, React, Node.js | Next.js, macOS desktop app (wrapper around the web app) | — |
| `publicLink` | `https://roustatv.com/` | `null` | — |

No metrics, client names, user counts, dates, or additional URLs are permitted beyond this table. VoiceDash's title is already public in `profile.projects`; its case-study slug, URL, and narrative must appear in no output.

## Derived output: `resume.json` (JSON Resume v1.0.0)

Mapping from the content sources, produced by `buildResume(profile, studies)`:

| JSON Resume field | Source | Rule |
|---|---|---|
| `$schema` | constant | `https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json` |
| `basics.name` | `profile.name` | as recorded |
| `basics.label` | `profile.headline` | as recorded |
| `basics.email` | `profile.contactEmail` | as recorded |
| `basics.summary` | `profile.bio` | as recorded |
| `basics.profiles` | `profile.links` | `[{network:"LinkedIn", url}, {network:"GitHub", url}]`, empty entries omitted |
| `work[]` | `profile.experience` | `name` = company, `position` = role, `startDate` = start, `endDate` = end (omitted when `present`), `highlights` = points |
| `education[]` | `profile.education` | `institution`; `studyType`/`area` split from `degree` on the last `" in "`; `startDate`/`endDate` split from `year` on `–`/`-` (year precision allowed by the schema) |
| `skills[]` | `profile.skills` | `{ name }` only — **no level** (F7 AC3 puts levels in `/api/profile`) |
| `languages[]` | `profile.languages` | `{ language: name, fluency: level }` |
| `projects[]` | `profile.projects` then published studies | profile projects in order (omit `url` when empty), then published studies: `name` = title, `description` = problem, `highlights` = [contribution, outcome], `keywords` = stack, `url` only when public |
| `meta.version` | constant | `"v1.0.0"` |

Draft studies never reach `projects`. Empty strings are never emitted as URLs (the schema's `format: uri` would be violated by `""`). `last_updated` is **not** a top-level field: the schema sets `additionalProperties: false`, so it belongs only to `/api/profile`.

## Derived output: `/api/profile`

`buildProfileApi(profile, studies)` returns exactly the `resume.json` object with two changes:

```jsonc
{
  "last_updated": "2026-11-08",                 // from profile.lastUpdated
  "basics": { … }, "work": [ … ], "education": [ … ], "languages": [ … ], "projects": [ … ],
  "skills": [{ "name": "Node.js", "level": "Expert", "category": "Backend" }, …]
}
```

- Every non-`skills` key is deep-equal to `resume.json`; `skills` is the same list enriched with `level` and `category` in profile order.
- No draft study appears in `projects` (it is already excluded from `resume.json`).
- Response is `application/json; charset=utf-8`, `Cache-Control: public, max-age=300`.

## Derived output: `llms.txt`

Plain text, `text/plain; charset=utf-8`, built by `buildLlmsTxt(profile, studies)`. Fixed section order and one fact per line:

```text
# Emad Poursina

> AI and Agentic Systems Engineer with a strong foundation in software development

## Target roles
- Software Engineer
- Backend Engineer
- Full-Stack Engineer
- AI Engineer
- Agentic Systems Engineer

## Work authorization
Requires employer-sponsored work authorization.

## Availability
one month notice

## Case studies
- Rousta TV: <site>/case-studies/rousta-tv
- NamehAmal: <site>/case-studies/namehamal

## CV
- <site>/cv.pdf

## Contact
- <site>/contact
- emad.poursina.work@gmail.com
```

`<site>` is the configured site URL (D7). Draft studies are absent. If no study is published, the case-studies section contains `- None published.` (keeps the file valid and deterministic).

## Derived output: Person JSON-LD

One block per rendered page, injected by `BaseLayout.astro`:

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "Emad Poursina",
  "jobTitle": "AI and Agentic Systems Engineer with a strong foundation in software development",
  "email": "emad.poursina.work@gmail.com",
  "sameAs": ["https://www.linkedin.com/in/emadpoursina/", "https://github.com/emadpoursina"],
  "knowsAbout": ["Node.js", "Express", "REST API Design", "…"]
}
```

`knowsAbout` is every skill at `Intermediate`, `Advanced`, or `Expert`, in profile order. No case-study data is present, so draft exclusion holds by construction; `Beginner / Learning` never appears. The JSON is serialized with `<` escaped as `\u003c` so it cannot terminate the `script` element.

## Derived output: `/sitemap.xml`

Deterministic XML, `application/xml` (UTF-8 in the XML prolog; the static file path adds no charset parameter — W1). Entries in this fixed order, absolute URLs from the site URL:

1. `/`
2. `/about`
3. `/case-studies`
4. `/contact`
5. each published study in content order (`/case-studies/<slug>`)

No draft slug, no machine-readable endpoint, no `/cv.pdf`. No `<lastmod>` (there are no per-page dates; inventing one would be a fabricated fact).

## Configuration

| Key | Where | Default | Effect |
|---|---|---|---|
| `SITE_URL` | environment, build time (`.env.example` documents it empty) | `http://localhost:4321` | Base for absolute URLs in `sitemap.xml` and `llms.txt`; trailing slash trimmed |

## Validation summary

| Rule | Enforced by | Failure names |
|---|---|---|
| profile required fields, approved strings, levels, categories, `lastUpdated` | `src/lib/profile.mjs` (extended), `scripts/check-profile.mjs` | the field and the file |
| case-study schema, unique slugs, published completeness, public/private link rules | `src/lib/case-studies.mjs`, `scripts/check-profile.mjs` | the study slug and field |
| 61 skills each in exactly one category, category set = the seven, order fixed | `tests/skills.test.mjs` | the skill/category |
| `resume.json` conforms to v1.0.0 and equals the generator output | `scripts/check-agent-output.mjs` (ajv-draft-04) | the schema path and offending instance path |
| `llms.txt`, sitemap, JSON-LD equal generator output; no draft slug | `scripts/check-agent-output.mjs` | the output name and mismatch |
| draft 404, `/api/profile` consistency, About content, Phase 1 routes | `scripts/test-public-routes.mjs` | the URL and assertion |
