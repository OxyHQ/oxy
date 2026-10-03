# Foreground approval pins and concurrent withdrawal

Source: `1134a419cb8e56b6be00036bfac162bcefa775c4`. This addresses [the two P2 reports](https://github.com/OxyHQ/oxy/pull/1557#issuecomment-5968300004).

A requester approval now retains the exact registration ID, version and digest approved at creation. Ticket issuance checks those stored values even when the caller omits `expectedCatalog`; a legitimate catalogue replacement requires a new requester approval. Signed requester tickets always contain this pin. Existing Alia/agent behavior is preserved.

Concurrent logout or expiry can invalidate the session after its first SQL validation. The known `ApiError(401, INVALID_SESSION)` from the subsequent binding read produces a refusal. The `/tickets` route uses the existing async handler; unexpected failures produce a bounded HTTP 500 rather than an unhandled rejection or pending response. Unexpected errors are not classified as withdrawn sessions.

The five new fixtures first failed against `f5804cdb8`: two stale approvals incorrectly issued tickets, and logout, expiry and an unexpected failure left three HTTP requests pending. The same five fixtures pass with the fix. Validation uses real SQL, JWTs and HTTP; a spy pauses the real session validator after its initial SQL result to control withdrawal. The unexpected-error fixture injects one synthetic failure. Redis nonce transport and AWS attestation remain isolated by the existing fixtures. No live authority, deployment, provider event delivery or consumer adoption is claimed.

Normal generation created 0142 and its snapshot/journal. The migration preserves all five generated statements in order and inserts exactly one source-owned UPDATE before the CHECK. That UPDATE revokes old requester approvals without a captured pin while preserving their IDs and history; it never reconstructs approval from a current catalogue. The snapshot changes only `capability_execution_authorizations`. An active requester must have a complete pin; an old revoked requester can retain three NULL fields. Alia/agent pins remain NULL.

Validation:

- `python3 scripts/rehearsal/test-i05-foreground-authority.py`: normal 142 migrations, repeat no-op, seven suites and 71 tests. The control suites include Alia/agent authority and workload attribution.
- `python3 scripts/rehearsal/test-i05-foreground-migration.py`: a temporary 141 journal prefix copies original SQL bytes and uses the shared normal runner; the actual API migrator then applies 142 and repeats. The old requester is revoked with ID, creation date and run preserved; Alia/agent stay active. Reactivation without a pin and partial pins fail the named CHECK. Repository snapshots and journal are untouched by this fixture.
- API TypeScript and scripts TypeScript exit 0; actual Biome 1.9.4 checks six changed files with `--error-on-warnings`, exit 0. A discarded initial `bun x biome` invocation resolved a different package and is not validation evidence.
- Snapshot sync reads 223 tables and emits nothing. Migration phase/journal and committed OpenAPI freshness pass (367 paths, 422 operations). `migration-source-equality.json` compares every generated statement and the SQL source supplement.

Every PostgreSQL process was started with fresh initdb, checked for its PID, executable, data directory and listening socket before CREATE DATABASE, and stopped in finally. One initial upgrade fixture failed before migration 142 because its raw SQL omitted the required user color; its failure log is preserved, then the fixture was corrected. No product failure is inferred from that setup error. Empty TypeScript logs mean the recorded commands completed with exit 0, not that output was discarded.

`proof.json` pins 18 source files and 22 records. The fixture was WIP during RED and is now committed with the identical regression cases; the RED runtime hashes are recorded separately. SDK code and packed artifacts are unchanged, so no new packaging claim is made. Canonical registrar configuration and live I05 adoption remain separate pending work.
