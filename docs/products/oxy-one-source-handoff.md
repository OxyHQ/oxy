# Oxy One draft source handoff

All six repositories are independent OxyHQ origin checkouts. Remote review branch: draft/oxy-one-personal-20261005. No merge, deployment, migration, payment activation or npm publication is part of this push. Draft branch pushes are outside the inspected production workflow branch filters; Mention workflow_run deployments also require main.

| Repository | Required draft source commit before this handoff |
|---|---|
| Oxy |87e40a561dfa683c6712ad882dc1962d7c4b92e9|
| Peable |d3d6e11c1bc26b595b2d303689d55bcf1cdc383d|
| Alia |8031e43489a9e8a8dc3afb331de531690edee1ae|
| Mention |63b91b58e12a90afb74859676dd145136ee1042b|
| Noted |5d1c35a2462769e7b66ab5c2358a3533e42f3f28|
| website |7392c8e0c41acb5e1e4027d4415951249f2e991f|

Fetch the named remote draft branch in each repository and create a separate worktree, preserving existing edits: git fetch origin draft/oxy-one-personal-20261005; git worktree add ../REPO-oxy-one --detach origin/draft/oxy-one-personal-20261005. Verify HEAD against the published push receipt; Oxy also includes this documentation commit after its source commit above. Do not cherry-pick one app in isolation and assume the platform contract exists.

## Packages and reproducible PC preparation

Peable candidates are @peable.to/shared-types0.3.1-oxy-one.0 then @peable.to/sdk0.2.3-oxy-one.0, public registry https://registry.npmjs.org/, nonlatest tag oxy-one. They have not been published: this cloud environment returned npm ENEEDAUTH. No new credential was created. Source manifests carry exact candidate dependency/publishConfig and source bun.lock carries workspace:0.3.1-oxy-one.0.

Use Peable's pinned Bun1.3.14; run bun install --frozen-lockfile --minimum-release-age=0 and bun scripts/check-lockfile-sync.mjs. In packages/shared-types run bun run build && bun pm pack --destination YOUR_REVIEW_DIRECTORY. Then in packages/sdk run bun run build && bun pm pack --destination YOUR_REVIEW_DIRECTORY. Build and pack in the same command for each package. Never use npm pack or silently overwrite an old published version.

Reviewed shared-types tarball SHA-256: d425dca834f20cdfc910ce76184f6fbd5ca1c0b98f09de826ecaf7703cde9e3a. Reviewed SDK tarball SHA-256:2892417f726f00ff2297e8bdfd67ed72cbb899e15ba1a03c96f74c1ef956cd7c. Compare actual rebuilt bytes with these hashes. If different, stop publication, inspect packed manifests/files, rerun artifact/runtime validation and obtain review of the new exact bytes; do not assume source identity establishes archive identity.

Run packages/sdk/scripts/verify-billing-packed.mjs from Peable root with shared tarball, SDK tarball and review-directory arguments. PEABLE_VERIFY_NODE_BINARY selects the actual Node binary for child checks. Both candidates preserve Node>=18 and include nested dist/esm/package.json with type:module. Reviewed CJS/ESM/public runtime/strict NodeNext checks pass on18.0.0,18.20.8,20.20.0,22.22.0,24.19.0;146 SDK tests pass. Inspect docs/oxy-one-sdk-release-artifacts.md. Recheck candidate availability, existing publisher permission and latest tags immediately before separately authorized publication; shared types precede SDK and latest must remain unchanged.

Oxy API deliberately still pins registry SDK0.2.2/shared-types0.3.0. Those do NOT contain new billing reads/event validation; the updated bridge consumes actual new public types and will not clean-build against that old pin. Local validation used actual candidate tarballs in ignored node_modules, not custom HTTP or a type shim. After candidate publication, change API dependency to exact0.2.3-oxy-one.0, generate the genuine registry bun.lock, then clean-install and run API typecheck/lifecycle tests without local tarball overrides. Do not fabricate registry integrity or claim adoption now. Website also needs released Oxy Core/Services adoption; Accounts currently resolves those workspaces locally. Release changed Oxy Contracts→Core→Services through their normal reviewed procedures before external consumers adopt.

## Candidate migration order and activation gates

Candidates only, not production execution: Oxy pre0147 checkout intents,0148 mono,0149 storage reservations,0150 recovery scheduling,0151 immutable refund fence; Alia pre0083 allocations then0084 operation identities; Peable pre0021 observation outbox pointer then0022 pending-event deferral. Reconcile actual base/ledger first; use each repository's phase-aware migrator and normal older pending pre/post ordering. Never apply to production as part of source checkout or package publication.

Runtime logic has162 Oxy regression tests,123 Peable backend tests,146 SDK tests and scoped UI/storage tests described in oxy-one-launch-readiness.md. Runtime callbacks/relays/recurring drain remain unmounted or disabled and tax/FX evidence has no guessed defaults. Faircoin manual monthly invoices versus authorized automatic renewal remains pending, as do verified seller/issuer/tax-remitter, tax/location/FX authority, exact merchant/app/offer/version/price mapping, credentials/signing and commercial activation approval. No wallet spending mandate, charges, live provider calls or legal acceptance are inferred.

## Actual GitHub push result (2026-10-06)

Oxy and Mention draft pushes succeeded and remote heads were verified. Peable, Alia, Noted and website push attempts failed with existing HTTPS Git authentication unavailable (could not read Username; terminal prompts disabled). Their requested remote draft branches were still absent on readback; no changes were pushed to those four repositories and no alternate credential path was attempted. Cross-repository checkout instructions above describe the intended completed handoff; they cannot fetch those four branches until authorized access is available and their existing local source commits are pushed. No PR, merge, deployment or package publication occurred. The Oxy and Mention branches are reviewable now; do not claim the full bundle is available on GitHub yet.
