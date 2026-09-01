/**
 * Ensure the Postgres extensions a schema depends on exist, before anything
 * runs DDL that names a type one of them provides.
 *
 * ## Why this is not a numbered migration
 *
 * An extension has to exist BEFORE the first statement that names a type it
 * provides — a `geography` column backed by PostGIS is the running example,
 * but the same is true of any extension-provided type or operator class. A
 * migration that creates such a column fails outright on a database with no
 * extension installed — and it fails only on a FRESH database, which is
 * precisely the shape that passes on a developer's warm machine and then
 * fails in CI or on a new managed-database instance.
 *
 * Putting `CREATE EXTENSION` in a numbered migration would answer that only
 * for as long as nobody renumbers, squashes or regenerates the sequence.
 * Where the schema TS is the source of truth and migrations get regenerated
 * centrally under whatever number is correct, anything that must be true
 * before the FIRST migration cannot live inside the numbered sequence at
 * all. So it is a precondition of the migrator instead — see `runner.ts`,
 * which calls this before applying anything, on every run, in every
 * environment that runs migrations. There is then no environment where the
 * ordering can be wrong, and no migration number that can be assigned
 * wrongly.
 *
 * ## Why `IF NOT EXISTS` is the right spelling on a managed database, and
 * what it does NOT do
 *
 * `CREATE EXTENSION` typically needs a superuser (`rds_superuser` on RDS)
 * for a non-trusted extension, which the application's migration role may
 * not have. `IF NOT EXISTS` short-circuits on the duplicate check BEFORE any
 * privilege check, so once the extension is installed — by infrastructure,
 * by a database's master user, once — this step is a NOTICE and a no-op for
 * an unprivileged role.
 *
 * That is the whole of what it buys. It is NOT a fallback that installs the
 * extension where it is absent, and the difference only shows up on a
 * database nobody has prepared: an unprivileged role still gets
 * `permission denied to create extension "…"` — owning the database is not
 * enough. So a new target database is a two-party job: a privileged role
 * runs `CREATE EXTENSION` once, and only then can the migration role
 * migrate.
 *
 * ## The trap a pre-built database image does NOT cover
 *
 * A Postgres image that seeds an extension into its default database does so
 * for THAT database (and sometimes a named template), never for
 * `template1`. A test harness that creates a fresh throwaway database per
 * run with no `TEMPLATE` clause creates it FROM `template1`, so it lands
 * without the extension regardless of which image is running. Running the
 * right image is necessary and not sufficient; this step is what makes each
 * freshly created database usable.
 */

import postgres from 'postgres';

/** Seconds the one-shot admin connection waits before forcing itself shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

/**
 * Extension names are interpolated into DDL (`CREATE EXTENSION` takes no
 * bound parameter), so the vocabulary is constrained to what a real
 * extension name can contain. The guard exists so an entry sourced from
 * anywhere other than a literal in the caller's own code cannot become an
 * injection site — and it matters more here than it would in a
 * single-consumer file, because the list is supplied by the CALLER rather
 * than fixed in this module.
 */
const EXTENSION_NAME = /^[a-z][a-z0-9_]*$/;

export interface RequiredExtension {
  /** The `CREATE EXTENSION` name. */
  readonly name: string;
  /** What in the caller's schema stops working without it. */
  readonly reason: string;
}

/**
 * Create every extension in `extensions` on `databaseUrl`, in one short-lived
 * connection.
 *
 * Idempotent by construction (`IF NOT EXISTS`), so it is safe to run before
 * every migration rather than only on a fresh database.
 *
 * Every name is validated BEFORE any connection is opened, and an empty list
 * opens no connection at all — a caller with no extension dependencies must
 * be able to call this against a database that does not exist yet without
 * that failing.
 *
 * @throws {Error} When a name does not match the allowed vocabulary, when an
 *   extension is unavailable in the server's installation, or when the role
 *   may not create it and nobody has installed it already. All three are
 *   environment (or input) faults that must stop the migration rather than
 *   let it fail later with a confusing "type … does not exist".
 */
export async function ensureExtensions(
  databaseUrl: string,
  extensions: readonly RequiredExtension[]
): Promise<void> {
  if (extensions.length === 0) return;

  for (const extension of extensions) {
    if (!EXTENSION_NAME.test(extension.name)) {
      throw new Error(
        `Refusing to create extension "${extension.name}": an extension name \
must match /^[a-z][a-z0-9_]*$/.`
      );
    }
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    for (const extension of extensions) {
      try {
        await client.unsafe(`create extension if not exists "${extension.name}"`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not ensure the "${extension.name}" extension: ${detail}
It is required because ${extension.reason}
Locally and in CI this means the image the database runs from must ship it \
(for example, postgis/postgis in place of a bare postgres image, for \
PostGIS). On a managed database, a role with sufficient privilege must run \
\`CREATE EXTENSION\` once; after that this step is a no-op for the \
migration role.`
        );
      }
    }
  } finally {
    await client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }
}
