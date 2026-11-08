#!/usr/bin/env node
/**
 * scripts/check-profile.mjs
 *
 * Thin CLI that validates content documents:
 * - content/profile.json through loadProfile()
 * - content/case-studies.json through validateCaseStudies()
 *
 * Prints "profile ok" and "case studies ok" to stdout and exits 0 on success.
 * Prints the reason to stderr and exits 1 on failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile } from '../src/lib/profile.mjs';
import { validateCaseStudies } from '../src/lib/case-studies.mjs';

function resolveCaseStudiesPath() {
  const candidates = [];

  const cwdPath = join(process.cwd(), 'content', 'case-studies.json');
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  candidates.push(cwdPath);

  const modulePath = join(dirname(fileURLToPath(import.meta.url)), '../../content/case-studies.json');
  if (existsSync(modulePath)) {
    return modulePath;
  }
  candidates.push(modulePath);

  throw new Error(`Cannot read case studies file: ${candidates.join(', ')}`);
}

try {
  loadProfile();
  console.log('profile ok');

  const resolvedPath = resolveCaseStudiesPath();
  let raw;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read case studies file: ${resolvedPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${resolvedPath}: invalid JSON — ${/** @type {Error} */ (err).message}`);
  }

  validateCaseStudies(parsed, resolvedPath);
  console.log('case studies ok');

  process.exit(0);
} catch (err) {
  process.stderr.write(/** @type {Error} */ (err).message + '\n');
  process.exit(1);
}
