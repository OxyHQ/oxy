/**
 * Which database is this migration allowed to write DDL to — asserted, not
 * assumed.
 *
 * ## Why this guard exists
 *
 * Pointed at the wrong database, a bulk data copy usually hits a missing table
 * and dies loudly. Pointed at the wrong database, a migrator instead finds an
 * empty journal ledger, applies the whole journal, logs `Applied N Postgres
 * migration(s)` and exits 0 — leaving the real database untouched while the
 * operator reads a success line. Whatever runs next then acts against a schema
 * that does not exist. There is no error to notice and nothing to roll back,
 * because nothing failed.
 *
 * ## An affirmative, not a denylist
 *
 * An explicit AFFIRMATIVE (`--target-database=<name>`) checked against
 * `current_database()`, not a denylist. A denylist answers only the mistakes
 * somebody thought of; an affirmative fails closed on a stale probe URL, on
 * another environment, on a database recreated under a different name. The
 * operator states where they believe they are pointing, and being wrong is the
 * case this catches. The message names BOTH sides for the same reason: "wrong
 * database" says you are wrong, `expected foo, got foo_audit_probe` says which
 * end to fix.
 */

import type { Sql } from 'postgres';

/** Raised when the connected database is not the one the operator named. */
export class WrongMigrationTargetError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `Refusing to migrate: the run expects ${JSON.stringify(expected)} but the \
connection string this process was given reaches ${JSON.stringify(actual)}.
One of those two is wrong, and this tool cannot tell which. Correct the \
expected name if the run named the wrong target; correct the connection \
string if this is pointed somewhere unintended. No DDL has been applied and \
the migration ledger has not been touched.`
    );
    this.name = 'WrongMigrationTargetError';
  }
}

/**
 * Raised when an argument list {@link readTargetDatabase} was asked to parse
 * names no target.
 *
 * Naming the flag here is not the deployment-specific knowledge this package
 * otherwise keeps out of its messages: `readTargetDatabase` PARSES
 * `--target-database=`, so the spelling is this module's own. Whether a caller
 * calls it at all — and therefore whether a target is required — is the
 * caller's decision; {@link assertMigrationTarget} is reached through an
 * OPTIONAL `expectedDatabase`, so this is not a claim that every run must
 * state one.
 */
export class MissingMigrationTargetError extends Error {
  constructor() {
    super(
      'Refusing to read a migration target: no --target-database=<name> in the ' +
        'arguments. Which database a run reaches is decided entirely by its ' +
        'connection string, so a run that does not state its intended target ' +
        'cannot be checked against it — and a migration aimed at the wrong ' +
        'database does not fail, it reports success over an untouched one. ' +
        'Example: `--target-database=my_app_audit_probe` for a rehearsal, ' +
        '`--target-database=my_app` for the cutover.'
    );
    this.name = 'MissingMigrationTargetError';
  }
}

/**
 * Read `--target-database=<name>` out of an argument list. No connection needed.
 *
 * Split from {@link assertMigrationTarget} so a mistyped flag is caught BEFORE
 * anything opens a socket — and so the refusal can be tested without a database.
 *
 * @throws {MissingMigrationTargetError} When no target was named.
 */
export function readTargetDatabase(argv: readonly string[]): string {
  const prefix = '--target-database=';
  const flag = argv.find((arg) => arg.startsWith(prefix));
  const target = flag?.slice(prefix.length).trim();
  if (target === undefined || target.length === 0) throw new MissingMigrationTargetError();
  return target;
}

/**
 * Check the named target against the database actually connected.
 *
 * MUST be the first statement issued on the connection: everything this
 * protects — extension setup, the ledger read, the DDL itself — is a write or
 * a precondition for one, so an assertion placed after any of them is checking
 * a database it has already begun changing.
 *
 * @throws {WrongMigrationTargetError} When they differ.
 */
export async function assertMigrationTarget(client: Sql, expected: string): Promise<void> {
  const rows = await client<{ current_database: string }[]>`select current_database()`;
  const actual = rows[0]?.current_database;
  if (actual !== expected) throw new WrongMigrationTargetError(expected, actual ?? '(unknown)');
}
