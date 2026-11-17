# ADR 0067 — Age bands, a date of birth at sign-up, and accounts below the minimum age

- Status: accepted
- Date: 2026-11-17
- Decision: the owner, 2026-11-17: a date of birth is required when a new account is created;
  an account for someone under 13 exists only under a guardian's supervision; from 13 to 17 a
  person has an account of their own with protections on by default.
- Builds on: [0041](0041-supervised-personal-policy.md) (supervision is a personal safety policy).
  Nothing in 0041 is superseded; this ADR adds one way a supervision profile comes to exist.
- Keeps: [0030](0030-email-code-password-authenticator.md)'s rule that sign-in and sign-up never
  reveal whether an account exists, and the no-IP invariant: nothing here derives a country.

## Context

Regulators restrict minors on social networks and on AI chatbots (Australia, the EU, Brazil), and
the restrictions are by age. Oxy did not know anyone's age: sign-up asked for a username and an
email, `users.date_of_birth` was an optional profile field the owner could set, change or clear at
will, and the one derived signal, `isAdult`, was readable only by the owner and absent for almost
every account. Supervision (ADR 0041) existed, but only as something an account opted into.

So no Oxy app could apply a protection by age, and every app that wanted one would have had to
ask for the date itself and derive its own threshold.

## Decision

1. **Sign-up asks for the date of birth.** The sign-up panel has a step for it between the username
   and the email. `POST /auth/signup` takes `dateOfBirth`; it is optional on the wire only while
   clients published before this ADR are in use, and becomes required once they are gone. An
   account created without one has no age band.

2. **Apps get a band, never the date.** `ageBand` is `under13`, `teen` (13 to 17) or `adult`,
   derived from the date on every read (`ageBandOf` in `@oxy.so/contracts`, UTC today) and never
   stored, so a birthday changes it with no write. An account with no date has no band: unknown is
   neither an adult nor a minor. The owner reads it on their own profile; an Oxy service reads it on
   the session it validates (`POST /safety/service/session`, first-party callers only); it is on no
   public profile and no third party receives it. `isAdult` stays, as `ageBand === 'adult'`.

3. **Below 13 the account is created under supervision, awaiting a guardian.** Sign-up creates the
   account private and, in the same transaction, a supervision profile with no guardian and
   `awaiting_guardian_since` set. Every policy read already fails closed on a profile with no
   guardian, so nothing the account reaches opens. The child invites a guardian through the
   existing invitation; that guardian's acceptance activates supervision exactly as a voluntary
   enrolment does (sessions revoked, account private) and clears the marker for good. Sign-up does
   not refuse the account and answers the same way whatever the date, so the age adds no way to
   probe for an account.

   On the wire the state is the existing `orphaned` (active, no guardian): the supervision contract
   is strict, and a new status would break every published client. The marker stays internal. It
   exists to tell a FIRST guardian from a replacement: once any guardian has held the profile, a
   change of guardian takes reviewed evidence, as ADR 0041 says.

   This does not infer guardianship from a birth date, which ADR 0041 forbids. The date decides
   that supervision is required; who the guardian is still takes both people's consent.

4. **A date of birth, once given, is the person's to correct only downwards.** Their own edit may
   keep the band or move to a younger one. It may not remove the date, and it may not move to an
   older band (`DATE_OF_BIRTH_LOCKED`): growing older on paper is how a protection would be shed.
   An existing account that declares a date under 13 is refused (`DATE_OF_BIRTH_SUPERVISION_REQUIRED`)
   and enrols through supervision, which takes the guardian's consent too.

5. **Moving to an older band is a reviewed correction.** A staff member, with fresh
   reauthentication and an evidence reference, corrects the date
   (`POST /safety/supervision/date-of-birth`, `oxy.safety.correctDateOfBirth`). It changes the date
   and nothing else: supervision stays until its own reviewed end, and an unsupervised account is
   not moved below 13. Each correction is a row in `supervision_audit`.

## Consequences

- Every app answers "is this a minor" the same way, from one derivation, and holds no birth date.
- Existing accounts have no band until their owner gives a date. They are not treated as minors
  and not as adults; an app that protects by default should say what it does for "unknown".
- The date is self-declared. A band is a basis for protective defaults, not proof of age; a
  requirement that needs proof needs age assurance, which this ADR does not provide.
- A person who mistypes an older date cannot fix it alone. That is the cost of the lock; the
  reviewed correction is the way out.
- An account created with a Commons key (`POST /auth/register`) carries no date yet and has no
  band until its owner gives one.

## Not in this ADR

Protective defaults per band (feed profile, autoplay, quiet hours), guardian-set limits, enabling
each application's reviewed supervision capabilities, and age assurance. Each is its own decision.
