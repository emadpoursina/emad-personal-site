#!/usr/bin/env node
/**
 * scripts/check-profile.mjs
 *
 * Thin CLI that validates content/profile.json.
 * Prints "profile ok" to stdout and exits 0 on success.
 * Prints the reason to stderr and exits 1 on failure.
 */

import { loadProfile } from '../src/lib/profile.mjs';

try {
  loadProfile();
  console.log('profile ok');
  process.exit(0);
} catch (err) {
  process.stderr.write(/** @type {Error} */ (err).message + '\n');
  process.exit(1);
}
