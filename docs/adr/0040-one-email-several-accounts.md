# ADR 0040 — One email, several accounts

- Status: accepted; implemented in the change that adds this ADR
- Date: 2026-10-15
- Decided by: the owner of Oxy
- Changes: ADR 0030 D1 (signing in with an email can end in a choice of
  account) and D2 (a sign-up for an address that already has an account gets a
  code, not a notice).

## Context

`users.email` was unique (`users_lower_email_key`), so one person could not
keep a second account (work, a project, a persona) on the address they
already use. The owner wants several accounts on one address, with one rule:
an email reaches every account on it; a username reaches only that account.

## Decision

### D1 — An email may hold several accounts

The unique index becomes a plain index on the same expression
(`users_lower_email_idx`). One address holds at most `EMAIL_ACCOUNTS_MAX`
(20) accounts; a sign-up past it is refused (`EMAIL_ACCOUNTS_FULL`), with the
count serialised per address. The sign-up `start` mails the code whatever the
address already holds; the "an account already uses it" notice is deleted.

### D2 — Which account signs in

- **By username**: that account, and only it. Its code goes to its email, as
  before; the account switcher then shows it and the accounts it operates, not
  the other accounts on the same email.
- **By email**: the request names the mailbox (`email_signin_requests.mailbox`),
  not an account. Once the code (`…/confirm`) or the link (`…/collect`) proves
  it, the accounts that can sign in by email (personal, active, no Commons key)
  are read by the verification's email hash. One account signs in directly.
  Several: the answer is `{ chooseAccount: true, accounts, expiresAt }`, the
  request is marked `proven_at` and lasts `EMAIL_SIGNIN_CHOICE_TTL_MS`
  (5 min), and `POST /auth/signin/email/choose { requestId, requestSecret,
  userId }` signs the chosen one in (its authenticator still applies). One
  proof signs in one account; the request is then spent.
- **By password**: an email with several accounts cannot say which one, so it
  is answered like a wrong password (the same one query and scrypt work); the
  message says to use the username.

Proving the mailbox already let its owner sign in to each of its accounts one
by one, so the choice hands over nothing new. It is shown only to the holder of
`requestSecret`, after the proof; `start` still answers every address the same
way, so nothing says whether, or how many, accounts an address holds.

### D3 — Limits are per mailbox

The daily ceiling on sign-in code guesses is keyed by the mailbox the codes go
to, whichever identifier asked, so a username and the email it shares with
other accounts do not each get their own guesses at the same inbox. The send
budgets were already per address.

### D4 — Lookups that needed one account

A member invite by email (`resolveUserByIdentifier`) refuses an email that
holds several accounts (409, "use the username") instead of picking one.
Contact discovery by email hash already returned every match.

## Consequences

- `@oxy.so/contracts` adds the choice types, `emailSignInChooseRequestSchema`,
  `isEmailSignInChooseAccount`, `EMAIL_ACCOUNTS_MAX`,
  `EMAIL_SIGNIN_CHOICE_TTL_MS` and `EMAIL_ACCOUNTS_FULL`; `@oxy.so/core` adds
  `oxy.auth.email.choose` and `confirm`/`collect` may answer the choice;
  `@oxy.so/services`' sign-in panel shows it.
- Migration 0164 (`pre`): the index swap and the two request columns.
