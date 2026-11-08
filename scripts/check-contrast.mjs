#!/usr/bin/env node
/**
 * scripts/check-contrast.mjs
 *
 * Enforces WCAG AA contrast (>= 4.5:1) for text pairs defined in tokens.css.
 * Parses [data-theme="light"] and [data-theme="dark"] blocks.
 *
 * Usage:
 *   node scripts/check-contrast.mjs
 *   node scripts/check-contrast.mjs --css <path-to-css>
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio } from '../src/lib/contrast.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/**
 * Parses CSS text and evaluates contrast for all declared theme pairs.
 *
 * @param {string} cssContent
 * @returns {{ ok: boolean, totalPairs: number, results: Array<{ theme: string, pair: string, fgToken: string, fgHex: string, bgToken: string, bgHex: string, ratio: number, passes: boolean }>, errors: string[] }}
 */
export function checkContrastInCss(cssContent) {
  // Strip comments
  const cleanCss = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');

  const themeBlockRegex = /\[data-theme=["']([^"']+)["']\]\s*\{([^}]+)\}/g;
  const results = [];
  const errors = [];
  let match;

  while ((match = themeBlockRegex.exec(cleanCss)) !== null) {
    const theme = match[1];
    const blockContent = match[2];

    const tokens = {};
    const pairs = [];

    const declarations = blockContent.split(';');
    for (const decl of declarations) {
      const trimmed = decl.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      const prop = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();

      if (prop.startsWith('--pair-')) {
        const parts = val.split(/\s+on\s+/);
        if (parts.length === 2) {
          pairs.push({
            name: prop,
            fgToken: parts[0].trim(),
            bgToken: parts[1].trim(),
          });
        }
      } else if (val.startsWith('#')) {
        tokens[prop] = val.trim();
      }
    }

    for (const pair of pairs) {
      const fgHex = tokens[pair.fgToken];
      const bgHex = tokens[pair.bgToken];

      if (!fgHex || !bgHex) {
        errors.push(
          `[${theme}] ${pair.name}: unresolved token (${pair.fgToken}=${fgHex || 'undefined'}, ${pair.bgToken}=${bgHex || 'undefined'})`
        );
        continue;
      }

      let ratio;
      try {
        ratio = contrastRatio(fgHex, bgHex);
      } catch (err) {
        errors.push(
          `[${theme}] ${pair.name}: failed to compute ratio for ${pair.fgToken} (${fgHex}) on ${pair.bgToken} (${bgHex}): ${/** @type {Error} */ (err).message}`
        );
        continue;
      }

      const passes = ratio >= 4.5;
      results.push({
        theme,
        pair: pair.name,
        fgToken: pair.fgToken,
        fgHex,
        bgToken: pair.bgToken,
        bgHex,
        ratio,
        passes,
      });

      if (!passes) {
        errors.push(
          `[${theme}] ${pair.name}: ${pair.fgToken} (${fgHex}) on ${pair.bgToken} (${bgHex}) has contrast ratio ${ratio.toFixed(2)}:1 (< 4.5:1 minimum)`
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    totalPairs: results.length,
    results,
    errors,
  };
}

// CLI Execution guard
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let cssPath = join(ROOT, 'src', 'styles', 'tokens.css');

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--css' && process.argv[i + 1]) {
      cssPath = resolve(process.cwd(), process.argv[i + 1]);
      i++;
    }
  }

  if (!existsSync(cssPath)) {
    process.stderr.write(`CSS file not found: ${cssPath}\n`);
    process.exit(1);
  }

  let cssContent;
  try {
    cssContent = readFileSync(cssPath, 'utf8');
  } catch (err) {
    process.stderr.write(`Cannot read CSS file ${cssPath}: ${/** @type {Error} */ (err).message}\n`);
    process.exit(1);
  }

  const { ok, totalPairs, errors } = checkContrastInCss(cssContent);

  if (!ok) {
    for (const err of errors) {
      process.stderr.write(`${err}\n`);
    }
    process.exit(1);
  }

  console.log(`contrast ok: ${totalPairs} theme pairs verified (all >= 4.5:1)`);
  process.exit(0);
}
