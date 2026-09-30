# Phase 2: every Android app on its own UID

> Status: **shipped, as a clean cut.** Tracking issue: OxyHQ/oxy#1388. Phase 1
> (Block Store device backup) and the no-GMS warning are in
> [device-backup.md](device-backup.md).
>
> Oxy had no real users when this shipped, so there was no staged rollout: no
> `sharedUserMaxSdkVersion`, no compatibility window, no legacy `getShared` lane,
> no telemetry field. Every app dropped `android:sharedUserId` in one release,
> and QA devices uninstall and reinstall (Android refuses an update that changes
> an installed app's UID).

## Summary

Oxy Android apps used to declare `android:sharedUserId="so.oxy.shared"` and run
as one Linux UID. The Android Keystore belongs to a UID, so "Clear storage" on
any one app wiped the Keystore of all of them, Commons' self-custody identity
included. And Commons published the raw identity private key to every sibling
(`getShared`).

Now:

- **Every Oxy app has its own UID.** No app declares `android:sharedUserId`.
  Clearing or reinstalling a sibling cannot touch Commons.
- **Commons is the only holder of the identity private key.** Other apps get
  what they need from Commons over signature-protected ContentProvider `call()`
  IPC: the public key, a signed server challenge, and domain-separated
  derivations. Never the key, nor anything it can be recovered from. This is the
  `AccountManager` model ("Sign in with Google").
- **The device session** lives in the host apps (Commons, Accounts) and every
  other app reads and writes it through their provider.
- **iOS is unchanged:** the keychain access group `group.so.oxy.shared`.

## Permissions and manifests

Two `signature`-level permissions:

| Permission | Guards |
|---|---|
| `so.oxy.permission.IDENTITY` | Commons' identity host, `so.oxy.commons[.dev].identity` |
| `so.oxy.permission.DEVICE_SESSION` | The device-session hosts, `so.oxy.commons[.dev].devicesession` and `so.oxy.accounts[.dev].devicesession` |

**Every** Oxy app declares AND requests both, through one plugin:
`@oxy.so/services/plugins/withOxySharedPermissions` (`@oxy.so/app-preset` 3
applies it). It also adds `<queries>` for all six authorities, or Android 11+
package visibility hides the providers.

- Every app declares, not only the hosts, so install order never matters: a
  signature permission is granted at install when the declaring app is already
  there. Android accepts identical declarations from packages with one
  certificate and rejects a differently signed one
  (`INSTALL_FAILED_DUPLICATE_PERMISSION`).
- Provider plugins declare nothing: `plugins/withOxyIdentityHost` (Commons) and
  `withSharedDeviceSessionProvider` (Commons, Accounts) only add the
  `<provider>`.
- `.github/workflows/scaffold-smoke.yml` asserts a scaffolded app has no
  `sharedUserId` and declares and requests both permissions.

**Precondition: one signing certificate.** With Play App Signing that is the app
signing key Google holds for each listing. Confirm it for every app with
`apksigner verify --print-certs` on the Play-delivered APK. An app signed
differently cannot hold the permissions and is refused by the providers.

## The caller check

The permission is necessary but not sufficient. Inside `call()` each provider
resolves the caller with `OxyCallerPolicy` (one copy in `@oxy.so/services`
`so.oxy.security`, one in Commons' module; a test keeps the lists identical):

1. The package comes from `Binder.getCallingUid()` → `getPackagesForUid`, never
   from anything the caller sends.
2. It must be on the Oxy allow-list: Mention `earth.mention.app`, Alia
   `onl.alia.app`, Allo `com.allo.app`, Homiio `com.homiio.android`, CrowdSource
   `so.oxy.crowdsource`, Peable `to.peable.app`, Atlas `so.oxy.atlas`, GoWay
   `to.goway.app`, Move `so.oxy.move`, Willo `sh.willo.app`, Moovo
   `now.moovo.app` / `.go` / `.tracker` / `.hub`, Noted `so.oxy.noted`, Accounts
   `so.oxy.accounts`, Commons `so.oxy.commons`, each with its `.dev` variant.
3. It must be signed with the provider's own certificate:
   `hasSigningCertificate(pkg, sha256, CERT_INPUT_SHA256)` on API 28+,
   `checkSignatures` below.

A refused call returns `null` and logs the package and method only.

## Commons' identity host

`packages/commons/modules/oxy-identity-host`: `OxyIdentityHostProvider` at
`${applicationId}.identity`, behind `so.oxy.permission.IDENTITY`.

| Method | Extras | Answer (Bundle keys) | Who may call |
|---|---|---|---|
| `describe` | – | `v` (Int 2), `publicKey` | every allow-listed app |
| `proveIdentity` | `challenge` (String) | `publicKey`, `signature`, `timestamp` (Long) | every allow-listed app |
| `deriveScopedSeed` | `info` (String) | `seed` (32 bytes, hex) | per package and label: Peable only, `peable/faircoin/v1` |
| `signSocialReceive` | `index` (Int), `digest` (String) | `signature`, `publicKey` (child, compressed) | Peable only |

- **`proveIdentity`** builds the whole message itself:
  `sha256("auth:${publicKey}:${challenge}:${timestamp}")`, the format
  `POST /auth/verify` has always checked (`packages/api/src/services/signature.service.ts`).
  The challenge must be 64 lowercase hex, as `/auth/challenge` issues, so a
  caller cannot get an arbitrary message signed. RFC 6979 ECDSA over secp256k1,
  DER, **without** low-S normalization (noble `lowS: false`; the server accepts
  both halves).
- **`deriveScopedSeed`** is `HKDF-SHA256(key, salt "oxy-identity-scoped-seed-v1",
  info, 32)`, byte-identical to `KeyManager.deriveScopedSeed` on the device that
  holds the key.
- **`signSocialReceive`** signs a 32-byte digest (a transaction sighash) with the
  non-hardened BIP32 child of `@fairco.in/core`'s social-receive scheme: chain
  code `HMAC-SHA256("oxypay/faircoin/social/v1", compressed identity public
  key)`, child `index`. RFC 6979, **low-S** (BIP 62), DER.
- No answer carries the private key or a child private key. Any refusal or
  failure is `null`.

The provider signs with the **identity signer store**: an EncryptedSharedPreferences
file `oxy_identity_signer` in Commons, the Commons-only copy of the key. The
provider cannot read expo-secure-store, so `KeyManager` writes this copy through
an injected store, `KeyManager.setIdentitySignerStore(store)` (the same pattern as
`setDeviceBackupStore`); Commons registers it in `app/_layout.tsx`
(`lib/identity-signer`, native module `OxyIdentitySigner`). Every persist writes
it, every delete clears it, `syncSharedIdentity` repairs it on launch, and it is
the `shared` rung of `attemptIdentityRecovery`. It is never returned over IPC.

**Vectors.** `modules/oxy-identity-host/vectors.json` is the contract between the
Kotlin (BouncyCastle) and `@oxy.so/core`'s `identityDerivations` (noble): proofs
covering both halves of S, the `oxypay/faircoin/v1` and `peable/faircoin/v1`
seeds, and social-receive children cross-checked against `@fairco.in/core`. The
Commons JVM unit test (`./gradlew :oxy-identity-host:testDebugUnitTest` on a
prebuilt Commons) and core's `identityDerivations.test.ts` both reproduce every
value.

## Client side (every other app)

- **`OxyIdentity`** (native module in `@oxy.so/services`) calls the host, prod
  authority first, then dev. `@oxy.so/protocol`'s `loadCommonsIdentityBridge()`
  wraps it and narrows every answer to its exact shape; the iOS stub resolves
  `nil`.
- **`oxy.auth.signInWithCommonsIdentity()`**: Android `describe` →
  `requestChallenge` → `proveIdentity` → `verifyChallenge`; iOS signs with the
  keychain-group key. The cold-boot lane is `commons-proof-signin` (after
  `shared-device-adopt`); refresh arm 2 (`allowCommonsIdentityFallback`) and the
  account dialog use the same method.
- **`KeyManager` on Android**: `getSharedPublicKey` reads `describe` (Commons
  reads its own signer store); `getSharedPrivateKey` is always `null`;
  `deriveScopedSeed` and `signSocialReceive` use the app's own primary key
  (Commons) else ask Commons. `importSharedIdentity` / `createSharedIdentity`
  throw outside Commons.

## Device session

`OxyDeviceSessionProvider` (`@oxy.so/services`) answers `read`, `write` and
`clear` behind `so.oxy.permission.DEVICE_SESSION`, with the same caller check.
The hosts are Commons and Accounts (prod and dev); each keeps the credential in
its own `oxy_shared_device_session` file.

- **Read:** every app sweeps the hosts in one order, Commons then Accounts (prod
  before dev); a host reads itself from its own store. `unavailable` from any
  source is sticky, so an unreadable slot is never taken for an empty one.
- **Write:** fans out to every reachable host; true when one confirmed by
  read-back. **Clear** also goes to every host.
- A non-host app keeps no copy of its own.

## Testing

Unit and source gates run in every `bun run test`: the providers' caller check
(Binder uid, certificate, allow-lists), no key anywhere in `@oxy.so/services`,
authority and allow-list drift between Kotlin and plugins, plugin behaviour, the
preset's manifest (no `sharedUserId`, both permissions declared and requested),
the vectors, and the boot-lane order in core.

On devices, with a **test identity only** (see
[on-device testing safety](../engineering/platform-features.md#on-device-testing-safety)):

1. `adb shell dumpsys package <id>`: every Oxy package has its own `appId=`, and
   `grep sharedUser` finds nothing.
2. Silent sign-in into a sibling with Commons installed, no UI.
3. **The #1388 property, inverted:** Clear storage on a sibling leaves Commons'
   identity intact, with no recovery screen, on GMS and no-GMS devices.
4. Peable: seed and social-receive addresses match the pinned vectors.
5. Commons absent: the sign-in chooser appears. Commons cleared or reinstalled:
   recovery works as in [device-backup.md](device-backup.md).
6. Install orders: Commons first, sibling first, Commons installed last.

Reference: [`<manifest>` element](https://developer.android.com/guide/topics/manifest/manifest-element)
(`sharedUserId` is deprecated and cannot be removed from an installed app),
[permission protection levels](https://developer.android.com/guide/topics/manifest/permission-element#plevel).
