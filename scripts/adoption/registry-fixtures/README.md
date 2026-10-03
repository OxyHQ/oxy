# Standalone final-registry fixtures

Preparation only. No installation of the final Oxy SDK or runtime acceptance has occurred. The five materialized directories are under `/home/nate/Oxy/.agent-evidence/i04-final-registry-fixtures/`: `mention`, `allo`, `web-first`, `web-second`, `web-third-party`. `materialized.json` records every copied file. Source entries, native app configuration/assets and web HTML are byte-preserved from the accepted fixtures in `preserved-inputs.json`. Only standalone manifests and build/resolver configuration differ. Dependency/tool versions were read from the frozen fixtures' actual installations; published app-preset3.0.0 availability was checked read-only. Final SDK installs wait for root's registry-ready signal.

The materializer refuses existing outputs and any package/workspace ancestor. The native preset normally watches `../..`; this config narrows it to the fixture and refuses resolved source/assets outside that directory. It retains the canonical preset and Bloom single-instance resolver. Babel consumes built published packages and no longer needs the monorepo source Flow workaround. The web config uses the maintained RN-web plugin and existing native-internal web mapping, with **no SDK/workspace aliases**. The build emits `registry-modules.json`. TypeScript has no workspace paths. No auth transport, key, token or provider behavior is mocked.

After root signals registry-ready, in each directory:

```sh
bun install --minimum-release-age=0
bun install --frozen-lockfile --minimum-release-age=0
```

Then, from the owned plan worktree, use the exact directory in place of `<fixture>` and a new private file in place of `<receipt>`:

```sh
python3 scripts/adoption/verify-registry-fixture.py --fixture <fixture> --output <receipt>
```

The verifier reads registry metadata/tarballs for contracts4.9.0, protocol1.2.2, core4.2.0, Services11.1.0, telemetry1.2.0, Bloom6.2.1 and app-preset3.0.0. It checks SHA512, every installed member and importer resolutions from the app and SDK packages; duplicates or an ancestor installation fail. It does not launch anything. This complements root's published-to-reviewed-candidate check and the seventeen-product adoption runner; no tarball is published here. Capture native autolinking/Gradle graph and compare it with the accepted APK before deciding reuse versus build/install-r.

## Launch after ownership handover

The existing synthetic authority manifest remains:
`/home/nate/Oxy/oxy/.worktrees/1519-real-oauth-browser-20261003/.integration-evidence/oauth1519-1n8d1xvu/manifest.json`.

The launcher inherits only basic process environment, disables dotenv and selects public client IDs from that manifest. It validates exact loopback authorities and registered redirects, refuses occupied ports, writes private intent/process receipts and owns only its spawned process group. Without `--launch` it reserves a plan/output directory but starts nothing. Output paths must be new.

Native launch (after verified installation; use `allo` for the second directory):

```sh
python3 scripts/adoption/launch-registry-fixture.py \
  --kind native --lane mention \
  --fixture /home/nate/Oxy/.agent-evidence/i04-final-registry-fixtures/mention \
  --manifest /home/nate/Oxy/oxy/.worktrees/1519-real-oauth-browser-20261003/.integration-evidence/oauth1519-1n8d1xvu/manifest.json \
  --verified-receipt <mention-registry-receipt> --output <new-mention-launch-directory> --launch
```

Native owns **17977/17978**, leaving17967/17968 untouched. Root alone changes AVD5580 debug host/reverse mappings and launches the existing matching package/certificate. No ADB action is in these helpers.

Web uses `--kind web --lane webFirst` (`webSecond`, or `a` for third-party), its matching standalone directory and verifier receipt. Auth acceptance must remain at the already registered origins **17972/17973/17962**: root must stop/release that exact old RP before launching; the helper never kills the old listener or alters registrations. Build-only/visual inspection can use unused17982/17983 via Vite CLI, but those origins are not authorized callback acceptance and must not be counted as successful auth. API17960/IdP17961/PG remain untouched throughout.

Before browser/device operation: run the fixture's type/build command, record live bundle HTTP bytes, check Metro `metro-resolved.jsonl` or Vite `registry-modules.json` paths against the verified installed roots and freeze source/bundles. The preparation tests only exercise copying/isolation/manifest/port guards. Real package installation, TypeScript, Vite/Metro build, autolinking comparison and runtime observations are pending registry-ready; no preparation test substitutes for them. SIGTERM of the launcher stops only its child group; it does not stop or rewrite the authority fixture.

The exact three native scenarios and web controls are in `docs/architecture/1519-consumer-rollout-preflight/execution/final-registry-canaries.md`. Preserve profile cache invalidation and sequence controls. Do not mutate Commons identity/preferences, clear storage, uninstall an identity-bearing app, or silently reuse candidate source aliases.
