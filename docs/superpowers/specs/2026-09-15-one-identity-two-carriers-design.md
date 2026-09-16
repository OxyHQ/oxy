# One Identity, Two Carriers — passkey web identity + Commons, same key, same recovery

**Date:** 2026-09-15
**Status:** Approved 2026-09-15; **partly superseded by [ADR 0024](../../adr/0024-one-oxy-account-root-holders.md)** (#1302): the identity origin is an internal holder host, not a product; moving is one of two holder operations (add or move); decision D2's session block is replaced by readiness metadata; the `{action,userId,timestamp}` proof is replaced by the v2 payload-bound proof. Read the ADR first.
**Owner question:** a newcomer to any Oxy app should get in with "Continue → passkey → username → done", without first understanding Commons. Can a passkey account be a first-class Oxy identity without making Oxy a custodian and without weakening Commons as *the* identity?

**Decisions already taken by the owner (2026-09-15):**

1. **No custodial accounts.** Oxy must never be able to use, recover or reset a user's identity. The web identity is locally custodied, like Commons.
2. **No email.** Not for sign-up, not for recovery, not optional.
3. **One recovery system for both carriers.** Whatever recovers a Commons identity recovers a web identity, and vice versa.
4. **Moving to Commons is easy and is a MOVE.** A web user can take their identity into Commons (QR scan). Afterwards the web copy no longer exists.

**Proposal:** every Oxy account has a self-custody secp256k1 identity key from the moment it exists. There are two *carriers* for that one key: **Commons** (native keychain, the stronger carrier) and a **web carrier** on a new isolated origin, where the key is sealed under a secret only the user's passkey can produce (WebAuthn PRF). Both recover with the same 12-word phrase. Commons stops being a separate kind of account and becomes the most secure place to keep the identity everyone already has.

---

## 1. Why the current passkey account cannot be the front door

A passkey sign-up today creates an account with **no identity key**. Every row below was verified in code.

| Fact | Evidence |
|---|---|
| Sign-up writes only `{ username }` plus a WebAuthn credential; `users.publicKey` stays NULL | `packages/api/src/routes/webauthn.ts:720-743`; `packages/api/src/db/schema/users.ts:339` |
| Its DID is custodial: controller is Oxy, not the user | `packages/api/src/services/did.service.ts:218-237` |
| **It cannot delete itself** — deletion requires an identity-key signature | `packages/api/src/routes/users.ts:1489-1492` ("Account does not have an identity key") |
| No recovery path of any kind; no email is stored | `webauthn.ts:723`; no recovery routes in `packages/api/src` |
| It cannot sign records, civic attestations, rotate a key, or transfer to a device | `OxyServices.identity.ts:236,343,515,530`; `OxyServices.civic.ts:920`; `deviceTransfer.service.ts:215` |
| Upgrading it to Commons (`POST /auth/link`, `linkIdentityKey`) exists but **no app calls it**, and the SDK side is native-only | `routes/authLinking.ts:502-601`; `core/src/mixins/OxyServices.identity.ts:236-258` |
| Commons onboarding has no "I already have an account from the web" path, so a passkey user who installs Commons creates a **second, unrelated identity** | `packages/commons/app/(auth)/welcome.tsx`, `create-identity/`, `import-identity/` |

Making this the front door would put most new users into accounts that cannot be deleted (a GDPR and App Store problem), cannot be recovered, and fork away from Commons. Adding custodial recovery (server-verified codes) would make Oxy the party that hands accounts back — ruled out by decision 1.

**Conclusion:** the passkey account must carry the same key as a Commons account, not be a second account type.

## 2. What Commons does today (the bar)

| Property | Commons today | Evidence |
|---|---|---|
| Key | secp256k1, **first 32 bytes of the BIP39 seed** (no BIP32 path) | `core/src/crypto/recoveryPhrase.ts:116-125` |
| Storage | Keychain / Keystore via SecureStore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — never synced, never leaves the device | `core/src/crypto/keyManager.ts:442` |
| Signing | Key read into app memory and signed in software (secure hardware does not do secp256k1). No storage-level biometric gate (`requireAuthentication` exists but is not applied) | `keyManager.ts:53,1711-1723`; `signatureService.ts:82` |
| Phrase | 12 words shown once at creation; stored separately, best effort, "convenience persistence, NOT a recovery mechanism" | `keyManager.ts:213-224` |
| Off-device backup | Ciphertext on Oxy's server, sealed with keys HKDF-derived from the **full 64-byte seed**; Oxy never sees phrase, derived key or plaintext | `core/src/mixins/OxyServices.identityBackup.ts:1-25` |
| Code that touches the key | Signed binary shipped through app stores | — |

Note on the existing backup: Oxy **already stores encrypted identity material it cannot open**. That is not custody — custody is the ability to use or recover the key — and it is the model this design reuses (see D1).

## 3. The web carrier

### 3.1 The isolated identity origin — `id.oxy.so` (new)

The key never lives on `auth.oxy.so` or any app origin:

- `auth.oxy.so` ships product analytics (PostHog, `packages/auth/oxy.pages-headers.json:3`) and the Cloudflare Insights beacon (`core/src/server/securityHeaders.ts:142`). Third-party code on the page that holds the key is unacceptable.
- RP apps (Mention, Homiio…) and `auth.oxy.so` itself **never** see the key. They ask `id.oxy.so` for an operation (unlock, sign, prove) through a popup, the way they already open the passkey hub today (`services/src/ui/components/passkeyHubPopup.ts`, `accountDialogController.ts` `startPasskeyHubSignIn`), and receive only the result.

`id.oxy.so` requirements:

- Its own Pages project; no analytics, no third-party script, font or CDN; `script-src 'self'` only, no `unsafe-inline` styles; `frame-ancestors 'none'`.
- Minimal code: key sealing, signing, SAS transfer, recovery. No product UI.
- Every production build publishes its asset hashes, so what the origin serves can be checked against a reviewed release.
- The only origin in the ecosystem allowed to request PRF (enforced by code review and a CI grep over every other package).

### 3.2 Key material and envelopes

At sign-up, on `id.oxy.so`:

1. Generate a 12-word mnemonic; derive the key exactly as Commons does (`seed[0:32]`), so a web identity and a Commons identity are indistinguishable.
2. Generate a random 256-bit **data key (DEK)**. Seal the **mnemonic entropy** (not only the private key — see §5.2, change 3) with the DEK (XChaCha20-Poly1305, the AEAD already used by backup and transfer, `core/src/crypto/aead.ts`).
3. Register the passkey with `extensions.prf.eval`. Derive a **key-encryption key (KEK)** from the PRF output with HKDF (info `oxy-web-carrier-kek-v1`). Wrap the DEK with the KEK.
4. Store the **envelope** — `{ sealedEntropy, wrappedDEKs: [{ credentialId, wrap, check }], version }` — in two places:
   - locally in IndexedDB on `id.oxy.so` (fast path), and
   - on the server, bound to the account (survival path; see §3.4 and D1).
5. Link the public key to the account in the same step (`POST /auth/link` semantics, bearer + signature), so the DID is self-sovereign from the first second.

Why the DEK indirection (the Bitwarden pattern): each additional passkey adds its own wrap of the same DEK; PRF inputs can rotate; a PRF mismatch on one credential does not strand the identity.

Each wrap stores a **key-check value** (AEAD tag over a constant). A PRF output that does not open its wrap is detected immediately and routes the user to another passkey or the phrase — never to silent corruption.

### 3.3 Unlock and signing

- An RP needs a signature → popup to `id.oxy.so` → WebAuthn `get()` with `prf.eval` (user verification required) → KEK → DEK → entropy → key → sign → **zeroize** → return only the signature to the RP.
- The key exists in memory for one operation. Nothing is cached across operations.
- Plain sign-in does **not** unlock the key; the passkey authenticates as it does today. Unlock happens only for operations that need the identity key (§1 list).

### 3.4 Where PRF works (external research, 2026-09-15)

Summary from primary sources where available; cells marked [C] rest on Corbado's community-sourced matrix (updated Aug 2026: https://www.corbado.com/blog/passkeys-prf-webauthn) and must be re-verified in the spike.

| Environment | PRF | Source |
|---|---|---|
| Safari, iOS/iPadOS 18.4+ and macOS 15+, iCloud Keychain | Works (create + get) | [C]; Apple forums |
| Chrome/Edge + Google Password Manager (Android, desktop) | Works | [C] |
| Chrome/Edge on Windows 11 + Windows Hello | Works only with KB5077181 (Feb 2026) and Chrome/Edge 147+ | [C]; Bitwarden community, Jul 2026 |
| Windows 10 (Windows Hello) | **No** | [C] |
| Firefox desktop | Works; Android partial (149+) | Mozilla bugs 1863819, 1958716 |
| 1Password, Proton Pass, Keeper | Works | [C] |
| Dashlane, NordPass, Microsoft Password Manager, Bitwarden-as-provider | **No / broken** | [C]; vendor pages |
| iOS + external security key | No before iOS 26.4 | Yubico; WebKit blog |

Known pitfalls that shape the design:

- **Synced copies of one passkey can return different PRF output** (open Apple thread, Jul 2026: https://developer.apple.com/forums/thread/822523). → key-check values + fallback to another wrap or the phrase.
- **"Supported" flags lie.** Detect PRF only by `prf.enabled === true` at create **and** a real `get()` returning `prf.results.first`.
- **Output at `create()` is often absent.** Always follow registration with an immediate `get()`.
- **Safari deletes a site's IndexedDB after 7 days without first-party interaction** (https://webkit.org/tracking-prevention/). Users interact with RP apps, not `id.oxy.so`, so **a local-only envelope would be wiped**. This is why the server copy exists.
- Use `eval`, not `evalByCredential`, for discoverable sign-in.

### 3.5 No-PRF environments

When PRF is unavailable (Windows 10, Dashlane, NordPass…), the web carrier cannot seal the key under the passkey. Options (D3):

- **(a) Commons or another browser.** The account and passkey sign-in work; the identity is created only once the user moves to a PRF-capable environment or Commons. Until then, operations needing the key are unavailable. Honest, simplest, strongest.
- **(b) Phrase-gated carrier.** Create the identity, force the phrase to be written down and confirmed at sign-up, and require the phrase to unlock on each operation. Works everywhere, high friction.
- **(c) Device-bound WebCrypto key.** Wrap the DEK with a non-extractable AES key in IndexedDB. No user-verification gate, and Safari's 7-day purge removes it. Weakest.

Recommendation: **(a)**, with a clear message naming what works ("Use Safari, Chrome, or the Commons app to keep your identity on this device").

## 4. Recovery — identical for both carriers (decision 3)

There is no Oxy-side reset. The recovery ladder is the same wherever the identity lives:

1. **Another signed-in device** of the same identity → device transfer (Commons↔Commons, web→Commons).
2. **A synced passkey** (web carrier) → server envelope + PRF on the new device.
3. **The 12-word phrase** → derives the key directly, anywhere; the existing encrypted backup restores Commons.

If a user loses every device, every synced passkey **and** the phrase, the identity is gone. This is the honest cost of decisions 1 and 2 and must be stated plainly in the product. When to demand the phrase is D2.

## 5. Moving the identity into Commons (decision 4)

### 5.1 User flow

**Web** (Settings → Security → "Move my identity to Commons"):

1. If Commons is not installed: store link / QR to install it.
2. `id.oxy.so` shows a **QR**. On the same phone: an "Open in Commons" button instead (deep link), as sign-in does today.
3. **Commons:** "I already have an identity → Scan".
4. Both screens show the **same 6-digit code**: "Do you see this code on your phone?" → Yes.
5. Passkey + biometric on the web unlocks the entropy and seals it to Commons.
6. **Commons:** "Your identity is on this phone." **Web:** "Your identity now lives in Commons."

This is also Commons' missing "I already have an account" path, which prevents duplicate identities (§1).

### 5.2 Protocol — reuse the device-transfer relay, with four changes

Today's relay (`core/src/mixins/OxyServices.deviceTransfer.ts`, `api/src/routes/deviceTransfer.ts`, `api/src/services/deviceTransfer.service.ts`, table `device_pairing_sessions`): ephemeral secp256k1 ECDH → HKDF(salt = pairingId, info `oxy-device-transfer-v1`) → XChaCha20-Poly1305; QR carries only `pairingId`; 3-minute TTL; approval needs bearer **and** a fresh identity-key signature; `/device-pair` socket with poll fallback. **No app uses it yet.**

| # | Change | Why |
|---|---|---|
| 1 | **Invert who shows the QR.** Today the NEW device shows it and the OLD device scans (`deviceTransfer.ts:13-21`). Here the OLD carrier is usually a computer: `id.oxy.so` shows it, Commons scans. | Laptops don't scan phones |
| 2 | **Mandatory SAS.** Both sides derive a 6-digit code from `(pairingId, both ephemeral public keys)` and the user confirms equality before anything is sealed. Today SAS is "deferred per owner decision" and the relay is explicitly not hardened against an active backend MITM (`deviceTransfer.ts:24-25`; `deviceTransfer.service.ts:13-14`). | Without SAS, a malicious or compromised Oxy backend can substitute Commons' ephemeral key and receive the identity — exactly the custody Oxy must not be able to take |
| 3 | **Transfer the mnemonic entropy, not only `{ privateKey, publicKey }`** (today's payload, `deviceTransfer.ts:192`). Key-only identities (imported by raw private key) transfer the key and get Commons' existing key-only handling. | The key is `seed[0:32]`, but backup keys derive from the full seed (`identityBackup.ts:8-15`); a key-only import cannot back up or show the phrase (`commons/app/(tabs)/(settings)/backup-recovery.tsx:17-19`) |
| 4 | **Confirm before destroying.** Commons proves possession (signs a server challenge with the imported key); only after the web verifies it are the local and server envelopes deleted and the passkey wraps revoked. Any failure before that leaves the web identity intact. | A MOVE must never be a loss |

After the move the account keeps its passkeys for **sign-in**. Operations needing the key from the web are approved in Commons. A generic "sign this" request to Commons does not exist today (only sign-in approval does, `routes/auth.ts:1719`) — it is new work (§7, phase 5).

## 6. Threat model differences (web carrier vs Commons)

| Threat | Commons | Web carrier | Mitigation |
|---|---|---|---|
| Oxy server breach reads stored data | Backup ciphertext only | Envelope ciphertext only | PRF secret never leaves the authenticator; phrase never stored |
| **Malicious or compromised deploy of the code that handles the key** | Needs a store release (signed, reviewable, visible) | **Code is served on every load; a bad deploy can exfiltrate the key at the next unlock** | Isolated minimal origin, no third parties, strict CSP, published build hashes, release review. Residual risk accepted explicitly; Commons is presented as the stronger carrier |
| Browser extension / XSS | n/a | Real | Minimal origin, no user-generated content, strict CSP |
| **PRF salt is shared by every `*.oxy.so` origin** (RP ID `oxy.so`, `api/src/utils/origin.ts:59-66`) | n/a | A compromised subdomain could ask for the same PRF output behind a biometric prompt | Only `id.oxy.so` may request PRF (CI grep + review); server envelope retrieval requires a token issued to the `id.oxy.so` client and CORS restricted to it |
| Phishing | Approval inside the app | Passkey bound to `oxy.so` | — |
| Transfer MITM by backend | Not protected today | Same relay | Mandatory SAS (§5.2) |
| Apple/Google account takeover | Key is device-only | Synced passkey on attacker device + server envelope → key | Accepted for the web carrier; Commons avoids it; offer "move to Commons" prominently to users who want the stronger model |

## 7. Plan

| Phase | Scope | Unblocks |
|---|---|---|
| 0 — Spike | Re-verify §3.4 on real devices (PRF at create/get, synced-copy stability, iOS in-app browser storage) | Everything |
| 1 — Web carrier | `id.oxy.so` origin; envelope API + storage; sign-up creates the identity; web signing popup; **account deletion works for every account** | Front door |
| 2 — Existing passkey-only accounts | On next sign-in, prompt to create the identity on `id.oxy.so` and link it (query: `users.public_key IS NULL` + `user_auth_methods.type = 'webauthn'`; batch/dry-run pattern of `api/src/scripts/backfill-reputation-denorm.ts` for reporting) | No account left without a key |
| 3 — Move to Commons | Relay changes 1–4 (§5.2); Commons "I already have an identity → Scan" | Decision 4 |
| 4 — Account dialog | Passkey-first entry; Commons as upgrade card; native apps reach `id.oxy.so` through a non-ephemeral `ASWebAuthenticationSession` / Custom Tab (never holding the key themselves, per `docs/auth/index.md:84`); `apple-app-site-association` + `assetlinks.json` for native passkey sign-in (none exist today) | Newcomer UX on every platform |
| 5 — Sign requests to Commons | "Sign this" request/approval for moved identities | Web features after a move |

## 8. Decisions (approved by the owner, 2026-09-15)

- **D1 — Server copy of the envelope: yes.** Local-only storage is wiped by Safari after 7 days (§3.4), so an encrypted server copy Oxy cannot open is kept, exactly like the Commons backup that exists today. Not custody: Oxy cannot use or recover the key without the user's passkey or phrase.
- **D2 — When to demand the phrase: after sign-up.** The newcomer flow stays "Continue → passkey → username → done"; persistent prompts follow, and a second session or any operation that needs the identity key is blocked until the phrase is confirmed.
- **D3 — No-PRF environments: option (a)** (§3.5). The account and passkey sign-in work; the identity is created once the user is in a PRF-capable browser or Commons, with a message naming what works.
- **D4 — SAS is mandatory on every move**, including same-device deep links.
