#!/usr/bin/env node
/**
 * scripts/check-cover-letter.mjs
 *
 * Build-time validation gate for the cover letter content document:
 * - Loads and validates content/cover-letter.json via loadCoverLetter()
 * - Builds the full letter text with buildGeneralLetter(doc)
 * - Scans for banned phrases case-insensitively and fails if any is present,
 *   reporting the first matching phrase in BANNED_PHRASES order and its field.
 *
 * Prints "cover letter ok" to stdout and exits 0 on success.
 * Prints failure reason to stderr and exits 1 on failure.
 */

import {
  loadCoverLetter,
  buildGeneralLetter,
  BANNED_PHRASES,
} from '../src/lib/cover-letter.mjs';

function determineField(doc, phrase) {
  const pLower = phrase.toLowerCase();

  const paragraphsJoined = Array.isArray(doc.paragraphs)
    ? doc.paragraphs.join('\n\n')
    : '';
  if (paragraphsJoined.toLowerCase().includes(pLower)) {
    return 'paragraphs';
  }

  if (
    typeof doc.greeting === 'string' &&
    doc.greeting.toLowerCase().includes(pLower)
  ) {
    return 'greeting';
  }

  if (
    typeof doc.authorization === 'string' &&
    doc.authorization.toLowerCase().includes(pLower)
  ) {
    return 'authorization';
  }

  if (
    typeof doc.signoff === 'string' &&
    doc.signoff.toLowerCase().includes(pLower)
  ) {
    return 'signoff';
  }

  return 'letter';
}

try {
  let doc;
  try {
    doc = loadCoverLetter();
  } catch (err) {
    process.stderr.write(`FAIL: cover letter content is invalid - ${err.message}\n`);
    process.exit(1);
  }

  const builtText = buildGeneralLetter(doc);
  const lowerBuilt = builtText.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (lowerBuilt.includes(phrase.toLowerCase())) {
      const field = determineField(doc, phrase);
      process.stderr.write(`FAIL: banned phrase "${phrase}" found in ${field}\n`);
      process.exit(1);
    }
  }

  console.log('cover letter ok');
  process.exit(0);
} catch (err) {
  process.stderr.write(`FAIL: cover letter content is invalid - ${err.message}\n`);
  process.exit(1);
}
