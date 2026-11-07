# Accounts, sign-in and Commons — inventory

The living record for [ADR 0024](../adr/0024-one-oxy-account-root-holders.md) as
changed by [ADR 0029](../adr/0029-one-oxy-session.md) D3 and
[ADR 0030](../adr/0030-email-code-password-authenticator.md). The ADRs say why;
this page says what exists, who calls it, and what is still unverified or
unbuilt. Update the row when the code changes — a stale row here is a bug.

## Two kinds of personal account

| | Email account | Commons account (self-custody) |
|---|---|---|
| Created | in any app's dialog (`OxySignUpPanel`): username → email, confirmed with a 6-digit code → signed in | in Commons: a key and its recovery phrase, made on the device (offline too); the account is created at the username step — `/auth/register` with the key AND the username in one insert, never a key alone |
| `users.public_key` | `NULL` | the root |
| `users.email` | the confirmed email | `NULL` — none is stored |
| Signs in with | an emailed code or link, an optional password, plus the authenticator when it has one (`/auth/signin/*`) | Commons (QR, deep link, shared keychain) |
| Gets back in with | an emailed code or link — there is no separate recovery flow | its recovery phrase, in Commons |
| Deleted with | the typed username and a code sent to its email for `delete_account` (+ authenticator) | its key's signature (+ authenticator), in Commons |
| DID controller | Oxy (custodial) | the person |

Commons is the official, recommended way: linking Commons makes the account
self-custodied and deletes its email, password and authenticator (ADR 0029 D3,
ADR 0030 D1). There is no web identity carrier: no envelope, no web phrase, no
PRF, no move, and no passkey.

## Linking Commons to an email account

Two devices, one authority (a `link_identity` root proof over a one-use
challenge, plus a fresh email code for `link_commons`):

1. `OxyLinkCommonsPanel` (the account menu, and Accounts' "Link Commons" row
   and recommendation) opens a request — `POST /identity/link` →
   `{ linkId, challenge, qrPayload }` — and shows the QR
   `oxycommons://link?id=…&c=…`. The account needs an email to confirm with.
2. Commons, fresh on the phone ("I already have an account" → "I have an Oxy
   account on the web", `app/(auth)/link-account/`), scans it, reads the request
   (`GET /identity/link/:linkId`: the account id and username), creates its key
   and phrase without registering an account, signs the proof over the
   challenge and posts it with its key (`POST /identity/link/:linkId/proof`,
   no bearer; first proof wins).
3. Both screens show `deriveIdentityLinkCode(linkId, key)`; the person checks
   they match, so a photographed QR cannot slip another key in.
4. The panel completes it with a code just sent to the email
   (`POST /users/me/reauth/email {action:'link_commons'}`, then
   `POST /identity/link/:linkId/complete {reauth}`, + the authenticator code).
   In one transaction the challenge is spent, `users.public_key` and the
   `identity` method are written, and the email, its outstanding codes, the
   password and the authenticator are deleted; the email is told, and every
   other session is signed out.
5. Commons, polling the request, sees `completed` and signs in with its key;
   the recovery phrase is acknowledged as in any Commons sign-up. While it
   waits, the reconnect sync does not register the key as a new account
   (`lib/link-account/linkInProgress.ts`).

## Vocabulary (for engineers, never for product copy)

| Term | Meaning |
|---|---|
| Root | A Commons account's secp256k1 key, linked as `users.public_key`. From a BIP-39 phrase (12–24 words): `seed[0:32]`. |
| Account email | An email account's `users.email`, set by a verified sign-up, and added, changed or removed (only with a password set) in the account's security settings with fresh proof (ADR 0030 D9). Not a profile field (`PUT /users/me` does not write it). It is how the account signs in, and recovers. |
| Verification | One `email_verifications` row (`signup`, `signin` or `reauth`): a code sent (or, for a decoy, not sent), its attempts, and — for `signup` — the ticket its confirmation mints. |
| Sign-in request | One `email_signin_requests` row: the `signin` verification, the hashes of the dialog's `requestSecret` and the link token, the device the dialog proved, and whether it carries the long code. |
| Ticket | 32 random bytes (base64url) a confirmed sign-up code returns; stored as its SHA-256, spent once by `POST /auth/signup`. 15 minutes. |
| Root proof | A signature by the root over `buildIdentityProofMessage` claims, spending a one-use challenge (ADR 0024 D7). The only action left is `link_identity`. |

## Invariants and where they are enforced

| Invariant | Enforced by |
|---|---|
| An email account is created with a confirmed email and no key | `POST /auth/signup` spends the `signup` ticket (`spendSignupTicket`) in the transaction that creates the user |
| A device (QR) sign-in is an official application's only | `POST /auth/session/create` refuses a non-official application's device sign-in, and every approval and the claim re-read the registry (#2215). Those handed out before it are ended by `scripts/revoke-third-party-device-signins.ts` (dry run unless `--apply`; counts only): an owner step |
| Only official Oxy apps and auth.oxy.so sign in or create accounts | `requireOfficialOrigin` on `/auth/signin/*`, `/auth/signup`, `/auth/email/*`; the link approval answers auth.oxy.so only (`requireAuthWebOrigin`) |
| Nothing says whether an email or username has an account | `start` answers the same for every case and records a decoy row when nothing is sent; a sign-up mails its code whatever the address already holds (one email may hold several accounts, ADR 0040); password sign-in runs the same scrypt work for any identifier (`verifyPasswordOrDummy`). Mail is dispatched without the response waiting on it |
| A code is guessed at most 5 times and lives 10 minutes | `consumeEmailCode` / `confirmEmailVerification` (row lock, attempt counter, `expires_at` filter) |
| Codes are not guessable across requests | 10 wrong sign-in codes per account per requester per day, 50 per account per day overall; past that, the long code (`services/emailSignIn.service.ts`) |
| The link signs in only the browser that asked | `approveEmailSignInLink`: approves only when auth.oxy.so's proven device is the one the dialog proved at `start`; the session is collected with the dialog's `requestSecret` |
| A password is guessed at most 5 times per 15 minutes | `loginLockout.service.ts`, keyed on the identifier as typed (`identifierLockoutKey`) |
| The authenticator is enforced on every sign-in | `completeFirstFactor` returns a second-factor challenge and no session; only `completeSecondFactor` mints one (`services/signInSession.service.ts`) |
| Mail is limited per requester and per address | `reserveSendBudget` (hourly, hashed), plus `rl:auth:*` keyed by `hashedIpKey` |
| No address, code, ticket, password or TOTP secret is readable at rest | `email_hash` (`hashEmail`), `code_hash` (HMAC), tickets/secrets/link tokens (SHA-256), `user_passwords` (scrypt), `user_totp.secret_ciphertext` (AES-256-GCM), backup codes (HMAC) |
| No IP is persisted | rate-limit and lockout keys only, via `hashedIpKey` |
| Sensitive changes need the person, now | `services/reauth.service.ts`: the current password or a code for that action, + the authenticator |
| Deleting an account needs the person, not the session | `DELETE /users/me`: a Commons account signs `delete:{publicKey}:{timestamp}`; an email account sends a `delete_account` code (+ authenticator); the confirmation text is checked first. The workflow is `services/accountDeletion.service.ts` |
| A root is linked first-time only, with a fresh factor | `linkRootToAccount` (`services/identityLink.service.ts`), behind `POST /auth/link` and `POST /identity/link/:linkId/complete` |
| Linking Commons deletes the email, password and authenticator | `linkRootToAccount` / `completeLinkRequest`, in the linking transaction |
| A link request relays; it authorizes nothing | `identity_link_requests` keeps the challenge's hash, the first key and proof Commons posted; only the owner's `/complete` links |
| A root is never unlinked | No route removes a root |
| A root is replaced only by rotation | `POST /auth/rotate/*` (old-root + new-root proofs); rotation deletes the old root's backup (one of envelope version 2 or later, which carries retired keys, is KEPT marked `superseded_at` instead: `/status` answers `exists: false, superseded: true` (R7-2), its lookup answers `superseded: true`, a client restores its keys only as retired keys, and an upload replaces it only with `replacesLookupId`, its own locator, else 409 `IDENTITY_BACKUP_SUPERSEDED`; R6-8, R7-2. Commons carries that backup's keys into the ring BEFORE the swap and keeps its locator in the per-account owed entry, so a failed re-seal can finish later; another device acknowledges it by adding the previous phrase, `backup.create(phrase, { previousPhrase })`) and records the replaced root in `personal_identity_key_retirements`, in the same transaction. A backup upload whose `publicKeyHint` is not the current root's prefix is refused 409 (R6-9). A retired root is never any account's root or organization key again: every key writer refuses it as a key linked elsewhere (`identityKeyEverUsed`, `services/organizationKeyHistory.ts`) |
| A backup the person deleted stays deleted (owner's decision, 2026-11-07) | `DELETE /identity/backup` records it on the account (`identity_backup_opt_outs`, same transaction); `/status` answers `optedOut: true` on every device; `POST /identity/backup` stores nothing without the person's `optIn` (409 `IDENTITY_BACKUP_OPTED_OUT`), and an accepted opt-in removes the record. An upload where the account has NO backup row at all (never made, or deleted before the record existed) is accepted only with `optIn` too (409 `IDENTITY_BACKUP_OPT_IN_REQUIRED`, whose message asks an older Commons to update); re-sealing a backup the account has (current, or superseded with `replacesLookupId`) needs none, and a rotation supersedes the backup (any version) rather than deleting it so its re-seal finds the row. `oxy.identity.rotateKey` for such a person uploads nothing and marks nothing owed (`backupOptedOut`), unless they choose "Create an encrypted backup" on `rotate-key/confirm.tsx` (`createBackup`), which also says, before the swap, that they have no backup and that the previous key is then recoverable off this phone only with its recovery phrase. A person with no backup on record (never made, or deleted before 2026-11-07, when nothing recorded it) sees the same notice with the choice ticked, and unticking it (`createBackup: false`) uploads nothing; `rotateKey` refuses to rotate when no backup is on record and `createBackup` is not given, and Commons does not offer the rotation until it has read the status. `backup.isOwed()` drops an owed entry the person did not choose. Backup & recovery and Previous keys state the phrase-only recovery whenever there is no backup (ADR 0061 D7 point 11) |
| A rotation keeps the replaced root for spending, never for signing in | The Peable wallet seed and the social-receive tree derive from the root (`KeyManager.deriveScopedSeed`, `signSocialReceive`), and coins keep arriving under it after a rotation. `oxy.identity.rotateKey` keeps the replaced private key in the device's retired ring (`@oxy.so/core` `crypto/retiredKeys.ts`) BEFORE asking for the challenge, and does not rotate if it cannot; the wallet reaches it with the `publicKey` selector (Android: the identity host's `keyPublicKey`, wallet only). With the selector, `null` means DEFINITIVELY not held; a key this device may hold but cannot read now (a locked keychain, an unreadable ring, a Commons that did not answer or lists the key without using it) throws `IdentityUnavailableError` (R7-4), which a wallet treats as "try again", never as "not this key". A phone without it adds the previous phrase in Commons (Backup & recovery → Previous keys), accepted only when `GET /identity/key-history` lists its key as retired. `rotate-key/confirm.tsx` still refuses until `rotateKey.confirm.fundsConfirm` is ticked: the copy says what is kept and that a compromise-driven rotation must move the funds at once (ADR 0061 D7 as amended 2026-11-06, Peable ADR 0002) |
| The DID of a personal root is controlled by the person | `buildDidDocument` → `controller: [userDid]` |
| An organization's key is created and replaced only by its owners and admins, and signs nobody in | `services/organizationIdentityKey.service.ts`; every key sign-in refuses a non-personal account — [Organization identity keys](organization-keys.md) (ADR 0061) |
| `auth.oxy.so` runs no third-party analytics | No PostHog dependency or wiring; Pages headers in `sensitive` mode strip the Cloudflare beacon; `packages/auth/lib/__tests__/sensitive-origin.test.ts` |

## Routes

| Route | Authority required | Notes |
|---|---|---|
| `POST /auth/email/verify/start` | official origin, per-IP and per-email limits | `{ purpose: 'signup', email }` → `{ verificationId, expiresAt }`, whatever exists. |
| `POST /auth/email/verify/confirm` | official origin, the code | → `{ ticket, expiresAt }`. |
| `POST /auth/signup` | official origin + the ticket | `{ username, email, emailTicket, device? }` → session. |
| `POST /auth/signin/email/start`, `/confirm`, `/collect`, `/choose` | official origin; `confirm`/`collect`/`choose` need the `requestSecret` | Code or link → session, a second-factor challenge, or (an email holding several accounts) the accounts to choose from, then `/choose`. |
| `POST /auth/signin/email/link` | auth.oxy.so + its device credential | Approves the request for the same browser only. |
| `POST /auth/signin/password` | official origin, identifier lockout | → session or second-factor challenge. |
| `POST /auth/signin/second-factor` | the challenge + a TOTP or backup code | → session. |
| `/users/me/sign-in-methods`, `/reauth/email`, `/password`, `/totp/*` | bearer, official origin, fresh proof | `routes/accountSecurity.ts`. |
| `GET /identity/root-status` | bearer, any first-party origin | `{ rootLinked, recoveryEmail }`. |
| `POST /identity/proof-challenge` | bearer | `link_identity` only. |
| `GET /identity/key-history` | bearer, first-party (`requireFirstPartyDeviceAccess`), personal account | `{ publicKey, retired: [{ publicKey, retiredAt }] }`, oldest first, canonical keys. |
| `POST /identity/key-history/claim` | bearer, first-party, personal account; a signature by the claimed key over `{ action: 'claim_retired_identity_key', userId, publicKey, timestamp }` (5 min) | Adds a root replaced before the history existed (migration 0235) only when Oxy's OWN records prove it was this account's: a verified, self-issued `signed_records` row signed by it (its signer was resolved from this account's identity keys at write time). 404 `IDENTITY_KEY_NOT_PROVEN` otherwise; 409 for the current root or another account's history; answers the history. Commons asks for its quarantined personal keys (`oxy.identity.claimQuarantinedKeys`, R6-5). `scripts/backfill-personal-key-retirements.ts` (dry run unless `--apply`) adds every key those records prove, for every account: an owner step. |
| `POST /auth/link` | bearer + root proof | Same-root heal or a keyed account only; an email account links through `/identity/link`. |
| `POST /identity/link` | bearer, official origin, an account with an email | Opens a link request; withdraws earlier open ones. |
| `GET /identity/link/:linkId` | the link id (either device) | `{ status, userId, username, publicKey, audience, expiresAt }`; 404 once expired. |
| `POST /identity/link/:linkId/proof` | the link id + a root proof over its challenge (Commons, no bearer) | First proof wins; a key another account holds is refused. |
| `POST /identity/link/:linkId/complete`, `DELETE` | bearer (the owner) + `reauth` | Links; withdraw. |
| `POST /auth/rotate/challenge`, `/complete` | old-root + new-root proofs, one-use challenge | Only way to replace a root. |
| `DELETE /users/me` | bearer + root signature (Commons) or `reauth` (email account) + typed username | Account deletion. |
| `POST`, `DELETE /identity/backup` | bearer, first-party (`requireFirstPartyDeviceAccess`, R7-1) | Commons' encrypted backup (full-seed HKDF). `version` at most `IDENTITY_BACKUP_MAX_VERSION` (2); never over a superseded backup without `replacesLookupId` (R7-2); never over the person's deletion, and never where the account has no backup, without `optIn` (2026-11-07). `DELETE` records the deletion. |
| `GET /identity/backup/status` | bearer | `{ exists, superseded?, optedOut?, publicKeyHint?, createdAt? }`. |
| `GET /identity/backup/:lookupId` | seed-derived locator (public) | The envelope, `superseded: true` for one a rotation kept. |

## Callers

| Caller | Uses |
|---|---|
| `packages/commons` | Commons sign-up (`/auth/register`: key + required username, no email; offline, the chosen username waits in secure storage and the reconnect sync registers with it), backup, deletion, linking a web account (`app/(auth)/link-account/`) |
| `packages/services` | `OxySignInPanel`, `OxySignUpPanel`, `OxyPasswordPanel`, `OxyAuthenticatorPanel`, `OxyDeleteAccountPanel`, `OxyLinkCommonsPanel` — in every app's dialog and account menu |
| `packages/auth` (`auth.oxy.so`) | `/login` renders `OxySignInPanel` (and sign-up with `?screen=signup`); `/email-signin` approves the link |
| `packages/accounts` | `GET /identity/root-status` and `/users/me/sign-in-methods` for the sign-in method rows (email, password, authenticator, "Link Commons") and the recommendation |

## Operator deletion

`packages/api/src/scripts/delete-accounts.ts` runs the same deletion workflow
(`services/accountDeletion.service.ts`) for named accounts: usernames or ids,
a dry run unless `--confirm`, and only `type = 'local'` and `kind = 'personal'`
accounts with no email. An account with a key is refused unless `--allow-key`,
which is only for identities Oxy itself created (test, emulator and E2E keys, and
key registrations abandoned before a username), never a person's account. In production it runs as a one-off ECS task on the API's task
definition (`node packages/api/dist/scripts/delete-accounts.js …`).

## Mail

Codes, links and notices go out through the outbound relay
(`smtpOutbound.sendSystem`, `Oxy <noreply@oxy.so>`, never stored in a mailbox
and never queued — a code that cannot be sent now is not worth sending later).
Links always point at `https://auth.oxy.so`, never at an app. A server with no
relay answers `start` with 503 `EMAIL_UNAVAILABLE`. Relay configuration:
`~/Oxy/docs/outbound-mail-relay.md`.

## Not verifiable from source

- Deliverability of the code mail to the major providers (SPF/DKIM alignment of
  the `noreply@` sender through each configured relay).
- iOS/Android: keychain access groups, the Android session broker, reinstall and
  biometric-change behavior, universal/app links for same-phone continuation.
- Non-technical usability of create → sign in by link → second app.
- A content-addressed release manifest check of what `auth.oxy.so` serves.
