# Legacy resolver fixture isolation after ACTIVE CI

CI run 37076663568 at 5bf80216e failed Deploy Script Tests: all 14 legacy cases read the real ACTIVE row while simulating an unrelated SHA and old queue workflow. Security Audit passed every step. This was fixture coupling; the production resolver correctly rejected incompatible evidence.

The frozen `red-harness.sh` is byte identical to the committed 5bf test and records 14 failures under the real ACTIVE row. The test-only change makes an owned temporary Git repository with a committed closed INACTIVE row and runs the unchanged production resolver from that fixture. Every original case and receiver remains. It records 14 passes while the real checkout still has its ACTIVE row, then 14 after the row is reset INACTIVE for the next source freeze. The 82 committed DAG assertions retain ACTIVE/fail-closed negatives, exact commands and no unexpected OIDC/AWS/registry effects. The 123 policy checks also pass.

Reproduce from repository root:

```sh
bash -n .github/scripts/test-resolve-queue-image.sh
bash .github/scripts/test-resolve-queue-image.sh
bun scripts/test-forge-future-dag.mjs
bun scripts/test-forge-audit-policy.mjs
```

`proof.json` hashes the frozen RED harness, changed fixture and six records. All ten input-tree IDs match the independent proof at 94154019f; its 17 core records plus five supplementals remain byte unchanged and are reused explicitly, including Oxy 34 and Expo 14. The new source requires its own exact ARM image proof and authenticated collector before ACTIVE. The historical da1 image does not validate the changed test tree. Session authorization and expiry 2026-10-09 22:00 UTC remain fixed. No release, merge, queue, registry or deployment is performed.
