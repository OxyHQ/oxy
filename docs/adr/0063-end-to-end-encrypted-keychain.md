# ADR 0063 — The Oxy Keychain: passwords, passkeys and codes in the account, end-to-end encrypted

- Status: accepted (2026-11-07). Step 1 (server) and step 2 (SDK) are built
  against this text; the OxyOS side is OxyOS ADR 0050.
- Date: 2026-11-07
- Decided by: the owner (2026-11-07): "Llavero y passkeys: no hay gestor de
  contraseñas, FIDO ni passkeys; Oxy debería guardar las passwords y esas
  cosas en la cuenta de Oxy" — designed as Apple would, end-to-end encrypted,
  "bien hecho de raíz, sin tricky things".
- Builds on: [0029](0029-one-oxy-session.md) (one shared session per device),
  [0030](0030-email-code-password-authenticator.md) (how an account signs in,
  re-verification), [0049](0049-first-party-platform-authority.md) (own apps,
  no scopes between them), [0058](0058-platform-held-session.md) (the platform
  holds the session; `host.self` tokens are the platform's account UI).
  Companion: OxyOS ADR 0050 (the keychain service, AutoFill and passkeys on
  OxyOS).
- Does not change: 0030 D8. Oxy itself still signs nobody in with a passkey.
  The keychain keeps the passkeys a person uses at OTHER relying parties.

## Context

A person on OxyOS has no password manager, no passkeys and no FIDO2. Their
Oxy account is the one thing every device they use shares, so the account is
where their passwords should live, as an Apple Account holds iCloud Keychain.

Two facts about Oxy shape the design:

1. **The server sees the account password.** `POST /auth/signin/password`
   sends it over TLS and `password.service.ts` checks it with scrypt. A key
   derived from that password (Bitwarden's master-password model) would be
   computable by the server at every sign-in. It cannot be the root of an
   end-to-end encrypted vault.
2. **An email account recovers through Oxy.** Its email code is Oxy's to
   send. Anything Oxy can recover, Oxy can read. So recovery cannot be
   "sign in again".

iCloud Keychain's answer is a circle of trusted devices: the secrets are
encrypted to device keys, a new device is admitted by a device already in the
circle, and a recovery key (Advanced Data Protection) covers losing them all.
That is the model here. Oxy has no HSM escrow, so there is no passcode-escrow
path; the recovery key replaces it.

## Decision

### D1. One vault per personal account, end-to-end encrypted

- The keychain is one **vault** per personal account (`users.kind =
  'personal'`). Organizations and shared vaults are later work (D9).
- Oxy stores only ciphertext, public keys, signatures and counters. It never
  receives a vault key, an item's plaintext, a device's private key or the
  recovery key, and no route accepts one.
- What Oxy can still see: that an account has a vault, how many items it holds
  and their padded sizes, when they change, and which of the account's devices
  are members. Item types, titles, usernames, domains and app ids are inside
  the ciphertext.
- Every route is the account's own: a bearer of a first-party device session,
  or an OxyOS `host.self` token (the platform's Settings and keychain service,
  ADR 0058), acting as itself (`principalUserId === subjectAccountId`).
  Third-party tokens and every other application token are refused
  (`requireAccountSecurityAccess`). An application never reaches the vault
  through Oxy; on a platform it asks the platform (OxyOS ADR 0050).

### D2. The keys

| Key | What it is | Where it lives |
|---|---|---|
| Vault key `VK_g` | 32 random bytes, generation `g` (1, 2, …). Encrypts items. | Only in member devices' memory and their local keychains, sealed |
| Keyring | Every generation of the vault key, `{ g: VK_g }` | Sealed to each member and to the recovery key (wraps) |
| Device signing key | Ed25519, made on the device | The device's own secure storage; never exported |
| Device box key | X25519, made on the device | The same |
| Recovery key | 20 random bytes (160 bits), shown once as 32 Crockford base32 characters in eight groups of four | On paper, with the person. Never stored by Oxy or by a device |
| Recovery signing / box keys | Ed25519 and X25519, derived from the recovery key | Derived when the recovery key is typed; their public halves are in the roster |

Rotation: when a member is removed, the vault key moves to a new generation
in the same request (D4). Items written later use the newest generation;
older items stay readable under the generation they name, because every
member's keyring holds every generation. A removed device may have kept what
it already decrypted; it receives nothing new.

### D3. The roster: who is a member, signed by members

The server cannot be trusted to say who the members are: if it could add a
device of its own, an honest device would seal the keyring to it. So the
membership is an **append-only signed log**, the roster, verified by every
device from its first entry.

- An entry is `{ v: 1, vaultId, seq, prev, op, …, createdAt }` plus
  `signatures: [{ signer, signature }]`. `seq` starts at 0; `prev` is the
  previous entry's hash, `null` at 0. Its hash is
  `hex(SHA-256(signingInput))`.
- Operations:
  - `genesis` (seq 0): the first member and the recovery public keys. Signed
    by that member AND by the recovery signing key, proving the person held
    the recovery key when the vault was made.
  - `add`: a member. Signed by a current member (approval, D5) or by the
    current recovery key (recovery, D6).
  - `remove`: a member id. Signed by a current member (itself included).
    Always followed in the same request by `generation`.
  - `generation`: the new vault-key generation number. Signed by a current
    member.
  - `recovery`: new recovery public keys (a replaced recovery key). Signed by
    a current member.
- A member is `{ id, name, platform, signingKey, boxKey }`; `id` is a uuid the
  device chooses, `platform` one of `oxyos`, `ios`, `android`, `macos`,
  `windows`, `linux`, `web` (a closed set for display only).
- A device keeps the hash of the genesis entry (the vault's identity) and the
  newest head it verified. An answer from Oxy that is not an extension of that
  head (a fork, a rewrite, a lower `seq`) is refused and shown as a warning;
  the device does not write to that vault until the person resolves it.
- Oxy verifies the same rules (continuity, signatures, signer membership) on
  every append, as a defence in depth and to keep garbage out; the clients'
  verification is what the security rests on.

### D4. Wraps: the keyring sealed to each member, signed

A wrap is the keyring sealed to one recipient's box key (a member, or
`recovery`) and **signed** by the member that sealed it (or, for a device
admitted by recovery, by the recovery signing key). A device accepts a wrap
only if the signer was a member (or the current recovery key) in the roster it
verified, so Oxy cannot hand a device a keyring of its own making and have it
encrypt under that.

- Oxy keeps one wrap per recipient: the newest, holding every generation.
- A `remove` is accepted only in one request with a `generation` entry and a
  new wrap for every remaining member and for `recovery`. A request missing
  any of them is refused, so no remaining member is left without the new key
  and none is sealed to the removed one.
- A member is bound to the account's presence on one device (its device
  context), not only to the device. When the account leaves the device —
  signed out of it, signed out everywhere, removed in Oxy's device list, the
  account removed from a machine — Oxy stops serving that member anything and
  marks it `orphaned` in `GET /keychain`, **whether or not other accounts
  remain on that device** (amended 2026-11-07: a device another account still
  used kept its device session, so the member was not orphaned). Signing in
  again on the device does not revive it: the device joins again. The next
  member device that sees an orphaned member removes it with a rotation. Oxy
  cannot remove a member itself: it can only stop serving it.

### D5. Adding a device: approval with a compared code

A new device asks; a member device approves; the person compares one six-digit
code on both screens. The code must be unforgeable by Oxy, which relays
everything, so it uses a commitment (the short-authentication-string pattern
of ZRTP and Bluetooth numeric comparison):

1. The new device makes its keys and a 32-byte random `deviceNonce`, and posts
   `{ member, commitment }`, `commitment = SHA-256(enrollCommitInput)`. Oxy
   keeps it 10 minutes, bound to the new device's Oxy device session.
2. A member device lists pending requests; the person opens one. It posts a
   32-byte random `approverNonce`.
3. The new device, seeing `approverNonce`, reveals `deviceNonce`. Oxy checks
   it against the commitment.
4. Both compute the code from `member`, `approverNonce` and `deviceNonce` and
   show it. Oxy had to commit to the new device's keys before it saw the
   approver's nonce, and could not pick the approver's nonce knowing the new
   device's, so a substitution matches by chance only (1 in 10⁶).
5. On the person's confirmation, the approving device appends `add` and a
   wrap for the new member in one request.

The approver never approves without the person's explicit confirmation of the
code; there is no automatic approval. Either side may cancel.

### D6. Recovery: the recovery key, and nothing Oxy holds

- The recovery key is made when the vault is made and shown once, with the
  choice to print or write it down; the person must type it back before the
  vault exists. It can be replaced later from a member device (`recovery`
  entry, a new recovery wrap); the old one then opens nothing new.
- A device with the recovery key and no member to approve it: reads the
  recovery wrap (`GET /keychain/recovery`), derives the recovery keys, opens
  the keyring, checks the wrap's signer against the roster, appends `add`
  signed by the recovery key and stores its own wrap signed by the recovery
  key.
- No member device and no recovery key: the vault cannot be opened, by
  anyone. The person may **reset** it (`DELETE /keychain`), which needs a
  fresh re-verification (`reset_keychain`, ADR 0030's reauth) and deletes
  every item, wrap and roster entry; a new vault starts with a new genesis.
  Nothing is reset silently.
- Signing in to Oxy again, an email code, a new password or support never
  open the vault. That is what end-to-end means; the product copy says so
  when the vault is made.

### D7. Items

Each item is one ciphertext under a vault-key generation. Its plaintext is a
JSON object, padded with trailing spaces to a multiple of 256 bytes so lengths
leak only coarsely. `type` and every field are inside the ciphertext.

| `type` | Fields |
|---|---|
| `login` | `title`, `username`, `password`, `urls` (`[{ url }]`, matched by registrable domain), `apps` (OxyOS desktop entry ids, iOS/Android package ids), `totp` (an `otpauth://` URI), `notes`, `passwordHistory` (`[{ password, changedAt }]`, newest first, at most 10) |
| `passkey` | `rpId`, `rpName`, `userHandle` (base64url), `userName`, `userDisplayName`, `credentialId` (base64url, 16 random bytes), `algorithm` (`-7`, ES256), `privateKey` (PKCS #8, base64url), `apps` |
| `totp` | `title`, `issuer`, `account`, `uri` (an `otpauth://` URI), `notes` |
| `note` | `title`, `body` |
| `wifi` | `ssid`, `password`, `security` (`wpa2-psk`, `wpa3-sae`, `wep`, `open`), `hidden` |

Every item also carries `id` (the server-visible uuid, repeated inside), `v`
(the schema version, 1), `createdAt`, `modifiedAt` and `counter`, a
per-item integer the writer increments. A device keeps the highest counter it
has seen per item and refuses an older one, so Oxy cannot roll an item back to
a password the person already changed. Passkeys are discoverable credentials
and are synced like iCloud Keychain's: backup eligible and backed up, the
signature counter always 0.

Sync is by revision: every write gets the vault's next revision; a device asks
for changes since the revision it has, deletions included (tombstones). A
write names the revision it was based on; a stale one is refused `409` and the
device re-reads, merges and retries.

### D8. The cryptography, exactly

Primitives only from audited libraries: in the SDK `@noble/curves` (Ed25519,
X25519), `@noble/ciphers` (XChaCha20-Poly1305) and `@noble/hashes`
(SHA-256, HKDF), as `crypto/aead.ts` and `crypto/kdf.ts` already use; in Rust
the RustCrypto/dalek crates (`ed25519-dalek`, `x25519-dalek`,
`chacha20poly1305`, `hkdf`, `sha2`). Nothing is implemented by hand. Both
implementations are checked against the same test vectors
(`packages/core/src/crypto/keychain/__tests__/vectors.json`).

Encodings: binary is base64url without padding; `JCS` is RFC 8785 (the SDK's
`canonicalize`). Every AAD and signing input starts with a domain string, so
no signature or ciphertext can be replayed as another kind.

- **Seal** (to an X25519 public key `R`, with `aad`), the construction of
  age's X25519 recipient: an ephemeral X25519 pair `(e, E)`;
  `shared = X25519(e, R)`, refused if all zero;
  `key = HKDF-SHA256(ikm = shared, salt = E ‖ R, info = "oxy.keychain.seal.v1", 32)`;
  a random 24-byte nonce; `ciphertext = XChaCha20-Poly1305(key, nonce, plaintext, aad)`.
  Sent as `{ epk: E, nonce, ciphertext }`.
- **Keyring plaintext**: `JCS({ "generations": { "<g>": "<VK_g base64url>", … } })`.
- **Wrap** to recipient `r` at newest generation `g`:
  `aad = "oxy.keychain.wrap.v1" ‖ 0x00 ‖ vaultId ‖ 0x00 ‖ r ‖ 0x00 ‖ g`;
  signature = Ed25519 over `"oxy.keychain.wrap.v1\n" ‖ JCS({ vaultId, recipient, generation, epk, nonce, ciphertext, signer })`.
- **Item**: `aad = "oxy.keychain.item.v1" ‖ 0x00 ‖ vaultId ‖ 0x00 ‖ itemId ‖ 0x00 ‖ g`;
  `ciphertext = XChaCha20-Poly1305(VK_g, random 24-byte nonce, paddedJson, aad)`.
- **Roster signing input**: `"oxy.keychain.roster.v1\n" ‖ JCS(entry without signatures)`;
  the entry's hash is `hex(SHA-256(signing input))`.
- **Enrollment commitment**:
  `SHA-256("oxy.keychain.enroll.commit.v1\n" ‖ JCS({ vaultId, member }) ‖ 0x00 ‖ deviceNonce)`.
- **Comparison code**: `h = SHA-256("oxy.keychain.enroll.code.v1\n" ‖ JCS({ vaultId, member }) ‖ 0x00 ‖ approverNonce ‖ deviceNonce)`;
  the code is the first four bytes of `h` as a big-endian unsigned integer,
  modulo 10⁶, zero-padded to six digits.
- **Recovery keys**: `seed_s = HKDF-SHA256(ikm = recoveryKey, salt = "oxy.keychain.recovery.v1", info = "ed25519", 32)`,
  the Ed25519 secret key; `seed_b` likewise with `info = "x25519"`, the X25519
  secret key. The recovery key's text is Crockford base32 of the 20 bytes;
  reading it ignores case, hyphens and spaces, and maps `I`/`L` to 1 and `O`
  to 0.
- `vaultId`, `itemId` and member ids are lowercase uuids; `g` is decimal ASCII.
- Randomness: the platform CSPRNG (`crypto.getRandomValues`, `getrandom`).

### D9. Not in this decision

- Sharing items or vaults with other people, and organization vaults: a later
  ADR (a shared vault is a second vault whose members are other accounts'
  devices).
- A vault in a plain browser page: none. A page would keep a device key in
  `localStorage` or IndexedDB, which ADR 0058 removed for the session itself.
  Astro reaches the keychain through OxyOS (OxyOS ADR 0050); a web UI may
  come with a platform that holds keys.
- iOS and Android apps for the keychain: the SDK makes them possible; they
  are product work of their own.
- Breach checks against a remote corpus (Have I Been Pwned's k-anonymity
  range API) are a client feature that needs no server change; reused and
  weak passwords are found on the device.

## Consequences

- Server (step 1): tables `keychain_vaults`, `keychain_roster_entries`,
  `keychain_members`, `keychain_wraps`, `keychain_items`,
  `keychain_enrollments`, all `ON DELETE CASCADE` from the account; routes
  under `/keychain`; `reset_keychain` added to `REAUTH_ACTIONS`; contracts in
  `@oxy.so/contracts` (`keychain.ts`). Logs carry counts and ids, never
  ciphertext, keys or names. Detailed in
  [docs/identity/keychain.md](../identity/keychain.md).
- SDK (step 2): `@oxy.so/core/crypto`'s `keychain/` (the formats above, the
  roster verifier, the item codec) and `oxy.keychain` (the routes); a
  `KeychainClient` that a platform drives with its own device-key storage.
- OxyOS (OxyOS ADR 0050) is the first platform: its keychain service is a
  member device, and AutoFill and passkeys come from it.
- Losing every device and the recovery key loses the vault. That is the cost
  of Oxy being unable to read it, and the product says so plainly.
