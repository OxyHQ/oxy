/**
 * `ensureExtensions` only — no database required.
 *
 * Both cases below are checkable without a live Postgres, and deliberately
 * point at an unreachable host to prove it: a name-validation failure and an
 * empty extension list must both resolve/reject WITHOUT ever opening a
 * connection. `client.unsafe(...)` succeeding or failing against a real
 * server is integration coverage this package's ephemeral-database harness
 * (`testing.ts`, `liveDatabase.test.ts`) could now provide, but does not yet:
 * that harness's own task closed the four functions Task 5 shipped with zero
 * coverage, not every live-Postgres gap in the package — this one is still
 * open.
 */

import { ensureExtensions } from '../migrate/extensions';

describe('ensureExtensions', () => {
  it('refuses a name that is not a bare identifier, before opening a connection', async () => {
    await expect(
      ensureExtensions('postgres://unreachable.invalid/db', [
        { name: 'postgis"; drop database x; --', reason: 'malicious' },
      ])
    ).rejects.toThrow(/must match/);
  });

  it('does nothing at all for an empty list', async () => {
    // A caller may require no extensions at all, and its database may not
    // exist yet when this runs — an unreachable host stands in for exactly
    // that: if this implementation opened a connection unconditionally, the
    // promise would reject (or hang) instead of resolving.
    await expect(
      ensureExtensions('postgres://unreachable.invalid/db', [])
    ).resolves.toBeUndefined();
  });
});
