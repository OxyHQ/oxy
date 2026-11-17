# ADR 0068 — Protective defaults by age band, and quiet hours

- Status: accepted
- Date: 2026-11-17
- Decision: the owner, 2026-11-17: from 13 to 17 a person has an account of their own with
  protections on by default (no autoplay, a chronological feed, quiet hours).
- Builds on: [0067](0067-age-bands-and-accounts-below-the-minimum-age.md) (the age band).

## Context

ADR 0067 gives every Oxy app the same answer to "is this a minor". It does not say what an app
does with the answer. Left to each app, one would turn autoplay off, another would not, and each
would pick its own hours. Regulators name the mechanics directly: ranked feeds, endless scroll,
autoplay and night-time notifications.

## Decision

1. **One derivation of the defaults.** `protectionsFor(ageBand)` in `@oxy.so/contracts` returns
   what an app applies. For `under13` and `teen`: `feedProfile: 'protected'` (posts in the order
   they were posted, no ranking by engagement, pages loaded on request instead of an endless
   scroll), `autoplay: 'never'`, and `quietHours` 22:00 to 07:00. For `adult` and for an account
   with no band: the standard profile. An app reads the band on the session it validates and
   derives the rest; nothing is stored and nothing is fetched.

2. **Quiet hours are local to the person.** The window is read on the account's own timezone
   (`users.preference_timezone`), UTC when there is none. Oxy answers "which of these accounts
   are quiet now" to its own services (`POST /safety/service/quiet-hours`,
   `OxyServer.accountsInQuietHours`): the quiet subset and nothing else, no age, band or zone.

3. **Quiet hours hold back what can wait, never what protects the account.** A new post or a new
   email waits until morning; it is still there, unread. A sign-in to approve or an account
   notice is sent at once. So the push service does not apply quiet hours by itself: each sender
   decides. Oxy's own new-mail push honours them; its sign-in approval and account notices do not.

4. **Defaults, not verdicts.** The band comes from a self-declared date. These are protective
   defaults for accounts that say they belong to a minor, not a claim that anyone's age was
   verified, and an account of unknown age is not treated as a minor.

## Consequences

- Every app protects the same people the same way, from one function.
- An existing account with no date of birth gets nothing new. Asking those accounts for a date is
  a product decision of its own.
- A minor who travels keeps the timezone on their account until they change it.

## Not in this ADR

Guardian-set limits for a supervised account, a daily time limit (Oxy measures no app usage), and
what each app does for "unknown". Each is its own decision.
