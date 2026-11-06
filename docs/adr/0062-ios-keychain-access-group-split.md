# ADR 0062 — On iOS only Commons reads identity secrets; the Peable wallet reads the keys it signs with; every other app reads public keys

- Status: accepted, implemented (`@oxy.so/core` 7.29.0, `@oxy.so/services` 14.8.0,
  `@oxy.so/protocol` 1.8.0, `@oxy.so/app-preset` 6.2.0, Commons 1.6.0); the native
  releases are in the order of "Consequences"
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
  shadows a newer one; every other app's calls are unchanged.

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
