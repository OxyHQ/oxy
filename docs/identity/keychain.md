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
4. A device session: `req.oxyToken.deviceSessionId` is required (it is what a
   member is bound to). Missing: `403 KEYCHAIN_DEVICE_REQUIRED`.

Responses use the API's usual `{ data }` envelope; errors use `error.code`
from `KEYCHAIN_ERROR_CODES` (`@oxy.so/contracts`).

## Tables

| Table | Key | Columns | Notes |
|---|---|---|---|
| `keychain_vaults` | `id` (uuid, client-chosen) | `account_id` (unique, FK users CASCADE), `genesis_hash`, `roster_seq`, `roster_head`, `generation`, `revision` (bigint, the item counter), `created_at`, `updated_at` | One per account |
| `keychain_roster_entries` | (`vault_id`, `seq`) | `hash`, `op`, `body` (text: the JCS of the entry without signatures, as received), `signatures` (jsonb), `created_at` | Append-only; FK vault CASCADE |
| `keychain_members` | (`vault_id`, `member_id`) | `device_session_id` (FK `device_sessions` SET NULL: NULL means orphaned), `name`, `platform`, `signing_key`, `box_key`, `added_seq`, `removed_seq` (nullable), `created_at`, `updated_at` | Derived from the roster; the binding to a device session is the server's own |
| `keychain_wraps` | (`vault_id`, `recipient`) | `generation`, `signer`, `epk`, `nonce`, `ciphertext`, `signature`, `created_at`, `updated_at` | `recipient` is a member id or `recovery`; one row per recipient, replaced |
| `keychain_items` | (`vault_id`, `item_id`) | `revision`, `generation`, `nonce`, `ciphertext` (nullable for a tombstone), `deleted_at` (nullable), `created_at`, `updated_at` | Index (`vault_id`, `revision`) |
| `keychain_enrollments` | `id` (uuid v7) | `vault_id` (FK CASCADE), `device_session_id` (FK CASCADE), `member` (jsonb), `commitment`, `approver_nonce`, `approver_member_id`, `device_nonce`, `status` (`pending`/`approved`/`denied`), `expires_at`, `created_at`, `updated_at` | Expiry registry on `expires_at` (+1 day grace) |

Limits: 10 000 live items per vault; an item's ciphertext at most 64 KiB
(base64url); a roster at most 1 000 entries; 32 live members; 4 pending
enrollments per vault.

## Routes

All bodies are strict (unknown keys refused). Binary fields are base64url
without padding, checked for length where it is fixed (keys 32 bytes, nonces 24,
signatures 64, nonces of enrollment 32, commitments 32).

| Route | Body → answer | Checks |
|---|---|---|
| `GET /keychain` | → `{ vault: null }` or `{ vault: { id, genesisHash, rosterSeq, rosterHead, generation, revision }, roster: Entry[], members: [{ id, orphaned, removed }], self: memberId \| null }` | `self` is the live member bound to the caller's device session |
| `POST /keychain` | `{ genesis: Entry, wraps: [Wrap(member), Wrap(recovery)] }` → the `GET` answer | No vault yet (`409 KEYCHAIN_EXISTS`); `genesis` valid (seq 0, prev null, two signatures: the member's and the recovery key's); both wraps generation 1, signed by the member; the member bound to the caller's device session |
| `POST /keychain/roster` | `{ entries: Entry[], wraps: Wrap[] }` → the `GET` answer | Caller is a live, non-orphaned member, or every entry is an `add` signed by the recovery key (recovery). Entries continue the head (`409 KEYCHAIN_ROSTER_CONFLICT` otherwise); each signature valid and its signer a current member (or the current recovery key where allowed); `remove` must be followed by `generation` = current + 1 and wraps at that generation for every remaining member and `recovery`; `recovery` must come with a recovery wrap; an `add` by recovery must come with the new member's wrap, signed by the recovery key, and binds the new member to the caller's device session |
| `GET /keychain/wrap` | → `{ wrap }` for the caller's own member | `404` when the caller is no live member |
| `GET /keychain/recovery` | → `{ wrap }` the recovery wrap | Any device of the account (it opens only with the recovery key) |
| `POST /keychain/enrollments` | `{ member, commitment }` → `{ enrollment }` | Vault exists; caller not already a live member; at most 4 pending; 10-minute life |
| `GET /keychain/enrollments` | → `{ enrollments: Enrollment[] }` pending ones | A live member |
| `GET /keychain/enrollments/:id` | → `{ enrollment }` | The enrolling device, or a live member |
| `POST /keychain/enrollments/:id/approver-nonce` | `{ memberId, approverNonce }` → `{ enrollment }` | A live member, the caller's own; once |
| `POST /keychain/enrollments/:id/reveal` | `{ deviceNonce }` → `{ enrollment }` | The enrolling device; after the approver's nonce; `SHA-256(commit input) === commitment` else `400 KEYCHAIN_COMMITMENT_MISMATCH` |
| `POST /keychain/enrollments/:id/approve` | `{ entry: Entry(add), wrap: Wrap }` → the `GET` answer | The approver who posted the nonce; revealed; the entry's member equals the enrollment's; one transaction with the roster append; binds the member to the ENROLLING device's session |
| `DELETE /keychain/enrollments/:id` | → `204` | The enrolling device or a live member |
| `GET /keychain/items?since=&limit=` | → `{ items: Item[], revision, more }` | A live, non-orphaned member; ascending revision; `limit` ≤ 500 |
| `PUT /keychain/items/:itemId` | `{ baseRevision: number \| null, generation, nonce, ciphertext }` → `{ item }` | A live member; `generation` ≤ the vault's and ≥ 1; `baseRevision` null only for a new item, else equal to the stored one (`409 KEYCHAIN_ITEM_CONFLICT`) |
| `DELETE /keychain/items/:itemId` | `{ baseRevision }` → `{ item }` (tombstone) | Same conflict rule |
| `DELETE /keychain` | `{ reauth }` → `204` | A fresh `reset_keychain` re-verification (ADR 0030); deletes the vault and everything under it |

`Entry` is `{ body: string, signatures: [{ signer, signature }] }`: the server
parses `body` (strict schema) and verifies the signatures over
`"oxy.keychain.roster.v1\n" ‖ body`, after checking `body` is the JCS of its
own parse (so a non-canonical body is refused). `Wrap` is
`{ recipient, generation, epk, nonce, ciphertext, signer, signature }`.

## Rate limits and logs

- Writes: 120 per account per 15 minutes; enrollment creation 10 per account
  per hour; reads 600 per account per 15 minutes. Keys via user id, never an IP
  (`hashedIpKey` only where no user exists).
- Logs: `keychain.*` events with the vault id, member id, op and counts. Never
  a body, ciphertext, key, signature, nonce, code or member name.
