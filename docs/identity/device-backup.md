# Identity device backup (Android Block Store)

> Phase 1 of [OxyHQ/oxy#1388](https://github.com/OxyHQ/oxy/issues/1388). Commons
> keeps a copy of the self-custody identity outside the Android Keystore, so a
> wipe of Commons' Keystore (Clear storage on Commons, or a reinstall) no longer
> loses the identity. On the next launch Commons restores it without asking for
> the recovery phrase. Phase 2 ([phase-2-shared-uid-migration.md](phase-2-shared-uid-migration.md))
> gave every Oxy app its own UID, so other apps can no longer cause that wipe.
>
> Code: `packages/core/src/crypto/deviceBackup.ts` and the device-backup paths in
> `KeyManager` · `packages/commons/lib/identity-backup/` ·
> `packages/commons/modules/oxy-identity-backup/` (native) ·
> `packages/commons/hooks/identity/silentRestore.ts`.
>
> Related: [Root holders, enrollment and recovery](holders-and-recovery.md) ·
> [On-device testing safety](../engineering/platform-features.md#on-device-testing-safety).

## The problem

The Android Keystore belongs to the app's Linux UID. Every copy the SDK keeps
of the identity in Commons is wrapped by it: expo-secure-store's aliases (the
`oxy_identity`, `oxy_identity_backup` and `oxy_identity_mnemonic` services) and
androidx's `_androidx_security_master_key_`, which wraps the identity signer
store. `clearApplicationUserData` on Commons (`adb shell pm clear
so.oxy.commons`, or *Settings › Apps › Commons › Storage › Clear storage*), or an
uninstall and reinstall, wipes that Keystore, and every copy dies together: the
recovery ladder shows "We couldn't restore automatically".

Until Phase 2 every Oxy app shared the UID `so.oxy.shared`, so clearing ANY Oxy
app wiped Commons' keys too (observed on a Pixel 8a after `pm clear
onl.alia.app`). Each app now has its own UID, so that case is gone; the backup
now covers Commons' own storage.

## The decision

Commons stores the identity in **Android Block Store** as well. Block Store data
lives in Google Play services' own private storage and is keyed to Commons'
package name and signing certificate. A wipe of Commons' Keystore cannot reach
it, and reading it back is a local call.

| Requirement | Block Store |
|---|---|
| The user types nothing | Yes. The read is silent and needs no prompt. |
| Oxy's servers cannot decrypt it | Yes. Oxy's servers never receive it. The cloud copy exists only when Block Store's end-to-end encryption is available, and that encryption is keyed by the device screen lock. |
| The restore check works offline | Yes. `retrieveBytes` reads the local copy. |
| It survives a wipe of Commons' Keystore | Yes. The data is in Play services' storage, not in Commons' Keystore. |
| It survives reinstalling Commons | Yes, when Backup is on (*Settings › Google › Backup*). |

### Options considered

**Auto Backup (`android:allowBackup` / `fullBackupContent`) with client-side
encryption.** Rejected. Auto Backup restores only during an install or a device
restore, so an app cannot pull its backup back after a wipe it lives through. The
backup would also hold expo-secure-store ciphertext whose Keystore keys are not
backed up. A separate client-side key would have to live somewhere that survives
the wipe, and on this device that place is Block Store. Block Store also does the
job without Auto Backup.

**A key wrapped by a platform authenticator and stored by Oxy.** Rejected for
Phase 1. Oxy had this model on the web (an envelope sealed behind `auth.oxy.so`,
deleted by ADR 0029 D3). On Android it fails the requirements: the user must
approve a prompt, so the restore is not silent, and the envelope is fetched from
Oxy's API, so the restore needs the network.

The web no longer holds identities at all: an account without a key signs in by
email (ADR 0030), and Commons is where a key lives.

**The existing phrase-keyed Oxy backup (`/identity/backup`).** This is the
"Restore from encrypted backup" entry on the import screen. Its AEAD key and its
256-bit lookup id are both derived with HKDF from the BIP-39 seed. Oxy stores
only ciphertext, and the only way to find and decrypt it is the phrase. That
zero-knowledge property is deliberate, and it is also why it cannot restore
silently: the key it needs is the phrase the user no longer has on the device.
It also requires the network. It stays the backup for a lost device, and the
device backup is built to work with it: the device backup record carries the
phrase (below), so after a silent restore Settings can still reveal the phrase
and create or replace that Oxy backup.

**iOS.** No change is needed. The identity is in the keychain, in items shared
through the `group.so.oxy.shared` access group. iOS has no "clear storage" for an
app, and removing one app from the group does not remove the group's items.
Commons registers no device backup on iOS.

## How it works

`@oxy.so/core` never imports a native module, so the store is injected:
`KeyManager.setDeviceBackupStore(store)` takes an `IdentityDeviceBackupStore`
(`read`, `write`, `clear`). Commons registers the Block Store adapter at module
scope in `app/_layout.tsx`. No other app registers one, so every path below does
nothing in Mention, Alia and the other apps.

The record is one Block Store entry under key `so.oxy.identity.device-backup.v1`:

```json
{ "version": 1, "privateKey": "<64 hex>", "publicKey": "<hex>", "mnemonic": "<12 words>", "updatedAt": "<ISO-8601>" }
```

`mnemonic` is present only when it was checked to derive `publicKey`. It is no
more powerful than the private key in the same record. It is included because
the phrase slot dies with the Keystore too, and without it a restored identity
could no longer reveal its phrase.

| Event | What happens |
|---|---|
| Create, import, restore or key rotation | `_persistIdentityAtomic`, which every identity write goes through, writes the record after the key is durable. The phrase is kept only when the identity is unchanged, so a rotation drops the old phrase. A failed write is logged and never fails the identity write. |
| `storeRecoveryMnemonic` | Adds the phrase to the record when it derives the current key. |
| Each launch, when the identity is present | `KeyManager.ensureDeviceBackup()` is one read and usually no write. It backfills identities that were created before this change, and it repairs a record left stale by a failed write, such as the old key after a rotation. |
| Launch with the keys gone | The boot probe (`readIdentityVerdictWithSilentRestore`) runs `attemptIdentityRecovery` before routing. The backup slot, then the shared slot (the identity signer store), then the device backup: the first healthy copy that matches the marker is restored. Routing then sees `present` and the user sees no recovery screen. |
| Launch with the keys and the marker gone (Commons' own data was cleared, or it was reinstalled) | The device backup is the only copy, so it is restored. Without this, onboarding would create a new identity and overwrite the backup. |
| Every `deleteIdentity` (forced or not), "Start over", account deletion | The record is cleared, so a deleted identity is never restored. |
| Nothing restorable | The recovery screen and the phrase paths work as before. |

`attemptIdentityRecovery` never switches accounts. When the marker records a
different identity than the copy holds, the copy is skipped and the result is
`mismatch`.

### Native module, store build, OTA

The native side is a local Expo module, `packages/commons/modules/oxy-identity-backup`.
Expo autolinks it from `./modules`. It adds
`com.google.android.gms:play-services-auth-blockstore:16.4.0`.
It moves one opaque UTF-8 string, and requests cloud backup only when
`isEndToEndEncryptionAvailable()` is true. Otherwise the copy stays on the device.

**It takes effect only in a new Commons store build.** An over-the-air JavaScript
update to an older binary finds no `OxyIdentityBackup` native module.
`createBlockStoreBackup()` looks the module up with `requireOptionalNativeModule`,
the same way `usePreventScreenCapture` does, and returns `null`. That binary
keeps its current behaviour: no device backup, and the phrase as the fallback.
Nothing crashes. The first launch of the new binary backfills the record through
`ensureDeviceBackup`.

## Threat model

What it protects: the secp256k1 identity key, and the phrase when it is known.

- **Another app on the device.** It cannot read the record. Play services checks
  the caller's package name and signing certificate. An app signed with the Oxy
  release key can ask only for its own package's data, and Commons is the only
  package that writes a record.
- **Oxy's servers and operators.** They never receive the record, so there is
  nothing for them to decrypt.
- **Google.** The local copy is in Play services' private, file-based-encrypted
  storage. The cloud copy is written only with end-to-end encryption keyed by the
  device screen lock, which Google cannot open. With no screen lock set, nothing
  leaves the device.
- **Someone who has the unlocked device, or root on it.** They could read Play
  services' data. They could also already sign as the identity through Commons,
  and could use Commons' Keystore, so this adds no new capability for
  them. Compared with keystore-only storage, the difference is this: the key is
  no longer bound to this device's hardware Keystore, and a rooted attacker can
  copy it off the device. Oxy accepts this in exchange for surviving a Keystore
  wipe. The phrase could always be copied the same way.
- **A malicious OTA update.** Oxy Updates are code-signed. JavaScript can already
  read the primary key, so this adds nothing.
- **Losing the device.** This is not in scope. Block Store's cloud copy goes to a
  new Android device only through Google's device-restore flow. The phrase and
  the phrase-keyed Oxy backup remain the ways to move an identity to a new device.

What it does not change: the phrase stays the root of recovery. A Keystore wipe
without Play services, on a device where Block Store is unavailable, still ends at
the phrase screen.

### Devices without a device backup: the warning

Where Block Store cannot exist (verified on a LineageOS Pixel with no GMS:
`Blockstore.API is not available on this device … statusCode=SERVICE_INVALID`),
or on a binary built before the native module, Commons tells the user. A
non-blocking banner says the identity is not backed up on this device and offers
two actions: reveal and write down the recovery phrase, and set up the
phrase-keyed encrypted backup (the counterpart of "Restore from encrypted
backup"). A key-imported identity has no phrase and is sent to key rotation
instead. The banner shows once on the ID tab after onboarding, and stays in
Settings until the user confirms they saved the phrase.

- The probe is `probeDeviceBackupAvailability` in `packages/commons/lib/identity-backup`:
  one local Block Store read. Only an "API missing" rejection (`SERVICE_INVALID`,
  `SERVICE_MISSING`, `SERVICE_DISABLED`, `API_UNAVAILABLE`) counts as unavailable,
  so a transient failure never shows the warning.
- The state is `hooks/identity/useDeviceBackupWarning.ts`. Both flags hold the
  public key they were set for, so a key rotation brings the warning back.
- It needs no new native code: an OTA reaches every binary that has the module.

With Phase 2 the warning is about Commons' own storage only: on these devices,
clearing Commons' storage or reinstalling it still ends at the phrase.

## The rule for people and agents

**Never `pm clear` Commons, clear its storage or uninstall it on a device that
holds a real identity.** That wipes Commons' Keystore; the device backup brings
the identity back only where Google Play services exist. Other Oxy apps have
their own UIDs: clearing them costs only their own session. See
[on-device testing safety](../engineering/platform-features.md#on-device-testing-safety).

## Master key rule (services)

`OxyEncryptedPrefs` never deletes the androidx master key
(`_androidx_security_master_key_`). Every store opens with
`RecoveryPolicy.RebuildFileOnly`: an unreadable file is deleted and rebuilt on
its own, and if the rebuild fails the store reports the data as absent.
`RegenerateSharedMasterKey` was removed. It deleted the one master key that
wraps every encrypted prefs file of the app (under the shared UID, of every Oxy
app), so one store could break all the others. Commons' identity signer store
follows the same rule: it is a copy Commons refills from the primary identity
(`syncSharedIdentity`). `packages/services/__tests__/android/encryptedPrefsRecoveryPolicy.test.ts`
enforces both points: the policy has one value, and no Kotlin source calls
`deleteEntry`.

## Device test plan (manual)

Run on a device holding a **disposable** identity only, with a Commons build that
contains the native module, Google Play services, a screen lock, and one other
Oxy app (for example Alia).

1. Install Commons and open it. Create an identity and write the phrase down.
   `adb logcat | grep -i -E "KeyManager|identity|Blockstore"` should show no
   `Failed to write the identity device backup` line.
2. Isolation (the #1388 case): `adb shell pm clear onl.alia.app`, reopen Commons.
   **Expected:** nothing happens to Commons; no recovery screen, same key.
3. Commons' own data: `adb shell pm clear so.oxy.commons`, then reopen.
   **Expected:** the identity is restored silently; the public key matches step 1.
   Onboarding may resume at the username step until the session is minted (or,
   for a key that never got an account, until a username is chosen: the account
   is created there). It must never show the welcome or create screen.
4. *Settings › Recovery phrase* reveals the same 12 words (the `mnemonic` round trip).
5. Sign in with Oxy from Alia: Commons answers again once its signer store is
   refilled (`syncSharedIdentity`).
6. Rotate the key (*Settings › Rotate key*), then repeat step 3.
   **Expected:** the NEW key is restored.
7. Deletion: *Settings › Delete account* (or "Start over") on the disposable
   identity, then `pm clear so.oxy.commons` and reopen. **Expected:** the welcome
   screen. The deleted identity does not come back.
8. Over-the-air behaviour: an older Commons binary that receives this JavaScript
   through Oxy Updates boots normally, logs nothing about Block Store, and after
   step 3 shows the phrase screen.

Open question for the device run: Block Store's documentation does not say
whether Play services clears a package's Block Store data when that package's
own storage is cleared. Step 3 answers it; if it does, only a reinstall with
Backup on is covered, and Clear storage on Commons ends at the phrase.
