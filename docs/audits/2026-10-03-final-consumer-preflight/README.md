# Final consumer SDK preflight

This inventory reads committed Git blobs and records manifest/lock hashes. It
preserves the accepted application source; it does not install packages, mutate
peer worktrees, or claim final registry adoption. Targets are contracts 4.9.0,
core 4.2.0, Services 11.1.0, MCP 1.1.0, protocol 1.2.2 and Bloom exactly 6.2.1.
Services' Bloom peer is `>=6.2.1 <6.3.0`.

## First chain prepared in isolated worktrees

| Consumer | Prepared commit | Remaining |
| --- | --- | --- |
| Mercaria | `813755a7` on accepted composition `9aff49fc` | Apply concrete 17-pin patch only with registry/lock; backend and three app typechecks/builds, MCP effective-account and Peable parity; coordinated rollout. |
| Mention | `3ddeb3469` on accepted I05 `f7c6eb7a` | Apply 8-pin patch/lock, published MCP/core parity and frontend checks. |
| Alia | `d5d02f274` on I10 `d9847676` | Receive integration's separate I05 source commit first; 21-pin patch/lock, inference/MCP authority and app checks. No uncommitted peer source was copied. |

Those patches live in each repository's own
`.worktrees/1519-final-sdk-pins-20261003/docs/audits/2026-10-03-final-sdk-preflight/`.
`git apply --check` passes. Actual manifests and locks are unchanged, so there is
no unresolved package/lock commit. All imported Bloom paths and their targets
exist in 6.2.1 (46 Mercaria, 202 Mention, 192 Alia), which does not establish named
export, prop or rendered compatibility. Those checks follow actual installation.

## Remaining source inventory

| Consumer/source | Current relevant gap | Next work |
| --- | --- | --- |
| Noted `0569162d` | core4/contracts4, Services11.0, Bloom6.3, MCP1.0 | Final pins/lock and accepted OAuth active-account regression with published SDK. |
| Homiio `c7304229` | core4/contracts4, Services11.0, Bloom6.3 | Final pins/lock and app tests. Published Peable verifier seam remains unmounted; no Pay rent activation claim. |
| Clarity `10d880c6` | core/contracts3, Services8, Bloom4.28 | Major API compatibility and existing billing subject/product-selection tests; root accepted source/CI remains the base. |
| website `718a6c40` (PR129) | core3.2, Services10, Bloom7.0.1 | Inspect real Bloom7 API use before selecting6.2.1; final auth/metadata/build checks. PR checks/review succeeded, still open; source acceptance remains root's decision. |
| Allo `795ba4e0` | core1.3, Services2, Bloom2.12 | Product source/API migration and native/web checks. The Android sibling fixture is not this product's adoption. |
| Examples `7a5bba6f` (PR4) | Next/Vite core4.1/contracts4.8/Services11.0/Bloom6.4; Expo still retired `@oxyhq/*` | Three independent locks. Expo needs namespace/provider source migration; two updated web starters need final graph and builds. Socket status is not build evidence. |
| Oxy Console/accounts/Commons at `dca175d2` | Local workspace SDK; Bloom catalog already6.2.1 | Preserve workspace architecture. Console is Vite web, accounts/Commons are native-capable packages. Final published-package fixtures and package/device acceptance remain separate. |

Oxy's three `examples/*.tsx` snippets are also distinct from the standalone
Examples repository. The shared Examples checkout had unrelated staged removals;
only Git blobs were read and no files there were touched.

## Peable compatibility finding

Peable main `6f671437` frontend declares Bloom6.3 and pay's optional peer starts at
6.3. An isolated copy of unchanged pay source passes real TSX typechecking,
CJS/ESM/declaration builds and 130 existing tests with published Bloom6.2.1.
Proof is Peable commit `2cb021b`, own worktree
`/home/nate/Oxy/Peable/.worktrees/1519-pay-bloom621-compat-20261003`.
All 20,940 installed Bloom files match the registry tarball. This supports a
reviewed lower-bound expansion for pay; no package peer/release changed here.
A Services host still needs the tighter `<6.3.0` intersection. Native rendering
and full Peable frontend compatibility were not tested by pay's pure test suite.

## Final gates

For each consumer: preserve/reconcile accepted source; receive final registry
publication and integrity; apply manifest changes with the generated Bun lock in
one source commit (`--minimum-release-age=0`); verify installed bytes and peer
graph; run appropriate package tests/types/builds with owned SQL fixtures; then
review CI and coordinate promotion through root. No production identities,
credentials, grants, billing configuration or frozen native Metros changed in
this preflight. Global I11 remains open.
