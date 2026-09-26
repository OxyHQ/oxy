# ADR 0030 — Email, code, password and authenticator; passkeys removed

- Status: accepted; implemented (#1421 the API, #1422 the dialog, the passkey
  removal in the change that adds this ADR)
- Date: 2026-09-26
- Decided by: the owner (product direction, "súper seguro"), recorded here
- Changes: ADR 0029 D1 (no auth.oxy.so window in an app's sign-in; only the
  bridge window) and D3 (an account without a key signs in by email, not with a
  passkey); ADR 0028 (no passkey, so no RP ID `oxy.so` and no ceremony page on
  auth.oxy.so); ADR 0024 D2's "new credentials keep RP ID `oxy.so`" and every
  passkey-as-authenticator line of D3–D9.
- Reverses: "no password" and "no email" in ADR 0024,
  `docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md` and
  the dialog docs of issue #691 Phase 5.

## Context

A passkey belongs to one registrable domain. Oxy's is `oxy.so`, so
mention.earth, alia.onl or willo.sh could never ask for it themselves: every app
outside `*.oxy.so` had to open auth.oxy.so's window for the one step that
mattered, and WebAuthn Related Origin Requests cap the fix at five labels for a
dozen apps. The owner wants a person to sign in **inside the app**, from Oxy
services' own dialog, like Google's steps. There are no real users yet, so the
passkeys go completely: routes, tables, SDK methods, UI, copy and docs.

## Decision

### D1 — Signing in is by steps, in the dialog of every app

1. Email or username (`POST /auth/signin/email/start`).
2. One email carries a 6-digit code **and** a link; either signs in
   (`…/confirm` with the code, or the link's approval collected by
   `…/collect`).
3. "Use your password instead" (`POST /auth/signin/password`), for an account
   that set one.
4. When the account has an authenticator, one more step
   (`POST /auth/signin/second-factor`, a TOTP code or a backup code).

Creating an account is username → email → code → signed in
(`POST /auth/email/verify/*` with `purpose: 'signup'`, then
`POST /auth/signup` spending the ticket). A password and an authenticator are
added later in settings. Recovery is not a separate flow: a person who lost
their password signs in by email.

Commons stays the official self-custody way (the QR in the dialog). Linking it
deletes the email, the password and the authenticator (D6). The browser bridge
of ADR 0029 D2 is unchanged and is the only window an app opens.

auth.oxy.so keeps `/login` (the same services panel), `/authorize`, `/device`,
`/mcp/link`, `/bridge`, and adds `/email-signin` where the link lands. Its
`/signup`, `/recover`, `/delete-account` and `/link-commons` pages are deleted:
those are services panels in the dialog and in Accounts.

### D2 — Nothing says whether an account exists

`start` answers every identifier the same way and does the same work — a real
account, one that cannot sign in by email (a Commons or managed account), and
none at all each get an `email_verifications` row and an `email_signin_requests`
row; only a real account is mailed, after the answer is decided and without
awaiting the relay (`services/emailSignIn.service.ts`). A sign-up for a taken
email sends a notice instead of a code (`services/accountEmail.service.ts`).
Password sign-in runs the same query and the same scrypt work for an unknown
name, an account without a password and a wrong password
(`verifyPasswordOrDummy`, `routes/signIn.ts`). Every failure is one generic
error.

### D3 — Brute force is bounded at every step

- **Codes**: 6 digits, 10 minutes, 5 attempts per code
  (`EMAIL_CODE_TTL_MS`, `EMAIL_CODE_MAX_ATTEMPTS`), HMAC-stored and compared in
  constant time. Across requests, 10 wrong codes per account per requester per
  day, and a ceiling of 50 per account per day from everyone together. Past the
  ceiling, a 6-digit code is refused unless the request comes from a device the
  account is already on, and every new email that day carries a **long code**
  (10 characters, `XXXXX-XXXXX`, `EMAIL_SIGNIN_LONG_CODE_*`) the ceiling does
  not apply to — the owner can still sign in, nobody can guess. The link keeps
  working throughout.
- **Password**: `loginLockout.service.ts`, 5 failures per 15 minutes per
  identifier AS TYPED (whether or not it names an account), reserved atomically
  before the check; a locked identifier costs no scrypt work.
- **Authenticator**: its own lockout scope (`totp`), separate from the
  password's; a second-factor challenge lives 5 minutes and takes 5 attempts
  (`SIGNIN_SECOND_FACTOR_*`).
- **Mail**: per hashed-requester and per-address hourly send budgets, with a
  reserved slice for a device the account is already on
  (`reserveSendBudget`); an over-budget request is answered like any other and
  sends nothing.
- Every route has an IP limiter keyed by `hashedIpKey`. **No IP is persisted**,
  raw, hashed or derived: the requester key lives only in the lockout store.

### D4 — The link signs in only the browser that asked

The dialog receives a `requestSecret` at `start` (stored as its SHA-256,
`email_signin_requests.request_secret_hash`) and is the only party that can
confirm the code or collect the session. The link (one use, 15 minutes,
`EMAIL_SIGNIN_LINK_TTL_MS`) always points at `https://auth.oxy.so/email-signin`,
never the app. The page proves its own credential for the browser's shared
device, and the request is **approved only when that is the device the dialog
proved at `start`** — the same browser, thanks to the bridge. Elsewhere it says
"enter the code in the app". So a link requested for someone else's email and
opened by its owner approves nothing for the requester, and whoever opens a
link never receives a session. Every spend (code, link, approval) is one
conditional update filtered on expiry: it signs in at most once.

### D5 — Secrets at rest

- Password: `node:crypto` scrypt, N=2^15, r=8, p=3 (32 MiB), 16-byte salt,
  self-describing `$scrypt$v=1$ln=15,r=8,p=3$…` so parameters can rise without a
  migration, NFKC-normalised, constant-time compare, bounded concurrency
  (`services/password.service.ts`). 10–256 characters.
- TOTP (RFC 6238, SHA-1, 30 s, 6 digits, ±1 step, never the same step twice):
  the secret is sealed with AES-256-GCM under an HKDF-derived key, with the
  row's identity as AAD (`utils/secretBox.ts`); 10 one-use backup codes stored
  only as HMACs (`services/totp.service.ts`).
- Codes are HMACs; tickets, link tokens and request secrets are SHA-256. None
  appears in a log or a response after it is issued; the protected-columns
  census enforces it.

### D6 — Sensitive changes need the person, now

Setting a password, turning the authenticator on or off, new backup codes,
linking Commons and deleting the account each carry a fresh proof in the same
request (`services/reauth.service.ts`): the current password or a code just
sent to the email for THAT action (`REAUTH_ACTIONS`: `change_password`,
`totp`, `link_commons`, `delete_account`), plus the authenticator code when it
is on. Each change is told to the account's email; turning the authenticator on
or off and linking Commons sign every other session out, a password change does
when asked. A Commons account deletes with its key's signature (plus its
authenticator code, if any).

### D7 — Who may call

The sign-in routes answer only official Oxy apps and auth.oxy.so
(`requireOfficialOrigin`; the link approval, auth.oxy.so only). A session is
minted by one tail (`services/signInSession.service.ts`): an account with an
authenticator gets a second-factor challenge and no session until it passes,
and a request that proves the browser's device is signed in ON it
(`finalizeDeviceLogin`). Third parties sign in with OAuth + PKCE on auth.oxy.so,
unchanged.

### D8 — The passkey is gone

Deleted: `routes/webauthn.ts` and `DELETE /auth/link/webauthn/:id`; the
`webauthn` auth-method type (`AUTH_METHOD_TYPES` is `['identity']`: the only
auth method is a Commons root; email, password and authenticator are sign-in
factors, not DID verification methods); `@simplewebauthn/*`;
`WEBAUTHN_RP_ID`, `getWebauthnRpId` and `isOxyApexOrigin`; the `webauthn`
contracts and core methods; the `recovery` email purpose and its ticket
(recovery is signing in by email).

`0118_drop_passkeys` is a `post` migration: it drops `webauthn_credentials`
and `webauthn_challenges`, deletes the passkey rows of `user_auth_methods` and
its `method_credential_id` and `method_name` columns, narrows its type check to
`identity`, and deletes the `recovery` rows of `email_verifications` before
narrowing its purpose check to `signup`, `signin`, `reauth`. It ships in a
release after the `pre` migration that added the email tables (0116); no `pre`
may sit behind it in the same release, because the deploy's `pre` run stops at
the first unapplied `post`.

Account deletion is one reusable workflow, `services/accountDeletion.service.ts`
(financial holds first, then the closure fence, the optional data, and archive
or delete with the `account.deleted` event), used by `DELETE /users/me` and by
the operator script `scripts/delete-accounts.ts` (usernames or ids; a dry run
that prints each account, its holds and the planned outcome unless `--confirm`
is given; it refuses anything but `type = 'local'` and `kind = 'personal'`).
The script is how the passkey-only test accounts that could no longer sign in
were removed.

## Consequences

- Every app signs in inside its own dialog, on every domain; the only window is
  the bridge, once per browser.
- An account without Commons trusts Oxy and its mailbox: whoever controls the
  email can sign in (plus the authenticator, if set). Commons is how a person
  takes that away from Oxy — linking it deletes the email, password and
  authenticator.
- The email carries sign-in authority, so its budgets, decoys and the
  same-browser link rule are part of the security boundary, not conveniences.
