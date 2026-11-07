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
| `POST /keychain/roster` | `{ entries: Entry[], wraps: Wrap[] }` → the `GET` answer | Caller is a live, non-orphaned member, or every entry is an `add` signed by the recovery key (recovery). Entries continue the head (`409 KEYCHAIN_ROSTER_CONFLICT` otherwise); each signature valid and its signer a current member (or the current recovery key where allowed); `remove` must be followed by `generation` = current + 1 and wraps at that generation for every remaining member and `recovery`; `recovery` must likewise be followed by `generation` = current + 1 and wraps at that generation for every member and the new `recovery` (ADR 0063 D6 as amended); an `add` by recovery must come with the new member's wrap, signed by the recovery key, and binds the new member to the caller's device session |
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

## Formats in detail

The SDK's `@oxy.so/core/crypto` (`packages/core/src/crypto/keychain/`) fixes
what [ADR 0063 D8](../adr/0063-end-to-end-encrypted-keychain.md) leaves to the
implementation. None of it changes D8; every point is in the test vectors.

- **JCS subset.** Every JCS value is objects, arrays, well-formed strings
  (a lone surrogate is refused), booleans, `null` and safe integers; a float or
  `-0` is refused. Keys are ASCII, so RFC 8785's UTF-16 key order is byte
  order. A reader refuses any text that is not exactly the JCS of its parse
  (whitespace, key order, escapes, duplicate keys). serde_json's default
  `Value` serialization (no `preserve_order`, no `arbitrary_precision`) writes
  exactly this subset.
- **Strict decoding.** base64url refuses padding, foreign characters and
  non-zero trailing bits; fixed-size fields (keys 32 bytes, nonces 24,
  signatures 64, enrollment nonces and commitments 32) are length-checked.
  Ids are lowercase 8-4-4-4-12 uuids of any version.
- **Timestamps** (`createdAt`, `modifiedAt`, `changedAt`) are UTC with
  milliseconds, exactly as `Date.prototype.toISOString` writes them
  (`2026-11-07T12:00:00.000Z`).
- **Ed25519** signatures are verified the RFC 8032 strict way: canonical
  encodings, small-order public keys refused (`@noble/curves` with
  `zip215: false`; `ed25519-dalek`'s `verify_strict`). A roster signing key
  must decode as such a point; a box key must not be of low order (X25519 with
  it is all zeros). Seal refuses a low-order key before any use
  (`x25519-dalek`: `!was_contributory()`).
- **Roster bodies.** Every body is `{ v: 1, vaultId, seq, prev, createdAt, op }`
  plus, by op: `genesis` `member`, `recovery`; `add` `member`; `remove`
  `memberId`; `generation` `generation` (an integer ≥ 2, the current + 1);
  `recovery` `recovery`. `recovery` is `{ signingKey, boxKey }`. A `remove`
  and a `recovery` must each be followed by a `generation` entry. A member's
  `name` is 1 to 256 bytes of UTF-8 (any characters; the UI sanitizes for
  display). The schema is closed at every level.
- **Roster signatures.** `genesis` carries exactly two (its member and
  `recovery`, either order); every other entry exactly one, from a distinct
  signer. A member id is never reused, even after its removal. The last member
  cannot remove itself (no member would remain to sign the `generation`).
- **Wraps.** A device accepts a wrap only at the roster's newest generation,
  for a current member or `recovery`, signed by a current member or the current
  recovery key; the opened keyring must hold exactly generations 1 to the
  wrap's. Keyring generation keys are canonical decimals (`"1"`, `"10"`), so
  JCS orders them as strings: `"1"`, `"10"`, `"11"`, `"2"`.
- **Items.** The plaintext is the item's JCS followed by spaces to the next
  multiple of 256 (none when the JCS already is one); a reader refuses
  anything else, and a padded plaintext over 48 896 bytes (its ciphertext
  would pass the server's 64 KiB of base64url). Every field of a type is
  required and none other is allowed; `login.totp` is an `otpauth://totp/` URI
  or `null`; `counter` is an integer ≥ 1 (1 for a new item), and a device
  accepts an equal or higher counter, never a lower one. `passkey.credentialId`
  is 16 bytes, `userHandle` 1 to 64; `wifi.ssid` at most 32 bytes, and
  `password` is `''` exactly when `security` is `open`. The decrypted item's
  `id` must equal the requested one.
- **Recovery key text.** Reading also skips tabs, CR and LF (pasted text), and
  refuses any non-ASCII character before upper-casing. 32 characters carry
  exactly 160 bits: there is no checksum, and a mistyped key is caught because
  its derived public keys are not the roster's (`recoveryKeyMatches`).
- **TOTP.** `otpauth://totp/` only (`hotp` refused); `secret` required, base32
  read leniently (case, spaces, `=`); `algorithm` SHA1/SHA256/SHA512, `digits`
  6–8, `period` 1–3600; a repeated parameter is refused, unknown ones ignored;
  query values read `+` as a space; the `issuer` parameter wins over the
  label's prefix.

## Test vectors

`packages/core/src/crypto/keychain/__tests__/vectors.json` holds every format
above computed from fixed keys, ephemeral keys and nonces. `vectors.test.ts`
checks the committed file is exactly what `vectorGenerator.ts` builds
(`bun scripts/generate-keychain-vectors.ts` in `packages/core` rewrites it) and
reproduces every value, also through Node's OpenSSL X25519/Ed25519/HKDF where it
has them. The OxyOS keychain service must reproduce every value byte for byte.

Binary values are base64url without padding, hashes lowercase hex, and text
(bodies, signing inputs, JCS, keyring plaintexts) the exact UTF-8 string.

| Key | Shape | Check |
|---|---|---|
| `vaultId` | uuid | used by every vector |
| `devices` | `{ "device-a": { member, signingSecretKey, signingPublicKey, boxSecretKey, boxPublicKey }, … }` | public keys from the secrets; member names carry JCS edge cases (quotes, `\`, `/`, every short escape, other C0 controls as `\u00xx`, DEL, U+2028, non-ASCII and astral characters) |
| `recoveryKeys[]` | `{ recoveryKey, text, parsesFrom[], signingSecretKey, signingPublicKey, boxSecretKey, boxPublicKey }` | `text` from the 20 bytes; every `parsesFrom` reads back to them; HKDF seeds and public keys |
| `recoveryKeyRejections[]` | text | each must be refused |
| `seal[]` | `{ recipientBoxSecretKey, recipientBoxPublicKey, ephemeralSecretKey, nonce, plaintext, aad, sealed: { epk, nonce, ciphertext } }` | seal with the given ephemeral key and nonce gives `sealed`; open gives `plaintext` |
| `sealRejectedBoxKeys[]` | X25519 public keys | sealing to any of them is refused (low order, including non-canonical spellings) |
| `keyrings[]` | `{ generations: { "<g>": key }, plaintext }` | JCS of the generations (one has 11, for the string order) |
| `wraps[]` | `{ vaultId, recipient, recipientBoxSecretKey, signer, signerSigningSecretKey, ephemeralSecretKey, nonce, keyringPlaintext, aad, signingInput, wrap }` | `aad`, `signingInput`, the deterministic `wrap` (ciphertext and Ed25519 signature) and its opening; one recipient is `recovery`, one signer is `recovery` |
| `roster.entries[]` | `{ op, body, signingInput, hash, signatures: [{ signer, signature }] }` | genesis → add (by a member) → add (by recovery) → remove → generation 2 → recovery → generation 3; each signature reproduced and verified |
| `roster.expected` | `{ vaultId, genesisHash, head: { seq, hash }, members[], recovery, generation, removedMemberIds[] }` | the verifier's result |
| `rosterRejections[]` | `{ name, reason, entries[], knownHead?, genesisHash? }` | the verifier refuses each with that `reason` (`not_extension`, `genesis_mismatch`, `signer`, `signature`, `incomplete`, `generation`, `continuity`, `format`, `membership`) |
| `enrollment[]` | `{ vaultId, member, deviceNonce, approverNonce, commitInput, commitment, codeInput, codeHash, code }` | commitment and code; one code starts with `0` |
| `items[]` | `{ vaultId, itemId, generation, vaultKey, item, plaintextJcs, paddedPlaintext, aad, nonce, ciphertext }` | one of each type, one whose JCS is exactly 256 bytes (no padding) |
| `totp.rfc6238[]` | `{ secret, algorithm, digits, period, unixSeconds, code }` | RFC 6238 Appendix B |
| `totp.otpauth[]` | `{ uri, secret, issuer, account, algorithm, digits, period, unixSeconds, code }` | the URI reads to these parameters and the code |
