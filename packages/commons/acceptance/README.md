# AND03: owned synthetic identity and file-only recovery

Preparation only. Root alone operates emulator-5580 / Oxy1519Root20261003.
The `so.oxy.commons.dev` slot must be empty or contain exactly this approved
fixture; root checked it empty and will recheck immediately before installation.
Do not touch any physical device, other AVD, real Commons installation, existing
identity, shared Keystore entry, or identity backup. No overwrite option exists
in this fixture's identity creation control.

With EXPO_PUBLIC_OXY_IDENTITY_RECOVERY=1 the existing Commons package mounts a
small observation screen. Its real local OxyIdentitySigner module, IdentitySignerStore,
IdentityCrypto, identity ContentProvider/caller policy and shared session provider
remain unchanged. The normal app config/Babel/router entry remain the default
when the flag is absent. Fixture OTA is disabled; URLs target the owned local
API17960 and IdP17961. The client must be a dedicated registered fixture client.

The UI uses KeyManager.createIdentity without overwrite, actual signed key
registration and SDK sign-in against the fixture API, and one OxyProvider with
sessionMode=identity. No private key leaves the app UID or appears in logs/UI.
Readback displays public key, server-resolved owner/profile, and the actual
canonical identity pin's key/owner comparison. Pin reads use
createNativeIdentityPinStore.load with real SecureStore (or the SDK's real
AsyncStorage fallback); the fixture never writes a fabricated pin. Its SDK
provider establishes the pin through the real identity session path.

## Before any corruption

1. Root records exact APK hash, disposable signing certificate, package UID,
   emulator identity, client metadata, public key and authenticated owner/pin.
2. Root confirms an actual sibling session has been published through real SDK
   IPC into Commons' derived shared-session file. No fake device credential is
   inserted. Record sibling profile and owner before the failure.
3. Quiesce only the owned fixture apps and force-stop Commons.dev. Keep root's
   existing Accounts host and foreign-signature control installed. Confirm no
   target process can overwrite a pending snapshot during the CAS operation.
4. Root captures ONLY
   `/data/user/0/so.oxy.commons.dev/shared_prefs/oxy_shared_device_session.xml`
   through the owned app UID into a private0600 host file. Require no Android
   `.bak` sibling. Record hashes of `oxy_identity_signer.xml` and relevant
   identity/pin storage as read-only sentinels; never copy plaintext keys into
   public evidence. Record the exact AndroidKeyStore alias inventory, without
   extracting key material.
5. Review the exact snapshot hash, byte count and operator manifest before any
   device write. Root approval of the source is not a substitute for that
   concrete preflight.

## Offline mutation preparation and root CAS application

`prepare-corrupt-slot.py` is pure host-side preparation. It does not invoke ADB.
It accepts only the named derived-session XML, owned0600, a matching SHA256,
strict UTF8/Android map and exactly one valid hexadecimal encrypted keyset. It
creates a new0700 attempt directory with exclusive0600 `original.xml`,
`corrupt.xml` and a metadata-only receipt, fsyncs outputs and refuses overwrites.
Only one ASCII hex byte in
`__androidx_security_crypto_encrypted_prefs_key_keyset__` changes. All other XML
bytes are preserved. Seven offline tests cover CAS, privacy, duplicates, malformed
input, exact mutation and preservation.

Root must re-read the device file immediately before applying, require its hash
still equals inputSha256, and verify the private backup matches. Root writes only
that one path and verifies corruptSha256 before explicitly relaunching a sibling.
A subsequent sibling read reaches the real Commons OxyDeviceSessionStore /
OxyEncryptedPrefs first, triggering bounded file-only rebuild. Its own SDK session
can then republish the real derived credential. Root reopens the identity fixture
and records the same public key, server owner/profile and real pin, plus sibling
recovery. Capture bounded logs and store/alias readbacks. Do not claim success if
any observation is missing or identity/owner changes.

Rollback may restore the private original file ONLY while the device file still
matches corruptSha256. Once the SDK has healed or reseeded it, do not overwrite
that new file with a stale snapshot; preserve evidence and investigate. No
Keystore deletion, SecureStore wipe, identity-file mutation or blanket storage
clear is permitted at any stage.

This fixture does not test Block Store/recovery-phrase restoration or hardware
loss. Its claim is bounded to a synthetic identity using real Android stores and
SDK identity pinning while a separate derived-session file is corrupted.

## Build and dependency correction

The first real Android assembly failed in checkDebugDuplicateClasses: Commons
identity-host used bcprov-jdk18on:1.80 while Expo Updates brought
bcutil-jdk15to18:1.81 and bcprov-jdk15to18:1.81. The upstream correction aligns
identity-host to bcprov-jdk15to18:1.81. No signing algorithm, identity store,
caller policy or allowlist changed. The corrected assembly passes (657 tasks),
five real JVM identity-vector tests pass, and dependencyInsight resolves one
provider family. This is build/JVM evidence; Android identity recovery remains
pending root's device preflight and exact-file CAS review.

The readonly debug instrumentation is
`so.oxy.fixture.identity.ObserverInstrumentation`, targeting only Commons.dev.
It returns UID, alias names and three named file hashes/presence flags, never
file contents or key material. It must run only after root validates package,
certificate and UID against this disposable installation. Its launch may stop
the target process; root schedules it between observations.

Metro uses port17969 and the registered nativeIdentity fixture client. Root must
set only the owned app's development host preference to127.0.0.1:17969. The
fixture has no OAuth callback scheme and does not collide with third-party astro.
