/**
 * No TypeScript source in this package may contain a raw control character.
 *
 * ## Why this is a gate and not a style preference
 *
 * A single raw NUL makes `file` classify the source as `data`, and GNU grep then
 * treats it as binary: `grep -c export resolutions.ts` printed nothing and
 * exited 1 on a 500-line file full of exports. Every grep-based check over that
 * file — a reviewer's search, a CI scanner, an agent verifying its own work —
 * silently reports zero matches instead of failing. That is the worst shape a
 * check can have, and it is invisible: no editor renders the byte, no linter
 * flagged it, `tsc` and 4155 tests passed with it in place.
 *
 * It is not hypothetical. Five files in this package carried one, four of them
 * on the migration path (`backfill/resolutions.ts`, `backfill/values.ts`,
 * `backfill/bulkLoad.ts`, `schema/signedRecords.ts` — the three backfill files
 * went with the backfill itself once the port was done, so only git history has
 * them now), and one agent working on them concluded its shell's `grep` was
 * broken and routed every content check through python for a whole session. The
 * blindness landed on exactly the files that encode irreversible decisions about
 * production data.
 *
 * ## What is allowed instead
 *
 * The escape. `'\u0000'` in a string or template literal produces the SAME byte
 * at runtime, so a separator stays a separator and a hash input stays a hash
 * input — `values.ts` derives uuid v5 row ids from `sha256(parent \u0000 path
 * \u0000 ordinal)` and those ids did not move when the raw bytes were escaped
 * (the full suite is the evidence: 4155 tests, unchanged).
 *
 * Tab, newline and carriage return are excluded — they are ordinary whitespace.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'scripts'];

/** Every byte below 0x20 except tab/LF/CR, plus DEL. */
const FORBIDDEN = new Set<number>([
  ...Array.from({ length: 0x20 }, (_, byte) => byte).filter(
    (byte) => byte !== 0x09 && byte !== 0x0a && byte !== 0x0d
  ),
  0x7f,
]);

function typescriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...typescriptFiles(path));
      continue;
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/** `<path>:<line> contains U+XXXX` for every offending byte, so a failure names the fix. */
function offences(path: string): string[] {
  const bytes = readFileSync(path);
  const reported: string[] = [];
  let line = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) line += 1;
    else if (FORBIDDEN.has(byte)) {
      reported.push(`${path}:${line} contains U+${byte.toString(16).padStart(4, '0').toUpperCase()}`);
    }
  }
  return reported;
}

describe('source files carry no raw control characters', () => {
  const files = ROOTS.flatMap((root) => typescriptFiles(join(__dirname, '..', '..', root)));

  /**
   * A traversal that silently walks nothing would make the assertion below pass
   * for the wrong reason — the failure mode this whole file exists to prevent.
   * The floor is far under the real count (1,000+) and only ever catches a
   * scanner that broke, never a legitimate change in the tree's size.
   */
  it('scans the package, so a broken traversal cannot pass silently', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it('finds no raw control character in any TypeScript source', () => {
    expect(files.flatMap(offences)).toEqual([]);
  });
});
