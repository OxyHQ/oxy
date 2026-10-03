# Two owned native provider siblings

This phase consumes the same candidate SDK source as the isolated acceptance
app. Select `EXPO_PUBLIC_OXY_NATIVE_SIBLING=mention` or `allo` along with
`EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE=1` and the corresponding dedicated registered
fixture public client ID. The application IDs are `earth.mention.app.dev` and
`com.allo.app.dev`, both already in the unmodified native caller allowlist.
The API fixture explicitly registers the applications as trusted; branding or
package names do not establish their server authority.

One public OxyProvider renders the real OxySignInButton without isolated OAuth
options, and `openAccountDialog('signin')` is the alternate public action. Thus
first-party sign-in uses the SDK dialog. Profile, refresh, switch and logout use
public SDK methods. No device credential, token, callback or key is handled here.
Each sibling uses its own SDK persistence prefix. The host device-session store
and cross-app IPC remain owned by the existing synthetic host fixture.

Use Metro17967 for Mention and17968 for Allo, each started with its own variant
and registered client ID. Generate/build sequentially per variant, with
`-PreactNativeDevServerPort=17967` or17968 and x86_64. Copy each APK outside Gradle
outputs before generating the next variant. Sign the copies with the existing
owned disposable `allowed.jks` fixture, never a production certificate.

Root alone checks and operates emulator-5580. Root authorized replacing only the
existing owned Mention instrumentation peer and confirmed the Allo slot empty.
Preserve the host so.oxy.accounts.dev, foreign onl.alia.app.dev, and isolated
so.oxy.acceptance1519. No app here invokes ADB or clears storage. Root configures
each owned debug_http_host preference to127.0.0.1:its-Metro-port to avoid Android
emulator default10.0.2.2. No authentication storage is patched.

Checks to observe: explicit UI sign-in on peer1; peer2 adopts through real SDK
cold boot/IPC; both SDK profile calls match their effective account; server-backed
account switch reaches the other sibling; logout propagation prevents subsequent
private calls. Record actual behavior separately from build results. No mock
session or fake deviceID may be inserted to make adoption pass.

AND03 is a separate reviewed corruption/recovery experiment, not a capability
of these UI controls. This preparation does not establish identity survival.
