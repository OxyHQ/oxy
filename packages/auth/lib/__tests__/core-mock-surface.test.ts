/**
 * The `@oxyhq/core` test mock must cover every value the app actually imports.
 *
 * `setup-core-source.ts` stubs `@oxyhq/core` with an explicit ALLOWLIST of pure
 * helpers, because importing the real entry pulls optional React Native modules
 * bun cannot parse. An allowlist that is maintained by hand drifts, and this
 * particular drift is close to invisible: a missing name does not fail one
 * assertion, it makes bun abort the ENTIRE importing test file with
 * `SyntaxError: Export named '…' not found in module …/core/dist/esm/index.js`.
 * Those cases then simply do not run. When `hub-passkey.tsx` moved from
 * `getAccountDisplayName` to `getNormalizedUserHandle`, the suite reported
 * "120 pass, 1 fail" — four `hub-passkey` cases had silently left the run, and
 * the error text pointed at core's built output rather than at this allowlist,
 * which sent the first diagnosis at the build.
 *
 * So: scan the app's own source for value imports of `@oxyhq/core` and assert
 * the mocked module actually provides each one. Type-only imports are skipped —
 * they are erased before runtime and never reach the module registry.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as mockedCore from '@oxyhq/core';

/** App source roots. `__tests__` is excluded — test files may stub freely. */
const APP_SOURCE_ROOTS = ['src', 'components', 'lib', 'hooks'];

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * Floors that make a broken traversal fail instead of passing vacuously. If a
 * refactor legitimately drops below these, re-count and lower them deliberately
 * — do not delete the check.
 */
const MIN_FILES_SCANNED = 20;
const MIN_VALUE_IMPORTS = 5;

/** Every `.ts`/`.tsx` file under the app source roots, excluding test folders. */
function collectSourceFiles(): string[] {
    const packageRoot = join(import.meta.dir, '..', '..');
    const found: string[] = [];

    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return; // A root that does not exist in this package layout.
        }
        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '__tests__') continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
                found.push(full);
            }
        }
    };

    for (const root of APP_SOURCE_ROOTS) walk(join(packageRoot, root));
    return found;
}

/**
 * `import { a, b as c, type D } from "@oxyhq/core"` — including multi-line.
 *
 * The specifier list is `[^{}]*`, NOT a lazy `[\s\S]*?`: lazy matching happily
 * starts at an EARLIER import's brace and runs to core's closing one, so a file
 * whose first import is `{ useCallback } from "react"` yields `useCallback` as a
 * "core import". That produced three phantom names on the first run of this
 * scanner. Excluding braces confines each match to a single import clause.
 */
const CORE_IMPORT = /import\s+(type\s+)?\{([^{}]*)\}\s*from\s*["']@oxyhq\/core["']/g;

/**
 * The VALUE names a file imports from `@oxyhq/core`. Returns the imported name
 * (the left side of `as`), since that is the key the module must expose.
 */
function valueImportsFrom(source: string): string[] {
    const names: string[] = [];
    for (const match of source.matchAll(CORE_IMPORT)) {
        if (match[1]) continue; // `import type { … }` — erased before runtime.
        for (const raw of match[2].split(',')) {
            const specifier = raw.trim();
            if (specifier.length === 0) continue;
            if (specifier.startsWith('type ')) continue; // inline type specifier
            names.push(specifier.split(/\s+as\s+/)[0].trim());
        }
    }
    return names;
}

describe('@oxyhq/core test mock surface', () => {
    const files = collectSourceFiles();

    const imported = new Map<string, string[]>();
    for (const file of files) {
        for (const name of valueImportsFrom(readFileSync(file, 'utf8'))) {
            const sites = imported.get(name) ?? [];
            sites.push(file);
            imported.set(name, sites);
        }
    }

    it('scanned a plausible amount of app source', () => {
        expect(files.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
        expect(imported.size).toBeGreaterThanOrEqual(MIN_VALUE_IMPORTS);
    });

    it('provides every value the app imports from @oxyhq/core', () => {
        const missing = [...imported.entries()]
            .filter(([name]) => !(name in mockedCore))
            .map(([name, sites]) => `${name} (imported by ${sites.join(', ')})`);

        expect(
            missing,
            `setup-core-source.ts does not stub these @oxyhq/core exports, so bun will abort ` +
                `the whole test file that imports them:\n  ${missing.join('\n  ')}`,
        ).toEqual([]);
    });

    /*
     * The other direction. A stub nobody imports is dead weight that outlives
     * the call site it was added for (`getAccountDisplayName` did), and it makes
     * the allowlist read as broader coverage than it has.
     */
    it('stubs nothing the app no longer imports', () => {
        const unused = Object.keys(mockedCore).filter((name) => !imported.has(name));
        expect(unused).toEqual([]);
    });
});
