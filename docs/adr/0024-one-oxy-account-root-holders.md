# 0024 — One Oxy account: `auth.oxy.so` is the web entry, the root lives in user-controlled holders

- Status: accepted
- Issue: #1302 (coordinates with #937, #691, #1288–#1296, #1301)
- Scope: web sign-in and account creation, the personal identity root, the web
  holder (`packages/id`), the identity envelope and move APIs, root link/unlink/
  rotation, the DID document, the SDK account dialog
- Supersedes, in part: `docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md`
  (§3.1 "a user-facing identity origin", §5 "moving is the only operation",
  decision D2 "block a second session until the phrase is confirmed",
  and the `{action,userId,timestamp}` proof format)

## Context

The September 15 design gave every account a self-custody secp256k1 root and a
second carrier for it: a browser envelope sealed under a passkey's WebAuthn PRF
output, on an isolated origin, `id.oxy.so`. That work shipped (#1289–#1296) and
the non-custodial core is sound: the server stores ciphertext it cannot open, the
root is `seed[0:32]` exactly as Commons derives it, and moves compare a SAS.

Reviewing it against the product we want — one account, one place to sign in,
nothing infrastructural for a person to understand — found gaps that are not
cosmetic:

1. **Authority.** `POST /auth/link` wrote a proposed key over an already-linked,
   different root with only a bearer and a proof by the NEW key. `DELETE
   /auth/link/identity` could turn a self-custody account back into a keyless
   one while a passkey remained. Removing a passkey counted login methods, not
   whether that passkey was the only thing able to open the web envelope.
2. **Proofs.** Envelope writes were authorized by a signature over
   `{action,userId,timestamp}`: not bound to the envelope bytes, the revision
   being replaced, or a one-use challenge. A captured proof replayed inside its
   freshness window could write a different envelope, and two concurrent writes
   lost one another (last write wins over `wraps`).
3. **Login unlocked the root.** Every passkey sign-in on the holder origin asked
   for PRF, kept the output on the signed-in session object, and decrypted the
   mnemonic to decide that "the identity is ready".
4. **Enrollment could finish keyless.** Sign-up created the account and passkey
   first and established the root afterwards, so a browser without PRF (or a
   failure in between) left a complete, usable account with `public_key = NULL`.
5. **Recovery required the old factor.** Phrase recovery ran only after a passkey
   sign-in. Losing every passkey left no way back even with the phrase.
6. **The PRF follow-up ceremony dropped the RP ID**, and the local envelope was
   used whenever the server call failed for any reason, including a revocation.
7. **The holder origin was a product.** Copy told people to "open id.oxy.so" to
   save or recover, and the account menu linked there.
8. **The DID named Oxy as a controller** of every self-sovereign account.

## Decision

### D1 — `auth.oxy.so` is the only web entry a person is sent to

Apps reach sign-in, creation, consent and recovery through `@oxy.so/services`
(the account dialog) and the IdP at `auth.oxy.so`. No user-facing copy, menu
row, reminder or support text names `id.oxy.so`.

The root-holding code does **not** move into `auth.oxy.so` yet. The browser
origin is the security boundary, and `auth.oxy.so` does not meet the holder
bar today: it runs product analytics (PostHog) and the Cloudflare Insights
beacon, loads the whole `@oxy.so/services` + Bloom UI graph, and its CSP allows
third-party connections. A Web Worker or a `/identity` path inside that origin
would not be a boundary. So:

- `id.oxy.so` stays as an **internal holder host**: minimal code, strict CSP,
  no third parties, never linked as a destination a person must remember. The
  dialog opens it as the popup of the canonical flow; the person sees "Oxy".
- It is removed when **all** of: every holder class in the migration inventory
  (`docs/identity/holders-and-recovery.md`) has a verified path; `auth.oxy.so`
  passes the holder gate in #1302 (no third-party code in the whole origin, strict
  CSP, reviewed dependency graph, content-addressed release manifest, restricted
  deploy authority); legacy-RP credentials have a compatibility path that does
  not need the old UI; telemetry shows no dependency past the agreed grace window.
- No third holder origin is created.

### D2 — Passkey RP model

New credentials keep RP ID `oxy.so` **until** the holder moves to `auth.oxy.so`:
a credential that wraps a root must be exercised on the holder origin, and
`id.oxy.so` cannot assert an `auth.oxy.so`-scoped credential. What changes now:

- the RP ID is carried explicitly through creation, assertion and the follow-up
  PRF evaluation; nothing relies on the browser's default;
- each wrap records the `rpId` and scheme it was created under, so a later
  canonical RP (`auth.oxy.so`, exact host) can coexist with legacy `oxy.so`
  wraps without guessing;
- a passkey becomes a **root holder** only after it has actually opened the
  envelope (`verifiedAt` on the wrap). A login passkey is not a holder.

### D3 — Login is not root unlock

Authentication yields a verified account and a session. It never requests PRF,
never decrypts, and nothing derived from a PRF output is kept on session state.
Holder status is read from non-sensitive metadata (`GET /identity/web-envelope`
reports holders and readiness without the client decrypting anything).

A root operation — establishing, recovering, showing the phrase, adding or
removing a holder, moving, deleting the account — runs one fresh ceremony
against the envelope's own wraps, opens the root, performs that one operation,
and wipes the material. Cancellation or unmount drops it.

### D4 — A personal account is created with its root, atomically, or not at all

Web sign-up runs entirely on the holder before the server is told anything:
create the passkey → obtain a 32-byte PRF output (at `create()` or a follow-up
`get()` scoped to that credential and RP ID) → generate the root → seal →
re-open the envelope locally → sign an enrollment proof. Only then does
`POST /webauthn/register/verify` run, and it creates the user, the passkey, the
identity key, both auth methods and the envelope in **one transaction**.

- No PRF → no account is created; the person is offered Commons (which creates
  accounts with their key already) or a supported browser. There is no pending
  user row and no username reservation to expire: the registration challenge
  (5 minutes) is the only intent.
- A credential created in the authenticator whose finalize never committed is an
  orphan the server does not know; retrying starts a new registration. A
  finalize that committed but whose response was lost is recovered by signing in
  with that passkey, which finds the account and its root.
- The API refuses a personal passkey sign-up that carries no identity
  enrollment. Commons sign-up (`/auth/register`) already carries its key.
- Existing keyless personal accounts are a migration class (D9), never a
  template for new ones.

### D5 — Recovery restores the same account from root possession alone

Signed out, with no passkey and no session: the holder derives the root locally
from recovery material, asks for a one-use challenge, and proves possession.
Only a valid proof learns anything about the account (so the public endpoint is
not an enumeration oracle). The same transaction registers a new passkey, stores
an envelope sealed under it, burns the challenge, and a session is minted. Account
id, username and everything bound to them are untouched.

Supported material: 12- and 24-word BIP-39 phrases (key = `seed[0:32]`,
unchanged) and raw 32-byte private keys. A raw-key identity stays a raw-key
identity: envelope `version 2` seals either mnemonic entropy or a raw key and
says which; nothing ever fabricates a phrase for a raw key.

Recovery readiness is five facts, never one boolean: root linked; this holder
opens it; another independent holder exists; recovery material confirmed; recovery
material re-derived the root (`recoveryVerifiedAt`).

### D6 — Holders, not moves

A root has one or more user-controlled holders (Commons on a phone, a browser
passkey wrap, another device). A recovery phrase is recovery material, not a
holder. Two intentions:

- **Add Commons / another device** copies the root, the destination proves
  durable possession, the source stays.
- **Keep only in Commons** = add + verified receipt + remove the web holder.

The source is never removed before the destination's receipt verifies locally
against the root. Removing the last web wrap, or the last passkey that is a
web wrap, is refused unless the web holder itself is removed with a root proof
(which is an explicit, warned operation). Removing a holder never claims that
historical, exported or synced copies vanished.

### D7 — One sensitive-proof format, bound to the operation

`@oxy.so/contracts` owns `buildIdentityProofMessage`, a canonical, versioned
serializer shared byte-for-byte by clients and the API:

```text
{ v: 2, domain: "oxy-identity-proof", action, subject, actor, rootPublicKey,
  payloadDigest, expectedRevision, audience, challenge, expiresAt }
```

`challenge` comes from `POST /identity/proof-challenge`, is bound to the actor,
action and root, and is burned by the verifying request. `payloadDigest` is the
SHA-256 of the canonical JSON of the exact payload (the envelope, the move
receipt fields, …). Envelope writes also carry `expectedRevision`; the write is
a compare-and-swap on `identity_web_envelopes.revision`. Wrong action, subject,
actor, root, payload, revision, audience, an expired or replayed challenge all
fail closed. The v1 `{action,userId,timestamp}` format is accepted only during
the rollout window stated in the implementing PRs and then removed; rollback
does not re-enable it.

### D8 — Root authority

- `POST /auth/link` is **first link only**: under a row lock, a different
  existing root is refused (409); the same root heals its `identity` method row.
  A keyless account must also present a fresh use of its existing factor: a
  WebAuthn assertion by one of its own passkeys over the same one-use proof
  challenge the new root signs. A bearer, however recent, is not that proof.
- Replacing a root is `POST /auth/rotate/*` only (old-root and new-root proofs,
  one-use challenge bound to the current root).
- `DELETE /auth/link/identity` is refused for personal accounts. A root is not
  "unlinked" back into a keyless account.
- No staff flag, service token, delegated account context, OAuth or MCP grant is
  authority over a personal root; every root-changing route checks the personal
  principal's own proof.

### D9 — DID controller is the person

A self-sovereign DID document lists the user's DID as its only `controller`.
Oxy's key appears only on accounts that have no root (managed, federated,
legacy keyless), labeled as custodial. Oxy signatures on records remain service
attestations and are verified as such; history is not rewritten.

### D10 — Rollout order

1. Additive schema and verifier (both proof versions, optional revision).
2. Authority fixes old clients tolerate (first-link-only, no identity unlink,
   last-holder guard).
3. Holder client: login without PRF, v2 proofs, atomic enrollment, recovery.
4. API: refuse keyless personal sign-up; require v2 proofs and revisions.
5. SDK/`auth.oxy.so`: creation and recovery route to the canonical flow; no
   copy names the holder host.
6. Holder add/move, DID controller.
7. Holder migration and host retirement (D1 criteria).

Each step deploys on merge (API through `deploy-aws.yml`, frontends through
`deploy-cloudflare.yml`), so a step never depends on a later one being live.

## Consequences

- A browser without PRF can no longer create an Oxy account on the web; Commons
  can. This is the honest cost of "never keyless" and must be visible in copy.
- One more round trip on every root operation (the proof challenge) and one more
  passkey prompt when a root operation follows a sign-in.
- `id.oxy.so` keeps existing for a while, invisibly. The retirement criteria are
  measurable, not a date.
- What source review and unit/integration tests cannot establish — PRF behavior
  per browser/authenticator and synced copies, native keychain/broker behavior,
  whether non-technical people complete the journey — remains an explicit gate
  in #1302 and is not claimed by this ADR.

## Rejected alternatives

- **Put the holder under `auth.oxy.so/identity` now.** Same origin as analytics
  and the full SDK graph; a path is not a boundary.
- **Keep account creation keyless and prompt later.** That is the state that
  produced unrecoverable, undeletable accounts in the first place.
- **Server-assisted recovery (email, support reset).** Makes Oxy the custodian.
- **Reserve usernames in a pending-account table.** The atomic finalize makes a
  reservation unnecessary, and every reservation is something to expire and leak.
