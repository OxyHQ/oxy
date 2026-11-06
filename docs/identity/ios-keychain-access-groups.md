# iOS: who can read identity private keys (keychain access-group split)

> Status: **proposed, not decided**. A design note for the owner: either take
> the split described below, or accept the risk in writing (an ADR that says so).
> Nothing here is implemented. Written 2026-11-06 after an independent security
> review refused Peable mainnet partly on this point (finding F5).
>
> Related: [Root holders, enrollment and recovery](holders-and-recovery.md) ·
> [Organization identity keys](organization-keys.md) (ADR 0061 D6) ·
> [Phase 2: every Android app on its own UID](phase-2-shared-uid-migration.md) ·
> Peable ADR 0002.

## The finding, checked against the code

**On iOS every Oxy app can read the personal identity private key, every
organization private key, and both recovery phrases. On Android only Commons
holds them, and only the Peable wallet may ask for money operations.** The
review said "the raw personal and organization private keys". From the code it
is wider than that, for the reason in point 2.

1. **Every Oxy iOS app is in the group.** `@oxy.so/app-preset`'s
   `withOxyKeychain` (`packages/app-preset/plugin/withOxyKeychain.js`) adds
   `$(AppIdentifierPrefix)group.so.oxy.shared` to `keychain-access-groups` by
   default (`keychainGroup = 'group.so.oxy.shared'` in `withOxyAppPreset.js`).
   Commons and Accounts declare it directly (`packages/commons/app.config.js`,
   `packages/accounts/app.config.js`). A sweep of `~/Oxy` on 2026-11-06 found it
   in the app configs of Alia, Allo, Atlas, Authenticator, Clarity, CrowdSource,
   Dropsea, GoWay, Homiio, Mention, Moovo (four apps), Move, Noted, Peable
   (wallet and Orbit), Syra (two apps), Willo (two apps), Accounts and Commons.

2. **The explicit access group is never applied, so every item lands in the
   shared group.** `@oxy.so/core` passes `keychainAccessGroup` to
   `expo-secure-store` (`keyManager.ts` `getSharedPrivateKey`, `createSharedIdentity`;
   `organizationKeys.ts` `pairOptions`; services `sharedDeviceCredentialStore.ts`).
   `expo-secure-store` 58 does not have that option: its field is `accessGroup`
   (`ios/SecureStoreOptions.swift`), and `query()` in `ios/SecureStoreModule.swift`
   sets `kSecAttrAccessGroup` only from `accessGroup`. Unknown record fields are
   dropped. The hand-written ambient shim `packages/core/src/types/expo-secure-store.d.ts`
   declares `keychainAccessGroup`, so `tsc` never flagged it (the repo's
   ambient-shim rule exists for exactly this).

   An item written without a group goes to the writing app's DEFAULT access
   group, which Apple defines as the first entry of its `keychain-access-groups`.
   Commons lists exactly one, the shared group. So every keychain item Commons
   writes is in `<TEAM>.group.so.oxy.shared`, not only the "shared" slot:

   | Item (`keychainService` / key) | Written by | What it is |
   |---|---|---|
   | `oxy_shared_identity_private_key` | `createSharedIdentity`, `syncSharedIdentity` | personal root private key (the "shared slot") |
   | v2 primary and backup slots (`keyManager.ts` `V2_SLOT_LAYOUT`) | `_persistIdentityAtomic` | the same personal root private key |
   | `oxy_identity_mnemonic` / `oxy_identity_mnemonic_v1` | the recovery-phrase slot | **the personal recovery phrase** |
   | `oxy_org_identity_*` (iOS: the group) | `storeOrganizationKey` | organization private keys |
   | `oxy_org_identity_mnemonic` | `storeOrganizationKey` | **organization recovery phrases** |

   A read without a group searches every group the reading app belongs to, and
   every Oxy app runs the same `@oxy.so/core` with the same service and key
   names. That is also why the shared slot works at all today: it is reached by
   the default group, not by the option the code thinks it is setting.

   *To confirm on a device before acting:* a debug build of any sibling app
   calling `SecureStore.getItemAsync('oxy_identity_mnemonic_v1', { keychainService: 'oxy_identity_mnemonic' })`
   on a phone where Commons holds an identity. Expected: the phrase.

3. **iOS apps use the private key in process, by design.**
   `KeyManager.signChallengeWithSharedKey` (`signatureService.ts`) signs sign-in
   proofs; `deriveScopedSeed` and `signSocialReceive` read
   `getSharedPrivateKey() ?? getPrivateKey()` (`keyManager.ts`), for the personal
   key and, with `{ accountId }`, an organization's (ADR 0061 D6: "on iOS through
   the shared keychain access group").

4. **Android is already narrow.** Only Commons holds a key. Its identity host
   (`packages/commons/modules/oxy-identity-host/.../OxyCallerPolicy.kt`) never
   returns a private key, admits only allow-listed packages signed with Commons'
   certificate, lets only `to.peable.app(.dev)` call `signSocialReceive`, and
   allows `deriveScopedSeed` only for the labels a package is listed for
   (`peable/faircoin/v1` for the wallet).

### What that exposure means

A compromised Oxy iOS app (a malicious dependency, a bad OTA bundle, a bug that
evaluates untrusted code) can read the root key and the phrase of every person
who uses Commons on that phone, and every organization key held there. With
them it can spend every FairCoin in the Peable wallet and every coin received
by `@username` or by a merchant the account owns, sign in as the person, and
**rotate the root** (`/auth/rotate/*` takes the old root's proof), which ADR 0024
D8 makes irreversible. That is a takeover with no Oxy-side recovery.

OTA updates (`expo-updates`) change JavaScript but never entitlements, so an
access-group split confines a compromised bundle of any app that is not in the
narrower group. It does not protect against someone holding the Apple team's
signing identity: any app built under the team can declare any of the team's
groups. That residual risk is the same on Android (Commons' certificate).

## What the split would take

### Groups and who holds them

| Group (value in `keychain-access-groups`) | Holders | Contents |
|---|---|---|
| `$(AppIdentifierPrefix)so.oxy.identity` (new) | Commons only, listed FIRST so its default writes land here | personal root (primary, backup), its phrase, organization phrases, the organization index |
| `$(AppIdentifierPrefix)so.oxy.wallet` (new) | Commons, Peable wallet (`to.peable.app`, `.dev`) | personal and organization PRIVATE keys, for `deriveScopedSeed` / `signSocialReceive` |
| `$(AppIdentifierPrefix)group.so.oxy.shared` (today) | every Oxy app | public keys only, plus the device-session credential (`sharedDeviceCredentialStore`) |

The wallet group holds private keys, not derived seeds, because the
social-receive children are derived from the identity key itself
(`deriveSocialReceiveKey`: non-hardened, per index, unbounded) and iOS has no
background IPC through which Commons could sign on request. That makes the
iOS wallet hold the key, where Android's gets only signatures: one app instead
of every Oxy app. The phrases never enter the wallet group.

### Code

1. **Set the group that is actually read.** Replace `keychainAccessGroup` with
   `expo-secure-store`'s `accessGroup` everywhere (core `keyManager.ts`,
   `organizationKeys.ts`, services `sharedDeviceCredentialStore.ts`), and delete
   the ambient shim so `tsc` checks option names against the package's own types.
   `kSecAttrAccessGroup` must equal an entitlement value exactly, so the code
   needs the team-prefixed string (`<TEAMID>.so.oxy.identity`). The prefix is
   not known to JavaScript: inject it at build time (`@oxy.so/app-preset` writes
   it into `extra`, read with `expo-constants`) or discover it once from
   `kSecAttrAccessGroup` of an item read back. Passing the bare
   `group.so.oxy.shared` would fail every write (`errSecMissingEntitlement`).
   Doing this step alone changes where new items land, so it ships only with
   the migration below.
2. **Write each item to its group.** Commons' identity writes go to the identity
   group (private keys mirrored to the wallet group); public keys to the shared
   group. `getSharedPrivateKey` and `getPrivateKey` outside Commons read only the
   wallet group and answer `null` in every other app.
3. **Sign-in in sibling apps without the key.** `commons-proof-signin` stops
   working in-process for every app but Commons and Peable. The supported
   replacement already exists: the Commons approval round-trip
   (`oxycommons://approve`, `oxy.auth.commons.start/poll`, ADR 0029), at the
   cost of one visible app switch the first time an app signs in. A silent
   alternative would be a per-device sign-in key minted by Commons into the
   shared group and registered as a sign-in-only credential (it could not
   rotate the root or spend). That is a new kind of credential, which ADR 0061's
   context notes does not exist; it needs its own ADR.
4. **Entitlements.** `@oxy.so/app-preset` keeps the shared group as the
   default; Commons lists `[identity, wallet, shared]` in that order, the Peable
   wallet `[wallet, shared]`. A test in app-preset pins that no app config but
   those two names the identity or wallet group. All apps stay on one Apple team
   (already a prerequisite).

### Migrating existing items

On the first launch of the Commons build with the new entitlements, for each
row of the table in point 2:

1. read it with an explicit `accessGroup` of the shared group;
2. write it to its new group (and the private keys to the wallet group too);
3. read it back from the new group and check the pair is healthy
   (`_isHealthyPair`, `isHealthyOrganizationKeyPair`) or the phrase derives the
   key;
4. only then delete it from the shared group.

This is the verify-before-delete pattern `_runSlotMigration` already uses; a
failure leaves the item where it is and retries next launch. Step 4 is the one
that closes the exposure. Until it runs, nothing changes for any app.

**Order of releases** (each is a native build, not an OTA update, because
entitlements change):

1. `@oxy.so/core` and `@oxy.so/services` that read the wallet group first and
   fall back to the shared group, and that fall back to the Commons round-trip
   when no shared private key exists. Every app picks it up in its next build.
2. The Peable wallet with the wallet-group entitlement. It must be in users'
   hands before step 3, or a migrated phone has a wallet that cannot find its
   key.
3. Commons with the new entitlements and the migration.
4. A later Commons release that stops falling back to the shared group.

An old build of a sibling app that is never updated keeps the shared-group
entitlement but finds nothing secret there after step 3. It loses silent
sign-in, which is the intended effect.

### Tests and verification

- core: `accessGroup` (not `keychainAccessGroup`) reaches the store for each
  item, with the team-prefixed value; the migration's verify-before-delete
  cases (locked keychain, partial copy, unhealthy pair).
- app-preset: entitlement order and membership per app.
- On devices: a phone with an identity and an organization key upgraded from the
  current Commons; a sibling app (debug build) reading each item before and
  after; Peable deriving the same wallet and signing a social-receive input
  before and after; a key rotation mid-migration (ADR 0002's open item).

## The decision the owner has to write down

- **Take the split** (above), with its cost: one app switch at first sign-in
  in every iOS app but Commons and Peable, three ordered native releases, and
  the team-prefix plumbing. Or
- **Accept the risk**: an ADR stating that on iOS any Oxy app can read the
  identity private keys and recovery phrases of the people and organizations
  using Commons on that phone, and why that is acceptable for mainnet money.

Either way, the misnamed option (point 2) should not stay as it is: the code
reads as if it chooses a group and does not.
