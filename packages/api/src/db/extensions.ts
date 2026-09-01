/**
 * Postgres extensions this schema requires.
 *
 * The registry is DATA, with a reason per entry — the same shape as
 * `DEFERRED_FOREIGN_KEYS` and `PROTECTED_COLUMNS`, for the same reason: a rule
 * a reader can enumerate beats a rule spread across the files that happen to
 * need it. The registry stays here because it names THIS schema's own tables;
 * the mechanism that ensures it (`ensureExtensions`, `RequiredExtension`)
 * lives in `@oxyhq/db/migrate` — see that module's doc comment for why an
 * extension has to exist before the first migration that names a type it
 * provides, and why `IF NOT EXISTS` is the right spelling on a managed
 * database.
 */

import type { RequiredExtension } from '@oxyhq/db/migrate';

/**
 * Every extension the schema depends on. An entry here is a claim that some
 * column, index or constraint does not exist without it — not a convenience.
 */
export const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [
  {
    name: 'postgis',
    reason:
      '`user_locations.geo` is a generated `geography(Point,4326)` column with a ' +
      'GiST index; `geography`, `ST_MakePoint`, `ST_DWithin` and `ST_Distance` ' +
      'all come from PostGIS.',
  },
];
