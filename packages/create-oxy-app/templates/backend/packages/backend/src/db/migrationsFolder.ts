/**
 * Where the SQL migrations live — ONE constant, because two things read it.
 *
 * `db/migrate.ts` applies the folder; `db/postgres.ts` reads the same folder's
 * journal to decide whether a task may serve traffic (`GET /ready`). If those
 * two disagreed, readiness would assert against a journal the migrator does not
 * apply — and it would PASS, because a journal nobody applies has nothing
 * pending. A gate that cannot fail is worse than no gate, so the path is stated
 * once here rather than copied into both.
 *
 * It cannot simply be imported from `migrate.ts`: that module runs its `main()`
 * at load, so importing it to borrow a constant would run a migration.
 *
 * ## Resolved by finding the PACKAGE ROOT, not by counting directories
 *
 * No fixed depth is correct for both ways this module runs. `bun run db:migrate`
 * executes the TypeScript source at `src/db/`, two levels below the package
 * root; `bun run build` emits `dist/src/db/`, three levels below it. Walking up
 * to the nearest `package.json` is depth-independent, so it is right for both —
 * and it throws rather than guessing, because a silent fallback here produces a
 * migrator pointed at an empty directory that reports "nothing to do".
 *
 * `__dirname` rather than `import.meta.url`: this package compiles to CommonJS
 * (`@oxyhq/app-preset/tsconfig/backend.json`), and `import.meta` is a syntax
 * error under that module target.
 *
 * NOTE for the container image: the runtime stage copies `dist/`, so it must
 * also copy `drizzle/` beside `package.json` — for the migration task AND for
 * every serving task, since readiness reads the journal from here. The
 * `Dockerfile` does that beside the `dist` COPY.
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/** The nearest ancestor of `from` (inclusive) holding a `package.json`. */
function findPackageRoot(from: string): string {
  const { root } = parse(from);
  let dir = from;
  while (!existsSync(join(dir, 'package.json'))) {
    if (dir === root) {
      throw new Error(
        `Could not locate the backend package root above ${from}, so the drizzle ` +
          `migrations folder cannot be resolved. The runtime image must ship ` +
          `packages/backend/package.json beside dist/.`,
      );
    }
    dir = dirname(dir);
  }
  return dir;
}

export const MIGRATIONS_FOLDER = join(findPackageRoot(__dirname), 'drizzle');
