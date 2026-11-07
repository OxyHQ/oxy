# The Oxy Keychain — server contract and storage

> The living record for [ADR 0063](../adr/0063-end-to-end-encrypted-keychain.md).
> The ADR says why and fixes the cryptography; this page says what the server
> stores, what each route takes and answers, and what it checks. Update the
> row when the code changes.

## Who may call

Every `/keychain` route:

1. `authMiddleware` — a verified bearer.
2. `requireAccountSecurityAccess` — a first-party device session, or an OxyOS
   `host.self` token; every other application token and every third-party
   session is refused `403`.
3. A personal account acting as itself: `req.user.kind === 'personal'` and
   `req.oxyToken.principalUserId === req.oxyToken.subjectAccountId`. Anything
   else is `403 KEYCHAIN_NOT_AVAILABLE`.
4. A device, and the account's presence on it: `req.oxyToken.deviceSessionId`
   and `req.oxyToken.deviceContextId` (the verified `device_context_id`) are
   both required; together they are what a member is bound to (see "Leaving a
   device"). Missing: `403 KEYCHAIN_DEVICE_REQUIRED`.

Responses use the API's usual `{ data }` envelope; a refusal is the API's error
body `{ error, message }` with `error` from `KEYCHAIN_ERROR_CODES`
(`@oxy.so/contracts`, also in `@oxy.so/contracts/client`), or a re-verification
code (`SIGN_IN_ERROR_CODES`, `IDENTITY_ERROR_CODES`) on the reset. Every answer
is `Cache-Control: no-store`.

Code: `packages/api/src/routes/keychain.ts`, `services/keychain.service.ts`
(storage, one transaction per write under the vault row's lock) and
`services/keychainRoster.ts` (the verification, no database).

## Tables

| Table | Key | Columns | Notes |
|---|---|---|---|
| `keychain_vaults` | `id` (uuid, client-chosen) | `account_id` (unique, FK users CASCADE), `genesis_hash`, `roster_seq`, `roster_head`, `generation`, `revision` (bigint, the item counter), `created_at`, `updated_at` | One per account |
| `keychain_roster_entries` | (`vault_id`, `seq`) | `hash`, `op`, `body` (text: the JCS of the entry without signatures, as received), `signatures` (jsonb), `created_at` | Append-only; FK vault CASCADE |
| `keychain_members` | (`vault_id`, `member_id`) | `device_session_id` (FK `device_sessions` SET NULL), `device_context_id` (FK `device_account_contexts` SET NULL); either NULL means orphaned, `name`, `platform`, `signing_key`, `box_key`, `added_seq`, `removed_seq` (nullable), `created_at`, `updated_at` | Derived from the roster; the binding to a device and the account's presence on it is the server's own; at most one live member per device context (partial unique index `keychain_members_live_device_context_key`) |
| `keychain_wraps` | (`vault_id`, `recipient`) | `generation`, `signer`, `epk`, `nonce`, `ciphertext`, `signature`, `created_at`, `updated_at` | `recipient` is a member id or `recovery`; one row per recipient, replaced |
| `keychain_items` | (`vault_id`, `item_id`) | `revision`, `generation`, `nonce` and `ciphertext` (both null for a tombstone), `deleted_at` (nullable), `created_at`, `updated_at` | Unique (`vault_id`, `revision`) |
| `keychain_enrollments` | `id` (uuid v7) | `vault_id` (FK CASCADE), `device_session_id` (FK CASCADE), `device_context_id` (FK `device_account_contexts` CASCADE: a request from an account that has left the device is void), `member` (jsonb), `commitment`, `approver_nonce`, `approver_member_id`, `device_nonce`, `status` (`pending`/`approved`/`denied`), `expires_at`, `created_at`, `updated_at` | Expiry registry on `expires_at` (+1 day grace) |

Every closed set is `text` + CHECK, every binary column CHECKs its base64url
shape. Migrations `0242_keychain`, `0243_keychain_member_device_context`
(pre) and `0244_keychain_drop_member_session_key` (post, drops the old
one-member-per-device-session index).

Limits (`KEYCHAIN_LIMITS`, refused `409 KEYCHAIN_LIMIT_REACHED`): 10 000 live
items per vault; an item's or a wrap's ciphertext at most 64 KiB (base64url
characters); a roster at most 1 000 entries; 32 live members; 4 pending
enrollments per vault. Refused as malformed (`400`): an entry `body` over
4 096 characters, more than 64 entries in one append, a member name that is
not 1 to 256 bytes of well-formed UTF-8, a timestamp not in `toISOString`'s
spelling, a member or recovery key no device could use (a small-order Ed25519
point, a low-order X25519 key).

## Routes

All bodies are strict (unknown keys refused). Binary fields are base64url
without padding, checked for length where it is fixed (keys 32 bytes, nonces 24,
signatures 64, nonces of enrollment 32, commitments 32).

| Route | Body → answer | Checks |
|---|---|---|
| `GET /keychain` | → `{ vault: { id, genesisHash, rosterSeq, rosterHead, generation, revision } \| null, roster: Entry[], members: [{ id, orphaned, removed }], self: memberId \| null }` | One snapshot (repeatable read). No vault: `vault` and `self` null, the lists empty. `self` is the live member bound to the caller's device and context |
| `POST /keychain` | `{ genesis: Entry, wraps: [Wrap(member), Wrap(recovery)] }` → `201`, the `GET` answer | No vault yet (`409 KEYCHAIN_EXISTS`, also for a vault id another account holds); `genesis` valid (seq 0, prev null, exactly two signatures: the member's and the recovery key's); exactly these two wraps, generation 1, signed by the member; the member bound to the caller's device session |
| `POST /keychain/roster` | `{ entries: Entry[], wraps: Wrap[] }` → the `GET` answer | See "Roster appends" below |
| `GET /keychain/wrap` | → `{ wrap }` for the caller's own member | `404 KEYCHAIN_NOT_MEMBER` when the caller is no live member |
| `GET /keychain/recovery` | → `{ wrap }` the recovery wrap | Any device of the account (it opens only with the recovery key); `404 KEYCHAIN_NOT_FOUND` without a vault |
| `POST /keychain/enrollments` | `{ member, commitment }` → `201`, `{ enrollment }` | Vault exists; caller not already a live member (`409 KEYCHAIN_ALREADY_MEMBER`); the member id never used in this vault; one pending request per device (a new one replaces the device's older one); at most 4 pending; 10-minute life |
| `GET /keychain/enrollments` | → `{ enrollments: Enrollment[] }` pending, unexpired ones | A live member |
| `GET /keychain/enrollments/:id` | → `{ enrollment }` | The enrolling device, or a live member (anyone else `404`); an expired pending one `410 KEYCHAIN_ENROLLMENT_EXPIRED` |
| `POST /keychain/enrollments/:id/approver-nonce` | `{ memberId, approverNonce }` → `{ enrollment }` | A live member, `memberId` the caller's own; pending and unexpired; once (`409 KEYCHAIN_ENROLLMENT_STATE`) |
| `POST /keychain/enrollments/:id/reveal` | `{ deviceNonce }` → `{ enrollment }` | The enrolling device; after the approver's nonce; once. `SHA-256(commit input) === commitment`, else `400 KEYCHAIN_COMMITMENT_MISMATCH` and the enrollment is `denied` (one try: a second nonce chosen after seeing the approver's would undo the commitment) |
| `POST /keychain/enrollments/:id/approve` | `{ entry: Entry(add), wrap: Wrap }` → the `GET` answer | The approver who posted the nonce; revealed; pending and unexpired; the entry is one `add` whose member is the enrollment's exactly (JCS-equal), signed by the approver alone; the wrap for the new member at the current generation, signed by the approver; one transaction with the roster append; binds the member to the ENROLLING device's session; the enrollment becomes `approved` |
| `DELETE /keychain/enrollments/:id` | → `204` | The enrolling device (withdrawn: deleted) or a live member (refused: `denied`, so the device reads the answer) |
| `GET /keychain/items?since=&limit=` | → `{ items: Item[], revision, more }` | A live, non-orphaned member; revisions above `since` and at most the vault's `revision` (read first, so nothing is skipped), ascending; `limit` 1–500 (default 500); `more` when another page follows the last item |
| `PUT /keychain/items/:itemId` | `{ baseRevision: number \| null, generation, nonce, ciphertext }` → `{ item }` | A live member; `generation` ≥ 1 and ≤ the vault's (`400 KEYCHAIN_GENERATION_INVALID`); `baseRevision` null only when the item never existed, else equal to the stored one, a tombstone's included (`409 KEYCHAIN_ITEM_CONFLICT`); the vault's next revision |
| `DELETE /keychain/items/:itemId` | `{ baseRevision }` → `{ item }` (tombstone) | Same conflict rule; an absent or already deleted item `404 KEYCHAIN_ITEM_NOT_FOUND` |
| `DELETE /keychain` | `{ reauth?, rootProof?, totpCode? }` → `204` | See "Reset" below; deletes the vault and everything under it |

`Entry` is `{ body: string, signatures: [{ signer, signature }] }` (one or two
signatures, each signer once): the server parses `body` (strict schema, which
rewrites nothing) and verifies the signatures over
`"oxy.keychain.roster.v1\n" ‖ body`, after checking `body` is the JCS of its
own parse (so a non-canonical body, a duplicate key or an unknown key is
refused). The body of each operation, besides `{ v: 1, vaultId, seq, prev, op,
createdAt }` (`createdAt` ISO 8601 UTC): `genesis` `{ member, recovery:
{ signingKey, boxKey } }`, `add` `{ member }`, `remove` `{ memberId }`,
`generation` `{ generation }` (≥ 2), `recovery` `{ recovery }`. `Wrap` is
`{ recipient, generation, epk, nonce, ciphertext, signer, signature }`.
`Enrollment` is `{ id, vaultId, member, commitment, approverNonce,
approverMemberId, deviceNonce, status, expiresAt, createdAt }`; `Item` is
`{ id, revision, generation, nonce, ciphertext, deletedAt, updatedAt }`
(timestamps ISO 8601).

### Roster appends

Every entry is checked against the roster as it stands just before it, the
order a device verifies in: `vaultId`; `seq` = head + 1 and `prev` = the head's
hash (the FIRST entry not continuing the head is `409 KEYCHAIN_ROSTER_CONFLICT`:
another device wrote first, or a fork; a later one is the request's own error,
`400 KEYCHAIN_ROSTER_INVALID`); exactly one signature (genesis: two), valid,
its signer a live member, or the current recovery key for an `add` only; an
`add` never reuses a member id; a `remove` names a live member; a `generation`
is the current one plus one; a `remove` and a `recovery` are each followed AT
ONCE by a `generation` (ADR 0063 D3/D6 as amended in #2219: the vault key moves
on whenever a key that could open it stops being trusted), and a request never
ends with one pending (`400 KEYCHAIN_ROTATION_INCOMPLETE`). These are the SDK
verifier's rules (`verifyRoster`); the server's verifier reproduces the SDK's
roster test vectors, accepting the chain and refusing every rejection.

Two callers:

- **A live member** (bound to the caller's device and the account's presence on it): `remove`,
  `generation` and `recovery` entries. An `add` is refused here: a device is
  added by approving its enrollment, which binds it to the device that asked.
  A request that moves the generation must come with a wrap at the newest one
  for every member live after the request (orphaned ones included) and
  `recovery` (the new recovery key after a `recovery`), and nothing else (`400
  KEYCHAIN_ROTATION_INCOMPLETE` for one missing, `400 KEYCHAIN_WRAP_INVALID` for
  one extra, a removed member's included). Every wrap is signed by the caller's
  member. A removed member's wrap is deleted. The last member cannot remove
  itself (no member would remain to sign the `generation`).
- **A device that is no member, with the recovery key** (ADR 0063 D6): exactly
  one `add`, signed by the recovery key alone, with the new member's wrap at
  the current generation signed by the recovery key; the new member is bound
  to the caller's device and context. Anything else from a non-member is `403
  KEYCHAIN_NOT_MEMBER`.

Ed25519 verification is strict (RFC 8032, `@noble/curves` with `zip215: false`).
All entries, members, wraps and the vault's head move in one transaction under
the vault row's lock; a concurrent append waits for it and then conflicts.

### Leaving a device (ADR 0063 D4)

A member is bound to the device session AND to the account's presence on it,
its `device_account_contexts` row. When the account leaves the device — signs
out of it, is removed from it in Oxy's device list or from a machine, or the
whole device ends — that row goes and the member's `device_context_id` is set
NULL by its foreign key, **whether or not other accounts remain on the
device** (the device-session row may stay for them). The member is then
orphaned for good: signing in again on the device makes a new context, so the
device is served nothing and joins again like any new device, and a member
device removes the orphan with a rotation. Being a foreign key, this holds for
every path that ends a context, present and future.

The one replacement that is not a departure is `addAccount`'s case 2: a new
session for an account that stays on the device as the same person. There the
members bound to the old context are re-bound to the new one in the same
transaction (`rebindKeychainMembers` in `deviceSession.service.ts`). If the
account moves to another operator, nothing is re-bound.

### Reset

`DELETE /keychain` checks that a vault exists first (`404 KEYCHAIN_NOT_FOUND`,
spending no factor), then:

- an account without a linked root: `reauth` for `reset_keychain` (ADR 0030:
  its email code, its password when it has no email, plus its authenticator's
  code when it has one);
- an account WITH a linked root (Commons: no email or password to re-verify
  with): `rootProof`, a one-use root proof (ADR 0024 D7) for `keychain_reset`
  whose payload is `{ vaultId }`, the challenge from `POST
  /identity/proof-challenge`, plus `totpCode` when it has an authenticator.
  Missing: `401 KEYCHAIN_RESET_PROOF_REQUIRED`. The proof is burned in the
  delete's transaction.

Account deletion deletes the keychain as well (an archived account keeps its
`users` row, so the cascade alone would not).

## Rate limits and logs

- Writes: 120 per account per 15 minutes; enrollment creation 10 per account
  per hour; reads 600 per account per 15 minutes. Keys via user id, never an IP
  (`hashedIpKey` only where no user exists).
- Logs: `keychain.*` events with the vault id, member id, enrollment id, ops,
  seq, generation and counts. Never a body, ciphertext, key, signature, nonce,
  code or member name.
