# I01 autonomous account candidate — 2026-10-03

Runtime source `780bef073`, test-only fixture correction `14422e379`, on
integration foundation `ad0681f83` (full migration 0138). The series includes
`4d03b5bc1` and `efea04c2f`. `proof.json` hashes every changed source and the
attached evidence; no log from another source is represented as a new run.

The accepted behavior is [ADR 0032](../../adr/0032-autonomous-account-agent-keys.md).
The [P1–P14 matrix](../../auth/proposals/bot-autonomous-auth.md#4-pruebas-contra-suplantación-y-escalada)
names executed regressions. Real HTTP, secp256k1 signatures, JWTs and PostgreSQL
cover autonomous login, delegated organization OAuth/AppBound sessions, key
revocation, both pending-approval finalizers and MCP A→revocation→B. Old MCP
tokens stay denied after the new grant. D4 derives key provenance from the live
session and retains catalog/resource/policy/limit checks. Governance distinguishes
self operations from transferable current owner/admin authority; people and bots
can govern with fresh proof. Financial-domain fixtures use synthetic funds only.

## Executed validation

- API surfaces: 10 suites / 179 tests; final focused set: 6 / 108; entry/internal
  service rejection: 2 / 18. Counts overlap and must not be added.
- Core full: 174 / 2128; contracts full: 53 / 915. Core final test-only cleanup
  confirmation: 2 / 7. Contracts and core CJS/ESM/types builds pass.
- API TypeScript passes. OpenAPI has 359 paths / 414 operations; freshness and
  mounted-route census pass. No-payload guard passes for 223 tables / 2630 columns.
- Biome 1.9.4 `lint --error-on-warnings`: 12 new files clean; 53 scoped paths have
  77 existing diagnostics both at base and candidate, zero added. ESLint has
  17 existing warnings at both, zero errors/added warnings. Comparison manifests
  include exact diagnostic identities. The followup fixture is separately clean.
- Migration 0139 was generated after full 0138; second generation finds no
  change. Fresh standard migrator applies 139 migrations, repetition is a no-op.
  Census verifies three provenance FKs and the approval-purpose CHECK; one `pre`
  marker. No manual snapshot edits.

All API tests use the package script with
`TEST_DATABASE_URL=postgres://oxy_i01@127.0.0.1:5574/postgres bun run test --runInBand`.
Exact path lists appear in each log. Core/contracts use their own `bun run test`.
TS uses `./node_modules/.bin/tsc --noEmit` in API. Builds use `bun run build` in
contracts/core. Migration rehearsal uses `bun run db:migrate` (the script already
supplies `--phase=all`) against the exclusively owned
`oxy_i01_0139_rehearsal_20261003`, then drops it. Generation uses `bun run db:generate`.
The local PostgreSQL 17 server remains available; only owned throwaway databases
were removed. Final catalog query shows no remaining `oxy_test_*` database for
this role. No production connection or user credential is involved.

## Failed attempts and limits

The first complete API attempt forced two workers while the harness creates one
DB; 583 files could not initialize. The corrected serial run reached Node's ~4GB
heap limit and SIGABRT. It is **not a passing full run**. Before the abort it found
an updates-admin mock expecting two arguments (fixed to assert the validated
session argument), and a schema fixture leaving a hold of 1 against a reserved
balance of 0. That fixture was identified by its owned `wlattr-*` account in the
aborted DB, then that DB was removed after verifying no remaining backend.

A direct fixture→global-sweep regression reproduced the balance CHECK failure
(14 pass / 1 fail). Test-only `14422e379` uses the actual reserve writer and a
private harness-created DB, then disposes of that whole DB. The first attempt to
remove financial rows was rejected by their append-only trigger; the guard was
preserved. The final 15 schema + 49 ledger tests pass in both explicitly forced
orders. The two small sequencers are included for reproduction; their absolute
path in logs is scratch provenance, not a repository dependency.

No full API success, production p99/revocation SLA, financial transfer, package
publication or consumer adoption is claimed. I03 must compose the supplied
transaction-bound key helper before standing-consent epoch/grant/marker/code
writes and prove the revocation race. I01 stays open pending its own integration
and acceptance; it does not wait for the parent issue to close.
