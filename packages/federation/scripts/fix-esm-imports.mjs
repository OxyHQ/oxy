/**
 * Post-build script: fixes ESM output for Node.js compatibility.
 *
 * 1. Adds .js extensions to bare relative imports
 * 2. Resolves directory imports to index.js
 * 3. Adds import attributes for JSON imports
 * 4. Rewrites CJS named imports to default-import + destructure
 *
 * `@oxyhq/federation` ships zero CJS runtime dependencies at the moment (the
 * `.` entry is the pure connector contract + normalized DTOs), so
 * {@link CJS_PACKAGES} is empty. When a later phase adds a CJS-only runtime
 * dependency to the `./node` engine, add it here so ESM default-import interop
 * is applied.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ESM_DIR = new URL('../dist/esm', import.meta.url).pathname;

// CJS packages that need default-import interop. Empty in Phase 0.
const CJS_PACKAGES = new Set();

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

      // Fix 3: Rewrite CJS named imports to default + destructure
      // e.g. a named import becomes a default import plus destructuring.
      for (const pkg of CJS_PACKAGES) {
        const namedRe = new RegExp(
          `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${pkg}['"];?`,
          'g',
        );
        updated = updated.replace(namedRe, (_, names) => {
          const safeName = '_cjs_' + pkg.replace(/[^a-zA-Z0-9]/g, '_');
          const destructured = names
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean)
            .map((n) => n.replace(/\s+as\s+/, ': '))
            .join(', ');
          return `import ${safeName} from '${pkg}';\nconst { ${destructured} } = ${safeName};`;
        });
      }

      if (updated !== content) {
        await writeFile(full, updated);
      }
    }
  }
}

await walk(ESM_DIR);
console.log('ESM imports fixed');
