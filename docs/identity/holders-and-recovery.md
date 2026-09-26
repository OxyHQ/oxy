# Accounts, sign-in and Commons — inventory

The living record for [ADR 0024](../adr/0024-one-oxy-account-root-holders.md) as
changed by [ADR 0029](../adr/0029-one-oxy-session.md) D3 and
[ADR 0030](../adr/0030-email-code-password-authenticator.md). The ADRs say why;
this page says what exists, who calls it, and what is still unverified or
unbuilt. Update the row when the code changes — a stale row here is a bug.

## Two kinds of personal account

| | Email account | Commons account (self-custody) |
|---|---|---|
| Created | in any app's dialog (`OxySignUpPanel`): username → email, confirmed with a 6-digit code → signed in | in Commons: a key and its recovery phrase (`/auth/register`) |
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
| Account email | An email account's `users.email`, set only by a verified sign-up. Not a profile field (`PUT /users/me` does not write it). It is how the account signs in. |
| Verification | One `email_verifications` row (`signup`, `signin` or `reauth`): a code sent (or, for a decoy, not sent), its attempts, and — for `signup` — the ticket its confirmation mints. |
| Sign-in request | One `email_signin_requests` row: the `signin` verification, the hashes of the dialog's `requestSecret` and the link token, the device the dialog proved, and whether it carries the long code. |
| Ticket | 32 random bytes (base64url) a confirmed sign-up code returns; stored as its SHA-256, spent once by `POST /auth/signup`. 15 minutes. |
| Root proof | A signature by the root over `buildIdentityProofMessage` claims, spending a one-use challenge (ADR 0024 D7). The only action left is `link_identity`. |

## Invariants and where they are enforced

| Invariant | Enforced by |
|---|---|
| An email account is created with a confirmed email and no key | `POST /auth/signup` spends the `signup` ticket (`spendSignupTicket`) in the transaction that creates the user |
| Only official Oxy apps and auth.oxy.so sign in or create accounts | `requireOfficialOrigin` on `/auth/signin/*`, `/auth/signup`, `/auth/email/*`; the link approval answers auth.oxy.so only (`requireAuthWebOrigin`) |
| Nothing says whether an email or username has an account | `start` answers the same for every case and records a decoy row when nothing is sent; a sign-up for a taken email sends a notice (no code); password sign-in runs the same scrypt work for any identifier (`verifyPasswordOrDummy`). Mail is dispatched without the response waiting on it |
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
| A root is replaced only by rotation | `POST /auth/rotate/*` (old-root + new-root proofs); rotation deletes the old root's backup |
| The DID of a personal root is controlled by the person | `buildDidDocument` → `controller: [userDid]` |
| `auth.oxy.so` runs no third-party analytics | No PostHog dependency or wiring; Pages headers in `sensitive` mode strip the Cloudflare beacon; `packages/auth/lib/__tests__/sensitive-origin.test.ts` |

## Routes

| Route | Authority required | Notes |
|---|---|---|
| `POST /auth/email/verify/start` | official origin, per-IP and per-email limits | `{ purpose: 'signup', email }` → `{ verificationId, expiresAt }`, whatever exists. |
| `POST /auth/email/verify/confirm` | official origin, the code | → `{ ticket, expiresAt }`. |
| `POST /auth/signup` | official origin + the ticket | `{ username, email, emailTicket, device? }` → session. |
| `POST /auth/signin/email/start`, `/confirm`, `/collect` | official origin; `confirm`/`collect` need the `requestSecret` | Code or link → session, or a second-factor challenge. |
| `POST /auth/signin/email/link` | auth.oxy.so + its device credential | Approves the request for the same browser only. |
| `POST /auth/signin/password` | official origin, identifier lockout | → session or second-factor challenge. |
| `POST /auth/signin/second-factor` | the challenge + a TOTP or backup code | → session. |
| `/users/me/sign-in-methods`, `/reauth/email`, `/password`, `/totp/*` | bearer, official origin, fresh proof | `routes/accountSecurity.ts`. |
| `GET /identity/root-status` | bearer, any first-party origin | `{ rootLinked, recoveryEmail }`. |
| `POST /identity/proof-challenge` | bearer | `link_identity` only. |
| `POST /auth/link` | bearer + root proof | Same-root heal or a keyed account only; an email account links through `/identity/link`. |
| `POST /identity/link` | bearer, official origin, an account with an email | Opens a link request; withdraws earlier open ones. |
| `GET /identity/link/:linkId` | the link id (either device) | `{ status, userId, username, publicKey, audience, expiresAt }`; 404 once expired. |
| `POST /identity/link/:linkId/proof` | the link id + a root proof over its challenge (Commons, no bearer) | First proof wins; a key another account holds is refused. |
| `POST /identity/link/:linkId/complete`, `DELETE` | bearer (the owner) + `reauth` | Links; withdraw. |
| `POST /auth/rotate/challenge`, `/complete` | old-root + new-root proofs, one-use challenge | Only way to replace a root. |
| `DELETE /users/me` | bearer + root signature (Commons) or `reauth` (email account) + typed username | Account deletion. |
| `/identity/backup*` | seed-derived locator | Commons' encrypted backup (full-seed HKDF). Unchanged. |

## Callers

| Caller | Uses |
|---|---|
| `packages/commons` | Commons sign-up (`/auth/register`, key included, no email), backup, deletion, linking a web account (`app/(auth)/link-account/`) |
| `packages/services` | `OxySignInPanel`, `OxySignUpPanel`, `OxyPasswordPanel`, `OxyAuthenticatorPanel`, `OxyDeleteAccountPanel`, `OxyLinkCommonsPanel` — in every app's dialog and account menu |
| `packages/auth` (`auth.oxy.so`) | `/login` renders `OxySignInPanel` (and sign-up with `?screen=signup`); `/email-signin` approves the link |
| `packages/accounts` | `GET /identity/root-status` and `/users/me/sign-in-methods` for the sign-in method rows (email, password, authenticator, "Link Commons") and the recommendation |

## Operator deletion

`packages/api/src/scripts/delete-accounts.ts` runs the same deletion workflow
(`services/accountDeletion.service.ts`) for named accounts: usernames or ids,
a dry run unless `--confirm`, and only `type = 'local'` and `kind = 'personal'`
accounts. In production it runs as a one-off ECS task on the API's task
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
