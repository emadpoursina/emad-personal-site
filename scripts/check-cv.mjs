#!/usr/bin/env node
/**
 * scripts/check-cv.mjs
 *
 * Real CV gate: verifies that the generated CV PDF meets all requirements:
 * 1. Byte-scans raw PDF to ensure no embedded raster images (/Subtype /Image).
 * 2. Extracts text using pdfjs-dist and verifies text presence.
 * 3. Enforces the six exact section headings in exact order.
 * 4. Enforces the work authorization line verbatim.
 * 5. Verifies single-column layout by checking horizontal gaps <= 24 pt.
 *
 * Default target: dist/client/cv.pdf (or accepts path argument).
 * Prints "cv ok" and exits 0 on success; prints failures on stderr and exits 1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export const EXPECTED_HEADINGS = [
  'Summary',
  'Experience',
  'Skills',
  'Projects',
  'Education',
  'Languages',
];

export const REQUIRED_WORK_AUTH =
  'Requires employer-sponsored work authorization.';

/**
 * Byte-scans a PDF buffer for image subtypes.
 *
 * @param {Buffer} buffer
 * @param {string} filePath
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkRawPdfForImages(buffer, filePath = 'cv.pdf') {
  // Matches /Subtype /Image or /Subtype/Image
  const rawString = buffer.toString('latin1');
  const imageRegex = /\/Subtype\s*\/Image\b/;
  if (imageRegex.test(rawString)) {
    return {
      ok: false,
      error: `Byte-scan failed: embedded image (/Subtype /Image) found in ${filePath}`,
    };
  }
  return { ok: true };
}

/**
 * Groups text runs by baseline (rounded y coordinate, tolerance ~1pt)
 * and sorts each line by x coordinate.
 *
 * @param {Array<{ str: string, transform: number[], width: number }>} items
 * @param {number} [tolerance=1.0]
 * @returns {Array<{ y: number, runs: Array<{ str: string, transform: number[], width: number }>, text: string }>}
 */
export function groupRunsIntoLines(items, tolerance = 1.0) {
  const validItems = items.filter(
    (it) => it && typeof it.str === 'string' && it.str.length > 0
  );

  // Sort descending by y (top of page first)
  const sorted = [...validItems].sort((a, b) => b.transform[5] - a.transform[5]);

  const lines = [];
  for (const item of sorted) {
    const y = item.transform[5];
    const existing = lines.find((line) => Math.abs(line.y - y) <= tolerance);
    if (existing) {
      existing.runs.push(item);
    } else {
      lines.push({ y, runs: [item] });
    }
  }

  for (const line of lines) {
    line.runs.sort((a, b) => a.transform[4] - b.transform[4]);
    // Construct line text by joining runs with spaces if not already separated
    let text = '';
    for (let i = 0; i < line.runs.length; i++) {
      const s = line.runs[i].str;
      if (i === 0) {
        text = s;
      } else {
        if (text.endsWith(' ') || s.startsWith(' ')) {
          text += s;
        } else {
          text += ' ' + s;
        }
      }
    }
    line.text = text.trim();
  }

  return lines;
}

/**
 * Checks that the six required section headings appear as line text in exact order.
 *
 * @param {string[] | Array<{ text: string }>} lines
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkHeadingOrder(lines) {
  const lineTexts = lines.map((l) => (typeof l === 'string' ? l : l.text).trim());
  const found = lineTexts.filter((t) => EXPECTED_HEADINGS.includes(t));

  if (found.length !== EXPECTED_HEADINGS.length) {
    return {
      ok: false,
      error: `Heading count mismatch: expected [${EXPECTED_HEADINGS.join(', ')}], found [${found.join(', ')}]`,
    };
  }

  for (let i = 0; i < EXPECTED_HEADINGS.length; i++) {
    if (found[i] !== EXPECTED_HEADINGS[i]) {
      return {
        ok: false,
        error: `Heading order mismatch at position ${i}: expected "${EXPECTED_HEADINGS[i]}", got "${found[i]}"`,
      };
    }
  }

  return { ok: true };
}

/**
 * Checks for multi-column horizontal gaps between consecutive runs on each line.
 * Fails if any horizontal gap between consecutive runs exceeds maxGap (default 24 pt).
 *
 * @param {Array<{ str: string, transform: number[], width: number }>} items
 * @param {number} [maxGap=24]
 * @param {number} [tolerance=1.0]
 * @returns {{ ok: boolean, offendingLine: string | null, gap?: number, error?: string }}
 */
export function detectColumnGaps(items, maxGap = 24, tolerance = 1.0) {
  const lines = groupRunsIntoLines(items, tolerance);

  for (const line of lines) {
    const nonBlankRuns = line.runs.filter((r) => r.str.trim() !== '');
    for (let i = 0; i < nonBlankRuns.length - 1; i++) {
      const r1 = nonBlankRuns[i];
      const r2 = nonBlankRuns[i + 1];
      const r1Right = r1.transform[4] + r1.width;
      const r2Left = r2.transform[4];
      const gap = r2Left - r1Right;

      if (gap > maxGap) {
        return {
          ok: false,
          offendingLine: line.text,
          gap,
          error: `Multi-column gap detected (${gap.toFixed(2)} pt > ${maxGap} pt) in line: "${line.text}"`,
        };
      }
    }
  }

  return { ok: true, offendingLine: null };
}

/**
 * Checks if the authorization line appears verbatim after whitespace normalization.
 *
 * @param {string[] | Array<{ text: string }>} lines
 * @param {string} [expected=REQUIRED_WORK_AUTH]
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkAuthorizationLine(lines, expected = REQUIRED_WORK_AUTH) {
  const normalizedExpected = expected.replace(/\s+/g, ' ').trim();
  const lineTexts = lines.map((l) =>
    (typeof l === 'string' ? l : l.text).replace(/\s+/g, ' ').trim()
  );

  const found = lineTexts.some((text) => text === normalizedExpected || text.includes(normalizedExpected));
  if (!found) {
    return {
      ok: false,
      error: `Missing required work authorization line: "${expected}"`,
    };
  }

  return { ok: true };
}

/**
 * Full check of a CV PDF file.
 *
 * @param {string} filePath
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export async function checkCv(filePath) {
  const errors = [];

  if (!existsSync(filePath)) {
    return {
      ok: false,
      errors: [`File does not exist: ${filePath}`],
    };
  }

  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (err) {
    return {
      ok: false,
      errors: [`Cannot read file ${filePath}: ${/** @type {Error} */ (err).message}`],
    };
  }

  // 1. Raw byte scan for embedded images
  const imageCheck = checkRawPdfForImages(buffer, filePath);
  if (!imageCheck.ok && imageCheck.error) {
    errors.push(imageCheck.error);
  }

  // 2. Extract text using pdfjs-dist
  let pdf;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
    });
    pdf = await loadingTask.promise;
  } catch (err) {
    errors.push(`Failed to parse PDF ${filePath}: ${/** @type {Error} */ (err).message}`);
    return { ok: false, errors };
  }

  if (pdf.numPages === 0) {
    errors.push(`PDF has 0 pages: ${filePath}`);
    return { ok: false, errors };
  }

  const allLines = [];
  let totalTextChars = 0;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = /** @type {Array<{ str: string, transform: number[], width: number }>} */ (textContent.items);

    for (const item of items) {
      totalTextChars += (item.str || '').trim().length;
    }

    // 5. Gap detector on this page
    const gapResult = detectColumnGaps(items, 24);
    if (!gapResult.ok && gapResult.error) {
      errors.push(`Page ${pageNum}: ${gapResult.error}`);
    }

    const pageLines = groupRunsIntoLines(items);
    for (const line of pageLines) {
      allLines.push(line);
    }
  }

  // 2. Verify text presence
  if (totalTextChars === 0) {
    errors.push(`No text found in PDF: ${filePath}`);
  }

  // 3. Heading order check
  const headingCheck = checkHeadingOrder(allLines);
  if (!headingCheck.ok && headingCheck.error) {
    errors.push(headingCheck.error);
  }

  // 4. Authorization line check
  const authCheck = checkAuthorizationLine(allLines);
  if (!authCheck.ok && authCheck.error) {
    errors.push(authCheck.error);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

// CLI Execution guard
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const targetPath = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : join(ROOT, 'dist', 'client', 'cv.pdf');

  checkCv(targetPath)
    .then((result) => {
      if (!result.ok) {
        for (const err of result.errors) {
          process.stderr.write(`${err}\n`);
        }
        process.exit(1);
      }
      console.log('cv ok');
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}
