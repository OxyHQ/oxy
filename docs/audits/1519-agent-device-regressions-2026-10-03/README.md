# Agent signer and device binding regressions

Source: `ea43f3d3a4a487e8eb6b96828d12d8d0d2dd9f2c`, based on `9b1288b1`.
Fixes the signer P2 in [#1558](https://github.com/OxyHQ/oxy/pull/1558#issuecomment-5964914111)
and the concurrent binding P1 in [#1549](https://github.com/OxyHQ/oxy/pull/1549#issuecomment-5960698679).

The signer parses both SEC1 representations as the same curve point. It signs
`buildAgentProofMessage` from the original claims, without rewriting signed bytes.
The real helper/API fixture proves compressed, uncompressed and uppercase keys
converge on one bot and one SQL auth method. Another point, account, actor, action,
expired challenge, invalid signer and absent method reject before signing.

All binding writers now lock the device before authoritative context/secret reads.
`addAccount` creates the row before taking that lock; its preliminary raw-row
lookup is discarded. `signout` and migration detach read their victims and secret
inside the lock. Directory reconciliation rereads principals and contexts under
that lock, excludes changed personal-session provenance and never deletes a row
that has become used since its original graph projection. The flat removal/election
semantics remain account based; scoped principal/context removal keeps its existing
pair semantics. Legacy storage has no persisted context in its background triple,
so invalidation of that account is conservative.

Device → context/principal writes retain the established order. Session deactivation
runs after COMMIT, including signout and detach, so failed context/secret writes
cannot kill a surviving session or wait for their own pool/FK write. Detach preserves
the explicitly migrated session. Existing activation still mints without a device
FK under its lock and records that FK after COMMIT. Account deletion commits its
closure fence before device cleanup. No account/key lock or remote operation was
added inside the new device mutation transactions.

## Frozen reproduction

The same final fixtures measured baseline **8 failures / 62 passes**, then fixed
**70 / 70**. The companion core fixture measured **2 failures / 6 passes**, then
**8 / 8**. `frozen-control.json` records both runtime hashes, all fixture hashes,
restoration and unchanged fixtures. The temporary mutation restored only the two
owned runtime files to baseline, then restored and verified their exact fixed bytes.
The first run was 3 failures / 60 passes; adding the inverse add→issuance order
produced 4 failures / 60 passes. Those earlier logs are preserved separately.

The SQL trigger barriers are synthetic and confined to a newly initialized local
server. In emission-first order, issuance holds the device row after its UPDATE;
`pg_stat_activity` and `pg_blocking_pids` observe the writer waiting before release.
In writer-first order, the DELETE trigger pauses replacement after the initial read;
baseline issuance completes and its secret mints with the replacement session.
With the fix, issuance waits on the device and its revision/context recheck refuses
that stale issuance. Poll deadlines bound a failed harness; observed SQL state and
final authorization outcomes are the assertions, not elapsed time. Advisory locks
are fixture barriers, not production lock ordering. Reconciliation uses a fixture
transaction-entry barrier around a real directory read and real activation.

Rollback triggers require exact SQLSTATE `P0001` for replacement, signout and detach.
After rollback the original contexts, revision, background proof, sessions, holder
and other account survive. Positive replacement and retirement preserve other
accounts and the migrated session. Additional compatibility suites pass **109 / 109**;
this includes the existing real bearerless background-token regression.

## Reproduce

Use package commands, never bare `bun test`:

```sh
bun install --frozen-lockfile --minimum-release-age=0
bun run build:all
python3 scripts/rehearsal/test-agent-device-regressions-1519.py
python3 scripts/rehearsal/test-device-session-compatibility-1519.py
cd packages/core
bun run test --runInBand --runTestsByPath src/server/__tests__/agentAccount.test.ts
```

Both PG scripts accept no connection override, scrub libpq variables and require a
fresh initdb plus PID, executable, data directory and listening socket ownership
before CREATE DATABASE. Final servers are stopped; no provider or production DB
is used. API, scripts and core strict TypeScript pass. Actual Biome 1.9.4 checks
five inputs without diagnostics; a prior call to the unrelated `biome` CLI is
explicitly excluded. These checks do not replace final composite CI or publication.
