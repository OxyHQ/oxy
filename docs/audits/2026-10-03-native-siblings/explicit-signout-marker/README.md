# Native siblings: explicit sign-out marker candidate

Both existing sibling fixtures now use complete `packages/contracts`, `packages/core`
and `packages/services` trees from reviewed source
`945c8adf04ce93b0a4a487c26c6c78f09efe26ff`. Their Git tree IDs match exactly.
This retains foreground reconciliation (`6cacee275`) and includes the reviewed
subject-binding and shared-device changes, instead of applying only one marker
hunk to the older graph. The fixture entry, client registrations, Android APKs,
package names, signing certificate and identity stores were not changed.

- Mention source: `34a78f63c`, worktree `1519-native-siblings-20261003`, Metro 17967.
- Allo source: `c319031f8`, worktree `1519-native-allo-20261003`, Metro 17968.
- Oxy remains a workspace candidate. This is not acceptance of a published Oxy SDK.
- Bloom is published `6.2.1`, with Services peer `>=6.2.1 <6.3.0`.
  All 20,940 tarball files match all four root/app resolutions byte for byte.

Root stopped both apps before the prior Metros were stopped. The preparer made no
ADB calls, API/IdP changes or identity-store writes. Both new Metros are frozen for
root's device repetition; the proof records fresh Android manifest launch URLs,
bundle bytes/hashes and all 5,426 built core/contracts/services files. Metro uses
workspace source for Oxy and the installed registry package for Bloom.

## Validation

In each sibling worktree:

```sh
bun install --minimum-release-age=0 --ignore-scripts
node packages/core/scripts/build-workspace-deps.mjs @oxy.so/utils @oxy.so/telemetry @oxy.so/contracts @oxy.so/protocol @oxy.so/core
cd packages/services
bun run build
```

Both dependency and Services builds passed. The identical source graph was tested
in Mention once: core 5 suites / 68 tests and Services 2 suites / 54 tests passed.
Commands are preserved as the first line of the focal logs. This does not replace
the upstream review's wider test evidence or claim a full suite rerun.

Metro commands use `CI=1 EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1`, the existing public
fixture client ID, `EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE=1`, the matching
`EXPO_PUBLIC_OXY_NATIVE_SIBLING`, and
`bunx --no-install expo start --localhost --port 17967` (17968 for Allo) `--clear`.
The manifests in this directory bind the served launch URL to each fixture.

## Device acceptance still pending at this freeze

Root will repeat full logout followed by cold boot, explicit sign-in, and shared
organization foreground reconciliation. Do not infer those outcomes from build
success. The prior AUTH center-touch obstruction was independently traced to a
LogBox development overlay, with unchanged source and coordinates; see
[the separate observation](../auth-touch-dev-overlay/README.md). No AUTH touch
runtime patch or warning suppression was added.
