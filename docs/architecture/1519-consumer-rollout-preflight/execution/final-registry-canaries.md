# Final public-registry acceptance

Prepared, not executed. Root supplies the registry-ready receipt after backend readiness and owns browser/ADB/live promotion. No native Metro, API fixture, identity store, client registration, grant or production setting is changed by this plan. Package publication ACK alone is insufficient. The seventeen consumer rows and importer census remain the executable installation inventory in `lots.json`.

## Artifact gate and local adoption

For each selected batch, from this worktree:

```sh
python3 scripts/adoption/final-registry-consumers.py \
  --repository OxyHQ/Homiio \
  --execute \
  --candidate-manifest /home/nate/Oxy/.agent-evidence/i04-consumer-final-200134-packs/manifest.json \
  --output /home/nate/Oxy/.agent-evidence/i04-registry-homiio-final
```

The output must be a new private directory. Repeat `--repository` for independent rows; do not run overlapping rows concurrently. The helper verifies all five final versions and every archive member against the reviewed shipping source before changing any repository, checks fresh main ancestry, applies only that row's pinned patch, resolves with minimum-release-age0, installs frozen, and compares every relevant nested importer to registry contents. Missing versions, changed source/patch/main, differing archives, multiple SDK copies with differing contents or unresolved imports stop that row. Preserve partial state; do not reapply a successful patch or publish again to recover an installation failure. A source change after this plan requires updating only the affected row and its proof.

Target versions: contracts4.9.0, protocol1.2.2, core4.2.0, services11.1.0, MCP1.1.0. Telemetry1.2.0, Bloom6.2.1/7.1.2 and PeableSDK0.2.2 are existing published dependencies. Services' corrected peer lines must accept only the reviewed Bloom lines; native fixtures pin6.2.1. Alia's standalone codea webview has no Services and retains its separately checked Bloom6.3 dependency; it must not be described as a621 installation.

After installation, execute the affected packages' existing type/build checks and focused authority/HTTP/socket regressions (commands and paths in each row's packageScripts and linked product proof). Preserve standard required CI after committing manifests+lock. Do not repeat crypto vectors, provider sandbox payments, full source suites or schema migrations locally merely because archive compression differs: identical member bytes plus existing proof are reusable. New failures, changed runtime source, native modules or lock resolution require the relevant test, not an automatic bypass. Homiio additionally reruns its delayed-body/picker owner regression; Noted its raw-envelope/status/deadline controls; Alia/Mention the internal MCP/requester/retirement controls; Allo its real-PG socket boundary. The isolated receiver probes fix environment before module imports and deny nonloopback test networking.

The installation receipt does not imply product acceptance. For every row record: source/main ancestry, registry metadata/integrity, lock hash, importer resolutions/member hashes, commands/results, exact PR/head and CI, and unresolved baseline limits. Root pauses affected deploy/publisher workflows before merges. No consumer package is published by this runner. ECS adoption remains the separate image-bound root operation, with newTD+capturedcount in one update, rollback:false, failure→hold0, and scaler restore only after that service's smoke. A worker startup log is not a delegated-authority test.

## Published web fixture

Keep the existing owned fixture API17960/IdP17961/SMTP17964 and synthetic registrations/data under root/coverage ownership. Revalidate listener PID/UID/executable/data manifest before reuse. Do not restart them or replace their fixture client IDs. Prepare a new standalone consumer directory outside Bun's workspace resolution, carrying the reviewed `scripts/rehearsal/real-oauth-browser/main.tsx` and index from `1519-real-oauth-browser-20261003`, with exact public registry dependencies. The existing Vite config aliases Services to `packages/services/lib/module/index.js` and React to workspace paths: remove those source/workspace aliases in the new fixture and retain the maintained web/RN transforms. Its resolver report and emitted bundle module map must point to the installed registry packages, including nested Services→core→contracts and the single Bloom/React graph. A successful export with workspace aliases is not registry acceptance.

Freeze separate first-party RP A/B and third-party callback builds using the existing manifest registrations. Reuse their exact registered origins/redirects; any listener handover is root-coordinated after stopping the previous owned RP, not an unregistered new callback. Root uses an isolated browser profile and captures network plus UI:

1. Fresh signed-out load performs no silent navigation, iframe/FedCM restore or cookie writes. Gesture sign-in uses the registered lane. First-party email/password dialog and third-party OAuth bridge/PKCE remain distinct.
2. Explicit sign-in resolves user A. Clear only `GET:/users/me` cache before each SDK profile read; require a new successful HTTP request and matching UI/account subject. Tokens, passwords, codes and full sensitive URLs never enter public receipts.
3. In the two independent first-party holders, switch to the fixture organization B; foreground the sibling and require UI B plus a fresh GET returning B. Partial logout falls back to the remaining valid account; full logout leaves both private API unavailable and no automatic challenge/verify. Reload remains signed out. Explicit re-login works.
4. In the third-party holder, cancellation and wrong/expired callback leave signed-out state; explicit successful OAuth permits a fresh profile read; isolated logout denies it. Reuse the reviewed bridge origin/state/one-use-code/PKCE rejection fixtures for byte-identical SDK code instead of manufacturing another provider transaction. Product browser observations are additional to those protocol fixtures.

Record the backend source/digest and fixture ownership separately from the registry SDK graph. Local synthetic authority does not prove production client configuration; per-product client/redirect and deployment smokes remain row-specific.

## Published Android fixture

The frozen candidate WTs `1519-native-siblings-20261003` and `1519-native-allo-20261003` and Metros17967/17968 stay unchanged until root releases them. Their `packages/test-app-expo/metro.config.js` explicitly aliases core/Services to workspace SOURCE, so a lockfile change there cannot establish registry execution.

Prepare separate standalone fixture directories from the same accepted `packages/test-app-expo/acceptance/entry.tsx`, app configuration and native dependency versions. Install exact final registry SDK packages and published Bloom6.2.1 with minimum-release-age0. Use the preset's standalone Metro configuration without Oxy workspace aliases/watchFolders. Preserve registered client IDs, loopback API origin, package IDs `earth.mention.app.dev` / `com.allo.app.dev`, no sibling OAuth scheme, and the existing fixture certificate. Do not add package allowlist entries or use a physical device. Record all importer resolutions and tarball-member equality, native autolinking/Gradle graph, source hashes, bundle hashes and live HTTP bundle bytes before launch. Select fresh unused Metro ports and hand them to root; root alone changes the owned debug_http_host preference and ADB reverse mappings.

The profile button keeps canonical `cache.delete('GET:/users/me')` before awaiting `users.me()` and increments `acceptance-profile-sequence` only after success. Each profile claim requires both the next sequence number and the observed successful GET. The old profileId alone proves nothing about freshness.

Compare installed registry native Android sources and native dependency/config graphs against the accepted APK. If identical, root may reuse that exact APK/certificate while changing only the JS bundle. If different, build/sign a new owned debug APK and have root review/install-r after checking signature and permissions. Never uninstall/clear Commons or delete Keystore aliases. Preserve existing synthetic identity and provider preferences; no token/auth-state injection.

Root repeats the three discriminating scenarios on emulator5580:

| Scenario | Preparation and required observation |
| --- | --- |
| Running sibling logout | Explicitly sign in, read fresh person profile in both; switch to org in one, foreground the other and read fresh org profile; full logout while sibling lives; both deny private API, then process-stop/cold boot stays signed out with zero automatic challenge/verify. |
| Warm explicit re-login | After logout, explicitly sign in one app and foreground the other; the new shared holder must be adopted and a fresh GET return its current subject. No stale holder or cached profile counts. |
| Stopped sibling logout | Explicitly sign in the sibling first so its local opt-out marker is false, then root force-stops it; full logout in the other; restart the stopped sibling and require signed-out/private-denied with zero automatic challenge/verify. Starting with marker already true is not this test. |

Root captures owner/pin and signer/SecureStore/alias preservation around the run without publishing material. Candidate AND03 already exercised exact owned derived-file ciphertext corruption and real self-heal while preserving identity; reuse its evidence only if the registry native implementation is byte-identical. No new corruption is implied by this plan. A changed implementation requires a separately pinned root CAS mutation/backup plan, never a wipe. Dismiss the development LogBox notification via its own visible close control if it covers the auth link; the prior same-coordinate PASS after dismiss established a development overlay, not an auth runtime patch. XML can omit an actually visible IME; screenshots and event/network evidence resolve that limit.

## Closure and limits

Link published-artifact receipts to the earlier three-scenario candidate evidence, without replacing its historical source pin. Mark final registry web/native checks only after their observations pass. Android export/build is not device acceptance, and a candidate APK is not an app-store release. Keep consumer deployment, billing cohort, background grants, MCP pilot configuration and production commerce separate. No new prices, grants, credentials or merchant terms are inferred from green SDK canaries.
