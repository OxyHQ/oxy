# Accounts, recovery and Commons — inventory

The living record for [ADR 0024](../adr/0024-one-oxy-account-root-holders.md) as
changed by [ADR 0029](../adr/0029-one-oxy-session.md) D3. The ADRs say why; this
page says what exists, who calls it, and what is still unverified or unbuilt.
Update the row when the code changes — a stale row here is a bug.

## Two kinds of personal account

| | Passkey account (the web) | Commons account (self-custody) |
|---|---|---|
| Created | on `auth.oxy.so/signup`: username → recovery email, confirmed with a 6-digit code → passkey | in Commons: a key and its recovery phrase (`/auth/register`) |
| `users.public_key` | `NULL` | the root |
| `users.email` | the confirmed recovery email | `NULL` — none is stored |
| Signs in with | a passkey, asserted only on `auth.oxy.so` (RP ID `oxy.so`) | Commons (QR, deep link, shared keychain) |
| Recovers with | a code sent to the recovery email, then a new passkey (`auth.oxy.so/recover`) | its recovery phrase, in Commons |
| Deleted with | the typed username and a passkey assertion (`auth.oxy.so/delete-account`) | its key, in Commons |
| DID controller | Oxy (custodial) | the person |

Commons is the official, recommended way: linking Commons to a passkey account
makes it self-custodied and deletes its recovery email (ADR 0029 D3). There is
no web identity carrier: no envelope, no web phrase, no PRF, no move.

## Vocabulary (for engineers, never for product copy)

| Term | Meaning |
|---|---|
| Root | A Commons account's secp256k1 key, linked as `users.public_key`. From a BIP-39 phrase (12–24 words): `seed[0:32]`. |
| Recovery email | A passkey account's `users.email`, set only by a verified sign-up. Not a profile field (`PUT /users/me` does not write it) and not a sign-in method. |
| Verification | One `email_verifications` row: a code sent (or, for a decoy, not sent), its attempts, and the ticket its confirmation mints. |
| Ticket | 32 random bytes (base64url) a confirmed code returns; stored as its SHA-256, spent once by registration. 15 minutes. |
| Root proof | A signature by the root over `buildIdentityProofMessage` claims, spending a one-use challenge (ADR 0024 D7). The only action left is `link_identity`. |

## Invariants and where they are enforced

| Invariant | Enforced by |
|---|---|
| A web account is created with a confirmed recovery email and a passkey, and no key | `POST /webauthn/register/verify` refuses a sign-up without `email` + `emailTicket` (`EMAIL_TICKET_REQUIRED`), spends the ticket in the transaction that creates the user, the credential and its auth method |
| Accounts are created and recovered only on `auth.oxy.so` | `/auth/email/*` answers only `getAuthWebOrigin()` and loopback; sign-up and recovery ceremonies reported from any other origin are refused (`isAuthWebOrigin`) |
| Nothing says whether an email or username has an account | `start` answers the same for every case; a sign-up for a taken email sends a notice (no code), a recovery naming nothing — or a Commons/managed account — sends nothing; both record a decoy row. `GET /auth/check-email` is deleted. Mail is dispatched without the response waiting on it |
| A code is guessed at most 5 times and lives 10 minutes | `confirmEmailVerification` (row lock, attempt counter, `expires_at` filter) |
| Codes are limited per address and per IP | 5 per hashed email per hour (counted from `email_verifications`); `rl:auth:email:*` keyed by `hashedIpKey` |
| No address, code or ticket is readable at rest | `email_hash` (`hashEmail`), `code_hash` (HMAC under `DEVICE_ID_SALT`), `ticket_hash` (SHA-256) |
| No IP is persisted | rate-limit keys only, via `hashedIpKey` |
| A ticket is spent once, by its purpose and its email | `spendSignupTicket` / `spendRecoveryTicket` — one conditional UPDATE inside the registration transaction |
| An account that linked Commons is recovered in Commons | The recovery branch of `/webauthn/register/verify` refuses an account with `public_key` set |
| Deleting a passkey account needs the person, not the session | `DELETE /users/me` with an `assertion` over a challenge from `POST /users/me/delete/options` (bound to the account, `authentication`, UV required, `auth.oxy.so` only); the confirmation is checked before the challenge is spent |
| A root is linked first-time only, with a fresh factor | `POST /auth/link` (proof + WebAuthn assertion over the same challenge) |
| A root is never unlinked | No route removes a root: `DELETE /auth/link/:type` does not exist; only `DELETE /auth/link/webauthn/:id` |
| A root is replaced only by rotation | `POST /auth/rotate/*` (old-root + new-root proofs); rotation deletes the old root's backup |
| The DID of a personal root is controlled by the person | `buildDidDocument` → `controller: [userDid]` |
| `auth.oxy.so` runs no third-party analytics | No PostHog dependency or wiring; Pages headers in `sensitive` mode strip the Cloudflare beacon; `packages/auth/lib/__tests__/sensitive-origin.test.ts` |

## Routes

| Route | Authority required | Notes |
|---|---|---|
| `POST /auth/email/verify/start` | `auth.oxy.so` origin, per-IP and per-email limits | `{ purpose: 'signup', email }` or `{ purpose: 'recovery', identifier }` → `{ verificationId, expiresAt }`, whatever exists. |
| `POST /auth/email/verify/confirm` | `auth.oxy.so` origin, the code | → `{ ticket, expiresAt, username }` (`username` for a recovery). |
| `POST /webauthn/register/options` | none (sign-up: `username`), recovery ticket, or bearer | A recovery challenge is bound to the account the ticket names. |
| `POST /webauthn/register/verify` | sign-up: `username` + `email` + `emailTicket`; recovery: `recoveryTicket`; link: bearer | Sign-up and recovery mint a session; link does not. |
| `GET /identity/root-status` | bearer, any first-party origin | `{ rootLinked, recoveryEmail }`. |
| `POST /identity/proof-challenge` | bearer | `link_identity` only. |
| `POST /auth/link` | bearer + root proof; keyless → also a fresh passkey assertion | First link only; same-root call heals the method row. |
| `POST /auth/rotate/challenge`, `/complete` | old-root + new-root proofs, one-use challenge | Only way to replace a root. |
| `DELETE /auth/link/webauthn/:id` | bearer | Keeps ≥1 auth method. |
| `POST /users/me/delete/options` | bearer, passkey account | WebAuthn request options over the account's passkeys. |
| `DELETE /users/me` | bearer + root signature (Commons) or passkey assertion (passkey account) + typed username | Account deletion. |
| `/identity/backup*` | seed-derived locator | Commons' encrypted backup (full-seed HKDF). Unchanged. |

## Callers

| Caller | Uses |
|---|---|
| `packages/commons` | Commons sign-up (`/auth/register`, key included, no email), backup, deletion |
| `packages/services` | `OxyCreateAccountPanel`, `OxyRecoverAccountPanel`, `OxyDeleteAccountPanel` (auth.oxy.so's pages); the account dialog opens auth.oxy.so in a window (`continueOnAuth`, ADR 0029 D1); "Delete account" on the web opens `auth.oxy.so/delete-account` |
| `packages/auth` (`auth.oxy.so`) | `/signup`, `/recover`, `/delete-account` render the services panels and continue to the request in the query |
| `packages/accounts` | `GET /identity/root-status` for the account-recovery row; passkey list/remove |

## Mail

Codes and notices go out through the outbound relay (`smtpOutbound.sendSystem`,
`Oxy <noreply@oxy.so>`, never stored in a mailbox and never queued — a code that
cannot be sent now is not worth sending later). A server with no relay answers
`start` with 503 `EMAIL_UNAVAILABLE`. Relay configuration:
`~/Oxy/docs/outbound-mail-relay.md`.

## Not verifiable from source

- Deliverability of the code mail to the major providers (SPF/DKIM alignment of
  the `noreply@` sender through each configured relay).
- iOS/Android: keychain access groups, the Android session broker, reinstall and
  biometric-change behavior, universal/app links for same-phone continuation.
- Non-technical usability of create → return → second app → recover.
- A content-addressed release manifest check of what `auth.oxy.so` serves.
