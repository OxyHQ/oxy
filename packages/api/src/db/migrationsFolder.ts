/**
 * `packages/api/drizzle`, resolved from this module rather than the working
 * directory. `src/db/` and `dist/db/` are both exactly two levels below the
 * package root, so the same expression is correct whether this file runs as
 * TypeScript under bun/ts-jest or as the compiled `dist/db/` output in the
 * container.
 *
 * Split out from `migrate.ts` so it can be imported — by `scripts/`,
 * `migrationLedger.test.ts`, `migrationPhases.test.ts` — without pulling in
 * that file's top-level `main()` invocation.
 */

import { join } from 'node:path';

export const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');
