/**
 * Postgres extensions this schema requires.
 *
 * The registry is DATA, with a reason per entry — the same shape as
 * `DEFERRED_FOREIGN_KEYS` and `PROTECTED_COLUMNS`, for the same reason: a rule
 * a reader can enumerate beats a rule spread across the files that happen to
 * need it. The registry stays here because it names THIS schema's own tables;
 * the mechanism that ensures it (`ensureExtensions`, `RequiredExtension`)
 * lives in `@oxy.so/db/migrate` — see that module's doc comment for why an
 * extension has to exist before the first migration that names a type it
 * provides, and why `IF NOT EXISTS` is the right spelling on a managed
 * database.
 */

import type { RequiredExtension } from '@oxy.so/db/migrate';

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
  {
    name: 'pg_trgm',
    reason:
      '`users_people_search_trgm_idx` is a GIN index over the concatenated ' +
      'people-search text using `gin_trgm_ops`, and it is the only thing that ' +
      'can serve the people-search predicate. That predicate is four OR-ed ' +
      "leading-wildcard `ILIKE '%term%'` tests (username, first name, last " +
      'name, bio) — a substring match, not a lexeme match, so no b-tree and no ' +
      '`tsvector` can answer it and every people search was a sequential scan ' +
      'of `users`. Unlike PostGIS this is a TRUSTED extension (PG13+), so a ' +
      'database owner can create it without `rds_superuser`, and it ships with ' +
      'every mainline `postgres` / `postgis/postgis` image.',
  },
];
