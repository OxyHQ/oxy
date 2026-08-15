# ADR 0011 — The inference data plane's production name is deferred; `Relay` is a working name and ships in nothing public

- Status: accepted (the decision recorded here is the deferral)
- Date: 2026-08-15
- Issue: #972

## Context

The epic calls the inference data plane **Relay** and marks it a working name.
Naming decisions are cheap to make and expensive to unmake: a name that reaches
npm, a public documentation page or a URL path acquires consumers who did not
agree to a rename, and the migration cost is paid by them.

Two facts already argue against adopting `Relay` by default, and both are
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

Neither fact is decisive against the name. Both are inputs to a review that has
not happened.

## Decision

**The production name of the inference data plane is deferred, pending
naming/trademark review. `Relay` is a working name for internal discussion,
issues, ADRs and internal code identifiers only.**

Until that review completes and a name is recorded here:

- **No published npm package name contains `Relay`** — not a scope, not a
  package name, not a subpath export.
- **No public documentation names it `Relay`** — not Console pages, not the
  developer docs, not SDK reference material, not error messages a customer can
  see.
- **No public API path, header, query parameter, event type or wire field
  contains `Relay`** — the internal envelope of ADR 0010 names *the data plane*,
  not a product, and its field names must survive a rename without a version
  bump.
- **No public repository, domain, subdomain or DNS record is registered under
  the name**, and no trademark filing is made.

Internal use is permitted and expected: this ADR set, the epic, issue titles,
internal service names, internal metric names and code identifiers inside a
private repository. That is exactly the boundary — a name is safe while every
consumer of it is someone who can be told it changed.

### What must be true before the production name is fixed

All of the following, recorded in this ADR when it is updated:

1. **Trademark clearance** for the candidate in the relevant classes and
   jurisdictions, with the search recorded and dated. A clean informal search is
   not clearance.
2. **No collision with an established term of art in a protocol Oxy implements**
   — atproto, ActivityPub, OAuth/OIDC — because those terms already appear in
   this codebase and cannot be disambiguated by context alone.
3. **Domain and package-name availability** for the exact spelling, on the
   registries that will actually be used, checked on a stated date rather than
   assumed from availability at some earlier time.
4. **A decision on whether the name is customer-facing at all.** A data plane the
   customer never addresses directly may not need a public name; "the Oxy
   inference data plane" is a valid outcome of this review and is not a failure
   to decide.
5. **Owner sign-off**, recorded here with the date.

Criteria 4 is the one most likely to be skipped, and it is the cheapest good
outcome: an internal component with no public name has no rename risk, no
trademark exposure and no term-of-art collision.

### How this ADR closes

When the review completes, this ADR is **updated in place** — the name recorded,
the criteria marked as met with their dates, the status changed from deferred to
decided. It is not superseded by a new ADR, because the reason a reader arrives
here is to learn what the data plane is called, and that question must have one
answer at one address.

## Alternatives rejected

**Adopt `Relay` now and rename later if review objects.** "Later" is after the
first published artifact, and the rename then costs every consumer a migration
for a decision that was never urgent. The cheap moment to change a name is before
anything depends on it, which is now.

**Pick a different name immediately to avoid the collisions above.** It replaces
an unreviewed name with another unreviewed name and consumes the one thing
deferral preserves: the option to conclude the component needs no public name at
all.

**Leave the name unspecified with no rule.** A working name with no boundary is
adopted by accident — the first package that needs a directory takes it, and by
the time review happens the decision has already been made by a filename.

## Consequences

- Workstream 13 and any repository created for the data plane may be named
  `Relay` internally; that name is provisional and carries no commitment.
- Reviewers gate on this rule concretely: a PR that puts `Relay` in a published
  package name, a public docs page, a public path or a wire field is changed
  before merge, and this is a mechanical check, not a judgement call.
- The internal envelope and event schemas of ADR 0010 must be written so that
  renaming the data plane changes no wire field. If a field name would have to
  change, that field is named after a product rather than a role and is wrong for
  a second reason.
- This ADR has an open item by design. An ADR whose status stays "deferred"
  indefinitely is a decision nobody made; the review is a tracked task with an
  owner, not a background hope.
