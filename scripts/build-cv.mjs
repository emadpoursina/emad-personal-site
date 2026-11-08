#!/usr/bin/env node
/**
 * scripts/build-cv.mjs
 *
 * Generates public/cv.pdf from content/profile.json using PDFKit.
 * Enforces single-column, left-aligned standard Helvetica layout.
 */

import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { loadProfile } from '../src/lib/profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_PATH = join(ROOT, 'public', 'cv.pdf');

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/**
 * PDFKit's built-in Helvetica uses WinAnsi encoding, which has no glyph for
 * U+2192 (RIGHTWARDS ARROW). Without this, PDFKit emits "!'" into the text
 * layer, so the rendered CV reads e.g. "Full-Stack Developer !' Backend".
 * Degrade unsupported characters to ASCII at the render boundary only;
 * content/profile.json keeps the approved source text unchanged.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function pdfSafeText(value) {
  if (typeof value === 'string') return value.replace(/\u2192/g, '->');
  if (Array.isArray(value)) return value.map(pdfSafeText);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, pdfSafeText(v)])
    );
  }
  return value;
}

/**
 * Formats YYYY-MM or "present" to "Mmm YYYY" or "Present".
 * @param {string} ym
 * @returns {string}
 */
function formatMonthYear(ym) {
  if (!ym) return '';
  if (ym.toLowerCase() === 'present') return 'Present';
  const parts = ym.split('-');
  if (parts.length === 2) {
    const y = parts[0];
    const m = parseInt(parts[1], 10);
    const monthName = MONTHS[m - 1] || parts[1];
    return `${monthName} ${y}`;
  }
  return ym;
}

/**
 * Formats a start and end date into "Start – End" with an en dash.
 * @param {string} start
 * @param {string} end
 * @returns {string}
 */
function formatDateRange(start, end) {
  return `${formatMonthYear(start)} \u2013 ${formatMonthYear(end)}`;
}

async function buildCv() {
  const profile = /** @type {Record<string, any>} */ (pdfSafeText(loadProfile()));

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

  const doc = new PDFDocument({
    size: 'A4',
    compress: false,
    margins: { top: 40, bottom: 40, left: 45, right: 45 },
    info: {
      Title: `${profile.name} — CV`,
      Author: profile.name,
      CreationDate: new Date('2026-01-01T00:00:00Z'),
      ModDate: new Date('2026-01-01T00:00:00Z'),
    },
  });

  const writeStream = createWriteStream(OUTPUT_PATH);
  doc.pipe(writeStream);

  // -------------------------------------------------------------------------
  // Header Block
  // -------------------------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(20).text(profile.name, { align: 'left' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10.5).text(profile.headline, { align: 'left' });
  doc.moveDown(0.2);

  const contactParts = [profile.contactEmail];
  if (profile.links?.linkedin) contactParts.push(profile.links.linkedin);
  if (profile.links?.github) contactParts.push(profile.links.github);
  doc.font('Helvetica').fontSize(9).text(contactParts.join('  \u2022  '), { align: 'left' });
  doc.moveDown(0.8);

  // Helper for section headings
  function renderSectionHeading(title) {
    if (doc.y > 700) {
      doc.addPage();
    } else {
      doc.moveDown(0.5);
    }
    doc.font('Helvetica-Bold').fontSize(12).text(title, { align: 'left' });
    doc.moveDown(0.3);
  }

  // -------------------------------------------------------------------------
  // 1. Summary
  // -------------------------------------------------------------------------
  renderSectionHeading('Summary');
  doc.font('Helvetica').fontSize(9.5).text(profile.bio, { align: 'left', lineGap: 1.5 });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9.5).text(`Availability: ${profile.availability}`, { align: 'left' });
  doc.font('Helvetica').fontSize(9.5).text(profile.workAuthorization, { align: 'left' });

  // -------------------------------------------------------------------------
  // 2. Experience
  // -------------------------------------------------------------------------
  renderSectionHeading('Experience');
  const experiences = Array.isArray(profile.experience) ? profile.experience : [];
  for (let i = 0; i < experiences.length; i++) {
    const exp = experiences[i];
    if (i > 0) doc.moveDown(0.4);

    // Line 1: Role — Company
    doc.font('Helvetica-Bold').fontSize(9.5).text(`${exp.role} \u2014 ${exp.company}`, { align: 'left' });
    // Date range
    doc.font('Helvetica-Oblique').fontSize(9).text(formatDateRange(exp.start, exp.end), { align: 'left' });
    // Bullet points
    doc.font('Helvetica').fontSize(9);
    if (Array.isArray(exp.points)) {
      for (const pt of exp.points) {
        doc.text(`\u2022 ${pt}`, { align: 'left', lineGap: 1 });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Skills
  // -------------------------------------------------------------------------
  renderSectionHeading('Skills');
  const skillLevels = ['Expert', 'Advanced', 'Intermediate', 'Beginner / Learning'];
  const allSkills = Array.isArray(profile.skills) ? profile.skills : [];
  doc.font('Helvetica').fontSize(9);
  for (const level of skillLevels) {
    const matching = allSkills.filter((s) => s.level === level).map((s) => s.name);
    if (matching.length > 0) {
      doc.text(`${level}: ${matching.join(', ')}`, { align: 'left', lineGap: 1.5 });
      doc.moveDown(0.2);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Projects
  // -------------------------------------------------------------------------
  renderSectionHeading('Projects');
  const projects = Array.isArray(profile.projects) ? profile.projects : [];
  doc.font('Helvetica').fontSize(9);
  for (let i = 0; i < projects.length; i++) {
    const proj = projects[i];
    const projLine = proj.url && proj.url.trim() !== ''
      ? `${proj.name} \u2014 ${proj.description} (${proj.url})`
      : `${proj.name} \u2014 ${proj.description}`;
    doc.text(projLine, { align: 'left', lineGap: 1.5 });
    if (i < projects.length - 1) doc.moveDown(0.2);
  }

  // -------------------------------------------------------------------------
  // 5. Education
  // -------------------------------------------------------------------------
  renderSectionHeading('Education');
  const education = Array.isArray(profile.education) ? profile.education : [];
  doc.font('Helvetica').fontSize(9);
  for (const edu of education) {
    doc.text(`${edu.degree} \u2014 ${edu.institution} (${edu.year})`, { align: 'left' });
  }

  // -------------------------------------------------------------------------
  // 6. Languages
  // -------------------------------------------------------------------------
  renderSectionHeading('Languages');
  const languages = Array.isArray(profile.languages) ? profile.languages : [];
  doc.font('Helvetica').fontSize(9);
  for (const lang of languages) {
    doc.text(`${lang.name} \u2014 ${lang.level}`, { align: 'left' });
  }

  doc.end();
  await finished(writeStream);

  const stats = statSync(OUTPUT_PATH);
  console.log(`CV written to ${OUTPUT_PATH} (${stats.size} bytes)`);
}

buildCv().catch((err) => {
  process.stderr.write(`Failed to build CV: ${err.message}\n`);
  process.exit(1);
});
