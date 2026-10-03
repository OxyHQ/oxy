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
