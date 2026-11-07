# Project rules — emad-personal-site

## Project context

- **Purpose:** Personal website for Emad Poursina: home, case studies, CV download, contact form, and a visitor Q&A assistant. The full spec is in `PRD.md` (v1.3, approved).
- **Stack (planned, not yet scaffolded):** Astro 5, Node.js 22, SQLite (named Docker volume), nodemailer, Docker Compose.
- **Layout:** `PRD.md` (spec), `README.md`, `.ainative/project.yaml`, `.specify/` and `.pi/prompts/` (Spec Kit). App code will be added by the first feature.

## Workflow

- Work is submitted through this project's Hermes Kanban board (`emad-personal-site`).
- Follow the card's `## Path` and the workflow stage assigned by Hermes.
- Keep `validation_commands` in `.ainative/project.yaml` accurate. It currently holds a bootstrap TODO that must be replaced once the scaffold runs.
- For a `feature`, follow the spec/plan/tasks workflow and its reviews. A `change` is already specified; a `job` runs only its named skill.
- Ask rather than guessing when a consequential project decision is unclear.
- Update `PRD.md` (and its change log) when a decision changes scope, stack, or requirements.

## Code and design constraints

- Use the stack in `PRD.md` §9. Prefer existing project abstractions; justify any new dependency.
- Accessibility and performance targets are in `PRD.md` §8 (keyboard navigation, semantic HTML, contrast, LCP < 2.0s on mid-range phones).
- Secrets (`.env`, API keys, SMTP credentials, `ADMIN_PASSWORD_HASH`, `ENCRYPTION_KEY`) never go into the image, git, or documentation. `.env` is gitignored.
- The site is public. Do not publish private-codebase details, salary figures, visa details, or case-study content marked draft (VoiceDash is a 404 until the manager's approval is recorded in `PRD.md`).

## Project-specific notes

- Public contact address on the site: `emad.poursina.work@gmail.com`. Git commit identity: `Emad Poursina <emad.puursina@gmail.com>`. These differ on purpose.
- Commits are made only with explicit owner approval. Pushes are a separate approval.

## Out of scope

- Visitor analytics and tracking (decided: none).
- Multi-user admin (the admin is one owner; PostgreSQL is not needed for the MVP).
- Deployment to a VPS or domain until the owner provides them.
