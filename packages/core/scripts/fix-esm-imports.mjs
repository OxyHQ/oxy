/**
 * Post-build script: fixes ESM output for Node.js compatibility.
 *
 * 1. Adds .js extensions to bare relative imports — STATIC AND DYNAMIC
 * 2. Resolves directory imports to index.js
 * 3. Adds import attributes for JSON imports
 * 4. Rewrites CJS named imports to default-import + destructure
 *
 * ## Why the dynamic form is called out
 *
 * `tsc` emits relative specifiers exactly as the source writes them, and this
 * package writes them without an extension throughout — which is legal under
 * `moduleResolution: bundler` and illegal in Node's ESM resolver. That is the
 * whole reason this script exists, and for its first life it only rewrote the
 * `from '...'` / `import '...'` forms, because `import\s+['"]` requires
 * whitespace after the keyword and `import('...')` has a parenthesis there.
 *
 * `await import('../x')` therefore shipped unrewritten in `dist/esm`, and it
 * failed the only way an unresolvable dynamic import can: at runtime, in the
 * consumer, as a rejected promise. `OxyServices.getServiceToken()`'s ADR 0026
 * attestation fallback loads `../server/workloadIdentity` that way, inside a
 * `try/catch` that reads a resolution failure as "this host cannot attest" — so
 * every ESM consumer of the built package was told it had no workload identity
 * and fell back to `Service credentials not provided`. It was invisible to
 * `bun run test` (jest resolves extensionless specifiers and the suite mocks
 * that module by name), invisible to `tsc`, and invisible to the CJS half of
 * the fleet, whose `require()` adds the extension for free. `mention-mcp` and
 * `alia` are ESM and are where it was finally measured.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * The tree to rewrite: `dist/esm` by default, an explicit path for the test.
 *
 * `src/__tests__/fixEsmImports.test.ts` runs this file against a fixture and
 * asserts what comes out, which is the only way to test a post-build step
 * without building the package first (core's CI job does not).
 */
const ESM_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : new URL('../dist/esm', import.meta.url).pathname;

// CJS packages that need default-import interop
const CJS_PACKAGES = new Set(['buffer', 'bip39', 'invariant']);

async function fixSpecifier(specifier, fromFile) {
  const dir = dirname(fromFile);
  const abs = resolve(dir, specifier);

  try {
    const s = await stat(abs);
    if (s.isDirectory()) {
      return specifier + '/index.js';
    }
  } catch {}

  return specifier + '.js';
}

async function walk(dir) {
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) {
      await walk(full);
    } else if (entry.endsWith('.js')) {
      let content = await readFile(full, 'utf8');

      // Fix 1: Add .js to bare relative specifiers (skip .js and .json).
      //
      // Three keyword forms reach a relative specifier and all three need the
      // extension in Node ESM:
      //   `from './x'`      — static import and re-export
      //   `import './x'`    — side-effect import
      //   `import('./x')`   — dynamic import
      // The third is the one this pattern used to miss: `import` is followed by
      // `(` rather than whitespace, so the `import\s+` alternative never
      // matched it and the specifier shipped extensionless. See the file header.
      const barePattern =
        /((?:from|import)\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+?)(?<!\.js)(?<!\.json)(['"])/g;
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
        // Named imports: import { x, y as z } from 'pkg'
        const namedRe = new RegExp(
          `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${pkg}['"];?`,
          'g',
        );
        updated = updated.replace(namedRe, (_, names) => {
          const safeName = '_cjs_' + pkg.replace(/[^a-zA-Z0-9]/g, '_');
          // Convert `x as Y` to `x: Y` for destructuring
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
