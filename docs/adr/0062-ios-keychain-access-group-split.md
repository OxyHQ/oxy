# ADR 0062 — On iOS only Commons reads identity secrets; the Peable wallet reads the keys it signs with; every other app reads public keys

- Status: accepted, implemented (`@oxy.so/core` 7.29.0, `@oxy.so/services` 14.8.0,
  `@oxy.so/protocol` 1.8.0, `@oxy.so/app-preset` 6.2.0, Commons 1.6.0); the native
  releases are in the order of "Consequences". Amended 2026-11-06 (D6, each app's
  own items in its own group: `@oxy.so/core` 7.31.0, `@oxy.so/services` 14.10.0,
  `@oxy.so/protocol` 1.10.0)
- Date: 2026-11-06
- Decision: the owner (2026-11-06, "Fix F5, F1 and D9"): take the split, not the
  risk, before Peable opens FairCoin mainnet (Peable mainnet-gate finding F5).
- Changes: [0061](0061-organization-identity-key.md) D6 ("on iOS through the
  shared keychain access group"). Builds on [0024](0024-one-oxy-account-root-holders.md)
  (the personal root lives in user-controlled holders) and
  [0029](0029-one-oxy-session.md) D3 (Commons is the one holder of a key; every
  other app signs in through it). Companion: Peable ADR 0002.
- Design and evidence: [docs/identity/ios-keychain-access-groups.md](../identity/ios-keychain-access-groups.md).

## Context

On Android only Commons holds a key, and its identity host answers other apps
with public keys, proofs and the derivations a caller is listed for. On iOS
every Oxy app was in one keychain access group, `group.so.oxy.shared`, and the
explicit group the SDK meant to set was never applied: `@oxy.so/core` passed
`keychainAccessGroup`, a field `expo-secure-store` does not have (its field is
`accessGroup`), behind a hand-written ambient shim that hid the mistake from
`tsc`. So every item Commons wrote landed in its default group, the shared one:
the personal root, its recovery phrase, every organization key and phrase. Any
Oxy iOS app, or a compromised bundle of one, could read them, spend the Peable
wallet and every coin received by `@username` or a merchant the account owns,
and rotate the root (ADR 0024 D8: irreversible).

## Decision

### D1 — Three groups, by what an item is

| Group | Holders | Item class | Contents |
|---|---|---|---|
| `<TEAM>.so.oxy.identity` | Commons only, FIRST in its list | `identity-secret` | personal root (primary, backup, legacy slots), personal and organization phrases, organization index |
| `<TEAM>.so.oxy.wallet` | Commons, the Peable wallet (`to.peable.app`, `.dev`) | `spending-key` | the personal key's shared slot and organization pairs: what `deriveScopedSeed` / `signSocialReceive` read |
| `<TEAM>.group.so.oxy.shared` | every Oxy app | `shared` | the shared public key, the device-session credential |

The class of an item, and so its group, is decided in ONE place,
`keychainGroupFor` in `@oxy.so/core` (`src/utils/keychainAccessGroups.ts`). A
new kind of item picks a class; it does not pick a group.

### D2 — The role comes from the entitlements, the prefix from the keychain

`kSecAttrAccessGroup` must equal an entitlement value exactly, and JavaScript
sees neither the entitlements nor the team prefix `$(AppIdentifierPrefix)`
expands to. The team id is in no config in any repository. So `@oxy.so/services`'
iOS `OxyIdentity` module writes a probe item without a group and reads back the
group it landed in: the app's default group, the first entitlement, prefix
included. From it `resolveKeychainAccess` takes the prefix and the role:
identity group first is Commons (`holder`), wallet group first the Peable wallet
(`wallet`), anything else `member`. A build-time injection was rejected: it needs
the team id in every app config, and a second source of truth for the role that
can disagree with the entitlements that actually decide it.

A native build without the probe (an older binary receiving new JavaScript) is
`ungrouped`: it behaves as before, which is what its entitlements (one shared
group) do anyway.

### D3 — What each role reads and writes

- `member`: no read of an identity secret or a spending key reaches the
  keychain; they answer `null`. In-process proof sign-in
  (`signInWithCommonsIdentity`, `commons-proof-signin`) therefore finds no key
  and falls through to the Commons approval round-trip (ADR 0029). No write of
  either class succeeds (no second holder).
- `wallet`: spending keys and public keys; never a phrase or the root slots.
- `holder`: everything, each written to its group with an explicit
  `accessGroup`, read from its group then from the shared group (the pre-split
  location; dropped in release 4), deleted from both.
- An app's OWN items (session credential, settings, the wallet's imported
  phrases) in Commons and the Peable wallet are written to their default group
  explicitly and read from it first, so the copy written before the split never
  shadows a newer one; every other app's calls are unchanged. *Superseded by D6:
  own items go to the app's own group in every app, and the SDK's session items
  are never read from where another app writes them.*

### D4 — Commons moves the existing items, verify before delete

On the first access in a Commons build with the new entitlements,
`ensureKeychainGroupsMigrated` reads each item from the shared group, writes it
to its group, reads it back (a pair must be healthy, a value byte-identical) and
only then deletes the shared copy. Every identity read and write in Commons
waits for the run, so none interleaves with a copy. A thrown read defers the run
to the next access; a failed copy or delete leaves the item where it is for the
next launch; two different values are both kept (`conflict`: a replaced key can
still receive money); an unhealthy pair is never moved. No interleaving of
crashes and failures loses a value (the test walks every step).

### D5 — The entitlements are policy, checked at prebuild

`@oxy.so/app-preset` keeps the shared group as every app's default. Only
Commons may list `[identity, wallet, shared]` and only the Peable wallet
`[wallet, shared]`, in that order; any other app naming either restricted group,
or a holder putting another group first, fails prebuild (`withOxyKeychain`,
and `withOxyKeychainPolicy` through `withOxyUpdates`, which every app applies).

*Tightened with D6 (security re-review R5-4, app-preset 6.4.0):* the list is
EXACTLY the bundle id's layout, optionally followed by the app's own
`$(AppIdentifierPrefix)<bundle id>`. Since D6 puts each app's items in
`<TEAM>.<bundle id>`, an app listing another app's bundle id would read them, so
any entry outside that list fails prebuild, and every native release (the shared
`android-release.yml`) and this repository's CI run `oxy-check-keychain-entitlements`
over the entitlements an iOS prebuild wrote
([the table](../identity/ios-keychain-access-groups.md#who-may-list-which-group)).

## Consequences

- Every iOS app but Commons and the Peable wallet loses silent sign-in: the first
  sign-in is one visible switch to Commons. A silent per-device sign-in key would
  be a new kind of credential and needs its own ADR.
- The Peable wallet holds private keys, where Android's gets only signatures: one
  app instead of every Oxy app. The phrases never enter its group.
- Anyone with the Apple team's signing identity can still build an app that
  declares any group; that residual risk is the same as Android's (Commons'
  certificate).
- Releases, each a native build (entitlements cannot ship over the air):
  1. the SDK packages above (every app picks them up in its next build);
  2. the Peable wallet with `[wallet, shared]`, in users' hands BEFORE 3, or a
     migrated phone's wallet cannot find its key;
  3. Commons 1.6.0 with the new entitlements and the migration;
  4. a later SDK release that drops the shared-group read fallback.
- ADR 0061 D6 now reads: on iOS through the wallet keychain group, which only
  Commons and the Peable wallet hold.

## Amendment 2026-11-06 — D6: an app's session is its own; the shared session item was a defect

### What was left open

Every Oxy app's SDK keeps its session store under the SAME names —
`oxy.auth.v1` (session id, user id, the holder's `deviceId` + `deviceSecret`),
`oxy.auth.token.v1` (the warm access token),
`oxy.auth.automatic-identity-signin-suppressed.v1` (the explicit sign-out
marker) and, in identity mode, `oxy.identity.pin.v1` — written with no access
group (`@oxy.so/services` `nativeSecureStorage.ts`). On iOS such a write lands
in the app's default group: before this ADR `group.so.oxy.shared` in every app,
and after D3 still in every app but Commons and the Peable wallet. So those apps
read and overwrote ONE session item. An app booted into whichever session
another app (or, before the split, Commons' identity-mode vault) wrote last;
one app's local sign-out cleared the others'; and D3's read fallback (`{}`, every
group) let Commons and the wallet adopt another app's copy.

### Decided: a defect, not single sign-on

The session store is per app everywhere else, and cross-app sign-on has its own,
narrower mechanism:

- Android keeps it in each app's own `expo-secure-store`; the one thing apps
  share is the device-session credential, through the signature-protected
  `OxyDeviceSession` broker. Web keeps it per origin.
- The server gives each app or origin its own holder credential
  (`device_credentials`, [0029](0029-one-oxy-session.md) D2); the code and docs
  call this store per app (`authStore.ts`, `identityPin.ts`,
  `docs/auth/sdk-isolated-oauth-lifecycle.md`).
- The deliberate cross-app join point on iOS is the dedicated device-session
  slot (service `oxy_device_session`, `oxy_shared_device_session_v1`, the shared
  group): only `{deviceId, deviceSecret}`, mirrored only from account mode (the
  vault never publishes, `authStore.ts`), and adopted only after an ordinary mint
  proves it (cold-boot lane 3, `docs/SESSION-ARCHITECTURE.md`).
- The shared `oxy.auth.v1` came from the same default-group mechanism this ADR's
  context describes, not from a design; it carried what the slot deliberately
  does not (the vault's session, the session and user ids, the warm token, the
  pin).

### D6 — Each app's own items live in its own group

- **One more item class, in the one table.** `keychainGroupFor('app')` is
  `app`: `<TEAM>.<bundle id>`, the application identifier. Apple makes every app
  a member of that group whatever `keychain-access-groups` lists, and no other
  app can name it, so no entitlement changes. `@oxy.so/services`' iOS
  `OxyIdentity` module proves it (`keychainApplicationAccessGroup(prefix)`
  writes a probe item there explicitly; `nil` when the keychain refuses it as
  not entitled), `@oxy.so/protocol`'s `loadKeychainApplicationAccessGroup`
  narrows it, and `resolveKeychainAccess` adds it as `appGroup`. A thrown probe
  (before first unlock) is "storage unavailable, retry", never "no app group": a
  process that wrote to the old place while the next read the new one first
  would see a stale value.
- **Placement** (`ownKeychainItemPlan(access, names)`): writes go to the app
  group; reads try it first, then Commons' or the wallet's default group (where
  D3 put their own items; no other app writes its own items there). What else a
  read may reach depends on who writes the NAME (`OwnKeychainItemNames`):
  - `every-oxy-app` (the SDK's session store, `nativeSessionItemNames`): nothing
    else. A copy in the shared group may be another app's session or the vault's,
    and apps still on an older build use it, so it is never read, written or
    deleted. Deletes reach the read locations, earlier ones first.
  - `every-oxy-app-withholding` (the sign-out marker): also the shared group,
    last on read and first on delete. A marker can only keep an app from signing
    in automatically, so honouring another app's is safe, and releasing it
    there is what a release always did.
  - `this-app` (names only one app uses: the Peable wallet's own items): every
    group, as before.
- **Migration: nothing is copied or deleted.** Commons and the wallet read their
  D3 copy until their next write lands in the app group, which the read order
  then prefers. Every other app finds no session of its own at the first launch
  of a fixed build and its cold boot joins the device through the dedicated slot
  (adopt, then a mint the server must accept): silent on any phone where an
  account-mode app has saved a session since the slot shipped (#965,
  2026-08-11), because every such save mirrors into the slot. With an empty slot
  the old shared item can only be the vault's or a pre-#965 build's; that app
  shows signed out and the person signs in once through Commons (the one app
  switch D3 already gives every app but Commons and the wallet). No app adopts
  another app's session item, and a crash or failure at any step leaves the
  value the app had (`ownSessionItems.test.ts`).
- **Builds.** The probe is native, so D6 reaches each app with its next native
  build. Until then a binary without the probe keeps its items where that build
  put them: every app but Commons and the wallet the one shared item (the
  defect, unchanged), Commons and the wallet their default group (no longer the
  `{}` fallback). Android and web are unchanged.
- **Left in the shared group** while older builds exist: their `oxy.auth.v1`,
  warm token and pin. They hold a device credential every Oxy app can read, the
  same exposure as the dedicated slot. A later release deletes them, with D3's
  release 4.

