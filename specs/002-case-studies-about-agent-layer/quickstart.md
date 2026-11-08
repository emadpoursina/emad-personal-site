# Quickstart: Phase 2 — Case Studies, About, and Agent-Readable Layer

**Plan**: [plan.md](./plan.md) · **Contracts**: [contracts/](./contracts/) · **Data model**: [data-model.md](./data-model.md)

Run every command from the worktree root. The list is exactly the one `.ainative/project.yaml` must carry (owned by the build card, not the spec card).

## Prerequisites

- Node 22-compatible runtime on the host (this host runs v26.7.0; the container is Node 22) and npm.
- Docker 26+ with Compose v2 and a live daemon for the container step.
- No `.env` is required for the content and agent-output steps. `verify-container.mjs` writes its own throwaway `.env` from `.env.example`.
- No SMTP credentials are needed; the contact check uses the local sink.

## Validation sequence

```bash
# 1. Install exactly the locked tree
npm ci

# 2. Build: prebuild (content validation, CV, contrast) → astro build → postbuild (CV + static-output)
npm run build

# 3. Unit tests (profile/case-study/skill/output builders, Phase 1 suites)
npm test

# 4. Build-output checks: JSON Resume schema conformance, JSON-LD, llms.txt, sitemap, draft exclusion
node scripts/check-agent-output.mjs

# 5. Live-server checks: About and case-study HTML, draft 404, /api/profile, Phase 1 regression
node scripts/test-public-routes.mjs

# 6. Phase 1 contact end-to-end (unchanged)
node scripts/test-contact-api.mjs

# 7. Lighthouse/LCP on /, /about, /case-studies/rousta-tv
node scripts/lighthouse-check.mjs

# 8. Container: compose up, health, new routes, volume persistence, disabled SMTP
node scripts/verify-container.mjs
```

## Expected outcomes

| Step | Pass signal |
|---|---|
| `npm ci` | exit 0 (EBADENGINE warnings for host Node 26 are expected) |
| `npm run build` | exit 0; `static-output ok`; `cv ok`; `contrast ok`; `dist/client/{about,case-studies,llms.txt,resume.json,sitemap.xml}` exist; no `dist/client/case-studies/voicedash` |
| `npm test` | all tests pass; includes 61/61 skill-category mapping and builder tests |
| `check-agent-output.mjs` | `agent-output ok` — resume validates against the vendored schema and equals the builder; every page has one Person JSON-LD; `llms.txt`/sitemap list no draft |
| `test-public-routes.mjs` | `public-routes ok` — `/case-studies/voicedash` is 404; both studies show the five headings in order; `/api/profile` matches `resume.json` plus levels; Phase 1 routes 200 |
| `test-contact-api.mjs` | `contact-api ok` (unchanged) |
| `lighthouse-check.mjs` | each page: Performance ≥ 95, Accessibility 100, LCP < 2000 ms (median of three runs) |
| `verify-container.mjs` | `container ok` — health, new routes, draft 404, rebuild preserves rows, disabled SMTP warns |

## Manual checks (after step 5, before step 7)

1. Open `/case-studies` and both study pages with JavaScript disabled; confirm the five sections in order and no missing content.
2. Tab through `/about` and a study page; every link shows a visible focus ring and the skip link is first.
3. Confirm the VoiceDash URL returns a not-found page, not an empty page.
4. Open `/resume.json` in a browser; confirm it downloads/renders as JSON, and `/llms.txt` as plain text.
5. View source on any page; confirm exactly one `application/ld+json` block and no other `<script>`.

## Notes and troubleshooting

- `SITE_URL` controls absolute URLs in `llms.txt` and `sitemap.xml`; leave it unset locally (`http://localhost:4321` is the default). Setting it never changes the path assertions.
- `check-agent-output.mjs` needs `dist/client` — run it after `npm run build`.
- `test-public-routes.mjs` boots the built server on a free port with a temporary `DATA_DIR`; it does not touch `data/site.sqlite`.
- If `npm ci` is skipped, every later step fails on missing `node_modules`; it is first for that reason.
- The Lighthouse script installs its pinned Chromium on first run; that download needs network once and is cached afterwards.
- Evidence from a run belongs in `specs/*/evidence*`, which is gitignored; never commit it.
