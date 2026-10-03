# Bounded Alia revocation canary API checkpoint

Source: `fa5113ac9cab820111c8805090511879574381db`, based on `ebb69bac0487fc13f1102fdb78a3f3a81973ffb5`.

The customer credential DELETE now calls a shared transaction that preserves its
exact application filter, workload exclusion, actor and audit. An internal Alia
canary can create only a new, expiring service credential using an existing grant
and the exact reviewed application, owner and scopes. It changes no user consent,
existing key, workload binding or public endpoint. Operational audit events have
a NULL customer actor and closed `operational_canary` metadata.

The plan pins the complete authority snapshot before issuance. Post-use checks
allow only natural usage metadata changes. Revocation and creation each commit
together with their audit event. Cleanup remains possible after expiry or
withdrawal. If a task dies with its secret only in memory, recovery derives the
verifier internally from the exact owned row and immutable creation audit; the
operator needs only the durable prior plan. Recovery refuses another credential
or mismatched operator, nonce or authorization digest.

Validation: 3 package-owned Jest suites / 58 tests, including 10 SQL canary
cases; API build and scripts typecheck; Biome on 3 new source/test files;
normal fresh migration and repeat; 5 checks using actual compiled modules under
Node 24.21.0 with production mode and the owned local database. The PostgreSQL
PID and postmaster file are absent after cleanup. The stopped scratch data
remains external. `proof.json` pins 9 source files, 9 records and 5 compiled files.

Run from this worktree, after the API dependency build:

```sh
python3 scripts/rehearsal/test-alia-revocation-canary.py
```

This is local source validation, with synthetic authority and zero provider
requests. It does not prove a live revocation latency sample or authenticate an
AWS operator. The external reviewed launcher supplies that authority and must
persist its intent before dispatch and reconcile unknown acknowledgements before
any retry. Parent and receiver helper WIP is excluded from this checkpoint.
The live sample is limited to two SDK receivers and a loopback effect sink;
it will not establish global performance or production business effects.

An earlier test run overlapped a dependency build and lost generated telemetry
files. The final run was sequenced after the build and passed all 58 tests.
No runtime was weakened to resolve that setup failure.
