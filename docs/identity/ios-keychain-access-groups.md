# iOS: who can read identity private keys (keychain access-group split)

> Status: **decided and implemented** ([ADR 0062](../adr/0062-ios-keychain-access-group-split.md)).
> The owner took the split on 2026-11-06 ("Fix F5, F1 and D9") instead of
> accepting the risk. Written 2026-11-06 after an independent security review
> refused Peable mainnet partly on this point (finding F5); "As implemented"
> below records what shipped and what still needs a device. The analysis that
> follows describes the code BEFORE the split.
>
> Related: [Root holders, enrollment and recovery](holders-and-recovery.md) ·
> [Organization identity keys](organization-keys.md) (ADR 0061 D6) ·
> [Phase 2: every Android app on its own UID](phase-2-shared-uid-migration.md) ·
> Peable ADR 0002.

## Who may list which group

Since `@oxy.so/app-preset` 6.4.0 an app's `keychain-access-groups` is EXACTLY
the list for its bundle id, in this order (the first entry is the default
group, from which `@oxy.so/core` reads the app's role):

| Bundle id | `keychain-access-groups` |
|---|---|
| `so.oxy.commons` | `$(AppIdentifierPrefix)so.oxy.identity`, `$(AppIdentifierPrefix)so.oxy.wallet`, `$(AppIdentifierPrefix)group.so.oxy.shared` |
| `so.oxy.commons.dev` | `$(AppIdentifierPrefix)so.oxy.identity.dev`, `$(AppIdentifierPrefix)so.oxy.wallet.dev`, `$(AppIdentifierPrefix)group.so.oxy.shared` |
| `to.peable.app` | `$(AppIdentifierPrefix)so.oxy.wallet`, `$(AppIdentifierPrefix)group.so.oxy.shared` |
| `to.peable.app.dev` | `$(AppIdentifierPrefix)so.oxy.wallet.dev`, `$(AppIdentifierPrefix)group.so.oxy.shared` |
| every other app | `$(AppIdentifierPrefix)group.so.oxy.shared` |

- Each list may end with the app's OWN application group,
  `$(AppIdentifierPrefix)<its own bundle id>`, which Apple grants it anyway.
- A holder (Commons, the Peable wallet) may still list the shared group alone:
  its build before the split, which can read nothing secret.
- Nothing else. In particular never another app's bundle id
  (`$(AppIdentifierPrefix)to.peable.app` in Mention, `so.oxy.commons` in a
  sibling, `to.peable.app.dev` anywhere but that build): `<TEAM>.<bundle id>`
  is that app's private group, where its session and its own items live
  (ADR 0062 D6), and every app of the team may list any of the team's groups.
- Each entry is spelled exactly as above; another spelling of an allowed group
  (`$(TeamIdentifierPrefix)…`, a literal team id, other case, whitespace) is
  refused, and so is an entry with a build variable or a wildcard after its
  prefix.

Where it is checked:

- **At prebuild**, by the preset's config plugin: `withOxyKeychain` (the
  `['@oxy.so/app-preset', {}]` plugin) writes the list, and
  `withOxyKeychainPolicy`, applied by `withOxyUpdates` (every Oxy app), checks
  an app's own `ios.entitlements` and the final entitlements. A refused list
  fails `expo prebuild` (and `expo config`) with an
  `[@oxy.so/app-preset] … may not list …` or `… must list its keychain access
  groups as exactly …` error.
- **In release CI**: the shared native release workflow
  (`.github/workflows/android-release.yml`, every Oxy app's signed release)
  prebuilds iOS on the same commit and runs `oxy-check-keychain-entitlements
  <bundle id> ios` over what was written; it fails the release when the app's
  `@oxy.so/app-preset` is older than 6.4.0.
- **On pull requests and in the merge queue** of this repository: the
  `android-kotlin` job of `ci.yml` prebuilds Commons and Accounts for iOS, both
  variants, and runs the same checker (scoped to changes of their app configs,
  app-preset's plugins and checker, and the native plugins; always in the
  queue). The scaffold smoke (`scaffold-smoke.yml`) does the same for a
  `create-oxy-app` app.
- **Codesigned output**: `oxy-check-keychain-entitlements <bundle id>
  <entitlements file> --team-id <TEAMID>` over `codesign -d --entitlements -
  --xml <app>`.

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

## As implemented

- **One table, one helper.** `@oxy.so/core` `src/utils/keychainAccessGroups.ts`:
  `keychainGroupFor(item)` maps an item class to its group —
  `identity-secret` → identity, `spending-key` → wallet, `shared` → shared;
  `mayHoldKeychainItem(role, item)`, `keychainReadPlan` (its group, then the
  shared group until release 4), `keychainWriteOption` (throws for a role that
  may not hold the item), `keychainDeletePlan`, `groupedKeychainStore(store,
  access, item)` (the wrapper KeyManager and `organizationKeys` use), and
  `ownKeychainItemPlan` for an app's own items. Item names live in
  `src/crypto/keychainItems.ts`.
- **A money holder derives its public key (R5-1, core 7.33.0).** The shared
  group's public-key item is writable by every Oxy app, so Commons and the
  Peable wallet never take their identity public key from it:
  `KeyManager.getIdentityPublicKeyForMoney({ accountId? })` (and
  `getSharedPublicKey` in those two apps) derives it from the private key in
  the restricted groups — the key the wallet actually spends.
- **The personal retired ring is bound to its owner (R5-2, core 7.33.0).** Each
  personal entry records the account id of the person whose key it was; every
  reader names `ownerAccountId` and reaches only that person's entries. An
  entry with no known owner is quarantined until that account's key history
  claims it (`claimRetiredIdentityKeys`). On Android the identity host holds
  only the signed-in person's personal entries (`syncRetiredKeys(owner)`;
  "Start over" withdraws them all).
- **Retired keys are spending keys.** The keys a person or an organization
  rotated away from (ADR 0061 D7 as amended 2026-11-06, `crypto/retiredKeys.ts`,
  `oxy_retired_identity_private_key.<scope>.<publicKey>` and the ring's index
  `oxy_retired_identity_index_v1`) are `spending-key` items: the wallet group,
  written by Commons only, read by Commons and the Peable wallet. They are new
  items, so the migration has nothing to move for them.
- **Team prefix and role: discovered, not injected.** No app config in any repo
  carries the team id, and the role must not have a second source that can
  disagree with the entitlements. `@oxy.so/services`' iOS `OxyIdentity` module
  answers `keychainDefaultAccessGroup()`: it deletes its probe item
  (`so.oxy.keychain-probe`, account = bundle id) in every group, adds it without
  a group, and returns the `kSecAttrAccessGroup` the keychain reports — the
  default group, prefix included. `@oxy.so/protocol`'s
  `loadKeychainDefaultAccessGroup()` narrows it; core's
  `resolveKeychainAccess()` memoizes `{ prefix, defaultGroup, role }`. A native
  module without the probe is `ungrouped` (the old behaviour); a thrown probe
  (before first unlock) is retried and reads as "storage unavailable".
- **Option names are checked.** Both ambient `expo-secure-store` shims are
  deleted; `crypto/secureStoreOptions.ts` fails `tsc` on a field
  `SecureStoreOptions` does not have, without naming expo-secure-store in the
  published declarations.
- **Roles.** `member`: identity-secret and spending-key reads answer `null` with
  no keychain call; `hasSharedIdentity()` is false, so `signInWithCommonsIdentity`
  returns `null` and the account dialog continues to the Commons round-trip
  (`signInWithOxy` → `startDeviceFlowSession`). `wallet`: spending keys and
  public keys. `holder`: all, written with explicit groups.
- **The migration** is `ensureKeychainGroupsMigrated()`
  (`src/crypto/keychainGroupMigration.ts`), awaited by every KeyManager,
  organization-key and retired-ring access in Commons. It is ONE-SHOT and
  adopts only what Commons provably wrote (round-4 review R4-6, R4-7): every
  Oxy app can write the shared group and keychain items survive an uninstall,
  so a personal key there is adopted only when it is the key Commons' sandbox
  identity marker records (a phrase only when it derives it), and organization
  items only on such a proven device. A device without the marker (a fresh
  install, a reinstall) adopts nothing from the shared group. On a proven
  device a shared copy that is a valid key but not the one kept is retired into
  the ring, read back, and only then deleted. A settled run writes a completion
  record (identity group) and its mirror (wallet group); from then on no secret
  read falls back to the shared group (Commons never; the Peable wallet once it
  has seen the mirror), and every Commons secret write deletes the item's
  shared copy. Outcomes per unit: `absent`, `moved`, `retired`, `discarded`,
  `failed` (retried next launch, no record), `deferred` (locked). The record
  also notes whether the current personal key sat in the shared group
  (`getPreSplitExposure()`): Commons then recommends, never forces, a
  rotation while that key is current.
- **App items.** `@oxy.so/services`' native SecureStore adapter and Peable's
  `kv-store` write an app's own items to its default group explicitly and read
  it first in Commons and the Peable wallet, because the split changed their
  default group; Peable also moves its wallet items out of the shared group.
- **App items** (ADR 0062 D6, amended the same day). Every app's own items go
  to its own group, `<TEAM>.<bundle id>` (item class `app`): the application
  identifier, which Apple makes every app a member of and no other app can
  name, proven by a second probe (`keychainApplicationAccessGroup`, probe
  account `<bundle id>.application-group`). The SDK's session store
  (`oxy.auth.v1`, `oxy.auth.token.v1`, the sign-out marker, the identity pin)
  is the SAME name in every app, and before D6 every app but Commons and the
  wallet shared ONE copy of it in the shared group (and before the split, with
  Commons' vault): `@oxy.so/services`' adapter now reads it from the app group,
  then Commons' or the wallet's default group, and never from the shared group,
  except the sign-out marker, which can only withhold. Cross-app sign-on stays
  where it was designed: the dedicated device-session slot, adopted only after a
  mint. Peable's `kv-store` (names only Peable uses) writes to the app group
  and still finds earlier copies in any group. A build without the second probe
  keeps the placement it had.
- **Entitlements.** `@oxy.so/app-preset` (`plugin/oxyKeychainGroups.js`) holds
  the policy; `withOxyKeychain` writes it, and `withOxyKeychainPolicy` (applied
  by `withOxyUpdates`) checks apps that declare `ios.entitlements` themselves.
  Since 6.3.0 every entry is normalised before it is judged (leading build
  variables, a leading team id, whitespace and case), and a restricted group
  must be spelled exactly `$(AppIdentifierPrefix)<group>`, so no other
  spelling reaches a restricted group. Since 6.4.0 (security re-review R5-4)
  the list is the bundle id's EXACT layout, optionally followed by the app's
  own application group; any other entry, another app's bundle id above all,
  fails prebuild ("Who may list which group" above). The dev builds (`so.oxy.commons.dev`,
  `to.peable.app.dev`) hold `so.oxy.identity.dev` / `so.oxy.wallet.dev`, never
  the production groups, because they sit beside the production apps under the
  same team and run JavaScript from a dev server. `oxy-check-keychain-entitlements
  <bundle-id> <ios-dir-or-file> [--team-id <TEAMID>]` runs the same policy over
  the entitlements a prebuild or a codesign actually wrote (every native
  release, this repository's CI for Commons and Accounts, and the scaffold
  smoke run it after an iOS prebuild).
- **Android is unchanged**: `resolveKeychainAccess()` is `ungrouped` there and
  every call is the call it was; the identity host already narrows.

### Verified in CI, and what needs a device

Covered by tests: `accessGroup` (never `keychainAccessGroup`) with the
team-prefixed value for every item (core `keychainAccessGroups.test.ts`,
services `sharedDeviceCredentialStore.test.ts`); each role's reads; the
migration from a keychain written by the pre-split code, the locked keychain,
a failed copy, a copy that reads back wrong, an unhealthy pair, two differing
keys, merged indexes, and a crash or a single failure at EVERY mutation of a run
(each value keeps a copy, no copy changes, the next launch completes); the
entitlement policy and order (app-preset `withOxyKeychain.test.js`). D6: core
`ownSessionItems.test.ts` (several apps on one keychain: each keeps, overwrites
and clears only its own session; none adopts the shared copy, which an older
build keeps using; Commons and the wallet keep their D3 copy; the marker only
withholds; a crash or failure at every mutation of save-then-sign-out never
yields another app's session, never drops a session on a failed save and never
brings back an older one on a failed sign-out), services
`nativeSecureStorage.test.ts`, protocol `keychainDefaultAccessGroup.test.ts`.

Not verifiable off a device (owner steps):

1. The Swift probe compiles and returns `<TEAM>.so.oxy.identity` in Commons,
   `<TEAM>.so.oxy.wallet` in Peable, `<TEAM>.group.so.oxy.shared` elsewhere.
2. A phone with an identity and an organization key, upgraded from Commons
   1.5.0: after 1.6.0's first launch a debug sibling app reading
   `oxy_identity_mnemonic_v1` (service `oxy_identity_mnemonic`), the v2 primary,
   the shared-slot private key and an organization key gets nothing; before it,
   the phrase (the confirmation point 2 asked for).
3. Peable derives the same wallet and signs a social-receive input before and
   after that upgrade, for the person and an organization.
4. A key rotation in Commons while the migration is mid-way (kill the app during
   first launch, rotate on the next).
5. A sibling app signs in through the Commons round-trip (one app switch).
6. (D6) The application-group probe answers `<TEAM>.<bundle id>` in Commons, the
   Peable wallet and a member app (a `nil` answer means the keychain refused the
   implicit group: the app keeps its earlier placement, and D6 needs the group
   listed in `keychain-access-groups`).
7. (D6) Two member apps signed in to different accounts on one phone, after
   their fixed builds: each cold-starts into its own account, and signing out of
   one leaves the other signed in. An app upgraded from a build that shared the
   item restarts signed in (through the device-session slot), and a debug read
   of `oxy.auth.v1` with the shared group's `accessGroup` still returns the
   older build's copy, untouched.

## What the split would take

(The design as proposed; "As implemented" above is what shipped.)

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

## The decision (taken: the split, ADR 0062)

- **Take the split** (above), with its cost: one app switch at first sign-in
  in every iOS app but Commons and Peable, three ordered native releases, and
  the team-prefix plumbing. Or
- **Accept the risk**: an ADR stating that on iOS any Oxy app can read the
  identity private keys and recovery phrases of the people and organizations
  using Commons on that phone, and why that is acceptable for mainnet money.

Either way, the misnamed option (point 2) should not stay as it is: the code
reads as if it chooses a group and does not.
