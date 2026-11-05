# Organization identity keys

> The living record for [ADR 0061](../adr/0061-organization-identity-key.md). The
> ADR says why; this page says what exists and how to call it. Update it when the
> code changes.
>
> Code: `packages/api/src/services/organizationIdentityKey.service.ts` (the one
> writer), `routes/organizationIdentityKey.ts`, `db/schema/organizationIdentityKeys.ts`
> · contracts `packages/contracts/src/organizationIdentityKey.ts` · SDK
> `oxy.accounts.identityKey` (`packages/core/src/api/accounts.ts`).
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

## Replacing a key, and the money

Replacing the key does not move funds (Peable ADR 0002): addresses already
reserved derive from the key they were reserved against, and coins received under
a replaced key are spendable only with that key. So:

- when a holder leaves the organization, an owner or admin replaces the key;
- before a voluntary replacement, the holder moves the funds while the key is held;
- a wallet keeps a replaced key while its addresses hold coins, compares the
  device's key with the DID's `#key-1` and stops offering to receive on a mismatch,
  and reads `keys` to know which keys were the organization's.

## Not verifiable from source

- That the people holding the phrase are the ones the organization intends; Oxy
  is not told who holds it (ADR 0061 D5).
