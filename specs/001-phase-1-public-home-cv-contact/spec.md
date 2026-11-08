# Feature Specification: Phase 1 — Public Home, CV Download, and Contact

**Feature Branch**: `emad-personal-site/t_cb4978b7-phase-1-public-home-cv-and-contact`

**Created**: 2026-11-07

**Status**: Ready for planning — two open questions recorded (see Clarifications)

**Input**: Phase 1 of `PRD.phases.md` (`PRD.md` v1.3): F1 home page (home only), F4 CV download (all), F6 contact form (all), F11 container packaging (all), F12 accessibility and performance baseline (all).

**Scope fence**: case studies, About, `/llms.txt`, `/resume.json`, `/api/profile`, the Ask assistant, the cover letter and its generator, the admin panel, and every V1.1 item are out of scope for this feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recruiter reads the home page (Priority: P1)

A technical recruiter opens `/` from a LinkedIn or CV link, on a phone, and within seconds sees who Emad is, which roles he targets, whether he needs sponsorship, when he is available, and how to reach the CV, the case studies, and the contact form.

**Why this priority**: Without a home page there is no site to send anyone to; every other story in this phase is reached from it.

**Independent Test**: Load `/` with a static HTTP client, assert the headline, availability, authorization line, target roles, and the three one-click links are present in the served HTML; confirm the page renders with JavaScript disabled.

**Acceptance Scenarios**:

1. **Given** a visitor opens `/`, **When** the first viewport renders, **Then** the headline "AI and Agentic Systems Engineer with a strong foundation in software development" is visible.
2. **Given** a visitor opens `/`, **When** the page renders, **Then** the work-authorization line "Requires employer-sponsored work authorization." and the availability "one month notice" are displayed.
3. **Given** a visitor opens `/`, **When** they look for a next step, **Then** Case Studies, CV, and Contact are each reachable in one click.
4. **Given** a claim that is not present in the approved profile, **When** the home content is written, **Then** the claim is omitted (content review gate, not runtime logic).

---

### User Story 2 - Recruiter downloads and parses the CV (Priority: P1)

A recruiter downloads `/cv.pdf`, forwards it to a hiring manager, and both the human and an ATS parser read the same text: one column, standard headings, the authorization line, no text trapped in an image.

**Why this priority**: The CV is the artifact a recruiter forwards; a PDF that fails in an ATS undermines the whole site.

**Independent Test**: Request `/cv.pdf`, extract the text without OCR, and assert the six standard headings appear in order and the authorization line appears verbatim; confirm the PDF contains no rasterized text and no multi-column text flow.

**Acceptance Scenarios**:

1. **Given** a visitor requests `/cv.pdf`, **When** the PDF is returned, **Then** its text is extractable without OCR.
2. **Given** the CV is generated, **When** it is laid out, **Then** it uses a single column and the headings Summary, Experience, Skills, Projects, Education, Languages in that order.
3. **Given** the CV contains text inside an image or a multi-column table, **When** the build runs, **Then** the build check fails and names the offending section.
4. **Given** the CV is generated, **When** it renders, **Then** it includes "Requires employer-sponsored work authorization." verbatim.

---

### User Story 3 - Recruiter sends a contact message (Priority: P1)

A recruiter fills in name, email, and message on `/contact` and submits. Emad receives the message by email and a row is stored; an invalid submission shows field-level errors and stores nothing.

**Why this priority**: Contact is the conversion point of the site; a form that silently loses messages is worse than no form.

**Independent Test**: Submit a valid message (mail sink on the configured SMTP port), a malformed email, an empty message, a 5,001-character message, and a sixth submission from one IP; assert status codes, field errors, stored rows, and the delivered email's recipient.

**Acceptance Scenarios**:

1. **Given** a valid name, email, and message, **When** the form is submitted, **Then** an email is sent to emad.poursina.work@gmail.com via SMTP within 30 seconds.
2. **Given** a submission is accepted, **When** it is stored, **Then** exactly one row exists in the contact message store with timestamp, name, email, message, and delivery status.
3. **Given** a malformed email, an empty message, or a message longer than 5,000 characters, **When** it is submitted, **Then** the response carries field-level errors and nothing is stored.
4. **Given** SMTP delivery fails, **When** the submission was otherwise valid, **Then** the stored row keeps the status "failed" and the visitor is asked to email directly.
5. **Given** more than 5 submissions from one IP address within an hour, **When** the next one arrives, **Then** it is rejected with HTTP 429.
6. **Given** a visitor submits the form with JavaScript disabled, **When** the response returns, **Then** they see a readable success or error page, not raw JSON.

---

### User Story 4 - Owner runs the whole site from one command (Priority: P2)

Emad runs `docker compose up` on this machine with a filled `.env`, gets the site on a local port with its database on a named volume, and can rebuild the image without losing messages.

**Why this priority**: It is the deployment contract for every later phase, but the site is usable without it during development.

**Independent Test**: Start the stack from a clean state with a valid `.env`, read `/healthz`, submit a message, rebuild, and confirm the message still exists; then start again without SMTP settings and confirm the contact feature is disabled with a logged warning.

**Acceptance Scenarios**:

1. **Given** `docker compose up` runs with a valid `.env`, **When** the stack starts, **Then** the site answers on its local port and creates its database in a named volume.
2. **Given** the container is running, **When** the image and repository are inspected, **Then** no SMTP or other secret is present in the image or in git.
3. **Given** `.env` is missing a required SMTP setting, **When** the container starts, **Then** the contact feature is disabled and a warning is logged.
4. **Given** the container is rebuilt, **When** it starts again, **Then** existing stored messages are still present.
5. **Given** the site is running, **When** `/healthz` is requested, **Then** it reports the service as healthy.

---

### User Story 5 - Recruiter gets an accessible, fast page on any device (Priority: P2)

A recruiter on a mid-range phone, a keyboard-only user, and a screen-reader user all read the site quickly and navigate it without traps; every interactive element shows focus.

**Why this priority**: Accessibility is a release gate in the PRD and a fast page is the point of a static site, but both are only meaningful once the pages exist.

**Independent Test**: Load `/` with JavaScript disabled, tab through every interactive element, run the mobile Lighthouse audit, and run the contrast build check against the declared color tokens.

**Acceptance Scenarios**:

1. **Given** a visitor opens a content page, **When** the response is inspected, **Then** the page is prerendered HTML and reads fully without client-side JavaScript.
2. **Given** a visitor navigates by keyboard, **When** focus moves, **Then** every interactive element shows a visible focus indicator.
3. **Given** `/` is audited on the standard mobile profile, **When** the audit finishes, **Then** Performance is at least 95, Accessibility is 100, and LCP is under 2.0 seconds.
4. **Given** any text color pair used by a page, **When** its contrast ratio is below 4.5:1, **Then** the build check fails and names the offending token or section.

---

### Edge Cases

- A message of exactly 5,000 characters is accepted; 5,001 is rejected with a field-level error.
- Whitespace-only name or message counts as empty and is rejected.
- Email with plus-addressing or a subdomain is accepted; an address without `@` or without a dot in the domain is rejected.
- Every POST attempt from an IP counts toward the 5-per-hour limit, including rejected ones; the limit uses a rolling hour window.
- SMTP that hangs is treated as failed at 30 seconds; the row keeps status "failed".
- A database write failure returns an error and sends no email (store before send).
- If the database file cannot be opened at startup, the service still starts and `/healthz` reports the failure rather than crashing silently.
- If the approved profile file is missing at build time, the build fails with a message naming the file; no placeholder content is published.
- If a forwarded client IP header is present but proxy trust is not enabled, the header is ignored (no spoofable rate limit).
- First run with no named volume creates it; a rebuild reuses it.
- A missing `.env` leaves the site up with the contact feature disabled.
- Unknown public paths return 404; `/healthz` is never served as cached static content.

## Requirements *(mandatory)*

### Functional Requirements

**Home page (PRD F1)**

- **FR-001**: `/` MUST display the headline "AI and Agentic Systems Engineer with a strong foundation in software development" within the first viewport. (PRD F1 AC1)
- **FR-002**: `/` MUST display the work-authorization line "Requires employer-sponsored work authorization." and the availability "one month notice". (PRD F1 AC2)
- **FR-003**: `/` MUST display a short bio, the target roles, and the target countries Canada, Ireland, the United Kingdom, the Netherlands, and Portugal, all drawn only from the approved profile. (PRD §2, §10)
- **FR-004**: `/` MUST link to Case Studies, CV, and Contact so each is reachable in one click. (PRD F1 AC3)
- **FR-005**: Content MUST omit any claim that is not present in the approved profile; the omission is enforced by content review before the build is accepted. (PRD F1 AC4)

**CV download (PRD F4)**

- **FR-010**: `GET /cv.pdf` MUST return a PDF whose text is extractable without OCR. (F4 AC1)
- **FR-011**: The CV MUST use a single-column layout with the headings Summary, Experience, Skills, Projects, Education, Languages in that order. (F4 AC2)
- **FR-012**: The build MUST fail, naming the offending section, if the CV contains text inside an image or a multi-column table. (F4 AC3)
- **FR-013**: The CV MUST contain "Requires employer-sponsored work authorization." verbatim. (F4 AC4)
- **FR-014**: Every CV fact MUST come from the approved profile. (F4, PRD §8 maintainability)

**Contact form (PRD F6, F11 AC3)**

- **FR-020**: `/contact` MUST provide a form with name, email, and message fields, each labelled, and MUST remain readable without client-side JavaScript. (F6, F12 AC1)
- **FR-021**: A valid submission MUST send an email to emad.poursina.work@gmail.com via SMTP within 30 seconds. (F6 AC1)
- **FR-022**: An accepted submission MUST store exactly one row containing timestamp, name, email, message, and delivery status. (F6 AC2)
- **FR-023**: A malformed email, an empty message, or a message longer than 5,000 characters MUST be rejected with field-level errors and MUST store nothing. (F6 AC3)
- **FR-024**: When SMTP delivery fails, the stored row MUST keep delivery status "failed" and the visitor MUST be told to email directly. (F6 AC4)
- **FR-025**: More than 5 submissions from one IP address within an hour MUST return HTTP 429. (F6 AC5)
- **FR-026**: When required SMTP settings are absent, a submission MUST be refused with HTTP 503, nothing stored, and the visitor shown the direct email address; `/contact` MUST always display that direct email address as a fallback, independent of build-time configuration. (F11 AC3)
- **FR-027**: A submission from a browser without JavaScript MUST receive a human-readable HTML outcome (success, field errors, rate limit, or disabled), not a bare JSON body; a client that asks for JSON MUST receive machine-readable JSON with the same status codes.

**Container packaging (PRD F11)**

- **FR-030**: `docker compose up` with a valid `.env` MUST serve the site on a local port. (F11 AC1)
- **FR-031**: The database MUST live in a named volume, not in the image or a bind mount. (F11 AC1)
- **FR-032**: Secrets MUST NOT appear in the image, in git, or in logs. (F11 AC2)
- **FR-033**: A missing required SMTP setting MUST leave the site running with the contact feature disabled and a warning in the log. (F11 AC3)
- **FR-034**: Rebuilding the image MUST preserve stored messages. (F11 AC4)
- **FR-035**: `GET /healthz` MUST report service health without exposing secrets.

**Accessibility and performance (PRD F12)**

- **FR-040**: Content pages MUST be served prerendered and readable with client-side JavaScript disabled. (F12 AC1)
- **FR-041**: Every interactive element MUST show a visible focus indicator during keyboard navigation. (F12 AC2)
- **FR-042**: `/` MUST score at least 95 Performance and 100 Accessibility in the standard mobile Lighthouse audit. (F12 AC3)
- **FR-043**: Any text/background pair below 4.5:1 contrast MUST fail the build and name the offending token or section. No large-text exception is granted: the PRD's criterion is 4.5:1 for all text. (F12 AC4)
- **FR-044**: LCP on `/` MUST be under 2.0 seconds on the PRD mid-range phone profile. (PRD §8)

### Key Entities

- **Contact message**: one visitor submission — timestamp, name, email, message text, delivery status (`sent` or `failed`); belongs to no other entity; retained until the owner deletes it.
- **Approved profile**: the single approved content source for the home copy and the CV; supplies display name, target roles, bio, availability, authorization line, experience, skills, projects, education, and languages. Its contents are not invented by this feature.
- **CV artifact**: the downloadable PDF built from the approved profile; carries the same facts as the site.
- **Rate-limit window**: per-IP count over a rolling hour for contact submissions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader of `/` can state Emad's role, sponsorship need, availability, and the CV and contact destinations after one page load; verified by content assertions on the served HTML.
- **SC-002**: 100% of the CV's headings and its authorization line are recoverable from the PDF text layer without OCR, and the build fails if they are not.
- **SC-003**: A valid contact submission produces exactly one stored message and one outbound email to the configured recipient within 30 seconds; invalid submissions produce zero stored rows.
- **SC-004**: A sixth submission from one IP within an hour is refused with 429.
- **SC-005**: From a clean host, the packaged site reaches a healthy state within 60 seconds of a single start command, and a rebuild preserves every previously stored message.
- **SC-006**: The home page scores at least 95 Performance, 100 Accessibility, and under 2.0 seconds LCP in the standard mobile audit; any sub-4.5:1 text pair fails the build.
- **SC-007**: Every content page reads completely with JavaScript disabled.

## Assumptions

- The approved profile file (`master-profile.md`) will be supplied by the owner before build content is written; until then, the build fails loudly instead of publishing placeholder facts. Recorded as Open Question 1.
- SMTP credentials for `emad.poursina.work@gmail.com` remain unavailable in this environment (PRD R12); the feature is verified end to end against a local SMTP sink, and a live Gmail send is a separate owner check. Recorded as Open Question 2.
- "Case Studies" on the home page links to the case-studies destination delivered in Phase 2; in Phase 1 that target may return 404. This keeps the one-click requirement honest without pulling F2 into this phase.
- The PRD mid-range phone profile is approximated by the standard Lighthouse mobile configuration (simulated 4G, 4× CPU slowdown); the exact command is pinned in the plan so the result is reproducible.
- One container, one SQLite file, single-digit concurrent writers: an in-process rate limiter is adequate; no external cache is introduced.
- The site is served over plain HTTP locally; TLS arrives with the VPS in a later phase.
- The owner is the only admin; no admin surface is built in this phase.

## Clarifications

### Session 2026-11-07

- Q: Where is `master-profile.md`, the single approved content source for the bio, target roles, CV, and authorization text? → A: **OPEN** — the file is not in the repository and not on this host. Spec, plan, and tasks assume it will be supplied at a stated path before content work starts; no profile fact is invented anywhere. Open Question 1.
- Q: How should the contact form's email delivery (F6 AC1) be verified when no SMTP credentials exist in this environment? → A: **OPEN, with a default** — automated verification uses a local SMTP sink that receives the message and records the envelope recipient (proving recipient, body, and timing); a live Gmail send stays an owner-signed manual check. Open Question 2 asks the owner to accept this or supply Gmail app-password credentials.

- Q: What should the home page's "Case Studies" link point to while case studies (F2) are outside this phase's fence? → A: `/case-studies`, the canonical destination from PRD §6, which returns 404 until Phase 2 lands. No placeholder page is added, because case studies are explicitly out of scope for Phase 1; the owner can override this with a one-line placeholder if a dead link is unacceptable in the interim.

No other spec-level ambiguity changed the plan; implementation-method questions were deferred to the plan.

## Open Questions

- **OQ-1 — approved profile file (blocks build content, not planning).** `master-profile.md` is not in the repository and not anywhere on this host. It is the only approved source for the bio, target roles, experience dates, skills with levels, education, languages, projects, and the authorization text. Action for the operator: supply the file (absolute path or content) or commit it at `content/master-profile.md`. Until then the build fails with a message naming the file; no profile fact is invented in the spec, plan, or tasks.
- **OQ-2 — SMTP credentials for F6 AC1 (blocks a live send, not the build).** No `.env` and no SMTP credentials exist on this host (PRD R12). Default accepted for planning: automated verification runs against a local SMTP sink that records the envelope recipient and message, proving the application's SMTP path end to end; a live Gmail send remains an owner-signed manual check. Action for the operator: either accept this verification mode in writing or supply Gmail app-password credentials for `emad.poursina.work@gmail.com` before the contact acceptance is signed off.

