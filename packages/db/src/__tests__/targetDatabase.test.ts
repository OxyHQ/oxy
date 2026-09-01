/**
 * `readTargetDatabase` only — no database required.
 *
 * `assertMigrationTarget` compares against a REAL `current_database()`, and a
 * stubbed `postgres.Sql` would only ever prove the comparison agrees with the
 * value the stub was told to return — the assertion and the fixture would be
 * the same decision written twice. Its coverage lives in
 * `liveDatabase.test.ts`, against a real database from the ephemeral harness
 * `testing.ts` provides, where `current_database()` is answered by Postgres.
 */

import { MissingMigrationTargetError, readTargetDatabase } from '../migrate/targetDatabase';

describe('readTargetDatabase', () => {
  it('REFUSES an argv with no --target-database at all', () => {
    expect(() => readTargetDatabase([])).toThrow(MissingMigrationTargetError);
    expect(() => readTargetDatabase(['--dry-run'])).toThrow(MissingMigrationTargetError);
  });

  it('REFUSES a flag present but empty, rather than accepting an empty target', () => {
    // `--target-database=` reads as "I named one" to a `startsWith` check and is
    // the shape a shell produces from an unset variable: `--target-database=$DB`
    // with `DB` unset expands to exactly this.
    expect(() => readTargetDatabase(['--target-database='])).toThrow(MissingMigrationTargetError);
    expect(() => readTargetDatabase(['--target-database=   '])).toThrow(
      MissingMigrationTargetError
    );
  });

  it('accepts a named target, so the refusals above are not unconditional', () => {
    expect(readTargetDatabase(['--target-database=my_app'])).toBe('my_app');
    expect(readTargetDatabase(['--other', '--target-database=my_app_audit_probe'])).toBe(
      'my_app_audit_probe'
    );
  });

  it('trims, so a trailing newline from a shell substitution is not a different database', () => {
    expect(readTargetDatabase(['--target-database=my_app\n'])).toBe('my_app');
  });
});
