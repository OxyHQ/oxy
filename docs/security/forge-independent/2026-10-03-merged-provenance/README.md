# Merged candidate provenance correction — 2026-10-03

Main `73bf4c8dbe22c30ae9c4a2f39e9b649b927b8d12` merged issuer PR1559. Its queue inspection and authorization succeeded, but publication run37101785365 failed before `skopeo copy`: the original ARM run37100967092 now returns `pull_requests: []`. The authenticated original collector reproduces exactly one error, `Workflow run identity differs from the pinned run of the trusted workflow` (`actual-main-evaluate.json`). No deployment is credited.

The corrected collector retains the original nonempty Actions association check. Only an empty list triggers two authenticated GETs: the exact pinned source commit's PR associations and the exact pinned PR. The matching association must be unique and agree with the merged PR's head SHA, branch, same-repository IDs, main base and merge commit. The PR must be closed and actually merged. Another nonempty Actions association cannot activate this fallback. Missing, malformed, foreign, ambiguous or inconsistent metadata fails closed. Supplied objects remain structural fixtures; the private collector WeakSet still determines authentication.

The new immutable queue base is main73bf, with the same parent/tree/executable and two-declarative-file restrictions. Candidate ARM inspection admits only the new exact fix branch in addition to existing exact branches. Policy is INACTIVE during this preparation. Runtime issuer baseline4b, TTL300 emission, dependency graph, lock, patch, Docker, validators, grants and DDL are unchanged. Expiry remains2026-10-09T22:00:00.000Z.

## Verification

`proof.json` records source files, command exit codes and raw logs. The frozen added positive fixture fails before the source fix. Corrected proposal150, policy123, topology20, binding43, collector61, Bun DAG82, legacy14 and audit10 all exit0; the19 added association cases include the merged positive and18 negatives. The initial DAG command incorrectly used Node for its Bun.YAML runner; that failure is retained and receives no PASS credit. Its corrected Bun execution passes82. No shell chaining is used to derive suite results.

Reproduce from the committed source with:

```sh
node scripts/test-forge-remediation-proof-proposal.mjs
node scripts/test-forge-audit-policy.mjs
node scripts/test-forge-source-topology.mjs
node scripts/test-forge-final-image-binding.mjs
node scripts/test-forge-final-image-collector.mjs
bun scripts/test-forge-future-dag.mjs
bash .github/scripts/test-resolve-queue-image.sh
bun scripts/test-check-dependency-audit.mjs
```

Ten independent package/toolchain/patch/suite Git inputs equal the accepted2f1f freeze. Their prior Oxy34/Expo14 and upstream/build/known-key crypto evidence is explicitly reused; this source-only collector correction does not claim a new crypto run. It still requires a fresh exact-source ARM candidate, independent full policy gate, declarative activation and its own queue image/publisher verification. A PR ARM artifact alone cannot authorize queue publication. No policy activation, registry copy, merge or deployment is performed by these local checks.
