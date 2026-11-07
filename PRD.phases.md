# Phase plan: Emad Poursina personal site

**PRD:** [PRD.md](./PRD.md)
**Date:** 2026-11-07
**MVP complete after:** Phase 4

## Phase 1: Public home, CV, and contact

**Goal:** A visitor can read the home page, download a plain-text CV PDF, and send a contact message, all running in one Docker container.
**Scope:**
- F1 Home page — part: home page only (headline, short bio, target roles, work-authorization line, primary links)
- F4 CV download — all
- F6 Contact form — all
- F11 Container packaging — all
- F12 Accessibility and performance baseline — all
**Exit criteria:**
- [ ] `/` loads with the headline, bio, target roles, work-authorization line, and links, and passes keyboard navigation and contrast checks
- [ ] The CV PDF downloads from the home page, has a text layer, and uses a single column with the standard headings
- [ ] A valid contact submission sends an email to emad.poursina.work@gmail.com and stores one row in SQLite; an invalid one shows field errors and stores nothing
- [ ] `docker compose up` starts the site with a named volume, and the site responds on its health endpoint
- [ ] Home page LCP is under 2.0s on the mid-range phone profile in the PRD
**Out of scope:** Case studies, About page, agent-readable files, the AI assistant, the cover-letter generator, and the admin panel.
**Spec:** none

## Phase 2: Case studies, About, and agent-readable layer

**Goal:** A recruiter can read the three case studies and the About page, and AI screening tools can read the same profile in machine-readable form.
**Scope:**
- F2 Case studies — all (Rousta TV, NamehAmal, and VoiceDash as a 404 draft)
- F3 About page — all
- F7 Agent-readable layer — all
**Exit criteria:**
- [ ] Rousta TV and NamehAmal case studies show problem, contribution, outcome, stack, and public link
- [ ] `/case-studies/voicedash` returns HTTP 404 while the draft flag is set
- [ ] About page shows summary, experience timeline, skills with honest levels, education, and languages, with Learning-level skills marked as such
- [ ] `/llms.txt`, `/resume.json`, and `/api/profile` return valid content that matches the profile, and every page has Person JSON-LD
**Out of scope:** The AI assistant, the cover-letter generator, and the admin panel. V1.1 case studies (F14, F15).
**Spec:** none

## Phase 3: Ask-me assistant and admin settings

**Goal:** A visitor can ask questions about Emad and get answers from the approved profile only, and the owner can change the AI provider and limits from a browser.
**Scope:**
- F8 Ask-me AI assistant — all
- F10 Abuse protection — part: rate limit and daily cap for F8 only
- F21 Admin settings panel — all
**Exit criteria:**
- [ ] `/ask` answers profile questions with citations to profile content, declines salary floor, private codebase, and visa-program questions with the approved position, and never returns a secret
- [ ] More than 10 `/api/ask` requests from one IP within an hour return HTTP 429
- [ ] `/admin` returns 401 without a session; the correct password starts a session; five wrong passwords block the IP for 15 minutes
- [ ] Changing the model or base URL in `/admin` takes effect on the next `/api/ask` request with no restart
- [ ] Stored API keys are encrypted and shown masked
**Out of scope:** The cover-letter generator and its rate limit (F10 for F9). Chat transcript review (F16, V1.1).
**Spec:** none

## Phase 4: General cover letter and generator path

**Goal:** A visitor can read the general cover letter and, once the generator service is configured, submit a job description to get a tailored cover letter.
**Scope:**
- F5 General cover letter — all
- F9 Cover-letter generator — all
- F10 Abuse protection — part: rate limit and daily cap for F9 only
**Exit criteria:**
- [ ] `/cover-letter` shows the general letter with the exact work-authorization line, sign-off, and no banned phrases from profile §11
- [ ] With the generator unconfigured, the job-description form is hidden and the general letter still works
- [ ] With the generator configured, a submitted job description returns a letter with the required lines, and an unavailable generator falls back to the general letter
- [ ] More than 10 `/api/cover-letter` requests from one IP within an hour return HTTP 429
**Out of scope:** Tailored CV per job (F13, V1.1).
**Spec:** none

## Deferred

| Item | Reason |
|------|--------|
| F13 Tailored CV per job | V1.1 (Should-Have) in the PRD |
| F14 Villion case study | V1.1 (Should-Have) in the PRD |
| F15 Quiz Manager / MirzaBenevis case studies | V1.1 (Should-Have) in the PRD |
| F16 Chat transcript review in admin | V1.1 (Should-Have) in the PRD |
| F17 Case-study editing in admin | Future (Nice-to-Have) in the PRD |
| F18 Custom domain and VPS deployment | Future; deployment waits for the owner's VPS and domain |
| F19 Writing section | Future (Nice-to-Have) in the PRD |
| F20 Analytics | Deferred by decision in the PRD |
