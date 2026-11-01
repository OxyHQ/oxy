# Account query migration: research and unresolved requirements

This is an investigation, not a migration implementation or an authorization
contract. Do not change `accountQueries` filters on a production app on the
assumption that the old persisted entries have been preserved. The existing
blob is keyed by subject; it contains no verified binding to an actor.

## Observed behavior

Services 13.16.0 maintains one `oxy_account_queries:<subject>` blob for all
registered roots and mutations. Every persister has its own ordered I/O queue;
that queue does not order other provider instances or browser tabs. The tests
in `accountQueryPersistenceMigration.audit.test.ts` deliberately document
current failure modes, not desired future behavior:

- A changed filter omits a legacy root from hydration. The next snapshot can
  overwrite the same blob without that root, although another root remains.
- A failed read is treated as no cache. A later snapshot can overwrite the
  unread blob. The web adapter also catches localStorage read, write and remove
  errors: its resolved promises cannot prove a write or deletion occurred.
- When two instances use the same storage, one can write a stale full snapshot
  over another instance's newer root. A writer still active after another
  instance signs out can write that subject's blob again.

Run the isolated synthetic-storage tests from the repository with the normal
frozen installation:

```sh
bun run --cwd packages/services test --runInBand accountQueryPersistenceMigration.audit.test.ts
```

The optional `scripts/diagnostics/account-cache/web-two-tabs.cjs` runs the
source persister and web storage adapter in two isolated Chromium tabs of the
same temporary localhost origin. It needs `esbuild`, `playwright` and a
compatible Chromium available to Node; these diagnostic dependencies are not
added to the package or its lockfile. It uses a new browser context and
synthetic content, with a simulated provider/session lifecycle. For example,
set `NODE_PATH` to directories containing those tools and their dependencies,
then run:

```sh
NODE_PATH="$AUDIT_NODE_PATH" \
  node scripts/diagnostics/account-cache/web-two-tabs.cjs "$AUDIT_CHROMIUM"
```

If Playwright has its managed browser installed, the Chromium path argument can
be omitted. This verifies the reported sequence in a browser but does not model
real authentication, session synchronization, actor identity, network failures,
all supported browsers, native devices or physical crash durability. Code
inspection shows one persister is constructed per `OxyRuntimeProvider`, with
localStorage used on web. `SessionClient` also broadcasts session-commit pings
to same-origin tabs and starts an asynchronous bootstrap in an authenticated
recipient; the channel is feature-detected, recipients without a current access
token do not bootstrap on that ping, and bootstrap can fail. There is also a
socket session-state path. This harness does not run either mechanism and does
not establish how long a real tab stays signed in after logout, or that a
revoked production session performs the demonstrated write. Neither the
harness nor the session ping establishes an atomic persistence barrier.

## Requirements before an opt-in migration

1. **Ownership and authorization.** A mechanical backup of an old blob does
   not authorize displaying or replaying it. Establish a subject, actor,
   session/scope and actual-bearer binding with an explicit offline validity
   and revocation policy. Subject-only blobs with unknown actor must not be
   attributed to the current actor merely from a local epoch or JWT payload.
   An unattributed queue must not replay automatically.
2. **Complete writers and downgrade.** Identify every writer, lifecycle and
   installed version. Old clients writing the old key do not participate in a
   new protocol. A backup cannot guarantee preservation across downgrade,
   concurrent tabs or an old native binary unless a platform-enforced mechanism
   includes or fences *all* those writers. An app reload or cooperative
   broadcast alone is not that guarantee. Define version compatibility and
   fail-closed behavior before enabling any filtering or restore.
3. **Atomicity and fencing.** A storage abstraction must expose actual atomic
   transactions or equivalent cross-instance compare-and-swap and fencing over
   the source snapshot, backup, migration marker and writer generation. A
   writer must be rejected if its generation became stale; a lock that can
   expire without fencing is insufficient. Verify all platform adapters and
   mixed-version behavior. Web Locks alone do not fence old clients or provide
   an atomic transaction across independent storage mechanisms.
4. **Reliable I/O and recovery.** Distinguish missing data from read failure,
   quota, denied access and corruption. No destructive migration or normal
   writer may start on an unconfirmed backup; failures need a visible,
   retryable state. Readback by itself is not a cross-instance transaction or
   proof of crash durability. Test crashes at each boundary, idempotent retry,
   partial/corrupt backup, cache expiry/build buster, queued mutations and
   shared roots. Native adapters need their own concrete durability tests.
5. **Sign-out and lifetime.** Define whether explicit sign-out deletes or
   retains a backup, the permitted recovery action, and user-visible failures.
   Any deletion must be ordered with all writers and recovery operations, use
   the same fencing mechanism, and prevent stale writers from recreating data.
   Existing best-effort removal does not demonstrate deletion of every copy.
6. **Scope and disclosure.** A backup is private data, including potentially
   sensitive query keys and mutation variables. Keep it out of global caches,
   logs, UI and other subjects' or actors' contexts. Define encryption and key
   lifecycle where the platform supports them; do not claim protection merely
   from a different storage key. Recovery requires explicit authorization and
   conflict handling; an inactive query's previous value is historical, not a
   current server confirmation.

These are conditions to design and test, not guarantees provided by the current
`StorageInterface`. No existing backup is created by this research.
