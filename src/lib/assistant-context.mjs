/**
 * src/lib/assistant-context.mjs
 *
 * Derives context sections and citations from profile and case studies.
 * Pure ESM functions, no file I/O.
 */

import { publishedStudies } from './case-studies.mjs';
import { displayLevel } from './skills.mjs';
import { SKILL_CATEGORIES } from './profile.mjs';

/**
 * Common English stopwords to ignore during token extraction.
 */
export const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'of', 'in', 'a', 'an']);

/**
 * Fixed static href allow-list for non-study sections.
 */
export const STATIC_HREF_ALLOW_LIST = [
  '/about#summary',
  '/about#experience',
  '/about#skills',
  '/about#education',
  '/about#languages',
  '/contact',
];

/**
 * Returns the complete allow-list of hrefs for a given case studies document.
 *
 * @param {unknown} caseStudiesDoc
 * @returns {string[]}
 */
export function buildHrefAllowList(caseStudiesDoc) {
  const studies = publishedStudies(caseStudiesDoc);
  const studyHrefs = studies.map((s) => `/case-studies/${s.slug}`);
  return [...STATIC_HREF_ALLOW_LIST, ...studyHrefs];
}

/**
 * Exported href allow-list reference.
 */
export const HREF_ALLOW_LIST = STATIC_HREF_ALLOW_LIST;

/**
 * Checks whether an href is in the allow-list for the given case studies document.
 *
 * @param {string} href
 * @param {unknown} [caseStudiesDoc]
 * @returns {boolean}
 */
export function isAllowedHref(href, caseStudiesDoc) {
  if (typeof href !== 'string') return false;
  if (STATIC_HREF_ALLOW_LIST.includes(href)) return true;
  if (caseStudiesDoc) {
    return buildHrefAllowList(caseStudiesDoc).includes(href);
  }
  return /^\/case-studies\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(href);
}

/**
 * Splits text on non-alphanumeric characters, filters out tokens shorter than
 * 3 characters and common stopwords.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractTokens(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Escapes characters with special meaning in RegExp.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tests whether a whole word or token appears in the text using word boundaries.
 *
 * @param {string} text
 * @param {string} token
 * @returns {boolean}
 */
function matchWord(text, token) {
  if (!text || !token) return false;
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(text);
}

/**
 * Tests whether a phrase/name appears in text with boundary delimiters.
 *
 * @param {string} text
 * @param {string} name
 * @returns {boolean}
 */
function matchNamePhrase(text, name) {
  if (!text || !name) return false;
  return new RegExp(`(^|[^a-zA-Z0-9])${escapeRegExp(name)}([^a-zA-Z0-9]|$)`, 'i').test(text);
}

/**
 * Builds the context sections array in the fixed order of data-model.md.
 *
 * @param {Record<string, unknown>} profile
 * @param {unknown} caseStudiesDoc
 * @returns {Array<{id: string, label: string, href: string, text: string}>}
 */
export function buildSections(profile, caseStudiesDoc) {
  const p = profile ?? {};
  const allowList = buildHrefAllowList(caseStudiesDoc);
  const sections = [];

  // Helper to define section with non-enumerable metadata
  function createSection(id, label, href, text, recordedNames = [], recordedTokens = []) {
    if (!allowList.includes(href)) {
      throw new Error(`Disallowed href for section "${id}": "${href}"`);
    }
    const section = { id, label, href, text };
    Object.defineProperty(section, '_recordedNames', {
      value: recordedNames,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(section, '_recordedTokens', {
      value: recordedTokens,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return section;
  }

  // 1. summary
  const summaryLines = [];
  if (p.name) summaryLines.push(`Name: ${p.name}`);
  if (p.headline) summaryLines.push(`Headline: ${p.headline}`);
  if (p.bio) summaryLines.push(`Bio: ${p.bio}`);
  if (Array.isArray(p.targetRoles) && p.targetRoles.length > 0) {
    summaryLines.push(`Target roles: ${p.targetRoles.join(', ')}`);
  }
  if (Array.isArray(p.targetCountries) && p.targetCountries.length > 0) {
    summaryLines.push(`Target countries: ${p.targetCountries.join(', ')}`);
  }
  if (p.availability) summaryLines.push(`Availability: ${p.availability}`);
  if (p.workAuthorization) summaryLines.push(`Work authorization: ${p.workAuthorization}`);
  if (p.contactEmail) summaryLines.push(`Contact email: ${p.contactEmail}`);

  sections.push(
    createSection('summary', 'About \u2014 Summary', '/about#summary', summaryLines.join('\n'))
  );

  // 2. experience
  const expLines = [];
  const expList = Array.isArray(p.experience) ? p.experience : [];
  const expNames = [];
  const expTokens = new Set();

  for (const item of expList) {
    if (item.role) {
      expLines.push(`Role: ${item.role}`);
      expNames.push(item.role);
      for (const tok of extractTokens(item.role)) expTokens.add(tok);
    }
    if (item.company) {
      expLines.push(`Company: ${item.company}`);
      expNames.push(item.company);
      for (const tok of extractTokens(item.company)) expTokens.add(tok);
    }
    if (item.start || item.end) {
      const dates = item.end ? `${item.start} to ${item.end}` : `${item.start}`;
      expLines.push(`Dates: ${dates}`);
    }
    if (item.context === 'team') {
      expLines.push('Team context: work was done within a team');
    }
    if (Array.isArray(item.points)) {
      for (const pt of item.points) {
        expLines.push(`Point: ${pt}`);
      }
    }
  }

  sections.push(
    createSection(
      'experience',
      'About \u2014 Experience',
      '/about#experience',
      expLines.join('\n'),
      expNames,
      Array.from(expTokens)
    )
  );

  // 3. skills
  const skillsLines = [];
  const skillList = Array.isArray(p.skills) ? p.skills : [];
  const skillNames = [];
  const skillTokens = new Set();

  // Group by SKILL_CATEGORIES order, then any additional categories
  const categoriesInOrder = [...SKILL_CATEGORIES];
  for (const s of skillList) {
    if (s && s.category && !categoriesInOrder.includes(s.category)) {
      categoriesInOrder.push(s.category);
    }
  }

  for (const cat of categoriesInOrder) {
    const catSkills = skillList.filter((s) => s && s.category === cat);
    if (catSkills.length > 0) {
      skillsLines.push(`Category: ${cat}`);
      for (const s of catSkills) {
        skillsLines.push(`Skill: ${s.name} (${displayLevel(s.level)})`);
        skillNames.push(s.name);
        for (const tok of extractTokens(s.name)) skillTokens.add(tok);
      }
    }
  }

  sections.push(
    createSection(
      'skills',
      'About \u2014 Skills',
      '/about#skills',
      skillsLines.join('\n'),
      skillNames,
      Array.from(skillTokens)
    )
  );

  // 4. education
  const eduLines = [];
  const eduList = Array.isArray(p.education) ? p.education : [];
  const eduNames = [];
  const eduTokens = new Set();

  for (const edu of eduList) {
    if (edu.degree) {
      eduLines.push(`Degree: ${edu.degree}`);
      eduNames.push(edu.degree);
      for (const tok of extractTokens(edu.degree)) eduTokens.add(tok);
    }
    if (edu.institution) {
      eduLines.push(`Institution: ${edu.institution}`);
      eduNames.push(edu.institution);
      for (const tok of extractTokens(edu.institution)) eduTokens.add(tok);
    }
    if (edu.year) {
      eduLines.push(`Years: ${edu.year}`);
    }
  }

  sections.push(
    createSection(
      'education',
      'About \u2014 Education',
      '/about#education',
      eduLines.join('\n'),
      eduNames,
      Array.from(eduTokens)
    )
  );

  // 5. languages
  const langLines = [];
  const langList = Array.isArray(p.languages) ? p.languages : [];
  const langNames = [];
  const langTokens = new Set();

  for (const lang of langList) {
    if (lang.name) {
      const prof = lang.level ? ` (${lang.level})` : '';
      langLines.push(`Language: ${lang.name}${prof}`);
      langNames.push(lang.name);
      for (const tok of extractTokens(lang.name)) langTokens.add(tok);
    }
  }

  sections.push(
    createSection(
      'languages',
      'About \u2014 Languages',
      '/about#languages',
      langLines.join('\n'),
      langNames,
      Array.from(langTokens)
    )
  );

  // 6. projects
  const projLines = [];
  const projList = Array.isArray(p.projects) ? p.projects : [];
  const projNames = [];
  const projTokens = new Set();

  for (const proj of projList) {
    if (proj.name) {
      projLines.push(`Project: ${proj.name}`);
      projNames.push(proj.name);
      for (const tok of extractTokens(proj.name)) projTokens.add(tok);
    }
    if (proj.description) {
      projLines.push(`Description: ${proj.description}`);
    }
    if (proj.url && proj.url.trim() !== '') {
      projLines.push(`URL: ${proj.url}`);
    }
  }

  sections.push(
    createSection(
      'projects',
      'About \u2014 Experience',
      '/about#experience',
      projLines.join('\n'),
      projNames,
      Array.from(projTokens)
    )
  );

  // 7. study:<slug> for each published study in document order
  const published = publishedStudies(caseStudiesDoc);
  for (const study of published) {
    const studyLines = [];
    studyLines.push(`Title: ${study.title}`);
    if (study.problem) studyLines.push(`Problem: ${study.problem}`);
    if (study.contribution) studyLines.push(`Contribution: ${study.contribution}`);
    if (study.outcome) studyLines.push(`Outcome: ${study.outcome}`);
    if (Array.isArray(study.stack) && study.stack.length > 0) {
      studyLines.push(`Stack: ${study.stack.join(', ')}`);
    }
    if (study.publicLink && typeof study.publicLink.url === 'string') {
      studyLines.push(`Public link: ${study.publicLink.url}`);
    }

    const studyTokens = new Set([
      ...extractTokens(study.title),
      ...extractTokens(study.slug),
    ]);

    sections.push(
      createSection(
        `study:${study.slug}`,
        `Case Study \u2014 ${study.title}`,
        `/case-studies/${study.slug}`,
        studyLines.join('\n'),
        [study.title, study.slug],
        Array.from(studyTokens)
      )
    );
  }

  // 8. contact
  const contactLines = [];
  if (p.contactEmail) contactLines.push(`Contact email: ${p.contactEmail}`);
  contactLines.push(
    'Contact form: Use the contact form at /contact to get in touch or ask Emad directly.'
  );

  sections.push(
    createSection('contact', 'Contact', '/contact', contactLines.join('\n'))
  );

  return sections;
}

/**
 * Vocabulary regular expressions for section keyword matching.
 */
const EXPERIENCE_VOCAB_RE =
  /\b(experience|experiences|role|roles|company|companies|work|job|jobs|career|team|lead|freelance|years?)\b/i;

const SKILLS_VOCAB_RE =
  /\b(skills?|tech|technology|technologies|stack|proficienc(y|ies)|proficient|expert|advanced|intermediate|beginner|learning|levels?|frameworks?|tools?|tooling|databases?|backend|frontend|devops|cloud)\b/i;

const EDUCATION_VOCAB_RE =
  /\b(education|degrees?|universit(y|ies)|colleges?|study|studied|academic|schools?)\b/i;

const LANGUAGES_VOCAB_RE =
  /\b(languages?|speaks?|spoken|fluent)\b/i;

const PROJECTS_VOCAB_RE =
  /\b(projects?|built|builds?|building|portfolio|open\s+source|github)\b/i;

const GENERIC_STUDY_RE =
  /\b(case\s+stud(y|ies)|projects?)\b/i;

/**
 * Selects sections based on question matching rules from data-model.md.
 * Returns selected sections in fixed order, deduplicated.
 *
 * @param {string} question
 * @param {Array<{id: string, label: string, href: string, text: string}>} sections
 * @returns {Array<{id: string, label: string, href: string, text: string}>}
 */
export function selectSections(question, sections) {
  if (!Array.isArray(sections)) return [];
  const q = typeof question === 'string' ? question : '';
  const selectedIds = new Set();

  // Summary is always selected
  selectedIds.add('summary');

  for (const s of sections) {
    if (!s || typeof s.id !== 'string') continue;

    if (s.id === 'experience') {
      let matched = EXPERIENCE_VOCAB_RE.test(q);
      if (!matched) {
        const tokens = s._recordedTokens ?? extractTokens(s.text);
        const names = s._recordedNames ?? [];
        for (const tok of tokens) {
          if (matchWord(q, tok)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (const name of names) {
            if (matchNamePhrase(q, name)) {
              matched = true;
              break;
            }
          }
        }
      }
      if (matched) selectedIds.add('experience');
    } else if (s.id === 'skills') {
      let matched = SKILLS_VOCAB_RE.test(q);
      if (!matched) {
        const tokens = s._recordedTokens ?? extractTokens(s.text);
        const names = s._recordedNames ?? [];
        for (const tok of tokens) {
          if (matchWord(q, tok)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (const name of names) {
            if (matchNamePhrase(q, name)) {
              matched = true;
              break;
            }
          }
        }
      }
      if (matched) selectedIds.add('skills');
    } else if (s.id === 'education') {
      let matched = EDUCATION_VOCAB_RE.test(q);
      if (!matched) {
        const tokens = s._recordedTokens ?? extractTokens(s.text);
        for (const tok of tokens) {
          if (matchWord(q, tok)) {
            matched = true;
            break;
          }
        }
      }
      if (matched) selectedIds.add('education');
    } else if (s.id === 'languages') {
      let matched = LANGUAGES_VOCAB_RE.test(q);
      if (!matched) {
        const tokens = s._recordedTokens ?? extractTokens(s.text);
        const names = s._recordedNames ?? [];
        for (const tok of tokens) {
          if (matchWord(q, tok)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (const name of names) {
            if (matchNamePhrase(q, name)) {
              matched = true;
              break;
            }
          }
        }
      }
      if (matched) selectedIds.add('languages');
    } else if (s.id === 'projects') {
      let matched = PROJECTS_VOCAB_RE.test(q);
      if (!matched) {
        const tokens = s._recordedTokens ?? extractTokens(s.text);
        const names = s._recordedNames ?? [];
        for (const tok of tokens) {
          if (matchWord(q, tok)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (const name of names) {
            if (matchNamePhrase(q, name)) {
              matched = true;
              break;
            }
          }
        }
      }
      if (matched) selectedIds.add('projects');
    } else if (s.id.startsWith('study:')) {
      let matched = GENERIC_STUDY_RE.test(q);
      if (!matched) {
        const slug = s.id.replace(/^study:/, '');
        const titleTokens = s._recordedTokens ?? [
          ...extractTokens(slug),
          ...extractTokens(s.label.replace(/^Case Study \u2014 /, '')),
        ];
        for (const tok of titleTokens) {
          if (matchWord(q, tok)) {
            matched = true;
            break;
          }
        }
        if (!matched && s._recordedNames) {
          for (const name of s._recordedNames) {
            if (matchNamePhrase(q, name)) {
              matched = true;
              break;
            }
          }
        }
      }
      if (matched) selectedIds.add(s.id);
    }
  }

  // Fallback: If the selected set is exactly {summary}, add experience and skills
  if (selectedIds.size === 1 && selectedIds.has('summary')) {
    selectedIds.add('experience');
    selectedIds.add('skills');
  }

  // Filter sections in their fixed input order, deduplicated
  const seenIds = new Set();
  const result = [];
  for (const s of sections) {
    if (s && selectedIds.has(s.id) && !seenIds.has(s.id)) {
      seenIds.add(s.id);
      result.push(s);
    }
  }

  return result;
}

/**
 * Builds citations list from selected sections.
 * Duplicates removed by href, first occurrence wins, section order preserved.
 *
 * @param {Array<{id: string, label: string, href: string}>} sections
 * @returns {Array<{label: string, href: string}>}
 */
export function buildCitations(sections) {
  if (!Array.isArray(sections)) return [];
  const seenHrefs = new Set();
  const citations = [];
  for (const s of sections) {
    if (!s || typeof s.href !== 'string') continue;
    if (!seenHrefs.has(s.href)) {
      seenHrefs.add(s.href);
      citations.push({
        label: s.label,
        href: s.href,
      });
    }
  }
  return citations;
}

/**
 * Exact regular expressions from data-model.md policy table.
 */
const POLICY_RULES = [
  {
    kind: 'salary',
    patterns: [
      /\b(salary|compensation|remuneration)\b/i,
      /\bpay\s+(range|floor|expectation|rate|scale)\b/i,
      /\bexpected\s+(salary|pay|compensation)\b/i,
      /\b(day|hourly)\s+rate\b/i,
      /\bhow\s+much\s+(does|would)\s+emad\s+(charge|cost|want)\b/i,
    ],
  },
  {
    kind: 'visa',
    patterns: [
      /\bvisa\b/i,
      /\bh-?1b\b/i,
      /\bo-?1\b/i,
      /\btn\s+visa\b/i,
      /\bwork\s+permit\b/i,
      /\bimmigration\s+program\b/i,
    ],
  },
  {
    kind: 'privateCodebase',
    patterns: [
      /(voice\s*dash|villion).{0,40}(code|codebase|repo|repository|source|architecture|implementation|schema)/i,
      /(code|codebase|repo|repository|source\s+code|architecture).{0,40}(voice\s*dash|villion)/i,
      /\b(private|proprietary|confidential)\s+(code|codebase|repo|repository|source)\b/i,
      /\bshow\s+(me\s+)?(the\s+)?(source|code)\b/i,
    ],
  },
];

/**
 * Matches a visitor question against deterministic policy decline rules.
 * Order: salary -> visa -> privateCodebase. First match wins.
 * Returns null if no rule matches.
 *
 * @param {string} question
 * @returns {{kind: 'salary' | 'visa' | 'privateCodebase'} | null}
 */
export function matchPolicy(question) {
  if (typeof question !== 'string') return null;
  for (const { kind, patterns } of POLICY_RULES) {
    for (const pattern of patterns) {
      if (pattern.test(question)) {
        return { kind };
      }
    }
  }
  return null;
}

/**
 * Fixed sources for each policy decline kind.
 */
export const POLICY_SOURCES = {
  salary: [{ label: 'Contact', href: '/contact' }],
  visa: [{ label: 'Contact', href: '/contact' }],
  privateCodebase: [
    { label: 'Case Studies', href: '/case-studies' },
    { label: 'Contact', href: '/contact' },
  ],
};

/**
 * Returns fixed sources for a given policy kind.
 *
 * @param {'salary' | 'visa' | 'privateCodebase'} kind
 * @returns {Array<{label: string, href: string}>}
 */
export function getPolicySources(kind) {
  return POLICY_SOURCES[kind] ?? [];
}

/**
 * Builds the policy decline answer for the matched kind.
 * Replaces `{caseStudiesPath}` with `/case-studies`.
 * Throws on unknown kind or missing policy object.
 *
 * @param {string} kind
 * @param {Record<string, unknown>} assistantPolicy
 * @returns {string}
 */
export function buildPolicyAnswer(kind, assistantPolicy) {
  if (kind !== 'salary' && kind !== 'visa' && kind !== 'privateCodebase') {
    throw new Error(`Unknown policy kind: "${kind}"`);
  }
  if (!assistantPolicy || typeof assistantPolicy !== 'object') {
    throw new Error('assistantPolicy must be a non-null object');
  }
  const answer = assistantPolicy[kind];
  if (typeof answer !== 'string') {
    throw new Error(`Missing or non-string policy answer for kind: "${kind}"`);
  }
  return answer.replaceAll('{caseStudiesPath}', '/case-studies');
}
