# Product Requirements Document: Emad Poursina — Personal Professional Site

**Version:** 1.3
**Date:** 2026-11-07
**Status:** Approved
**Author:** PRD Writer Agent, from the confirmed discovery decision table
**Change log:** 1.1 (2026-11-07): host set to this machine with Docker Compose (no VPS yet); site email emad.poursina.work@gmail.com; AI provider OpenRouter with a default model; admin settings panel added (F21); CV scoped as one simple page with PDF download; master profile used as reference only, plus the updates given in chat. 1.2 (2026-11-07): contact SMTP = Gmail with app password for emad.poursina.work@gmail.com; chat log stores full question text; cover-letter generator (F9) blocked until the generator API docs are provided (not a scope cut); OpenRouter uses the default daily cap only (no USD cap); VoiceDash case study approved for drafting, pending manager confirmation. 1.3 (2026-11-07): manager confirmation received for the VoiceDash case study (go ahead); git commit identity is Emad Poursina <emad.puursina@gmail.com>, while the website contact email stays emad.poursina.work@gmail.com; cover-letter generator service is not ready to use yet, so F9 stays blocked and its form stays hidden until its endpoint is configured.

---

## 1. Executive Summary

A personal website for Emad Poursina, a backend engineer with 7+ years of production Node.js experience, built to win senior backend and AI-integration roles in Canada, Ireland, the UK, the Netherlands, and Portugal. It is designed for two audiences: recruiters and hiring managers who skim quickly, and the AI screening agents many companies now use to review applications. It presents verified proof of work (case studies with outcomes), a downloadable CV in an ATS-friendly format, a general cover letter, machine-readable profile data, a contact form, and a visitor-facing AI assistant that answers questions about Emad using only his approved profile. The site is an Astro application with server endpoints, packaged in a single Docker container running on this machine. A VPS and domain come later.

## 2. Business Model

| Element | Detail |
|---------|--------|
| **Who** | Technical recruiters, engineering hiring managers, and the AI screening agents their companies use, at companies hiring senior backend or AI-integration engineers in the five target countries |
| **Problem** | Recruiters spend seconds per CV. A CV alone does not prove production experience, and AI screeners can misread or miss context that is not structured |
| **Solution** | A fast static site with verified case studies, structured data (`llms.txt`, `resume.json`, Person JSON-LD), an ATS-safe CV, and an AI assistant that answers evidence-based questions about Emad |
| **Name** | Emad Poursina — Personal Site (working title; no brand name chosen) |

Not a commercial product. There is no revenue model. Success means interviews and offers.

## 3. User Personas

### Primary Persona: Technical Recruiter / Sourcer

- **Who they are**: A recruiter sourcing backend engineers for a company in one of the target countries, often screening 50+ profiles per week.
- **Goals**: Decide within a minute whether a candidate matches a role's stack, seniority, and work-authorization needs, then pass a shortlist to the hiring manager.
- **Pain points**: Generic portfolios with no outcomes. Missing or unclear work authorization. Outdated or hard-to-find CVs. Claims they cannot verify.
- **Context**: Desktop, often on a phone between meetings. Arrives from a LinkedIn profile or a CV link.

### Secondary Persona: Hiring Manager / Senior Engineer

- **Who they are**: An engineering lead or CTO at a small or mid-size company, reviewing candidates who passed the recruiter screen.
- **Goals**: Judge technical depth, ownership, and how the candidate thinks about production problems.
- **Pain points**: Vague case studies. Skills claimed at a level the candidate cannot back up. No view of the candidate's real working style.
- **Context**: Desktop, reading case studies before a call. May ask the AI assistant specific technical questions.

### Tertiary Persona: AI Screening Agent

- **Who they are**: An automated agent (ATS module, LLM-based screener, or browsing agent) that reads the site and the CV on the recruiter's behalf.
- **Goals**: Extract structured facts (role, years, stack, location, authorization, contact) and match them to job requirements.
- **Pain points**: Unstructured prose, text trapped in images, inconsistent facts between CV and site.
- **Context**: Machine access. Reads HTML, `llms.txt`, `resume.json`, and the CV PDF.

## 4. User Journeys

### Journey 1: Recruiter screens Emad from a LinkedIn or CV link

1. Recruiter opens the home page from a link.
2. Home shows the headline, a short specific bio, target roles, work authorization line, and links to case studies and CV.
3. Recruiter opens a case study and sees problem, contribution, outcome, and stack.
4. Recruiter downloads the CV (text-based PDF) and checks it against the job description.
5. Recruiter uses the contact form or the email address to reach Emad. The message is emailed and logged.

### Journey 2: AI screening agent evaluates Emad for a role

1. Agent fetches `/llms.txt` and `/api/profile` (or `resume.json`).
2. Agent reads structured facts: roles, dates, stack with honest skill levels, projects with public URLs, work authorization, availability.
3. Agent fetches the CV PDF and compares it to the job requirements.
4. Agent produces a match summary from the same facts the recruiter sees.

### Journey 3: Hiring manager asks the AI assistant

1. Manager opens the Ask page and types a question (for example, "Has Emad run Docker Compose in production?").
2. The backend checks the rate limit and message length, then sends the question with the approved profile as context to the configured model.
3. The assistant answers only from the profile. For anything not in the profile, it says it does not have that information and points to the contact form.
4. The answer includes a note that it is an AI assistant and that the CV and case studies are the source of record.

### Journey 4: Visitor requests a tailored cover letter

1. Visitor opens the Cover Letter page, which shows the general letter.
2. Visitor pastes a job description and submits.
3. The backend calls the external generator service through its API, with a key stored in `.env`.
4. The result is shown with the required work-authorization line and sign-off, and can be copied.

## 5. Feature Set

### MVP (Must-Have)

| # | Feature | Description | Priority |
|---|---------|-------------|----------|
| F1 | Home page | Headline, short bio, target roles, work-authorization line, primary links | P0 |
| F2 | Case studies | Three case studies (Rousta TV, NamehAmal, VoiceDash-draft) with problem, contribution, outcome, stack, and public link | P0 |
| F3 | About page | Summary, experience timeline, core skills with honest levels, education, languages | P0 |
| F4 | CV download | Text-based PDF CV, single column, standard headings, generated from the profile | P0 |
| F5 | General cover letter | Public general letter following profile §11 rules (exact authorization line, sign-off, no banned phrases) | P0 |
| F6 | Contact form | Validated form; sends email via SMTP to emad.poursina.work@gmail.com and stores a row in SQLite | P0 |
| F7 | Agent-readable layer | `/llms.txt`, `/resume.json`, `/api/profile`, Person JSON-LD on every page | P0 |
| F8 | Ask-me AI assistant | Visitor chat answering questions about Emad from the approved profile only; generic model adapter (OpenAI-compatible API) | P0 |
| F9 | Cover-letter generator (blocked: the generator service is not ready to use yet) | Visitor submits job text; backend calls external generator API; result shown with required lines | P0 |
| F10 | Abuse protection | Per-IP rate limit and daily global cap on F8 and F9 (F9 once built); max input length | P0 |
| F11 | Container packaging | Single Docker image; SQLite on a named volume; config via `.env` | P0 |
| F12 | Accessibility and performance baseline | Semantic HTML, keyboard navigation, contrast, prerendered static pages | P0 |
| F21 | Admin settings panel | Password-protected `/admin` page to set the AI provider base URL, model, API key, daily cap, rate limits, SMTP settings, and generator endpoint, stored in SQLite (keys encrypted) | P0 |

### V1.1 (Should-Have)

| # | Feature | Description | Priority |
|---|---------|-------------|----------|
| F13 | Tailored CV per job | CV variant generated from a pasted job description via the external generator | P1 |
| F14 | Case study: Villion (mobile, personal scope) | Case study on the React Native trip-feature redesign, using personal-scope facts only | P1 |
| F15 | Case study: Quiz Manager / MirzaBenevis | Additional public-project case studies | P1 |
| F16 | Chat transcript review in admin | Read-only log of assistant questions with full question text, to see what recruiters ask | P1 |

### Future (Nice-to-Have)

| # | Feature | Description | Priority |
|---|---------|-------------|----------|
| F17 | Case-study editing in admin | Edit case studies and profile data from the admin page (settings are F21) | P2 |
| F18 | Custom domain and VPS deployment | Public hosting behind TLS | P2 |
| F19 | Writing section | Technical posts | P2 |
| F20 | Analytics | Privacy-friendly page analytics (deferred by decision) | P2 |

## 6. Page / Screen List

```
/
├── Home (F1)
├── About (F3)
├── Case Studies (F2)
│   ├── /case-studies/rousta-tv
│   ├── /case-studies/namehamal
│   └── /case-studies/voicedash        (draft until approved)
├── CV (F4)                            /cv.pdf download
├── Cover Letter (F5, F9)              /cover-letter
├── Ask (F8)                           /ask
├── Contact (F6)                       /contact
├── Admin settings (F21)               /admin (password login)
├── Machine-readable (F7)
│   ├── /llms.txt
│   ├── /resume.json
│   └── /api/profile
└── API (F6, F8, F9, F10)
    ├── POST /api/contact
    ├── POST /api/ask
    └── POST /api/cover-letter
```

## 7. Functional Requirements

### F1: Home page

**User Story:** As a recruiter, I want to see who Emad is and what roles he targets within seconds, so that I can decide whether to keep reading.

#### Acceptance Criteria

1. WHEN a visitor opens `/`, THE System SHALL display the headline "Backend engineer building production Node.js and AI-integrated systems" within the first viewport.
2. WHEN a visitor opens `/`, THE System SHALL display the work-authorization line "Requires employer-sponsored work authorization." and the availability ("one month notice") text.
3. WHEN a visitor opens `/`, THE System SHALL display links to Case Studies, CV, and Contact, each reachable in one click.
4. IF the bio text would contain a claim not present in the approved profile, THEN THE System SHALL omit the claim (enforced by content review, not runtime logic).

### F2: Case studies

**User Story:** As a hiring manager, I want each case study to show the problem, Emad's specific contribution, and the outcome, so that I can judge his ownership.

#### Acceptance Criteria

1. WHEN a visitor opens a case study, THE System SHALL display the sections Problem, My Contribution, Outcome, Stack, and Public Link in that order.
2. WHERE a case study is a private product, THE System SHALL show only public URLs and no repository or source links.
3. IF a case study's status is "draft", THEN THE System SHALL not include it in the navigation, sitemap, `llms.txt`, or `resume.json`.
4. WHILE the VoiceDash case study is in draft, THE System SHALL respond to `/case-studies/voicedash` with a 404 status.
5. WHEN a case study lists a skill, THE System SHALL use only skill levels recorded in master-profile.md §3.

### F3: About page

**User Story:** As a recruiter, I want a complete, honest professional background, so that I can verify the CV.

#### Acceptance Criteria

1. WHEN a visitor opens `/about`, THE System SHALL display the professional summary, experience timeline with dates, education, and languages from master-profile.md §§2, 4, 6, and 1.
2. WHEN a visitor opens `/about`, THE System SHALL show skills grouped by category with their levels (Expert, Advanced, Intermediate, Beginner / Learning) exactly as recorded in the profile.
3. IF a skill is marked Beginner / Learning, THEN THE System SHALL label it as "Learning" and not place it in any headline or strengths list.
4. WHERE a role is marked team context (such as Villion's backend), THE System SHALL describe it as team context and not as personal ownership.

### F4: CV download

**User Story:** As a recruiter, I want a current CV I can parse and forward, so that I can share it with a hiring manager.

#### Acceptance Criteria

1. WHEN a visitor requests `/cv.pdf`, THE System SHALL return a PDF with a text layer that can be extracted without OCR.
2. WHEN the CV is generated, THE System SHALL use a single-column layout with the standard headings Summary, Experience, Skills, Projects, Education, and Languages.
3. IF the CV contains text inside an image or a multi-column table, THEN THE System SHALL fail the build check and report the offending section.
4. WHERE the CV is generated, THE System SHALL include the work-authorization line "Requires employer-sponsored work authorization." verbatim.

### F5: General cover letter

**User Story:** As a recruiter, I want a cover letter that states Emad's authorization and availability clearly, so that I can judge fit without a follow-up email.

#### Acceptance Criteria

1. WHEN a visitor opens `/cover-letter`, THE System SHALL display the general letter starting with the greeting, with no city or date letterhead.
2. WHEN the general letter is rendered, THE System SHALL include the exact phrase "Requires employer-sponsored work authorization." and the sign-off "Best regards, Emad Poursina".
3. IF the letter contains "I am writing to express my interest", "passionate", "dynamic", "synergy", "results-driven", or "team player", THEN THE build check SHALL fail.
4. WHEN the letter is rendered, THE System SHALL show LinkedIn and GitHub links on separate lines after the sign-off.

### F6: Contact form

**User Story:** As a recruiter, I want to send a message to Emad in one step, so that I can start a conversation without finding an email address.

#### Acceptance Criteria

1. WHEN a visitor submits `/contact` with a valid name, email address, and message, THE System SHALL send an email to emad.poursina.work@gmail.com via SMTP within 30 seconds.
2. WHEN a submission is accepted, THE System SHALL store a row in the SQLite `contact_messages` table with timestamp, name, email, message, and delivery status.
3. IF the email address is malformed or the message is empty or longer than 5,000 characters, THEN THE System SHALL reject the submission with field-level error messages and store nothing.
4. IF SMTP delivery fails, THEN THE System SHALL keep the row with status "failed" and return a message asking the visitor to email directly.
5. WHILE the form is submitted more than 5 times per IP address per hour, THE System SHALL reject further submissions with HTTP status 429.

### F7: Agent-readable layer

**User Story:** As an AI screening agent, I want structured, accurate facts about Emad, so that I can match him to a role without guessing.

#### Acceptance Criteria

1. WHEN an agent requests `/llms.txt`, THE System SHALL return a plain-text summary listing the headline, target roles, work authorization, availability, case study URLs, CV URL, and contact URL.
2. WHEN an agent requests `/resume.json`, THE System SHALL return JSON that conforms to the JSON Resume schema and matches the profile in master-profile.md.
3. WHEN an agent requests `/api/profile`, THE System SHALL return the same facts as `resume.json` plus skill levels, with a `last_updated` field.
4. WHERE a page is rendered, THE System SHALL include a Person JSON-LD block with name, job title, email, sameAs links (LinkedIn, GitHub), and knowsAbout values taken from skills at Intermediate level or above.
5. IF a case study is in draft, THEN THE System SHALL exclude it from all four outputs above.

### F8: Ask-me AI assistant

**User Story:** As a hiring manager, I want to ask specific questions about Emad's experience and get a grounded answer, so that I can evaluate fit faster.

#### Acceptance Criteria

1. WHEN a visitor submits a question on `/ask`, THE System SHALL send the question, the approved profile text, and the system instructions to the configured model endpoint and display the reply.
2. WHILE the model is answering, THE System SHALL display a visible "thinking" state and disable the submit button.
3. IF the question asks about information absent from the approved profile, THEN THE System SHALL reply that the information is not available and suggest the contact form.
4. IF the question asks for a salary floor, a private codebase detail, or a named visa program, THEN THE System SHALL decline and state the approved position (expected range from §9 is the only salary figure it may give, and only as the opening ask).
5. WHEN a reply is displayed, THE System SHALL show the note "AI assistant. The CV and case studies are the source of record."
6. WHERE the model endpoint is not configured, THE System SHALL show "The assistant is unavailable right now" and not call any external service.
7. IF the message exceeds 1,000 characters, THEN THE System SHALL reject it before calling the model.

### F9: Cover-letter generator

**User Story:** As a recruiter, I want a letter tailored to a specific job, so that I can see Emad's fit for that role.

#### Acceptance Criteria

1. WHEN a visitor submits a job description on `/cover-letter`, THE System SHALL call the external generator API using the key from `.env` and display the returned letter.
2. IF the returned letter lacks the exact authorization line or the sign-off, THEN THE System SHALL append them before display.
3. IF the generator API returns an error or times out after 30 seconds, THEN THE System SHALL display an error and store nothing.
4. WHERE the generator endpoint is not configured, THE System SHALL hide the generator form and show the general letter only.
5. IF the job description exceeds 8,000 characters, THEN THE System SHALL reject it before calling the generator.

### F10: Abuse protection

**User Story:** As Emad, I want the AI features to have hard cost limits, so that abuse cannot run up a bill.

#### Acceptance Criteria

1. WHILE a single IP address has made more than 10 requests to `/api/ask` or `/api/cover-letter` in one hour, THE System SHALL return HTTP 429.
2. WHILE the total of `/api/ask` and `/api/cover-letter` requests in a UTC day exceeds the configured daily cap (default 200), THE System SHALL return HTTP 429 with a message saying the service is paused for today.
3. WHEN the daily cap is reached, THE System SHALL log the event and send no external calls until the next UTC day.
4. WHERE the daily cap value is set in `.env`, THE System SHALL use that value instead of the default.

### F11: Container packaging

**User Story:** As Emad, I want the whole site to run from one command locally, so that moving it to a VPS later is simple.

#### Acceptance Criteria

1. WHEN `docker compose up` is run in the project root with a valid `.env`, THE System SHALL start the site on a local port and create the SQLite database in a named volume.
2. WHILE the container is running, THE System SHALL keep secrets (SMTP credentials, model key, generator key) out of the image and out of git.
3. IF the `.env` file is missing a required SMTP or model setting, THEN THE System SHALL start with that feature disabled and log a warning.
4. WHERE the container is rebuilt, THE System SHALL keep existing SQLite data in the named volume.

### F12: Accessibility and performance baseline

**User Story:** As a recruiter using any device, I want fast, readable pages, so that I can review the site on a phone or with a screen reader.

#### Acceptance Criteria

1. WHEN a visitor opens any static page, THE System SHALL serve it prerendered with no client-side JavaScript required to read the content.
2. WHILE a visitor navigates with a keyboard, THE System SHALL show a visible focus indicator on every interactive element.
3. WHEN a page is audited with Lighthouse, THE System SHALL score at least 95 for Performance and 100 for Accessibility on the home page.
4. IF any text on a page has a contrast ratio below 4.5:1 against its background, THEN THE build check SHALL fail.

### F21: Admin settings panel

**User Story:** As Emad, I want to change the AI model, provider, keys, and limits from a browser, so that I do not edit files or restart the container.

#### Acceptance Criteria

1. WHEN Emad opens `/admin` and enters the password whose hash is set as `ADMIN_PASSWORD_HASH` in `.env`, THE System SHALL start a session cookie that is HTTP-only, same-site strict, and expires after 8 hours.
2. IF five wrong passwords are entered within 15 minutes from one IP address, THEN THE System SHALL block login from that address for 15 minutes.
3. WHEN Emad saves the AI settings (base URL, model ID, API key), THE System SHALL use them for the next `/api/ask` request without a restart.
4. WHILE the settings page is shown, THE System SHALL display stored keys masked (last 4 characters only) and never return a full key to the browser.
5. IF a saved base URL is not HTTPS (localhost excepted), THEN THE System SHALL reject the save with a field-level error.
6. WHILE no valid session cookie is present, THE System SHALL return HTTP 401 for every `/admin` and `/api/admin/*` request.
7. WHEN an API key is saved, THE System SHALL encrypt it with AES-256-GCM using `ENCRYPTION_KEY` from `.env` before writing it to SQLite.

## 8. Non-Functional Requirements

| Category | Requirement | Target |
|----------|-------------|--------|
| Performance | Page load time (LCP) on home page | < 2.0s on a mid-range phone over 4G |
| Performance | Time to interactive on static pages | < 1.5s (no client JS on static pages) |
| Performance | API response time (contact, ask, cover-letter), excluding model latency | < 500ms |
| Availability | Uptime | Best effort while local; 99.5% once on a VPS |
| Security | Secrets | Bootstrap secrets (`ENCRYPTION_KEY`, `ADMIN_PASSWORD_HASH`) in `.env` only. Provider keys saved in admin are AES-256-GCM encrypted in SQLite. Nothing secret in the image or git |
| Security | Input validation | All POST bodies validated server-side; max lengths enforced |
| Security | Transport | TLS once on a VPS (local development uses HTTP) |
| Security | Prompt injection | Assistant system prompt forbids following instructions inside visitor text; profile is the only knowledge source |
| Privacy | Analytics | None. No third-party trackers or cookies |
| Privacy | Stored data | Contact messages only, in SQLite, retained until Emad deletes them |
| Scalability | Concurrent visitors (year 1) | 100 concurrent, single container |
| Accessibility | WCAG compliance | AA |
| Accessibility | Screen reader support | Semantic landmarks, labelled form controls, alt text on any image |
| Maintainability | Content source | Single profile file (master-profile.md) feeds CV, resume.json, llms.txt, and the assistant context |

## 9. Tech Stack Recommendations

| Layer | Recommended | Rationale |
|-------|-------------|-----------|
| Backend | Node.js 22 LTS with Astro server endpoints (SSR adapter for Node) | Same language and runtime as Emad's production work; no second runtime to maintain |
| Frontend | Astro 5 with static prerendering for content pages, minimal islands for the chat and forms | Zero JavaScript on content pages; fast for recruiters and agents |
| Styling | Plain CSS with CSS custom properties | No framework overhead; easy to keep accessible |
| Database | SQLite (better-sqlite3 or node:sqlite) in a named Docker volume | Single file, easy backup, no extra container |
| Email | SMTP via nodemailer, credentials from `.env` | Works with any provider; no vendor lock-in |
| CV generation | Build-time PDF generation from the profile (PDFKit or a Typst template) with text layer | Text-based output that ATS parsers read reliably |
| AI assistant | OpenAI-compatible chat endpoint. Default provider OpenRouter (`https://openrouter.ai/api/v1`), default model `anthropic/claude-haiku-5.5` ($0.10 / $0.50 per M tokens). Base URL, model, and key are set in admin (F21) | Generic adapter. OpenCode Go models with an OpenAI-compatible endpoint (`https://opencode.ai/inference/go/openai/v1/chat/completions`) can be selected the same way |
| Generator | External service API, key in `.env` | Owned separately by Emad; this site only proxies the call |
| Rate limiting | In-memory per-IP limiter plus SQLite-backed daily counter | Simple, enough for single-container scale |
| Container | Docker, one image, Compose file with a named volume | Matches the planned VPS deployment |
| Testing | Vitest for logic, Playwright for page checks, Lighthouse CI for scores | Standard tools; checks the acceptance criteria above |
| Monitoring | Container logs and a `/healthz` endpoint | No analytics by decision; minimal operational surface |
| Hosting | This machine with Docker Compose (decided 2026-11-07); VPS and domain later | Per decision |

### Liberties and Alternatives

- The AI assistant and generator are behind a generic adapter, so the model provider can change without touching page code.
- If the external generator is unavailable, F9 falls back to the general cover letter only.
- If Node-based PDF generation proves hard to keep ATS-safe, a Typst build step is the alternative.
- If the site needs multi-user admin later (F17), move from SQLite to PostgreSQL. This is not needed for MVP.

## 10. Design Direction

- **Visual tone**: Minimal and technical. Strong typography, generous whitespace, one accent color, light and dark themes.
- **Key interaction patterns**: Static pages with plain links; a single chat panel on `/ask`; a standard form on `/contact` and `/cover-letter`. No animations that delay reading.
- **Accessibility targets**: WCAG 2.2 AA, keyboard-complete, visible focus, reduced-motion respected.
- **Responsive strategy**: Mobile-first, single column below 768px, two columns for case-study metadata above it.
- **Design system**: Built from scratch with CSS custom properties. No component library.

## 11. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Recruiter or hiring-manager replies per month | 3 by month 2 after the site is live, 5 by month 3 | Count of contact-form rows plus inbound emails |
| CV downloads per month | 20 by month 3 | Server log count of `GET /cv.pdf` (no analytics tool) |
| AI screening agent reads | `llms.txt` and `resume.json` fetched at least 5 times per month | Server log count |
| Assistant answer accuracy | 0 claims not present in the profile in a monthly 20-question review | Manual review of logged questions and answers (F16 in V1.1; manual export until then) |
| Lighthouse Performance on home | ≥ 95 | Lighthouse CI on every build |
| Lighthouse Accessibility on home | 100 | Lighthouse CI on every build |
| Interview invitations from the site | 2 by month 3 | Manual count |

## 12. Risks and Assumptions

| # | Risk / Assumption | Impact | Mitigation |
|---|-------------------|--------|------------|
| R1 | The assistant states a claim not in the profile (hallucination) and a recruiter repeats it | High | System prompt limits answers to the profile; "not available" fallback; monthly review of logged answers; add a disclaimer on every reply |
| R2 | VoiceDash case study published without manager approval | High | Draft status blocks publication (F2 AC3–4, F7 AC5); publish only after written approval |
| R3 | Visitor prompt injection makes the assistant reveal secrets or invent claims | High | Profile-only context; no tools; instructions treated as data; no secrets in prompts |
| R4 | Abuse drives external model costs | High | F10 per-IP limit and daily cap; max input lengths; endpoint disabled when unset |
| R5 | Profile data goes stale (master-profile still says `emad.puursina@gmail.com`; skill levels will change) | Medium | Single source file feeds all outputs; the email in the profile is corrected before publication; re-check each release |
| R6 | CV PDF is not parsed correctly by ATS tools | High | Text-layer check in build; single column; standard headings; no tables for layout |
| R7 | Overclaiming Learning-level skills (NestJS, GraphQL, AWS, Jest, GitHub Actions) | High | Labels from profile §3 enforced in F3 AC2–3; no Learning skill in headline |
| R8 | SMTP credentials leak through git or the image | High | `.env` in `.gitignore`; `.dockerignore` excludes it; secret scan before commit |
| R9 | Local-only hosting means the site is not reachable to recruiters until VPS setup | Medium | Accepted by decision; VPS and domain are a later phase (F18) |
| R10 | Headline says "AI-integrated systems" while profile rates AI integration Intermediate | Medium | Matches the profile; update the headline when profile §3 is revised |
| R11 | Assumption: the external generator service exposes a documented API with a stable contract | Medium | Confirm its API docs before F9 is built; F9 is skipped if not available |
| R12 | Assumption: an SMTP provider is available for `emad.poursina.work@gmail.com` | Medium | Confirm credentials before F6 is tested end to end |

## 13. Open Questions

- When will the cover-letter and CV generator service be ready? Its endpoint, request format, and authentication are needed before F9 can be built, and before F13 (tailored CV, V1.1).
- Scope: "keep it one simple page" applies only to the CV and resume. The rest of the MVP stays as listed (F1–F12, F21).
- VoiceDash: manager confirmation received (1.3). Master profile §5 still says the codebase is confidential and is not edited by this project; you update §5 when you're ready.
- The headline is set to "Backend engineer building production Node.js and AI-integrated systems" (you asked me to choose). Revisit it when master-profile §3 is updated to advanced AI-integration.
- Which brand name, if any, should appear in the header (currently "Emad Poursina")?
