# Organization identity keys

> The living record for [ADR 0061](../adr/0061-organization-identity-key.md). The
> ADR says why; this page says what exists and how to call it. Update it when the
> code changes.
>
> Code: `packages/api/src/services/organizationIdentityKey.service.ts` (the one
> writer), `routes/organizationIdentityKey.ts`, `db/schema/organizationIdentityKeys.ts`
> · contracts `packages/contracts/src/organizationIdentityKey.ts` · SDK
> `oxy.accounts.identityKey` (`packages/core/src/api/accounts.ts`) · device
> `packages/core/src/crypto/organizationKeys.ts` · Commons
> `app/(tabs)/(settings)/organization-wallets/`.
>
> Related: [Root holders, enrollment and recovery](holders-and-recovery.md) ·
> [Organization directory](organization-directory.md) · Peable ADR 0002.

An organization can have its own secp256k1 identity key. Its DID publishes it as
`#key-1`, and Peable derives the organization's FairCoin receive addresses from
it, exactly as it does a person's: a merchant's FairCoin goes to the wallet of the
account that owns the merchant's application. The private key and its 24-word
phrase exist only on the devices of the owners and admins who hold them, in
Commons; Oxy and Peable never see either.

## What it is, and what it is not

| | Organization key | Personal root |
|---|---|---|
| Who | a claimed, active `organization` with no closure fence | a `personal` account |
| Stored | `users.public_key` of the organization + a row in `organization_identity_keys` | `users.public_key` + the `identity` auth method |
| DID | `#key-1`, controller the organization's DID | `#key-1`, controller the person's DID |
| Signs in | **never**: `POST /auth/challenge`, `/auth/verify`, the signed approval of an auth session and `/auth/rotate/*` refuse a non-personal account | yes, with Commons |
| Created by | an owner or admin, from Commons | the person, in Commons |
| Replaced by | any owner or admin, **with or without** the current key | the person, with the current key (`/auth/rotate/*`) |
| Reused | never: every key it ever had stays in `organization_identity_keys`, and no account (personal or organization) may take one | — |

An organization without a key has a DID with no `#key-1`: Peable cannot derive an
address for it, and must say "no wallet yet" rather than use another key.

## Who may

The signed-in person's **effective role** over the organization (a membership of
it, or of an ancestor that is inherited, active) must be `owner` or `admin`. The
role decides; per-member permission grants and revokes do not (ADR 0056). Every
read and write checks it again; a write checks it under lock in its own
transaction. Anyone else gets `403 ORGANIZATION_KEY_FORBIDDEN`, including for an
unclaimed, suppressed, archived or non-organization account.

Signing a change also needs the person's **own root**: only a Commons account can
create or replace an organization key (`403 ORGANIZATION_KEY_ACTOR_ROOT_REQUIRED`
otherwise). Reading does not.

## Routes

All three need a first-party bearer (`requireFirstPartyDeviceAccess`).

| Route | Answer |
|---|---|
| `GET /accounts/:id/identity-key` | `OrganizationIdentityKeyState`: `{ accountId, publicKey \| null, keys: [{ publicKey, method, linkedByUserId, previousKeyProven, linkedAt, retiredAt }] }`, oldest first |
| `POST /accounts/:id/identity-key/challenge` `{ operation: 'create' \| 'replace', publicKey }` | `OrganizationKeyChallenge`: the one-use challenge (5 minutes) and every claim to sign |
| `POST /accounts/:id/identity-key` `{ operation, publicKey, challenge, expiresAt, actorSignature, keySignature, previousKeySignature? }` | the new `OrganizationIdentityKeyState` |

Refusals besides the two 403s: `409 IDENTITY_ROOT_ALREADY_LINKED` (`create` on an
organization with a key), `409 ORGANIZATION_KEY_MISSING` (`replace` without one),
`409 IDENTITY_ROOT_LINKED_ELSEWHERE` (a key another account holds),
`409 ORGANIZATION_KEY_USED` (a key this or another organization ever had),
`401 IDENTITY_PROOF_INVALID` (a signature, the challenge or its expiry).

## The proof

One identity-proof ceremony (ADR 0024 D7, `buildIdentityProofMessage`), with
`action` `organization_key_create` or `organization_key_replace`, `subject` the
organization, `actor` the person and `payloadDigest` the SHA-256 of
`canonicalJson(organizationKeyPayload({ operation, accountId, publicKey, previousPublicKey }))`.
Up to three signatures over those claims, which differ only in `rootPublicKey`:

1. `actorSignature` — the person's own root;
2. `keySignature` — the new key (possession);
3. `previousKeySignature` — the current key, optional, for `replace`; recorded as
   `previousKeyProven`.

`organizationKeyProofClaims(challenge, signerPublicKey)` builds the claims for one
signer. The new and current key signatures are checked first; the actor's spends
the challenge; the key, its history row, the burn and a `security_activities`
row for the organization commit in one transaction.

## SDK

```ts
// Anyone may read the organization's DID; owners and admins read the state:
const state = await oxy.accounts.identityKey.get(orgId);
if (state.publicKey === null) {
  // "Set up the organization's Peable wallet"
}

// Commons (native only): the device's personal root is the actor.
await oxy.accounts.identityKey.link(orgId, {
  operation: 'create',            // or 'replace'
  key: { privateKey, publicKey }, // the new organization key, on this device
  previousKey,                    // the current one, when this device holds it
});
```

`requestChallenge` and `apply` are the two halves of `link`, for a signer that is
not `KeyManager`.

## On the device

The key lives in Commons, beside the person's own root (ADR 0061 D6), from
`@oxy.so/core/crypto` (`crypto/organizationKeys.ts`):

| Function | Who | What |
|---|---|---|
| `generateOrganizationKey()` | Commons | a fresh 24-word phrase and its `seed[0:32]` pair; stores nothing |
| `organizationKeyFromPhrase(phrase)` | Commons | the pair a 24-word phrase derives; stores nothing |
| `storeOrganizationKey(accountId, { privateKey, publicKey, mnemonic? })` | Commons | keep it: iOS the wallet keychain group (pair) and the identity group (phrase, index), ADR 0062; Android Commons' own slot plus the identity host's signer store |
| `getOrganizationPublicKey(accountId)` | any Oxy app | the key this device can reach, or `null` (Android outside Commons: Commons' identity host, `describe` with `accountId`) |
| `getOrganizationPrivateKey(accountId)` | Commons, iOS group | for signing in the app; `null` on Android outside Commons |
| `getOrganizationRecoveryPhrase(accountId)`, `listOrganizationKeys()`, `deleteOrganizationKey(accountId)` | Commons | |
| `KeyManager.deriveScopedSeed(info, { accountId })`, `KeyManager.signSocialReceive(index, digest, { accountId })` | the wallet | the organization's derivations, exactly as the personal ones; `null` when this device cannot reach that organization's key, never the personal key instead |

On Android the identity host answers an organization only when the request
carries `accountId` and only when its answer echoes it, so an older Commons that
ignores the extra can never hand back the personal key for an organization. It
refuses `proveIdentity` for an organization: the key signs nobody in.

## In Commons

Settings → **Organizations** → **Organization wallets** lists every organization
the person owns or administers, each with where its wallet stands:

- **No wallet yet** → the organization's screen says "Set up the organization's
  Peable wallet" → **Set up the wallet** → reveal and write down the 24 words →
  tick "I wrote down the 24 words…" → **Continue** → **Create the organization's
  key** → the device's biometric or passcode. The key is linked first and kept on
  the phone only after Oxy took it.
- **Wallet set up on another phone** → **Add the key you were given** → type the
  24 words the person who set it up gave you → **Add the key**. Commons checks the
  phrase derives the organization's current `#key-1` and sends nothing. A phrase
  of one of the organization's REPLACED keys (`keys[].retiredAt` set) is kept as
  a previous key instead, for spending only; any other phrase is refused.
- **Wallet key on this phone** → **Show the recovery phrase** (to hand it to
  another owner or admin, in person) or **Replace the key**.
- **Replace the key** (also from "another phone" and "old key") → a new phrase →
  "The current key stays with the funds" and its checkbox → **Replace the
  organization's key**. When this phone holds the current key it is first kept
  in the retired ring (the replacement stops if it cannot be), and it signs too.

## Replacing a key, and the money

Replacing the key does not move funds (Peable ADR 0002): addresses already
reserved derive from the key they were reserved against, and coins keep arriving
under a replaced key after the replacement (broadcast payments settle, late
payers and `@username` senders hold its addresses). So the replaced key is kept,
for spending only (ADR 0061 D7 as amended 2026-11-06):

- Commons keeps it in the organization's retired ring (`@oxy.so/core`
  `crypto/retiredKeys.ts`) before replacing, and a phone holding a key another
  owner replaced moves it there the next time it reads the organization;
- a phone without it adds the replaced key's phrase as a previous key, checked
  against `keys`;
- Peable reaches it with `deriveScopedSeed` / `signSocialReceive` and the
  `publicKey` selector (Android: the identity host's `keyPublicKey` extra and
  `listRetiredKeys`, wallet only), shows the coins as spendable and offers to
  move them to the current key; a key it cannot read now throws
  `IdentityUnavailableError` (never `null`, R7-4);
- a retired key never signs anyone in, never takes a new reservation and is
  never the current key again;
- when a holder leaves or the phrase may be exposed, replace the key and move the
  funds at once: the retired key is still theirs too, and the move races them;
- a wallet compares the device's key with the DID's `#key-1` and stops offering
  to receive on a mismatch, and reads `keys` to know which keys were the
  organization's.

## Not verifiable from source

- That the people holding the phrase are the ones the organization intends; Oxy
  is not told who holds it (ADR 0061 D5).
