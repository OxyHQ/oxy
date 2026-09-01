/**
 * Post-build script: fixes ESM output for Node.js compatibility.
 *
 * 1. Adds .js extensions to bare relative imports
 * 2. Resolves directory imports to index.js
 * 3. Adds import attributes for JSON imports
 *
 * `@oxyhq/db`'s only runtime imports are its `drizzle-orm`/`postgres` peer
 * dependencies, resolved via bare package specifiers that Node's own resolver
 * handles directly — so no CJS default-import interop rewrites are needed
 * here. What `tsconfig.esm.json`'s `moduleResolution: "bundler"` does leave
 * broken are this package's OWN relative specifiers (`./casing`, `./migrate`),
 * which is what this script fixes.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ESM_DIR = new URL('../dist/esm', import.meta.url).pathname;

async function fixSpecifier(specifier, fromFile) {
  const dir = dirname(fromFile);
  const abs = resolve(dir, specifier);

  try {
    const s = await stat(abs);
    if (s.isDirectory()) {
      return specifier + '/index.js';
    }
  } catch {
    // Not a directory on disk — fall through to appending the .js extension.
  }

  return specifier + '.js';
}

async function walk(dir) {
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) {
      await walk(full);
    } else if (entry.endsWith('.js')) {
      const content = await readFile(full, 'utf8');

      // Fix 1: Add .js to bare relative specifiers (skip .js and .json)
      const barePattern = /((?:from|import)\s+['"])(\.\.?\/[^'"]+?)(?<!\.js)(?<!\.json)(['"])/g;
      let match;
      const replacements = [];

      while ((match = barePattern.exec(content)) !== null) {
        const fixed = await fixSpecifier(match[2], full);
        replacements.push({ original: match[0], replaced: match[1] + fixed + match[3] });
      }

      let updated = content;
      for (const { original, replaced } of replacements) {
        updated = updated.replace(original, replaced);
      }

      // Fix 2: Add `with { type: "json" }` to JSON imports that lack it
      updated = updated.replace(
        /((?:from|import)\s+['"][^'"]+\.json['"])(?!\s*with\b)/g,
        '$1 with { type: "json" }',
      );

      if (updated !== content) {
        await writeFile(full, updated);
      }
    }
  }
}

await walk(ESM_DIR);
console.log('ESM imports fixed');
