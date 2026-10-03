# I01/I03 — additive schema 0137

This handoff unblocks the serial generation of billing migration 0138. It does
**not** enable bot login or claim that runtime epoch/revocation enforcement is
implemented. Those remain in I01/I03, authorized by Nate's architecture decision.

## Contract

- `user_auth_methods`: separate `agent_key`, label, enrollment provenance,
  last-use and revocation tombstone; the globally unique public key remains
  unique after revocation. Existing identity rows are unchanged.
- `sessions` and `auth_codes`: nullable method id **and signer owner id**;
  composite FK to the real method owner with `ON DELETE RESTRICT`. The signer
  must be `coalesce(operated_by_user_id,user_id)`, not necessarily the effective
  subject. Both provenance fields are present together or absent together.
  Thus a bot acting as an organization can retain the bot's credential through
  OAuth; no nulling of provenance to make a delegated account fit.
- `auth_challenges`: distinct agent purposes and target/actor/payload digest.
  Existing personal sign-in/rotation remain valid. Actual signature, audience,
  freshness and atomic challenge consumption belong to the next runtime step.
- Reauth email adds `credentials_manage` with explicit purpose text. This is one
  governor proof option, not an obligation for a responsible bot to have email:
  autonomous governors must be able to sign a fresh payload-bound proof with
  their own live credential, as personal root holders can with theirs.
- Persistent `(user,application)` bigint epoch independent of the grant row.
  It survives grant deletion/regrant. Runtime bumps in the same grant/revoke
  transaction and stale-response checks remain required; this migration does
  not itself enforce monotonic updates or live authorization.

Generated with `bun run db:generate`. Drizzle emitted the composite FKs before
its new target UNIQUE; the SQL reorders that generated UNIQUE before the FKs,
without changing the snapshot. One `oxy:deploy-phase=pre` marker. First generator
attempt used bigint literal `0n`, which drizzle-kit cannot serialize; final
schema uses SQL `0` with bigint runtime mode and a nonnegative constraint.

## Verification

Own PostgreSQL17, `127.0.0.1:5574`, role `oxy_i01`; no shared instance or remote
credentials. Fresh `bun run db:migrate` applies all **137 journal entries**,
including 0137 (historic journal numbering has a gap), and census finds **221
public tables**. Repeating the same migrator is a no-op. The dedicated migration
database `oxy_i01_migration_0137` was dropped afterward. Jest's three suites use
its normal generated `oxy_test_<16hex>` database and teardown; final census has
only `postgres` excluding templates. Server remains for this agent's next tests.

`bun run test --runInBand src/db/schema/__tests__/agentAuthoritySchema.test.ts src/db/schema/__tests__/schemaInvariants.test.ts src/db/schema/__tests__/foreignKeys.test.ts`:
**3 suites/14 tests pass**. Seven new cases exercise real constraint behavior:
legacy null provenance, delegated signer session/code, wrong owner, incomplete
provenance, tombstone delete refusal, complete account cascade and exact bigint
beyond `Number.MAX_SAFE_INTEGER` across grant deletion/regrant. The initial four
negative matcher failures inspected Drizzle's wrapper message; final assertions
check PostgreSQL `cause.code` 23503/23514. They were fixture failures, not a runtime
security reproduction. Account deletion here exercises SQL cascades, not the
full authenticated account-deletion HTTP flow.

Contracts build and API `tsc --noEmit` pass. Scoped ESLint schema/mail/test files
passes with `--max-warnings=0`. `session.service.ts` adds only the two selected
columns; its two existing unused-variable warnings remain byte-for-byte the same
in baseline/final (logs included). Actual Biome1.9.4 passes the new schema/test
files. `proof.json` pins 14 source files and 12 logs. No publish/deploy or change
to Forge, billing, app-local token handling or human login.
