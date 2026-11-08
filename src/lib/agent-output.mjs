/**
 * src/lib/agent-output.mjs
 *
 * Pure ESM builders for the five agent-readable and crawler surfaces:
 * - buildResume: JSON Resume v1.0.0
 * - buildProfileApi: enriched profile for /api/profile
 * - buildLlmsTxt: plain text llms.txt
 * - buildPersonJsonLd: Schema.org Person JSON-LD
 * - buildSitemap: sitemap.xml
 *
 * No side effects, no file I/O.
 */

import { absoluteUrl, getSiteUrl } from './site.mjs';
import { knowsAbout } from './skills.mjs';
import { publishedStudies } from './case-studies.mjs';

const SCHEMA_PIN = 'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json';

/**
 * Splits education degree into studyType and area on the last occurrence of ' in '.
 * E.g. "Associate Degree in Computer Engineering" -> { studyType: "Associate Degree", area: "Computer Engineering" }
 *
 * @param {string} [degree]
 * @returns {{ studyType?: string, area?: string }}
 */
function splitDegree(degree) {
  if (typeof degree !== 'string') {
    return {};
  }
  const lastIndex = degree.lastIndexOf(' in ');
  if (lastIndex === -1) {
    return { studyType: degree.trim() };
  }
  const studyType = degree.slice(0, lastIndex).trim();
  const area = degree.slice(lastIndex + 4).trim();
  const res = {};
  if (studyType) res.studyType = studyType;
  if (area) res.area = area;
  return res;
}

/**
 * Splits education year into startDate and endDate on en-dash or hyphen.
 * E.g. "2019 – 2023" -> { startDate: "2019", endDate: "2023" }
 *
 * @param {string} [year]
 * @returns {{ startDate?: string, endDate?: string }}
 */
function splitYear(year) {
  if (typeof year !== 'string') {
    return {};
  }
  const parts = year.split(/[–-]/).map((p) => p.trim()).filter(Boolean);
  const res = {};
  if (parts.length > 0 && parts[0]) res.startDate = parts[0];
  if (parts.length > 1 && parts[1]) res.endDate = parts[1];
  return res;
}

/**
 * Builds the JSON Resume v1.0.0 representation of profile and case studies.
 *
 * @param {Record<string, unknown>} profile - Parsed content/profile.json
 * @param {Record<string, unknown>} studiesDoc - Parsed content/case-studies.json
 * @returns {Record<string, unknown>}
 */
export function buildResume(profile, studiesDoc) {
  const p = profile ?? {};
  const links = (p.links && typeof p.links === 'object') ? /** @type {Record<string, string>} */ (p.links) : {};

  const profiles = [];
  if (typeof links.linkedin === 'string' && links.linkedin.trim() !== '') {
    profiles.push({ network: 'LinkedIn', url: links.linkedin.trim() });
  }
  if (typeof links.github === 'string' && links.github.trim() !== '') {
    profiles.push({ network: 'GitHub', url: links.github.trim() });
  }

  const basics = {
    name: p.name,
    label: p.headline,
    email: p.contactEmail,
    summary: p.bio,
    profiles
  };

  const experience = Array.isArray(p.experience) ? p.experience : [];
  const work = experience.map((exp) => {
    const item = {
      name: exp.company,
      position: exp.role,
      startDate: exp.start
    };
    if (exp.end && exp.end !== 'present') {
      item.endDate = exp.end;
    }
    if (Array.isArray(exp.points)) {
      item.highlights = exp.points;
    }
    return item;
  });

  const educationList = Array.isArray(p.education) ? p.education : [];
  const education = educationList.map((edu) => {
    const item = {
      institution: edu.institution
    };
    const { studyType, area } = splitDegree(edu.degree);
    if (studyType) item.studyType = studyType;
    if (area) item.area = area;

    const { startDate, endDate } = splitYear(edu.year);
    if (startDate) item.startDate = startDate;
    if (endDate) item.endDate = endDate;

    return item;
  });

  const skillsList = Array.isArray(p.skills) ? p.skills : [];
  const skills = skillsList.map((skill) => ({
    name: skill.name
  }));

  const languagesList = Array.isArray(p.languages) ? p.languages : [];
  const languages = languagesList.map((lang) => ({
    language: lang.name,
    fluency: lang.level
  }));

  const profileProjects = Array.isArray(p.projects) ? p.projects : [];
  const projects = [];

  for (const proj of profileProjects) {
    const projItem = {
      name: proj.name,
      description: proj.description
    };
    if (typeof proj.url === 'string' && proj.url.trim() !== '') {
      projItem.url = proj.url.trim();
    }
    projects.push(projItem);
  }

  const published = publishedStudies(studiesDoc);
  for (const study of published) {
    const studyItem = {
      name: study.title,
      description: study.problem,
      highlights: [study.contribution, study.outcome],
      keywords: Array.isArray(study.stack) ? study.stack : []
    };
    if (
      study.visibility === 'public' &&
      study.publicLink &&
      typeof study.publicLink === 'object' &&
      typeof study.publicLink.url === 'string' &&
      study.publicLink.url.trim() !== ''
    ) {
      studyItem.url = study.publicLink.url.trim();
    }
    projects.push(studyItem);
  }

  return {
    $schema: SCHEMA_PIN,
    basics,
    work,
    education,
    skills,
    languages,
    projects,
    meta: {
      version: 'v1.0.0'
    }
  };
}

/**
 * Builds the enriched profile object for /api/profile.
 * Exactly buildResume() with top-level last_updated = profile.lastUpdated
 * and skills enriched to { name, level, category } in profile order.
 *
 * @param {Record<string, unknown>} profile - Parsed content/profile.json
 * @param {Record<string, unknown>} studiesDoc - Parsed content/case-studies.json
 * @returns {Record<string, unknown>}
 */
export function buildProfileApi(profile, studiesDoc) {
  const resume = buildResume(profile, studiesDoc);
  const p = profile ?? {};

  const skillsList = Array.isArray(p.skills) ? p.skills : [];
  const enrichedSkills = skillsList.map((skill) => ({
    name: skill.name,
    level: skill.level,
    category: skill.category
  }));

  return {
    ...resume,
    last_updated: p.lastUpdated,
    skills: enrichedSkills
  };
}

/**
 * Builds the plain-text llms.txt representation.
 *
 * @param {Record<string, unknown>} profile - Parsed content/profile.json
 * @param {Record<string, unknown>} studiesDoc - Parsed content/case-studies.json
 * @returns {string}
 */
export function buildLlmsTxt(profile, studiesDoc) {
  const p = profile ?? {};
  const siteUrl = getSiteUrl();
  const published = publishedStudies(studiesDoc);

  const lines = [
    `# ${p.name}`,
    '',
    `> ${p.headline}`,
    '',
    '## Target roles'
  ];

  const targetRoles = Array.isArray(p.targetRoles) ? p.targetRoles : [];
  for (const role of targetRoles) {
    lines.push(`- ${role}`);
  }

  lines.push('');
  lines.push('## Work authorization');
  lines.push(p.workAuthorization ?? '');
  lines.push('');
  lines.push('## Availability');
  lines.push(p.availability ?? '');
  lines.push('');
  lines.push('## Case studies');

  if (published.length === 0) {
    lines.push('- None published.');
  } else {
    for (const study of published) {
      lines.push(`- ${study.title}: ${siteUrl}/case-studies/${study.slug}`);
    }
  }

  lines.push('');
  lines.push('## CV');
  lines.push(`- ${siteUrl}/cv.pdf`);
  lines.push('');
  lines.push('## Contact');
  lines.push(`- ${siteUrl}/contact`);
  lines.push(`- ${p.contactEmail}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Builds the Schema.org Person JSON-LD object.
 *
 * @param {Record<string, unknown>} profile - Parsed content/profile.json
 * @returns {Record<string, unknown>}
 */
export function buildPersonJsonLd(profile) {
  const p = profile ?? {};
  const links = (p.links && typeof p.links === 'object') ? /** @type {Record<string, string>} */ (p.links) : {};

  const sameAs = [];
  if (typeof links.linkedin === 'string') sameAs.push(links.linkedin);
  if (typeof links.github === 'string') sameAs.push(links.github);

  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: p.name,
    jobTitle: p.headline,
    email: p.contactEmail,
    sameAs,
    knowsAbout: knowsAbout(/** @type {any} */ (p.skills))
  };
}

/**
 * Builds the sitemap XML document.
 *
 * @param {Record<string, unknown>} studiesDoc - Parsed content/case-studies.json
 * @returns {string}
 */
export function buildSitemap(studiesDoc) {
  const published = publishedStudies(studiesDoc);
  const locs = [
    absoluteUrl('/'),
    absoluteUrl('/about'),
    absoluteUrl('/case-studies'),
    absoluteUrl('/contact')
  ];

  for (const study of published) {
    locs.push(absoluteUrl(`/case-studies/${study.slug}`));
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  ];

  for (const loc of locs) {
    lines.push('  <url>');
    lines.push(`    <loc>${loc}</loc>`);
    lines.push('  </url>');
  }

  lines.push('</urlset>');
  lines.push('');

  return lines.join('\n');
}
