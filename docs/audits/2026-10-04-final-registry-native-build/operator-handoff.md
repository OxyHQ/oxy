# Root-only Android replay

Use only `emulator-5580`. Root revalidates the serial/package/certificate and preserves the existing synthetic identity before install-r. Do not use the physical Pixel, uninstall/clear applications, remove shared keys, or mutate identity stores.

Private artifact directory: `/home/nate/Oxy/.agent-evidence/i04-final-registry-native-types-20261004`.

| Lane | Package | APK | APK SHA256 | Frozen Metro |
| --- | --- | --- | --- | --- |
| Mention | `earth.mention.app.dev` | `mention-registry-signed.apk` | `527b6dc8f173863756371e14c2706f2a6ab0d15739c1a5085efcf3b435cdfcb1` | `127.0.0.1:17977` |
| Allo | `com.allo.app.dev` | `allo-registry-signed.apk` | `1e8531227f2abb1ba0fe22d638ae80a5eefbff408877846b924813633b0115f8` | `127.0.0.1:17978` |

Both certificates: `0114ce567a3be9b87dcbb0ef1083bba5f6e38ebf6733b29df93be1acfd7fbb55`. These are fresh x86_64 APKs with the required native peers, using the existing fixture signing key.

Root installs with `adb -s emulator-5580 install -r <exact-APK>`. Reverse ports17977,17978,17960,17961 on this serial. Set each application's own React Native `debug_http_host` to its exact Metro above; reversing8081 alone does not replace an old explicit17971 preference. No SDK auth preference changes.

The existing private manifest is `/home/nate/Oxy/oxy/.worktrees/1519-real-oauth-browser-20261003/.integration-evidence/oauth1519-1n8d1xvu/manifest.json`; use `clients.nativeFirst` and `clients.nativeSecond`. It contains a private synthetic password; do not print/copy its contents into evidence. API17960/IdP17961 remain unchanged.

`live-bundles.json` in the artifact directory pins the bytes served by both frozen Metros. Mention bundle SHA256 `bd7d78395a2dd287a9edd047c456a47e1d6f959c59484f4cd51259a3ba8c3c29`; Allo `6c106cf15effb0761fa55b5f07556d6f359b692e6f20ec13fc0ec97c2a672758`. The adjacent final-verified receipts and resolver summaries establish registry/member identity. Historical Metros17967/17968 are untouched.

Repeat the three scenarios in [the canary plan](../../architecture/1519-consumer-rollout-preflight/execution/final-registry-canaries.md): running sibling logout, warm explicit re-login, and stopped sibling logout after explicitly clearing its opt-out through actual sign-in. Each profile assertion needs the next `acceptance-profile-sequence` and a successful observed fresh GET `/users/me`. Require signed-out/private-denied after logout/cold boot, zero automatic challenge/verify, and unchanged identity signer/SecureStore/aliases. Existing development LogBox can cover touch targets; close only its visible notification control before judging auth touch behavior.

Build/export/registry verification is complete. Device acceptance remains pending root's observations; no new corruption or identity-recovery mutation is part of this replay.
