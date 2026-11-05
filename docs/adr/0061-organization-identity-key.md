# ADR 0061 — An organization has its own identity key, created and held in Commons by its owners and admins

- Status: accepted
- Date: 2026-11-06
- Decision: the owner (2026-11-06): organization accounts get a Peable wallet.
  Peable receives FairCoin for a merchant into the wallet of the Oxy account that
  owns the merchant's application, person or organization, derived from that
  account's DID `#key-1`.
- Amends: [0024](0024-one-oxy-account-root-holders.md) D8 ("only a personal
  account has a root") for organizations only. Builds on
  [0001](0001-multi-principal-device-model.md) (a principal is always a human),
  [0029](0029-one-oxy-session.md) D3 (Commons is the one holder of a key),
  [0032](0032-autonomous-account-agent-keys.md) (governance of a non-personal
  account's key by its owners and admins),
  [0039](0039-canonical-organization-directory.md) (claimed organizations) and
  [0056](0056-first-party-operator-authority.md) (authority follows the role).
- Companion: Peable ADR 0002 (social receive is bound to one identity key).

## Context

Peable derives a person's receive addresses from the secp256k1 key their DID
publishes as `#key-1` (Peable `services/socialReceive.ts`,
`resolveIdentityPublicKey` over `oxy.identity.resolveDid`, then
`deriveSocialReceiveAddress` from `@fairco.in/core`), and the person's wallet
derives the same tree from the private half (`KeyManager.deriveScopedSeed`,
`signSocialReceive`). The owner decided that a merchant's FairCoin goes to the
wallet of the account that owns the merchant's application. Today that account
is an organization for both live first-party merchants (Oxy Central Billing and
Mercaria, owned by the `oxy` organization), and no organization can have a key:

- `linkRootToAccount` and `mintIdentityProofChallenge`
  (`packages/api/src/services/identityLink.service.ts`,
  `identityProof.service.ts`) refuse `kind !== 'personal'` with
  `NOT_PERSONAL` ("Only a personal account has a root").
- Production holds 482 organization accounts and none has a `public_key`
  (read-only probe, 2026-11-06).

The DID builder already publishes `users.public_key` as `#key-1` for any account
(`services/did.service.ts`, `collectIdentityKeys`), so the missing piece is not
the document: it is who may create an organization's key, where the private half
lives, how a second person gets it, and what happens when people leave.

What the code supports today for moving key material between devices
(evidence for D5):

- Commons is the one holder of a key; the web envelope, its moves and its
  holder transfers were deleted (ADR 0029 D3;
  `docs/identity/holders-and-recovery.md`: "no envelope, no web phrase, no PRF,
  no move").
- A link request (`identity_link_requests`, `routes/identityLink.ts`) relays a
  root PROOF from Commons to a signed-in app; it never carries key material.
- The encrypted backup (`routes/identityBackup.ts`) is keyed by a locator
  derived from the seed itself, so only someone who already has the phrase can
  restore it. Block Store (`docs/identity/device-backup.md`) restores the same
  Commons install's key to the same Google account; it shares nothing.
- The Android identity host (`modules/oxy-identity-host`,
  `OxyIdentityHostProvider.kt`) never returns a private key: other apps get
  signatures and derivations.
- Agent keys (ADR 0032) are per-bot runtime keys held by an injected signer;
  there is no per-device delegation of a human-held key.
- The one path by which a key enters a device from outside is its recovery
  phrase (or raw key) typed into Commons (`app/(auth)/import-identity/`).

So nothing shares a key between people's devices except its phrase.

## Decision

### D1 — Only an organization gets an organization key

The kind is `organization`, active, claimed in the directory (ADR 0039), with no
closure fence. Projects, channels and bots do not (a bot authenticates with
agent keys, ADR 0032). A personal root keeps ADR 0024 unchanged.

### D2 — The key is the organization's `#key-1`, and it is not a way to sign in

The key is a secp256k1 key from a fresh 24-word BIP-39 phrase, `seed[0:32]`,
exactly as a personal root. It is stored as the organization's
`users.public_key` (so the DID, the global uniqueness index on
`lower(btrim(public_key))` and Peable's resolver need no change) and recorded in
`organization_identity_keys`, the key's history: one row per key with who
linked it, how, and when it was retired. A retired key stays there forever and
is refused for any account, personal or organization, so an old key can never
come back as someone else's address tree.

The organization key authenticates nobody. No `identity` auth method row is
written for it, and every key sign-in (`POST /auth/verify`, the signed approval
of an auth session, `/auth/rotate/*`, `/auth/link`) refuses a non-personal
account. An organization is still reached only through a person's membership
(ADR 0001: a principal is a human); holding the organization's phrase gives
spending power over its FairCoin and nothing inside Oxy.

### D3 — Owners and admins, by role

Creating, replacing and reading the organization's key status is for a person
whose effective role over the organization (membership of it or of an ancestor,
active, ADR 0056) is `owner` or `admin`. The role decides, not per-member
permission deltas, and nothing is granted per person: giving someone the power
is giving them the role. The membership is read again under lock in the
transaction that writes the key.

### D4 — One challenge, three signatures, from Commons

`POST /accounts/:id/identity-key/challenge` mints a one-use challenge bound to
the organization, the actor, the operation (`create` or `replace`), the new
public key and the key it replaces. `POST /accounts/:id/identity-key` spends it
in the transaction that writes the key, and requires:

1. the actor's OWN personal root signature over the claims: the person, not
   just their session (Commons holds that root; an account without one cannot
   do this);
2. the new key's signature over the same claims (possession);
3. for `replace`, the current key's signature when the device has it. It is
   optional (D7) and the history records whether it was given.

The bytes are `buildOrganizationKeyProofMessage` in `@oxy.so/contracts`, shared
by client and server. The write, the history row, the challenge burn and a
`security_activities` row for the organization commit together.

### D5 — The phrase is how a second owner gets the key

Commons creates the key on an owner's or admin's device and shows its phrase
once, to be written down and confirmed, as for a personal account. Another owner
or admin adds the same key to their Commons by entering that phrase (Commons
first checks that it derives the organization's current `#key-1`, and refuses
it otherwise). Oxy and Peable never see the phrase or the private key, and are
not told who holds it.

This is the simplest sound approach the code supports: nothing else moves key
material between people (Context). What it costs:

- The phrase is a bearer secret over every coin the key has received or will
  receive. Each copy is permanent; Oxy cannot list, count or revoke holders.
- Membership gates changing the key, not spending with it. Removing someone from
  the organization does not take the phrase away: the remedy is D7, replacing
  the key, and moving the funds while the key is still held.
- A written phrase passed between people is the weakest point. Commons shows it
  only to an owner or admin, on the device that created or holds it.

A device-to-device encrypted transfer (an ECDH channel between two Commons with
a short comparison code, as `deriveIdentityLinkCode` does for link requests)
would remove the typing but not the cost: it is still a copy of one key. It is
not built, and is a later decision.

### D6 — Where the key lives on a device

Commons stores each organization key under the organization's id beside the
personal root, with the same protection. Other Oxy apps reach an organization
key exactly as they reach the personal one, by derivation, never by the key:
`KeyManager.deriveScopedSeed(info, { accountId })` and
`signSocialReceive(index, digest, { accountId })` — on Android through the
Commons identity host with an `accountId` extra, under the same caller policy
(the wallet only), on iOS through the shared keychain access group.

### D7 — Replacing the key, and what happens to the money

Any owner or admin may replace the organization's key with a new one created in
Commons, with or without the current key. Unlike a personal root (ADR 0024 D8),
the organization's authority is its roles, not its key: Oxy already decides who
acts as the organization, so letting its owners replace a lost key makes Oxy no
more a custodian than it is. This is the recovery path when the only holder
loses the phrase or leaves.

Replacing the key does not move money, following Peable ADR 0002:

- Every address already reserved derives from the key it was reserved against
  (Peable records it on the cursor). New reservations use the new `#key-1`.
- Coins received under the previous key are spendable only with the previous
  key. Oxy and Peable cannot move them.
- When a holder leaves the organization the owners must replace the key. A
  voluntary replacement should move the funds first while the key is held.
- The wallet keeps the previous key while its addresses hold coins and keeps
  watching them; it compares the device's key with the DID's `#key-1` and stops
  offering to receive on a mismatch (ADR 0002); it reads the key history
  (`GET /accounts/:id/identity-key`) to know which keys were the organization's.

### D8 — A keyless organization

Its DID lists no `#key-1` (Oxy is its controller, as for every account without
a key), so Peable cannot derive an address and must say that the organization
has no wallet yet rather than fall back to another key (an owner's personal key
is not the organization's). `GET /accounts/:id/identity-key` answers
`publicKey: null` to its owners and admins, and Commons shows them "Set up the
organization's Peable wallet".

A DID with an organization key lists the organization's DID as its controller
and the key as `#key-1`.

## Rejected alternatives

- **Use an owner's personal key.** Funds follow a person, not the organization,
  and leave with them.
- **Oxy or Peable holds the organization key** (KMS, escrow, a server-side
  wallet). It makes Oxy a custodian of the organization's funds, which ADR 0024
  and Peable's non-custody rule refuse.
- **A key per holder, multisig.** Peable's social receive derives from one key
  (`deriveSocialReceiveAddress`); a multi-key tree is a Peable and FairCoin
  protocol change, not this decision.
- **Require the current key to replace it.** It is the personal rule, and for an
  organization it turns one lost phrase or one departed holder into an
  organization that can never receive again.
- **Let the organization key sign in as the organization.** It would make a
  phrase-holder a principal without membership, which ADR 0001 forbids.

## Consequences

- An organization can receive FairCoin through Peable once an owner or admin
  creates its key in Commons.
- Funds received under a replaced key are not recovered by anything here.
- `organization_identity_keys` and the new challenge rows are an additive
  pre-deploy migration.
