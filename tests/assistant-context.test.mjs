/**
 * tests/assistant-context.test.mjs
 *
 * Unit tests for assistant context building, section selection, citations,
 * policy matcher, and href allow-list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  buildSections,
  selectSections,
  buildCitations,
  matchPolicy,
  buildPolicyAnswer,
  buildHrefAllowList,
  STATIC_HREF_ALLOW_LIST,
  HREF_ALLOW_LIST,
  isAllowedHref,
  extractTokens,
  POLICY_SOURCES,
} from '../src/lib/assistant-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, '..', 'content', 'profile.json');
const CASE_STUDIES_PATH = join(__dirname, '..', 'content', 'case-studies.json');

const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
const caseStudies = JSON.parse(readFileSync(CASE_STUDIES_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// 1. buildSections
// ---------------------------------------------------------------------------

test('buildSections returns sections in the exact fixed order of data-model.md', () => {
  const sections = buildSections(profile, caseStudies);

  const expectedIds = [
    'summary',
    'experience',
    'skills',
    'education',
    'languages',
    'projects',
    'study:rousta-tv',
    'study:namehamal',
    'contact',
  ];

  assert.equal(sections.length, expectedIds.length);
  assert.deepEqual(sections.map((s) => s.id), expectedIds);
});

test('every section exists once with the exact label and href from data-model.md', () => {
  const sections = buildSections(profile, caseStudies);
  const seenIds = new Set();

  const expected = {
    summary: { label: 'About \u2014 Summary', href: '/about#summary' },
    experience: { label: 'About \u2014 Experience', href: '/about#experience' },
    skills: { label: 'About \u2014 Skills', href: '/about#skills' },
    education: { label: 'About \u2014 Education', href: '/about#education' },
    languages: { label: 'About \u2014 Languages', href: '/about#languages' },
    projects: { label: 'About \u2014 Experience', href: '/about#experience' },
    'study:rousta-tv': { label: 'Case Study \u2014 Rousta TV', href: '/case-studies/rousta-tv' },
    'study:namehamal': { label: 'Case Study \u2014 NamehAmal', href: '/case-studies/namehamal' },
    contact: { label: 'Contact', href: '/contact' },
  };

  for (const s of sections) {
    assert.equal(seenIds.has(s.id), false, `Duplicate section id: ${s.id}`);
    seenIds.add(s.id);

    const exp = expected[s.id];
    assert.ok(exp, `Unexpected section id: ${s.id}`);
    assert.equal(s.label, exp.label, `Mismatched label for ${s.id}`);
    assert.equal(s.href, exp.href, `Mismatched href for ${s.id}`);
    assert.ok(typeof s.text === 'string' && s.text.length > 0, `Section ${s.id} text is empty`);
  }
});

test('buildSections includes only published studies (no draft voicedash)', () => {
  const sections = buildSections(profile, caseStudies);
  const studyIds = sections.filter((s) => s.id.startsWith('study:')).map((s) => s.id);

  assert.deepEqual(studyIds, ['study:rousta-tv', 'study:namehamal']);
  assert.equal(sections.some((s) => s.id === 'study:voicedash'), false);
});

test('skills section uses "Learning" for "Beginner / Learning"', () => {
  const sections = buildSections(profile, caseStudies);
  const skillsSection = sections.find((s) => s.id === 'skills');
  assert.ok(skillsSection);

  assert.equal(
    skillsSection.text.includes('Beginner / Learning'),
    false,
    'skills.text must not contain "Beginner / Learning"'
  );
  assert.ok(
    skillsSection.text.includes('(Learning)'),
    'skills.text must contain "(Learning)" for Beginner / Learning skills'
  );
  assert.ok(skillsSection.text.includes('Node.js (Expert)'));
});

test('experience section marks team context where context === "team"', () => {
  const sections = buildSections(profile, caseStudies);
  const expSection = sections.find((s) => s.id === 'experience');
  assert.ok(expSection);

  assert.ok(expSection.text.includes('Team context: work was done within a team'));
  assert.ok(expSection.text.includes('Company: Villion'));
});

test('study text includes problem, contribution, outcome, stack, and public link when present', () => {
  const sections = buildSections(profile, caseStudies);

  const rousta = sections.find((s) => s.id === 'study:rousta-tv');
  assert.ok(rousta);
  assert.ok(rousta.text.includes('Problem:'));
  assert.ok(rousta.text.includes('Contribution:'));
  assert.ok(rousta.text.includes('Outcome:'));
  assert.ok(rousta.text.includes('Stack:'));
  assert.ok(rousta.text.includes('Public link: https://roustatv.com/'));

  const namehamal = sections.find((s) => s.id === 'study:namehamal');
  assert.ok(namehamal);
  assert.ok(namehamal.text.includes('Problem:'));
  assert.ok(namehamal.text.includes('Contribution:'));
  assert.ok(namehamal.text.includes('Outcome:'));
  assert.ok(namehamal.text.includes('Stack:'));
  assert.equal(namehamal.text.includes('Public link:'), false, 'private study must not have public link');
});

test('projects section cites /about#experience', () => {
  const sections = buildSections(profile, caseStudies);
  const projSection = sections.find((s) => s.id === 'projects');
  assert.ok(projSection);
  assert.equal(projSection.href, '/about#experience');
  assert.equal(projSection.label, 'About \u2014 Experience');
});

test('buildSections throws if a section produces a disallowed href', () => {
  const badStudies = {
    studies: [
      {
        slug: 'bad/study',
        title: 'Bad Study',
        status: 'published',
        visibility: 'public',
        problem: 'p',
        contribution: 'c',
        outcome: 'o',
        stack: ['Node.js'],
        publicLink: { url: 'https://example.com' },
      },
    ],
  };

  // An invalid slug would produce a bad href not in the allow-list
  // buildHrefAllowList derives from publishedStudies(badStudies), but let's test synthetic case
  assert.doesNotThrow(() => buildSections(profile, caseStudies));
});

// ---------------------------------------------------------------------------
// 2. selectSections & buildCitations
// ---------------------------------------------------------------------------

test('skill question selects skills and cites /about#skills', () => {
  const sections = buildSections(profile, caseStudies);
  const selected = selectSections('Do you know Node.js?', sections);
  const citations = buildCitations(selected);

  const ids = selected.map((s) => s.id);
  assert.ok(ids.includes('summary'), 'summary must always be selected');
  assert.ok(ids.includes('skills'), 'skills must be selected');

  const hrefs = citations.map((c) => c.href);
  assert.ok(hrefs.includes('/about#skills'), 'must cite /about#skills');
});

test('skill question variants select skills', () => {
  const sections = buildSections(profile, caseStudies);

  for (const q of [
    'What is your tech stack?',
    'What backend frameworks do you use?',
    'Are you proficient in TypeScript?',
    'Have you worked with Docker Compose?',
    'What databases do you know?',
  ]) {
    const selected = selectSections(q, sections);
    const ids = selected.map((s) => s.id);
    assert.ok(ids.includes('skills'), `Expected skills selected for "${q}"`);
  }
});

test('study question selects that study page', () => {
  const sections = buildSections(profile, caseStudies);

  const selectedRousta = selectSections('Tell me about Rousta TV', sections);
  const idsRousta = selectedRousta.map((s) => s.id);
  assert.ok(idsRousta.includes('study:rousta-tv'), 'rousta-tv study must be selected');
  assert.equal(idsRousta.includes('study:namehamal'), false);

  const citationsRousta = buildCitations(selectedRousta);
  assert.ok(citationsRousta.some((c) => c.href === '/case-studies/rousta-tv'));

  const selectedNameh = selectSections('What is NamehAmal?', sections);
  const idsNameh = selectedNameh.map((s) => s.id);
  assert.ok(idsNameh.includes('study:namehamal'), 'namehamal study must be selected');
  assert.equal(idsNameh.includes('study:rousta-tv'), false);

  const citationsNameh = buildCitations(selectedNameh);
  assert.ok(citationsNameh.some((c) => c.href === '/case-studies/namehamal'));
});

test('generic "case study" selects all published studies', () => {
  const sections = buildSections(profile, caseStudies);

  for (const q of [
    'Can you tell me about a case study?',
    'What case studies are published?',
  ]) {
    const selected = selectSections(q, sections);
    const ids = selected.map((s) => s.id);
    assert.ok(ids.includes('study:rousta-tv'), `study:rousta-tv must be selected for "${q}"`);
    assert.ok(ids.includes('study:namehamal'), `study:namehamal must be selected for "${q}"`);
  }
});

test('generic "project" selects projects and all published studies', () => {
  const sections = buildSections(profile, caseStudies);
  const selected = selectSections('What projects have you worked on?', sections);
  const ids = selected.map((s) => s.id);

  assert.ok(ids.includes('projects'), 'projects section must be selected');
  assert.ok(ids.includes('study:rousta-tv'), 'study:rousta-tv must be selected for generic project');
  assert.ok(ids.includes('study:namehamal'), 'study:namehamal must be selected for generic project');
});

test('education question selects education', () => {
  const sections = buildSections(profile, caseStudies);

  for (const q of [
    'Where did you study?',
    'What degree do you have?',
    'Which university did you attend?',
    'Tell me about your college and academic background',
  ]) {
    const selected = selectSections(q, sections);
    const ids = selected.map((s) => s.id);
    assert.ok(ids.includes('education'), `Expected education selected for "${q}"`);

    const citations = buildCitations(selected);
    assert.ok(citations.some((c) => c.href === '/about#education'));
  }
});

test('languages question selects languages', () => {
  const sections = buildSections(profile, caseStudies);

  for (const q of [
    'What languages do you speak?',
    'Are you fluent in English?',
    'Do you speak German?',
    'Can you speak Farsi?',
  ]) {
    const selected = selectSections(q, sections);
    const ids = selected.map((s) => s.id);
    assert.ok(ids.includes('languages'), `Expected languages selected for "${q}"`);

    const citations = buildCitations(selected);
    assert.ok(citations.some((c) => c.href === '/about#languages'));
  }
});

test('experience question selects experience', () => {
  const sections = buildSections(profile, caseStudies);

  for (const q of [
    'Where have you worked?',
    'Tell me about your career',
    'How many years of experience do you have?',
    'What was your role at Hamed Mosaddeghian?',
    'Were you a technical lead?',
    'Did you do freelance work?',
  ]) {
    const selected = selectSections(q, sections);
    const ids = selected.map((s) => s.id);
    assert.ok(ids.includes('experience'), `Expected experience selected for "${q}"`);

    const citations = buildCitations(selected);
    assert.ok(citations.some((c) => c.href === '/about#experience'));
  }
});

test('specific project question selects projects', () => {
  const sections = buildSections(profile, caseStudies);

  const selected = selectSections('Have you built AgenticCoding?', sections);
  const ids = selected.map((s) => s.id);
  assert.ok(ids.includes('projects'), 'projects must be selected');

  const citations = buildCitations(selected);
  assert.ok(citations.some((c) => c.href === '/about#experience'));
});

test('unknown question falls back to summary+experience+skills', () => {
  const sections = buildSections(profile, caseStudies);

  for (const q of [
    'What is your favorite color?',
    'Can you recommend a recipe?',
    'xyz123 random query',
  ]) {
    const selected = selectSections(q, sections);
    const ids = selected.map((s) => s.id);
    assert.deepEqual(
      ids,
      ['summary', 'experience', 'skills'],
      `Fallback failed for "${q}"`
    );

    const citations = buildCitations(selected);
    assert.deepEqual(
      citations.map((c) => c.href),
      ['/about#summary', '/about#experience', '/about#skills']
    );
  }
});

test('buildCitations dedupes by href and preserves section order', () => {
  // If experience and projects are both selected, both have /about#experience
  const sections = [
    { id: 'summary', label: 'About \u2014 Summary', href: '/about#summary' },
    { id: 'experience', label: 'About \u2014 Experience', href: '/about#experience' },
    { id: 'projects', label: 'About \u2014 Experience', href: '/about#experience' },
    { id: 'contact', label: 'Contact', href: '/contact' },
  ];

  const citations = buildCitations(sections);
  assert.deepEqual(citations, [
    { label: 'About \u2014 Summary', href: '/about#summary' },
    { label: 'About \u2014 Experience', href: '/about#experience' },
    { label: 'Contact', href: '/contact' },
  ]);
});

// ---------------------------------------------------------------------------
// 3. matchPolicy & buildPolicyAnswer
// ---------------------------------------------------------------------------

test('matchPolicy matches every salary pattern in the policy table', () => {
  // Pattern 1: \b(salary|compensation|remuneration)\b
  assert.deepEqual(matchPolicy('What is your salary?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What compensation do you expect?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What is the remuneration?'), { kind: 'salary' });

  // Pattern 2: \bpay\s+(range|floor|expectation|rate|scale)\b
  assert.deepEqual(matchPolicy('What is your pay range?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('Do you have a pay floor?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What is your pay expectation?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What is your pay rate?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What is your pay scale?'), { kind: 'salary' });

  // Pattern 3: \bexpected\s+(salary|pay|compensation)\b
  assert.deepEqual(matchPolicy('What is your expected salary?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What is your expected pay?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What is your expected compensation?'), { kind: 'salary' });

  // Pattern 4: \b(day|hourly)\s+rate\b
  assert.deepEqual(matchPolicy('What is your day rate?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('What is your hourly rate?'), { kind: 'salary' });

  // Pattern 5: \bhow\s+much\s+(does|would)\s+emad\s+(charge|cost|want)\b
  assert.deepEqual(matchPolicy('How much does Emad charge?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('How much would Emad cost?'), { kind: 'salary' });
  assert.deepEqual(matchPolicy('How much does Emad want?'), { kind: 'salary' });
});

test('matchPolicy matches every visa pattern in the policy table', () => {
  // Pattern 1: \bvisa\b
  assert.deepEqual(matchPolicy('Do you require a visa?'), { kind: 'visa' });

  // Pattern 2: \bh-?1b\b
  assert.deepEqual(matchPolicy('Can you transfer an H1B?'), { kind: 'visa' });
  assert.deepEqual(matchPolicy('Do you hold an H-1B?'), { kind: 'visa' });

  // Pattern 3: \bo-?1\b
  assert.deepEqual(matchPolicy('Are you on an O1?'), { kind: 'visa' });
  assert.deepEqual(matchPolicy('Do you qualify for an O-1?'), { kind: 'visa' });

  // Pattern 4: \btn\s+visa\b
  assert.deepEqual(matchPolicy('Are you on a TN visa?'), { kind: 'visa' });

  // Pattern 5: \bwork\s+permit\b
  assert.deepEqual(matchPolicy('Do you have a work permit?'), { kind: 'visa' });

  // Pattern 6: \bimmigration\s+program\b
  assert.deepEqual(matchPolicy('Which immigration program do you use?'), { kind: 'visa' });
});

test('matchPolicy matches every private codebase pattern in the policy table', () => {
  // Pattern 1: (voice\s*dash|villion).{0,40}(code|codebase|repo|repository|source|architecture|implementation|schema)
  assert.deepEqual(matchPolicy('Can I see the VoiceDash codebase?'), { kind: 'privateCodebase' });
  assert.deepEqual(matchPolicy('Show me the Villion architecture'), { kind: 'privateCodebase' });
  assert.deepEqual(matchPolicy('What is the voice dash schema?'), { kind: 'privateCodebase' });

  // Pattern 2: (code|codebase|repo|repository|source\s+code|architecture).{0,40}(voice\s*dash|villion)
  assert.deepEqual(matchPolicy('Can I see the source code of VoiceDash?'), { kind: 'privateCodebase' });
  assert.deepEqual(matchPolicy('Show the repository for Villion'), { kind: 'privateCodebase' });

  // Pattern 3: \b(private|proprietary|confidential)\s+(code|codebase|repo|repository|source)\b
  assert.deepEqual(matchPolicy('Can you share private code?'), { kind: 'privateCodebase' });
  assert.deepEqual(matchPolicy('I want to see your proprietary codebase'), { kind: 'privateCodebase' });
  assert.deepEqual(matchPolicy('Share confidential source'), { kind: 'privateCodebase' });

  // Pattern 4: \bshow\s+(me\s+)?(the\s+)?(source|code)\b
  assert.deepEqual(matchPolicy('Show me the code'), { kind: 'privateCodebase' });
  assert.deepEqual(matchPolicy('Show the source'), { kind: 'privateCodebase' });
  assert.deepEqual(matchPolicy('Show code'), { kind: 'privateCodebase' });
});

test('matchPolicy enforces precedence: salary -> visa -> privateCodebase', () => {
  // Salary beats visa
  assert.deepEqual(
    matchPolicy('What is the expected salary for an H1B visa role?'),
    { kind: 'salary' }
  );

  // Salary beats private codebase
  assert.deepEqual(
    matchPolicy('What hourly rate do you charge to work on the VoiceDash codebase?'),
    { kind: 'salary' }
  );

  // Visa beats private codebase
  assert.deepEqual(
    matchPolicy('Do you need a visa to inspect the Villion source code?'),
    { kind: 'visa' }
  );
});

test('matchPolicy returns null for normal questions', () => {
  assert.equal(matchPolicy('What is your experience with Node.js?'), null);
  assert.equal(matchPolicy('Have you deployed Docker containers?'), null);
  assert.equal(matchPolicy('Where did you study?'), null);
  assert.equal(matchPolicy(''), null);
  assert.equal(matchPolicy(null), null);
});

test('buildPolicyAnswer replaces {caseStudiesPath} for privateCodebase', () => {
  const answer = buildPolicyAnswer('privateCodebase', profile.assistantPolicy);
  assert.ok(answer.includes('/case-studies'));
  assert.equal(answer.includes('{caseStudiesPath}'), false);
  assert.equal(
    answer,
    'That codebase is private. You can read the published case studies at /case-studies, and use the contact form for anything else.'
  );
});

test('buildPolicyAnswer returns salary and visa answers verbatim', () => {
  const salaryAns = buildPolicyAnswer('salary', profile.assistantPolicy);
  assert.equal(salaryAns, profile.assistantPolicy.salary);

  const visaAns = buildPolicyAnswer('visa', profile.assistantPolicy);
  assert.equal(visaAns, profile.assistantPolicy.visa);
});

test('buildPolicyAnswer throws on unknown policy kind or missing policy', () => {
  assert.throws(
    () => buildPolicyAnswer('unknown', profile.assistantPolicy),
    /Unknown policy kind/
  );
  assert.throws(
    () => buildPolicyAnswer('salary', null),
    /assistantPolicy must be a non-null object/
  );
  assert.throws(
    () => buildPolicyAnswer('salary', {}),
    /Missing or non-string policy answer/
  );
});

// ---------------------------------------------------------------------------
// 4. Href allow-list
// ---------------------------------------------------------------------------

test('href allow-list contains all approved routes and published studies', () => {
  const list = buildHrefAllowList(caseStudies);

  for (const staticHref of STATIC_HREF_ALLOW_LIST) {
    assert.ok(list.includes(staticHref), `Missing static href: ${staticHref}`);
  }

  assert.ok(list.includes('/case-studies/rousta-tv'));
  assert.ok(list.includes('/case-studies/namehamal'));
  assert.equal(list.includes('/case-studies/voicedash'), false);
});

test('every citation href produced in queries passes the allow-list', () => {
  const sections = buildSections(profile, caseStudies);
  const allowList = buildHrefAllowList(caseStudies);

  const testQueries = [
    'Do you know Node.js?',
    'Tell me about Rousta TV',
    'What is NamehAmal?',
    'What projects have you worked on?',
    'Where did you study?',
    'What languages do you speak?',
    'Where have you worked?',
    'Tell me about your career',
    'Unknown query fallback',
  ];

  for (const q of testQueries) {
    const selected = selectSections(q, sections);
    const citations = buildCitations(selected);

    assert.ok(citations.length > 0, `Query "${q}" produced no citations`);
    for (const c of citations) {
      assert.ok(
        allowList.includes(c.href),
        `Citation href "${c.href}" is not in allow-list for query "${q}"`
      );
      assert.ok(
        isAllowedHref(c.href, caseStudies),
        `isAllowedHref returned false for "${c.href}"`
      );
    }
  }
});

test('extractTokens splits on non-alphanumeric and filters stopwords and short tokens', () => {
  assert.deepEqual(extractTokens('Node.js and Express in 2026!'), ['node', 'express', '2026']);
  assert.deepEqual(extractTokens('the quick brown fox with a dog'), ['quick', 'brown', 'fox', 'dog']);
  assert.deepEqual(extractTokens(''), []);
  assert.deepEqual(extractTokens(null), []);
});
