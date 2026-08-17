# ADR 0011 — The inference data plane's production name is `Relay`; whether that name may appear in anything customer-facing is a separate question and is still open

- Status: accepted (the name is decided; the public-use prohibitions below are NOT lifted)
- Date: 2026-08-15
- Closed: 2026-08-17 — the deferral this ADR originally recorded is resolved. The
  name is `Relay`, three of the five criteria are met or overruled, two are
  outstanding and named as such. See "How this ADR closed".
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

**What is NOT decided, and what a reviewer must therefore still gate on:**
whether `Relay` may appear in anything a customer can see. That was criterion 4
below, it is separable from the name, and it is unanswered. Until it is answered:

- **No published npm package name contains `Relay`** — not a scope, not a
  package name, not a subpath export.
- **No public documentation names it `Relay`** — not Console pages, not the
  developer docs, not SDK reference material, not error messages a customer can
  see. (This repository's `docs/` is a separate matter; see below.)
- **No public API path, header, query parameter, event type or wire field
  contains `Relay`** — the internal envelope of ADR 0010 names *the data plane*,
  not a product, and its field names must survive a rename without a version
  bump.

Those three stand as written. The fourth prohibition — "no public repository,
domain, subdomain or DNS record is registered under the name, and no trademark
filing is made" — has been overtaken by events for its repository clause, and
this ADR records that rather than pretending otherwise:

**`OxyHQ/Relay` is a PUBLIC repository**, created 2026-08-16T11:55:46Z, Go,
described as "Oxy inference data plane: provider adapters, routing execution,
streaming, deployments, health and technical metering. Control plane is
OxyHQ/oxy." So the name is publicly discoverable, and the premise that made the
deferral safe — "a name is safe while every consumer of it is someone who can be
told it changed" — no longer holds for the repository name. The domain, subdomain,
DNS and trademark-filing clauses of that prohibition are untouched and still
stand; no such registration has been made, and none should be until criterion 4
is answered. Whether to ratify the repository's public name or make it private
again is the owner's call, not this ADR's.

One more thing a reader will find and should not be surprised by: **`OxyHQ/oxy`
is itself a public repository**, so this ADR, `docs/inference/README.md` and every
other engineering document here name `Relay` in public. Prohibition 2's own list
is narrower than that — Console pages, developer docs, SDK reference material,
customer-visible error strings — and on that reading it holds: measured
2026-08-17, `packages/console/src` and `packages/services/src` contain exactly one
occurrence of `Relay` between them and it is a source comment, and no
customer-visible error string in `packages/api/src/routes` or
`packages/api/src/services` contains it. The name is not secret; it is simply not
yet a product name.

### The five criteria, resolved

Recorded here as the closing procedure below requires. Two are met, one is
overruled, two are outstanding — and the outstanding ones are named rather than
ticked.

1. **Trademark clearance** — **NOT DONE, and outstanding.** No search was run, no
   search is recorded, and nothing in this repository or the issue thread
   references one. The owner accepted the name without it. This is stated plainly
   because a criterion marked met on the strength of nobody having objected is
   worse than an open one.
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
3. **Domain and package-name availability** — **PARTIALLY MEASURED, and
   outstanding for domains.** Measured 2026-08-17: `@oxyhq/relay` is not
   published (npm registry returns 404), and no `package.json` in this monorepo
   declares a name, `bin` or subpath export containing `relay` — a census with a
   positive control, since the same test does see `@oxyhq/core`'s `./server`
   subpath. NOT measured: any domain or DNS registry, and the unscoped `relay`
   name on npm. Nothing here needs either today, which is why the gap is
   tolerable and recorded rather than closed.
4. **Whether the name is customer-facing at all** — **UNANSWERED. This is the one
   that still changes work.** Deciding that the data plane is called `Relay` does
   not decide that a customer ever sees the word. "The Oxy inference data plane"
   remains a valid answer for every customer-facing surface, and it is still the
   cheapest good outcome: an internal component with no public name has no rename
   risk, no trademark exposure and no term-of-art collision. Until the owner
   answers this, the three prohibitions above are the rule to check a PR against,
   and a PR that puts `Relay` on a Console page, in a published package name or in
   a customer-visible string is changed before merge.
5. **Owner sign-off** — **MET, 2026-08-15.** #972 comment, 2026-08-15T20:58:58Z.

### The deferral cost nothing, and that is checkable

The reason it was cheap to hold the option open is that this ADR's own
consequence about wire fields was honoured. Measured 2026-08-17: zero field names
in `packages/contracts/src/` begin with `relay`, against a positive control of 14
occurrences of the role-named `resolvedModelReference` / `servingProvider` /
`deploymentId` in `packages/contracts/src/inference/`. Had the review concluded
the other way, the rename would have touched internal identifiers and a
repository name, and no wire contract at all.

### How this ADR closed

As the original text specified: **updated in place** — the name recorded, the
criteria resolved with their dates, the status changed from deferred to decided.
It is not superseded by a new ADR, because the reason a reader arrives here is to
learn what the data plane is called, and that question has one answer at one
address.

What that procedure did not anticipate is a decision that answers the name and
leaves the public-use question open. So the status above says both things, and the
prohibitions stay in this file rather than moving to a successor: a reviewer who
needs to know whether `Relay` may ship in a customer-visible string still has
exactly one place to look.

## Alternatives rejected

**Adopt `Relay` now and rename later if review objects.** Rejected in the
original deferral, and the deferral is what made the eventual decision free: by
the time the name was settled, nothing published depended on it.

**Pick a different name immediately to avoid the collisions above.** It would
have replaced an unreviewed name with another unreviewed name and consumed the one
thing deferral preserved — the option to conclude the component needs no public
name at all. That option is still open, as criterion 4.

**Leave the name unspecified with no rule.** A working name with no boundary is
adopted by accident — the first package that needs a directory takes it, and by
the time review happens the decision has already been made by a filename.

**Record the decision in a new ADR (0015) and mark this one superseded.**
Rejected because this ADR specified its own closing procedure, `docs/adr/README.md`
sanctions exactly this case ("An ADR is updated in place only to record its own
closure"), and splitting the answer across two files means the next reader finds
the deferral first.

**Lift all four prohibitions because the name is decided.** Rejected: the name and
its blast radius are different decisions, and only the first was made. Lifting
them here would let the next PR put `Relay` on a Console page with an ADR
apparently authorising it.

## Consequences

- Workstream 13's repository is `OxyHQ/Relay`, and the name is no longer
  provisional. It is public, which is a fact this ADR records rather than
  authorises; the domain, DNS and trademark clauses of prohibition 4 are still in
  force.
- Reviewers gate on prohibitions 1–3 concretely and mechanically: a PR that puts
  `Relay` in a published package name, in customer-facing documentation, or in a
  public path, header, event type or wire field is changed before merge. This is
  unchanged by the naming decision and stays true until criterion 4 is answered.
- The internal envelope and event schemas of ADR 0010 stay written so that the
  data plane's name appears in no wire field. That is now a permanent property
  rather than a hedge: a field named after the product would be named after a
  product rather than a role, which is wrong on its own terms.
- Two criteria are open — trademark clearance, and domain availability — and they
  are open in the record, not in someone's memory. A trademark filing or a domain
  registration under this name needs criterion 1 done first.
- This ADR no longer has an open *decision*. It has an open *question* about
  scope, which is a different thing and is stated in its title.
