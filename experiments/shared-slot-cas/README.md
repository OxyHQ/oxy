# Shared slot CAS: executable research model

Run `python3 experiments/shared-slot-cas/proof.py`. The tests use separate OS
processes and one SQLite database on the local filesystem, with synthetic values
only. A delayed writer that observed an older version cannot replace a newer
committed value; a terminated writer's uncommitted transaction is rolled back;
an unconditional legacy writer still replaces a CAS-protected value. These are
properties of this model and its filesystem, not results from an Android or iOS
backend, real credentials, the Oxy API, or app integration.

A usable design would require all participating apps to address exactly one
accessible authority, authorize each operation, perform a conditional write and
advance the version atomically, and never expose credentials in logs. Network
proof and other slow operations must occur outside the authority's transaction.
Local logout and login must not wait for replication; failures and timeouts must
be reported as unknown, since they do not cancel a write already in flight.
A stale writer's authority version can protect a newer committed write only when
all writers participate in the same rule; server-side validity and holder proof
still need checking, and `device_sessions.revision` is not this slot version.

No existing deployment provides this model end to end:

- Android fans out among up to four separately installed host providers with
  separate storage. Selecting one canonical host, secure access, removal or
  reinstall, migration, and unavailable-host recovery need design. A lock in
  each provider does not synchronize distinct hosts. Provider calls can run on
  multiple Binder threads.
- iOS current shared storage uses Expo SecureStore and an access group, not a
  shared SQLite database. Apple documents uniqueness of generic password items
  for the same class, access group, account, service and synchronizability;
  `SecItemAdd` can therefore provide a first-writer-only seed in a new native
  namespace, but it is not a compare-and-swap for replacement or deletion.
  Expo's existing update path and old apps can bypass any new rule. Do not rely
  on undocumented Keychain internals.
- A different SQLite-backed shared container requires proof that every deployed
  participant has access to the same persistent database, correct encryption and
  key management, migration from the Keychain, lifecycle/recovery, and tested
  filesystem locking and crash semantics on supported devices. No such migration
  or container is implemented here.

References: [Apple Keychain item uniqueness](https://developer.apple.com/documentation/security/errsecduplicateitem), [Android provider threading](https://developer.android.com/guide/components/processes-and-threads), [SQLite isolation](https://www.sqlite.org/isolation.html).
