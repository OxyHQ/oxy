# Native SDK acceptance preparation — candidate only

Source `a887db7be` prepares an opt-in playground app for the root-owned isolated
AVD. The SDK source pin is `1e719545f`; no SDK runtime is changed. See the
[harness instructions](../../../packages/test-app-expo/acceptance/README.md).

Frozen install, dependency builds, strict harness TypeScript and scoped ESLint
passed. Android prebuild and Gradle debug build passed (424 tasks). The APK is
x86_64, package `so.oxy.acceptance1519`, callback scheme `astro`, with no shared
UID. The merged manifest and APK hashes are recorded; APK/native generated files
remain ignored local artifacts. The ordinary playground config compares equal
to its previous app.json configuration when the acceptance flag is absent.

The first Gradle attempt failed because prebuild was repeated during the build
and removed the generated autolinking input. Running them sequentially passed.
The initial harness TypeScript config omitted the existing NativeWind declaration;
including it passed, without an ambient shim or SDK change. The first ESLint
launcher used a missing root .bin; the installed package ESLint invocation passed.
Those failed logs are retained privately and hashed in the manifest.

No ADB command, device installation, browser auth interaction or production
request has been executed by this agent. Metro with the registered native fixture
client, actual device behavior, and final published SDK repeat remain pending.
This package is outside the existing trusted sibling allowlist and therefore
cannot establish shared-device SSO; it exercises third-party isolated OAuth.

## Registered client and bundle

Coverage registered a dedicated development third-party public credential with
exact callback `astro://oauth/callback`, without prefabricating sessions/grants.
Metro17966 compiled3555 Android modules and servedHTTP200; the bundle contains
the registered client and acceptance persistence namespace. A pre-existing
`@noble/hashes/crypto.js` export warning used Metro file resolution; device runtime
remains the authority for whether the loaded SDK works.

Root preflight identified a signature-permission conflict with the existing
owned fixture host. A separate APK was signed with that fixture's disposable
`allowed.jks` certificate (`0114ce…`), without changing package identity,
allowlists or original APK. Both artifacts are hashed. The signer is a public
local test fixture, not a production key. Root alone installs/operates the AVD.
The debug APK loads JS from Metro; successful compilation is not a device run.

## Executed device failure and consumer dependency correction

Root installed the compatible test-signed APK. The emulator defaulted to
10.0.2.2:8081 for Metro; root set only the owned app's `debug_http_host` preference
to127.0.0.1:8081. The next real runtime failure was an unlinked
react-native-keyboard-controller, before sign-in. The playground had not declared
that native dependency. Source1bb2a8bd4 adds its catalog dependency/exclusion and
expo-secure-store for native SDK storage; no SDK runtime or UI was bypassed.
Gradle447 tasks, native autolinking, strictTypeScript and scopedESLint pass.

`native-peers-followup.json` pins the new APK outside Gradle's mutable output
folder. The earlier APK hashes remain historical, independently verified by root
before installation; rebuilding replaced their original output paths. Device
acceptance of the corrected APK remains pending root's operation.

Correction: the initial peer followup TypeScript6 log failed because the harness
config omitted existing styles.d.ts (the earlier rootTypeScript5.9 run passed).
The config now includes that existing declaration; corrected packageTypeScript6
run exits0. Both logs remain in the proof. This changes only harness types.

## Root-operated candidate third-party device run

Root observed the corrected APK on owned emulator-5580: cold boot resolved
signed out; IdP cancellation remained signed out with the exact typed result
`failed:native-callback-invalid`; both SDK button/hook completed actual OAuth;
provider user and SDK profile matched; logout removed authentication and the next
profile call was denied; process restart stayed signed out as expected for the
memory-only isolated grant. Root observed zero browser cookies. No sibling SSO
claim follows from this run. Final registry installation/repeat remains pending.

`third-party-device-observation.json` carries only the operator's whitelisted
observations and private evidence hashes. Raw browser/network/XML evidence is
not copied into the repository; it may include callback/authentication material.
The observed Metro bundle hash binds the executed JS separately from the APK.
The initial load/link errors and an earlier coordinate-based tap that logged out
are retained in root's private evidence and not counted as successful sign-in.
