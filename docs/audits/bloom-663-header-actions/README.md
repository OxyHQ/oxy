# Surface header actions compatibility

The original package-build and Nilo-install receipts in this file describe the
14.15.3 candidate and are retained as historical evidence. The release candidate
has since been rebased onto current Oxy main and bumped to 14.18.1 after 14.18.0 published. Its current
source has been revalidated below; the old Nilo install receipt does not prove
acceptance of 14.18.1.

Observed while adopting registry Bloom17.23.0/app-preset6.6.0 in Nilo202.
Services14.14.0 and current Oxy main14.15.2 directly read accessibilityLabel on
the whole DialogHeaderConfig.actions union. The new semantic branch has id/label,
so Nilo's real app typecheck fails with TS2339 twice. `types-negative.txt` preserves
the same diagnostic with the main hook and published Bloom17.23 declarations.

The candidate compares the fixed presentation vocabulary for both generations:
id, label, accessibilityLabel, icon, group, priority, essential, overflow,
visible, disabled, busy, selected, labelVisibility. Defaults normalize without
merging selected=undefined (command) with selected=false (toggle). Reflect.get
reads that explicit vocabulary as unknown so the same source still compiles
against the supported old declarations. There are no ambient module declarations,
source aliases or casts making the new union look like the old one.

Stable semantic callbacks resolve the latest action by ID; removing an action
makes an already retained callback inert. Legacy static entries keep positional
dispatch. Callback identity remains outside the presentation comparison, avoiding
the existing setContent/render loop. Custom node slots still compare by identity.

## Checks

25 tests in the three useSurfaceHeader suites pass: twelve presentation fields,
semantic-only entries, default/closure stability, ID reordering, removal/unmount,
legacy accessible names/positional callbacks, custom nodes and the existing
real feedback-loop host. The new runtime test is JavaScript intentionally: it
exercises both published union generations while this workspace keeps Bloom's
17.15.0 minimum catalog. Published declaration compatibility is checked separately.

A distinct consumer package copied only the candidate hook and the attached
consumer/tsconfig fixtures. Its node_modules pointed read-only at Nilo's installed
registry Bloom17.23.0 peers; TypeScript's ordinary package resolution selected
published declarations. `tsc -p` passed. Replacing only the hook with origin/main
failed with the two expected TS2339 errors. A second distinct package used the
workspace's installed Bloom17.15.0 plus the legacy consumer: the same candidate
hook passed. No node_modules package was modified.

These small declaration checks are not a built-Services or final published-Nilo
acceptance. Build, pack and consumer results are recorded below as completed;
publication still goes through the normal version-bump workflow. iPhone is not
part of this check.

`typecheck-receipt.json` records compiler version, actual declaration resolution,
package/declaration/source/consumer hashes, both successful exits and the failed
main-source control. No errors from an incorrectly configured harness count as
these passes: the final probes use each consumer's own tsconfig/package boundary.

## Generated icon subset

The existing icon census scans every quoted source string, so the metadata key
`group` also adds the MaterialCommunityIcons glyph of that name. The normal
`generate:icon-fonts` command was run, not bypassed. FontTools4.60.1 produced the
recorded assets/manifest: MaterialCommunityIcons grows29268→29428bytes (+160).
Ionicons stays42812bytes with identical glyph order/cmap and all tables except
`head` identical (generation timestamp/checksum); see `font-generation.json`.
The tool was isolated in a local venv (39MiB including pip), not installed into
runtime dependencies. `check:icon-fonts` now passes.

## Built package and Nilo candidate

The dependency-ordered build passed all five packages and Services' packaging
gate:3086 files,2651 under lib/,48 export targets. The tarball was created with
`bun pm pack --ignore-scripts`. Nilo installed it through Bun normally, alongside
registry Bloom17.23.0, app-preset6.6.0, core7.44.0 and contracts6.22.0. All3086
installed Services files match the candidate archive; receipt and SHA256 are in
`nilo-candidate-receipt.json`. The actual Nilo app typecheck now exits0, compared
with the published14.14.0 adapter's TS2339 failure. This source candidate must be
published and installed again before Nilo's final published-dependency acceptance.

The same candidate also passes Nilo's synthetic browser suite:17 workspace/document
frames and2 table keyboard-focus frames (320/390), errors=[] and unexpected=[] in
both reports. After the probe, the original published-only manifests/lock were
restored through a frozen Bun install:Bloom17.23.0,preset6.6.0,Services14.14.0,
core7.42.0,contracts6.19.0. No file dependency remains in the Nilo checkout.
Services14.18.1 must be published and installed before final Nilo acceptance.

## Current 14.18.1 candidate revalidation

The header-action candidate was rebased onto Oxy main after Services 14.18.0
(account-language snapshot support) had already published. The header-action fix
is prepared as 14.18.1 to keep package versions unique. On this exact source,
`bun run services:test` passed 178 suites / 1,529 tests, `bun run typescript`
passed, `bun run check:icon-fonts` passed, and `bun run build` passed its
packaging gate: 3,105 files, 2,667 under `lib/`, and all 48 export targets.
An `--ignore-scripts` tarball was created from that built output and contains
the 14.18.1 manifest. This does not replace the old Nilo consumer receipt above:
the final published-dependency Nilo typecheck remains pending publication. Exact
commands, results, tarball SHA256 and pending consumer acceptance are recorded
in [services-candidate-receipt-14.18.1.json](./services-candidate-receipt-14.18.1.json).
