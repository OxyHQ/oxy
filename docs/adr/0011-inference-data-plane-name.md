# ADR 0011 — The inference data plane's production name is `Relay`, it is customer-facing, and all four prohibitions on its public use are lifted — with trademark clearance and name availability never checked

- Status: accepted (decided; the prohibitions this ADR imposed are lifted)
- Date: 2026-08-15
- Closed: 2026-08-17 — the deferral this ADR originally recorded is resolved. The
  owner accepted the name on 2026-08-17 and lifted all four prohibitions, with
  criteria 1 and 3 outstanding. See "How this ADR closed".
- Issue: #972

## Context

The epic called the inference data plane **Relay** and marked it a working name.
Naming decisions are cheap to make and expensive to unmake: a name that reaches
npm, a public documentation page or a URL path acquires consumers who did not
agree to a rename, and the migration cost is paid by them. This ADR was written
to hold that option open, and it did.

Two facts argued against adopting `Relay` by default, and both are still
checkable in this repository:

- **The word is already load-bearing as a common noun here.** The device-transfer
  relay (`packages/api/src/routes/deviceTransfer.ts:9-12`,
  `packages/api/src/db/schema/devicePairingSessions.ts:2`), the SMTP relay
  (`packages/api/src/config/email.config.ts:39`,
  `packages/api/src/services/smtp.outbound.ts:62`) and the atproto Relay
  (`packages/api/src/utils/atproto.constants.ts:12`) all use it in unrelated
  senses. A proper noun colliding with a common noun already used in the same
  codebase makes every future grep, log line and comment ambiguous.
- **`Relay` is an established term of art in the federation space Oxy already
  interoperates with.** In atproto, a Relay is a specific network role. Naming an
  inference data plane the same thing inside a repository that also implements
  atproto and ActivityPub creates a durable, avoidable confusion.

Neither fact was decisive, and neither has gone away. Both were inputs to a
review, and the owner has now made the call with them on the table.

## Decision

**The production name of the inference data plane is `Relay`.**

The owner decided this on 2026-08-15 (#972 comment, 2026-08-15T20:58:58Z: "Yes,
production name should be Relay."). The name is settled and no further ADR
decides it.

**`Relay` is customer-facing, and all four prohibitions this ADR imposed are
lifted.** The owner answered criterion 4 — "is it customer-facing at all?" — YES,
on 2026-08-17, and lifted the prohibitions with it. Concretely, `Relay` may now
appear in:

- a **published npm package name**, including a scope or a subpath export;
- **public documentation** — Console pages, developer docs, SDK reference
  material, and error messages a customer can see;
- a **public API path, header, query parameter, event type or wire field**;
- a **public repository, domain, subdomain or DNS record**.

`OxyHQ/Relay` is a PUBLIC repository — created 2026-08-16T11:55:46Z, Go,
described as "Oxy inference data plane: provider adapters, routing execution,
streaming, deployments, health and technical metering. Control plane is
OxyHQ/oxy." It was created while prohibition 4 stood, so it was a violation of
this ADR for a day. That is now **regularized** by this decision rather than
standing as an exception to it — the repository's public name is permitted, not
tolerated.

**Lifted means permitted, not mandated.** Nothing here obliges any surface to use
the name, and no wire field is renamed by this decision: ADR 0010's envelope stays
role-named (see Consequences). A PR that puts `Relay` on a Console page or in a
published package no longer needs a rule checked against it — but it also gains no
instruction to do so, and the reasons the word is ambiguous in this codebase
(criterion 2 below) have not gone away.

**What is NOT decided by this, and is the reason the title says so:** trademark
clearance and name availability were never checked. See criteria 1 and 3, and the
risk statement in Consequences. The name is now in a position where those checks
would have mattered, and they were not run.

### The five criteria, resolved

Recorded here as the closing procedure below requires. Two are answered, one is
overruled, **two are OUTSTANDING and were never run** — and the outstanding ones
are named rather than ticked. The decision was taken with them open; that is a
fact about the decision, not a gap in the record.

1. **Trademark clearance** — **NOT DONE, and outstanding.** No search was run, no
   search is recorded, and nothing in this repository or the issue thread
   references one. The owner accepted the name on 2026-08-17 and lifted all four
   prohibitions with this criterion open. This is stated plainly because a
   criterion marked met on the strength of nobody having objected is worse than an
   open one — and because the lift is what makes it expensive (Consequences).
2. **No collision with an established term of art in a protocol Oxy implements**
   — **CONSIDERED AND OVERRULED.** The atproto collision described in the Context
   above was raised in this ADR before the decision and the owner decided anyway,
   which is a legitimate outcome: the criterion asked for the collision to be
   known, not for it to be absent. How the ambiguity is handled: the proper noun
   `Relay` denotes the inference data plane and nothing else; the existing
   common-noun uses (device transfer, SMTP) and `atproto.constants.ts`'s network
   role keep their spellings and are disambiguated by their module, not by the
   word. The rule that keeps this survivable is the one in Consequences below —
   Oxy-side identifiers name the *role* (`resolvedModelReference`,
   `servingProvider`, `deploymentId`), so no data structure has to be read as
   "which Relay".
3. **Domain and package-name availability** — **NOT DONE as the criterion asked,
   and outstanding.** The criterion asked for availability "on the registries that
   will actually be used", and no registrar was checked at all. What WAS measured,
   2026-08-17: `@oxyhq/relay` is not published (npm returns 404), and no
   `package.json` in this monorepo declares a name, `bin` or subpath export
   containing `relay` — a census with a positive control, since the same test does
   see `@oxyhq/core`'s `./server` subpath. That answers "is the scoped npm name
   free today" and nothing else. NOT measured: any domain or DNS registry, and the
   unscoped `relay` name on npm. Both are now permitted uses, so the gap is no
   longer academic.
4. **Whether the name is customer-facing at all** — **ANSWERED: YES, 2026-08-17.**
   The owner decided the name is customer-facing and lifted all four prohibitions.
   The alternative — "the Oxy inference data plane", an internal component with no
   public name, no rename risk, no trademark exposure and no term-of-art collision
   — was available and was not taken. Recording that it was available is the point:
   this was a choice between two viable outcomes, not a default.
5. **Owner sign-off** — **MET, twice.** The name on 2026-08-15 (#972 comment,
   2026-08-15T20:58:58Z, "Yes, production name should be Relay."), and the scope —
   customer-facing, prohibitions lifted — on 2026-08-17.

### The deferral cost nothing, and that is checkable — but the lift ends that

The reason it was cheap to hold the option open is that this ADR's own consequence
about wire fields was honoured. Measured 2026-08-17: zero field names in
`packages/contracts/src/` begin with `relay`, against a positive control of 14
occurrences of the role-named `resolvedModelReference` / `servingProvider` /
`deploymentId` in `packages/contracts/src/inference/`. While the prohibitions
stood, abandoning the name would have touched internal identifiers and a
repository name and **no wire contract, no published package and no customer-
visible string at all**.

That property is a consequence of the prohibitions, not of the name, so lifting
them ends it. See the risk statement in Consequences.

### How this ADR closed

As the original text specified: **updated in place** — the name recorded, the
criteria resolved with their dates, the status changed from deferred to decided.
It is not superseded by a new ADR, because the reason a reader arrives here is to
learn what the data plane is called, and that question has one answer at one
address.

It closed in two steps, a day apart, and both are recorded because the second is
the one with teeth: the NAME on 2026-08-15, and the SCOPE — customer-facing, all
four prohibitions lifted — on 2026-08-17. A reader who needs to know whether
`Relay` may ship in a customer-visible string has exactly one place to look, and
the answer is yes.

The procedure did not anticipate closing with two of its own criteria unrun. They
are therefore left standing as open items in the criteria list above rather than
being dropped as spent, because the decision did not make them false — it made
them consequential.

## Alternatives rejected

**Adopt `Relay` now and rename later if review objects.** Rejected in the
original deferral, and the deferral is what made the eventual decision free: by
the time the name was settled, nothing published depended on it.

**Pick a different name immediately to avoid the collisions above.** It would
have replaced an unreviewed name with another unreviewed name and consumed the one
thing deferral preserved — the option to conclude the component needs no public
name at all. That option was live until 2026-08-17 and was not taken.

**Leave the name unspecified with no rule.** A working name with no boundary is
adopted by accident — the first package that needs a directory takes it, and by
the time review happens the decision has already been made by a filename.

**Record the decision in a new ADR (0015) and mark this one superseded.**
Rejected because this ADR specified its own closing procedure, `docs/adr/README.md`
sanctions exactly this case ("An ADR is updated in place only to record its own
closure"), and splitting the answer across two files means the next reader finds
the deferral first.

**Keep the name and hold the prohibitions — an internally-named component with no
public name.** This was the cheapest outcome on every axis the criteria measure: no
rename risk, no trademark exposure, no term-of-art collision with atproto, and
nothing published that a failed clearance could strand. It was rejected by the
owner on 2026-08-17 in favour of a customer-facing name. Recorded here rather than
dropped, because it is the alternative a future reader will want to know was
considered if criterion 1 ever comes back badly.

**Lift the prohibitions only for the ones already needed (the repository), and
hold the rest.** This would have regularized `OxyHQ/Relay` and left npm, public
docs and wire fields closed until clearance existed — a partial lift, matched to
what was actually in use. Rejected with the full lift; noted because it was the
narrower option and the difference between it and what was chosen is exactly the
exposure described in Consequences.

## Consequences

### A rename used to be free. It is not any more, and that is the accepted risk

This is the consequence a future reader most needs, so it is stated first and
without hedging.

While the four prohibitions stood, abandoning `Relay` would have cost **nothing
outside this repository**. That was not luck: the wire fields were deliberately
role-named — `resolvedModelReference`, `servingProvider`, `deploymentId`, never
`relay*` — precisely so a rename could not reach a published contract. Measured
2026-08-17: zero field names in `packages/contracts/src/` begin with `relay`,
against a positive control of 14 occurrences of those three role names in
`packages/contracts/src/inference/`. A rename would have touched internal
identifiers and one repository name.

**Once `Relay` is in a published npm package name, in developer documentation, in
a customer-visible string or in a public wire field, a failed trademark clearance
stops being free.** It becomes a migration paid by consumers who never agreed to
it — which is the exact cost this ADR was originally written to avoid, and the
exact reason it prohibited those four uses in the first place. Trademark clearance
(criterion 1) was never run, and neither was registry availability beyond the
scoped npm name (criterion 3).

**That is the risk the owner accepted on 2026-08-17.** It is recorded here, and not
anywhere else, so that whoever discovers a conflict later can see that the decision
was made knowingly rather than by omission. The mitigation available and not taken
was the narrower lift in Alternatives rejected.

### The rest

- Workstream 13's repository is `OxyHQ/Relay`, public, and its name is now
  authorised rather than merely recorded. A domain, subdomain or DNS record under
  the name is likewise permitted; a trademark FILING should still wait on criterion
  1, because a filing is the one act that turns an unchecked name into a claim
  against third parties.
- **Reviewers no longer gate on the name.** A PR that puts `Relay` in a published
  package name, in customer-facing documentation, or in a public path, header,
  event type or wire field is no longer changed before merge on those grounds. The
  mechanical check this ADR used to supply is withdrawn.
- **ADR 0010's envelope and event schemas stay role-named anyway**, and this is now
  an independent rule rather than a hedge against a rename. A field named after the
  product would be named after a product rather than a role, which is wrong on its
  own terms — and it is what keeps the atproto collision (criterion 2) from
  reaching a data structure, where no module context disambiguates it.
- Two criteria are open — trademark clearance, and registry availability beyond
  `@oxyhq/relay` on npm — and they are open in the record rather than in someone's
  memory. Anyone about to make the first customer-facing use of the name has this
  paragraph to read first.
- The term-of-art collision with atproto's `Relay`, and the common-noun uses
  already in this codebase (device-transfer relay, SMTP relay), are **accepted
  costs**, not resolved problems. Greps, log lines and comments containing the word
  remain ambiguous, and now so may customer-facing text.
- This ADR has no open *decision* and no open *question*. What it has is two
  unrun *checks*, which is a third thing: nobody is waiting on an answer, and the
  work simply was not done. That is why they are in the title.
