/**
 * tests/agent-output.test.mjs
 *
 * Unit tests for src/lib/agent-output.mjs.
 * Run with: node --test tests/agent-output.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildResume,
  buildProfileApi,
  buildLlmsTxt,
  buildPersonJsonLd,
  buildSitemap
} from '../src/lib/agent-output.mjs';
import { getSiteUrl } from '../src/lib/site.mjs';
import { validateProfile } from '../src/lib/profile.mjs';
import { validateCaseStudies } from '../src/lib/case-studies.mjs';

// Load both content JSON files from disk and validate them before use
const profilePath = resolve(process.cwd(), 'content/profile.json');
const caseStudiesPath = resolve(process.cwd(), 'content/case-studies.json');

const profileRaw = readFileSync(profilePath, 'utf8');
const caseStudiesRaw = readFileSync(caseStudiesPath, 'utf8');

const profile = JSON.parse(profileRaw);
const caseStudies = JSON.parse(caseStudiesRaw);

validateProfile(profile, profilePath);
validateCaseStudies(caseStudies, caseStudiesPath);

test('1. buildResume: JSON Resume v1.0.0 mapping and constraints', () => {
  const resume = buildResume(profile, caseStudies);

  // $schema pinned URL
  assert.equal(
    resume['$schema'],
    'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json'
  );

  // meta.version 'v1.0.0'
  assert.deepEqual(resume.meta, { version: 'v1.0.0' });

  // 61 skills each an object with only a `name` key, names in profile order
  assert.equal(resume.skills.length, 61);
  assert.equal(resume.skills.length, profile.skills.length);
  for (let i = 0; i < resume.skills.length; i++) {
    const skill = resume.skills[i];
    assert.deepEqual(Object.keys(skill), ['name']);
    assert.equal(skill.name, profile.skills[i].name);
  }

  // work[].endDate present for the ended role and absent for every 'present' role; highlights equal points
  assert.equal(resume.work.length, profile.experience.length);
  for (let i = 0; i < resume.work.length; i++) {
    const workItem = resume.work[i];
    const expItem = profile.experience[i];

    if (expItem.end && expItem.end !== 'present') {
      assert.equal(workItem.endDate, expItem.end);
      assert.ok('endDate' in workItem);
    } else {
      assert.equal('endDate' in workItem, false);
    }

    assert.deepEqual(workItem.highlights, expItem.points);
  }

  // education studyType 'Associate Degree', area 'Computer Engineering', startDate '2019', endDate '2023'
  assert.ok(Array.isArray(resume.education) && resume.education.length > 0);
  const edu = resume.education[0];
  assert.equal(edu.studyType, 'Associate Degree');
  assert.equal(edu.area, 'Computer Engineering');
  assert.equal(edu.startDate, '2019');
  assert.equal(edu.endDate, '2023');

  // projects length 8 = the six profile projects in order (the three with url '' have no url key)
  // then exactly Rousta TV and NamehAmal in content order
  assert.equal(resume.projects.length, 8);
  for (let i = 0; i < 6; i++) {
    const proj = resume.projects[i];
    const profileProj = profile.projects[i];
    assert.equal(proj.name, profileProj.name);
    assert.equal(proj.description, profileProj.description);
    if (profileProj.url && profileProj.url.trim() !== '') {
      assert.equal(proj.url, profileProj.url.trim());
      assert.ok('url' in proj);
    } else {
      assert.equal('url' in proj, false);
    }
  }

  // Then exactly Rousta TV and NamehAmal in content order
  assert.equal(resume.projects[6].name, 'Rousta TV');
  assert.equal(resume.projects[7].name, 'NamehAmal');
  assert.ok('url' in resume.projects[6]);
  assert.equal('url' in resume.projects[7], false);

  // every project url is non-empty (for any project that has a url)
  for (const proj of resume.projects) {
    if ('url' in proj) {
      assert.ok(typeof proj.url === 'string' && proj.url.length > 0);
    }
  }

  // VoiceDash appears exactly once as a project (the profile project) and no '/case-studies/voicedash' appears anywhere
  const voiceDashProjects = resume.projects.filter((p) => p.name === 'VoiceDash');
  assert.equal(voiceDashProjects.length, 1);
  assert.equal(voiceDashProjects[0].url, 'https://voicedash.ai');
  const serialized = JSON.stringify(resume);
  assert.equal(serialized.includes('/case-studies/voicedash'), false);

  // languages mapping
  assert.equal(resume.languages.length, profile.languages.length);
  for (let i = 0; i < resume.languages.length; i++) {
    assert.deepEqual(resume.languages[i], {
      language: profile.languages[i].name,
      fluency: profile.languages[i].level
    });
  }
});

test('2. buildProfileApi: enriched profile for /api/profile', () => {
  const resume = buildResume(profile, caseStudies);
  const api = buildProfileApi(profile, caseStudies);

  // every key except skills and last_updated deep-equals buildResume
  const { skills: rSkills, ...rRest } = resume;
  const { skills: aSkills, last_updated: aLu, ...aRest } = api;

  assert.equal('last_updated' in resume, false);
  assert.deepEqual(aRest, rRest);

  // last_updated === profile.lastUpdated
  assert.equal(api.last_updated, profile.lastUpdated);

  // api skills are {name,level,category} in profile order
  assert.equal(api.skills.length, profile.skills.length);
  for (let i = 0; i < api.skills.length; i++) {
    assert.deepEqual(api.skills[i], {
      name: profile.skills[i].name,
      level: profile.skills[i].level,
      category: profile.skills[i].category
    });
  }
});

test('3. buildLlmsTxt: plain text llms.txt structure and contents', () => {
  const text = buildLlmsTxt(profile, caseStudies);
  const siteUrl = getSiteUrl();

  // the section headers in order:
  // # Emad Poursina, > headline, ## Target roles, ## Work authorization, ## Availability, ## Case studies, ## CV, ## Contact
  const expectedHeaders = [
    `# ${profile.name}`,
    `> ${profile.headline}`,
    '## Target roles',
    '## Work authorization',
    '## Availability',
    '## Case studies',
    '## CV',
    '## Contact'
  ];

  let searchIndex = 0;
  for (const header of expectedHeaders) {
    const idx = text.indexOf(header, searchIndex);
    assert.ok(
      idx !== -1,
      `Expected section header "${header}" to appear after index ${searchIndex}`
    );
    searchIndex = idx + header.length;
  }

  // every target role line
  for (const role of profile.targetRoles) {
    assert.ok(
      text.includes(`- ${role}`),
      `Expected target role "- ${role}" in llms.txt`
    );
  }

  // both published study URLs
  assert.ok(
    text.includes(`- Rousta TV: ${siteUrl}/case-studies/rousta-tv`),
    'Expected published study Rousta TV URL in llms.txt'
  );
  assert.ok(
    text.includes(`- NamehAmal: ${siteUrl}/case-studies/namehamal`),
    'Expected published study NamehAmal URL in llms.txt'
  );

  // the CV and contact URLs and the email
  assert.ok(
    text.includes(`- ${siteUrl}/cv.pdf`),
    'Expected CV URL in llms.txt'
  );
  assert.ok(
    text.includes(`- ${siteUrl}/contact`),
    'Expected contact URL in llms.txt'
  );
  assert.ok(
    text.includes(`- ${profile.contactEmail}`),
    'Expected contact email in llms.txt'
  );

  // no 'voicedash'
  assert.equal(
    text.toLowerCase().includes('voicedash'),
    false,
    'Expected no "voicedash" anywhere in llms.txt'
  );

  // ends with a newline
  assert.ok(text.endsWith('\n'), 'Expected llms.txt to end with a newline');
});

test('4. buildPersonJsonLd: Schema.org Person JSON-LD object', () => {
  const person = buildPersonJsonLd(profile);

  // exactly six keys (@context,@type,name,jobTitle,email,sameAs,knowsAbout)
  const expectedKeys = ['@context', '@type', 'name', 'jobTitle', 'email', 'sameAs', 'knowsAbout'];
  assert.deepEqual(Object.keys(person).sort(), expectedKeys.sort());

  // @context 'https://schema.org', @type 'Person'
  assert.equal(person['@context'], 'https://schema.org');
  assert.equal(person['@type'], 'Person');

  // name/jobTitle/email equal the profile
  assert.equal(person.name, profile.name);
  assert.equal(person.jobTitle, profile.headline);
  assert.equal(person.email, profile.contactEmail);

  // sameAs equals [links.linkedin, links.github]
  assert.deepEqual(person.sameAs, [profile.links.linkedin, profile.links.github]);

  // knowsAbout length 36 and contains no 'Beginner / Learning' skill name
  assert.equal(person.knowsAbout.length, 36);

  const beginnerSkills = new Set(
    profile.skills
      .filter((s) => s.level === 'Beginner / Learning')
      .map((s) => s.name)
  );

  for (const skillName of person.knowsAbout) {
    assert.equal(
      beginnerSkills.has(skillName),
      false,
      `Expected "${skillName}" not to be a Beginner / Learning skill`
    );
  }
});

test('5. buildSitemap: sitemap.xml structure and URLs', () => {
  const xml = buildSitemap(caseStudies);
  const siteUrl = getSiteUrl();

  // loc path list exactly ['/','/about','/case-studies','/contact','/case-studies/rousta-tv','/case-studies/namehamal']
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

  const expectedPaths = [
    '/',
    '/about',
    '/case-studies',
    '/contact',
    '/case-studies/rousta-tv',
    '/case-studies/namehamal'
  ];

  // every loc starts with getSiteUrl()
  for (const loc of locs) {
    assert.ok(
      loc.startsWith(siteUrl),
      `Expected loc "${loc}" to start with getSiteUrl() "${siteUrl}"`
    );
  }

  const paths = locs.map((loc) => loc.slice(siteUrl.length));
  assert.deepEqual(paths, expectedPaths);

  // no 'voicedash'
  assert.equal(
    xml.toLowerCase().includes('voicedash'),
    false,
    'Expected no "voicedash" in sitemap'
  );

  // no '<lastmod>'
  assert.equal(
    xml.includes('<lastmod>'),
    false,
    'Expected no "<lastmod>" in sitemap'
  );
});

test('6. getSiteUrl: resolution and trailing slash trimming', () => {
  const originalEnv = process.env.SITE_URL;

  try {
    delete process.env.SITE_URL;
    assert.equal(getSiteUrl(), 'http://localhost:4321');

    process.env.SITE_URL = 'https://example.com/';
    assert.equal(getSiteUrl(), 'https://example.com');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.SITE_URL;
    } else {
      process.env.SITE_URL = originalEnv;
    }
  }
});
