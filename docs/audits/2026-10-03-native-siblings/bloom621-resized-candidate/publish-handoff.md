# Bloom 6.2.1 publication handoff — root operator

Reviewed maintenance PR: https://github.com/OxyHQ/Bloom/pull/259

- Base: maintenance/6.2 at published6.2.0, 493d37963b5687850157673f90f3f3e972f42e32.
- Reviewed head: 2e5a5d9e85b38f7aac177225bd9a03c399585c55.
- Expected merge tree: 425a497f353e62712ef471d94ac2f9def1fb755c.
- Runtime candidate:16a98eca; final follow-up changes only generated adoption counts/proof. The docs are packaged, so the old candidate tarball is not the final release artifact.
- Dist-tag: maintenance-6. Preserve latest7.1.1. Version6.2.1 must still be absent immediately before publication (only registry404 counts as absence; network/auth errors are not absence).
- Local9suites110PASS +11matrix gatePASS; final CI37120459494 must complete successfully on exact2e5a5d9e before merge/publication.
- Native runtime proof: proof.json/device-observation.json beside this handoff. Root operated emulator5580: full-height backing345→790 with morph true/false, counters1/1, Back veto, Xclosed1, reopen, secondXclosed2. Original auth-keyboard touch flow remains separate.

Main7 forward port is complete in PR258, head acca63ad52a5f4191b612e7d266cd648492d11e8. BottomSheetBase/types, DialogBottomSheet, SurfacePaint and their four changed tests are byte-identical across branches. The7.x branch has its own generated matrix correction; no7.x publication is implied.

## Reviewed operator sequence

Root creates a new isolated worktree from merged maintenance/6.2, confirms its tree equals425a497f353e62712ef471d94ac2f9def1fb755c and version6.2.1, and records merge/CI/registry preflight. Do not use the shared checkout. Install with `bun install --frozen-lockfile --ignore-scripts --minimum-release-age=0`; reject any source/lock difference. Reserve a new private release directory outside the worktree and retain logs there. Existing registry credentials remain in their normal mechanism; never print/copy their values.

Run the following lifecycle in ONE shell execution from that clean release worktree, with `release_dir` set to the newly reserved absolute directory (root owns the actual path):

```bash
set -euo pipefail
umask 077
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD^{tree})" = 425a497f353e62712ef471d94ac2f9def1fb755c
test "$(node -p 'require("./package.json").version')" = 6.2.1
bun run build > "$release_dir/build.log" 2>&1
git diff --exit-code
bun pm pack --ignore-scripts --destination "$release_dir" > "$release_dir/pack.log" 2>&1
test -f "$release_dir/oxy.so-bloom-6.2.1.tgz"
sha256sum "$release_dir/oxy.so-bloom-6.2.1.tgz" > "$release_dir/tarball.sha256"
bun publish "$release_dir/oxy.so-bloom-6.2.1.tgz" --tag maintenance-6 --access public > "$release_dir/publish.log" 2>&1
```

`build` performs its normal build/package/freshness gates. `pack --ignore-scripts` deliberately avoids a second prepare/prepack build while packaging the fresh outputs from the same shell execution. The flag is supported by the installed Bun CLI. There is no implicit retry or fallback to an old tarball. If publication response is uncertain, inspect exact registry version/integrity before deciding any next step.

After publication, independently read registry version metadata and dist-tags; require maintenance-6=6.2.1 and latest still7.1.1. Download the registry tarball, verify SHA512 integrity/SHA1 plus local SHA256, enumerate files and compare against the freshly packed artifact. Install registry6.2.1 in consumers, never the candidate file path, and compare installed bytes. Retain the failed earlier CI and native paint observations as history.

## Sibling preparation after registry

Owned Mention/Allo worktrees remain frozen on SDK1e719. Exact `/tmp/i04-native-resume.patch` from commit6cacee275 applies cleanly to both (read-only apply checks done). After registry availability, install published Bloom6.2.1, apply only that reviewed OxyContext delta, rebuild workspace services as needed and freeze source/bundles/installed-byte proofs. Root alone operates ADB; no reinstall/clear/uninstall or key changes are required for JS-only updates. Final complete Oxy registry repeat follows coverage's final release pin; do not substitute nominal candidate versions.

## Completed CI and publication reconciliation

Final CI37120459494 succeeded on exact2e5a5d9e: build/package/types and all nine shards, 490 unique suites / 11007 tests passed, zero failures. The authenticated shard union equals the source `test --listTests` census; records and hashes are in [ci/proof.json](ci/proof.json). Root merged maintenance6.2 to a35ef1b2f7daeeb5f13e7a77e648289cac6be20d with the expected tree. Main7 forward-port PR258 was also merged to fb52fa49007f6325a1d802683417d67b1546940b; no7.x publication.

Root reported a successful fresh build/pack/publish command for6.2.1, while initial registry reads still returned404. Availability is not yet claimed by this record. Do not retry publication after that ACK. npm documents a publish-time scan before installation becomes available, typically about five minutes and sometimes15minutes or longer depending on size/load; those are estimates, not guarantees. This general mechanism does not prove the status of this specific version. Reconcile exact metadata/tarball integrity and tags before consumer installation. [Official npm announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
