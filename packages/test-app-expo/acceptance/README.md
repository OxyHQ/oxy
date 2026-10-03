# Owned native SDK acceptance fixture

This opt-in playground entry mounts one public `OxyProvider` and uses the real
`OxySignInButton nativeOAuthCompletion="sdk"`, `startNativeOAuthSignIn`,
`useAuth.signOut`, and `oxyServices.users.me`. It does not handle callback codes,
exchange tokens, fabricate device IDs, copy a session, or access a private key.
The screen exposes only public fixture account IDs, booleans, and typed outcomes.

Set `EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE=1` and the public
`EXPO_PUBLIC_OXY_CLIENT_ID` registered by the owned API fixture. There is no
production/default client. API and IdP addresses are explicitly
`http://127.0.0.1:17960` and `http://127.0.0.1:17961`; the exact registered redirect
is `astro://oauth/callback`, an existing permitted IdP scheme. The provider uses
its own `oxy1519-native-acceptance` persistence namespace.

The Android application ID is `so.oxy.acceptance1519`, with its own UID. It is not
an allowed Commons sibling and therefore tests a third-party isolated session,
not cross-app native SSO. The ordinary playground configuration is unchanged
when the flag is absent. The acceptance build alone permits HTTP for the owned
loopback fixture. Never install this build on a real identity device.

Build from the repository root after the frozen install and dependency builds
(contracts, protocol, core in that order):

```sh
cd packages/test-app-expo
EXPO_NO_DOTENV=1 EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE=1 node ../../node_modules/expo/bin/cli prebuild --platform android --no-install
cd android
ANDROID_HOME=/home/nate/Android/Sdk EXPO_NO_DOTENV=1 EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE=1 ./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=3 --console=plain
```

Complete prebuild before starting Gradle. Generated native files/APKs remain
local ignored build outputs; capture their hashes in the evidence manifest.
The public client ID must also be supplied to Metro, started from this package
with `EXPO_NO_DOTENV=1`, the acceptance flag and `expo start --localhost --port
17966`. The debug APK uses its default Metro port 8081: the root operator maps
emulator port 8081 to host17966, and maps17960/17961 to the same host ports.

Only the root operator may use ADB, and only `emulator-5580`, the owned
`Oxy1519Root20261003` AVD. Root checks package slots/signatures before installation.
Do not touch the connected Pixel, existing AVDs, Commons storage, or shared
Keystore entries. This harness contains no ADB/install/clear commands.

Suggested device checks: explicit cancel leaves signed out; actual browser
sign-in/consent completes into the provider; SDK profile matches provider user;
normal process restart follows the SDK's documented isolated-session behavior;
logout revokes the isolated session and profile then fails. Record actual
observations independently. Builds/source checks do not prove these device cases.

This first run consumes the candidate workspace SDK at the source pin in the
proof, not published final packages. Registry installation and a repeat device
run remain required after the coordinated Oxy release.
