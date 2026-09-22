#!/usr/bin/env node
/**
 * Asserts that every `className` the app writes actually compiles to a rule.
 *
 * ## Why this is worth a script
 *
 * A className that Tailwind does not emit is INERT and SILENT. Nothing errors,
 * nothing warns, and on native the element simply renders with none of the
 * layout it asked for — which is the failure mode `~/Oxy/docs/frontend-conventions.md`
 * describes as masked by colours still working. A typo (`gap-space-13`, a rung
 * that does not exist) costs a padding, and you find out by looking.
 *
 * So: build `global.css` the way Metro does, collect every class the app uses,
 * and fail on any that the build did not emit.
 *
 *     node scripts/check-classnames.mjs
 *
 * ## Run it from THIS directory
 *
 * `@tailwindcss/postcss` auto-detects sources from the process CWD on top of the
 * `@source` globs, so the same input built from the monorepo root scans every
 * other package and answers a different question. Metro runs here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['app', 'components', 'hooks', 'lib', 'constants', 'utils'];

const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const files = SOURCE_DIRS.flatMap((dir) => {
  const path = join(ROOT, dir);
  try {
    return statSync(path).isDirectory() ? sourceFiles(path) : [];
  } catch {
    return [];
  }
});

if (files.length < 90) {
  console.error(`Only found ${files.length} source files — the directory layout moved and this check is not looking at the app.`);
  process.exit(1);
}

const used = new Map();
for (const file of files) {
  for (const match of readFileSync(file, 'utf8').matchAll(/className="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/).filter(Boolean)) {
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(file.slice(ROOT.length + 1));
    }
  }
}

const globalCss = join(ROOT, 'global.css');
const built = (await postcss([tailwind()]).process(readFileSync(globalCss, 'utf8'), { from: globalCss })).css;

// A class is emitted as a selector; escape the characters Tailwind escapes in one.
const emitted = (name) => built.includes(`.${name.replace(/([.:/[\]!])/g, '\\$1')}`);

const missing = [...used.keys()].filter((name) => !emitted(name)).sort();

if (missing.length) {
  console.error(`${missing.length} className(s) compile to NOTHING and are inert on native:\n`);
  for (const name of missing) {
    console.error(`  ${name}\n    ${[...new Set(used.get(name))].join('\n    ')}`);
  }
  console.error('\nEither the rung does not exist (check @oxy.so/bloom/design-tokens/theme.css)');
  console.error('or the file is outside global.css\'s @source globs.');
  process.exit(1);
}

console.log(`all ${used.size} classNames across ${files.length} files compile (${built.length} bytes of CSS)`);
