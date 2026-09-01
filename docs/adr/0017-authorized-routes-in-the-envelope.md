# ADR 0017 — The envelope carries an ordered list of PRE-AUTHORIZED ROUTES, not a policy snapshot and not only a reference

- Status: accepted
- Date: 2026-08-17
- Issue: #972 (workstreams 6 and 13)
- Changes: [ADR 0006](0006-oxy-kaana-boundary.md) (what crosses the boundary, and
  one responsibility-matrix row), [ADR 0010](0010-public-api-compatibility.md)
  (the internal envelope). Neither is amended in place: neither states a
  procedure for its own amendment the way
  [ADR 0011](0011-inference-data-plane-name.md) does, and this is a change of
  substance rather than the closure of a decision either one deferred.

## Context

`inferenceRequestSchema.routingPolicy` carries `{routingPolicyId,
policyVersion}` — a REFERENCE to the customer's routing policy, and no values
from it.

ADR 0010 originally described a resolved policy SNAPSHOT travelling in the
envelope. #1018 corrected the ADR to the code rather than the code to the ADR,
on the reasoning that since #1012 the control plane filters every candidate route
against every control it can express as a predicate over one candidate, refuses
`policy_violation` when none qualifies, and therefore leaves the data plane only
one decision: RANKING among routes that already qualify.

That correction is right about the primary route and leaves a hole one step
later. Its own words are that the data plane owns "failover within the
destinations the policy authorized" — and **the envelope names no destinations.**
`resolveEdgeRoute` computes the full ordered set of survivors, takes
`permitted.kept[0]`, and discards the rest. So the data plane is assigned a
decision over a set it was never sent.

The consequence is measured, not hypothetical. The first implementation ever
written against this contract reports it as the sharpest of nineteen findings and
the one that blocks working code (`OxyHQ/Kaana`, `README.md` §"What Oxy still has
to decide", item 11):

> Every one of them governs what this repository's failover does, and the
> envelope carries none of them — only `{routingPolicyId, policyVersion}`. So a
> Kaana that failed over by default would override, for every customer who set
> it, a control the platform advertises to them. This build therefore ships
> failover **off**, and choosing among the deployments of one model at all is
> withheld with it.

It also cannot be pre-built on that side: adding a snapshot field to the Go
request type fails the descriptor gate, because the published shape has none.

So the platform today advertises `allowedRegions`, `deniedRegions`,
`requireZeroDataRetention`, `allowedLicenseIds`, the provider lists and the
fallback controls, and has NO availability failover at all — because the only
component that could fail over cannot tell whether a switch would honour them.
There are three ways out, and the first two are the ones to reject explicitly.

## Decision

**Oxy forwards the candidate routes that SURVIVED the customer's routing policy,
in preference order, as `authorizedRoutes`. The data plane fails over by taking
the next entry. It holds no policy value and needs no policy semantics.**

A route switch outside the customer's policy becomes impossible BY CONSTRUCTION
rather than by two enforcement engines, in two languages, agreeing.

### The shape

`packages/contracts/src/inference/routingPolicy.ts` —
`authorizedRouteSchema`, a discriminated union whose entries carry exactly what
executing a route requires:

```text
{ substitution: 'same_model',  deploymentId, modelReference, provider, regions }
{ substitution: 'cross_model', deploymentId, modelReference, provider, regions,
                               authorizedByPolicy: true }
```

- **Order IS preference.** `authorizedRoutes[0]` is the primary route Oxy
  resolved; the rest are failover destinations in the order Oxy prefers them.
- **`modelReference` is always revision-pinned**, the same rule
  `modelDeploymentSchema` enforces. An unpinned entry would leave the data plane
  choosing a revision, which is a substitution nobody authorized.
- **`regions` is plural**, matching `modelDeploymentSchema.regions`. A non-empty
  list declares every attested region the deployment MAY serve from and Oxy
  checks the whole set against the customer's residency controls as a SUBSET.
  An explicit empty list means no regional attestation exists; it is eligible
  only when the effective policy has neither `allowedRegions` nor
  `deniedRegions`. Kaana still compares the signed list to inventory exactly.
- **`{routingPolicyId, policyVersion}` stays.** It is provenance: a settled
  receipt must still record the exact revision of the customer's own
  configuration that produced the charge.

### Authorization is an ENTRY, never a boolean

`inference_routing_policy_fallbacks` already takes this stance in storage —
"being allowed to substitute IS having rows here, and each row names its
destination" — and the envelope now takes the same one. There is no envelope-level
"cross-model allowed" flag, because a flag beside a list re-invents the
"permission granted, destination unnamed" state that table exists to remove.

`substitution` is read relative to the primary, and `cross_model` is expressible
only with `authorizedByPolicy: true` as a LITERAL — the construction
`inferenceRouteSwitchDetailSchema` already uses to make the resulting
route-switch event unreportable. Four refinements close the ways a substitution
could otherwise travel unlabelled: the primary cannot be a substitution for
itself; a `same_model` entry on a different model line is refused; a
`cross_model` entry on the same line is refused; and a request that PINNED a
revision authorizes no substitute at all and must be served on exactly the
revision it pinned.

### The field is OPTIONAL, and that is a decision with a cost

Required would change the requiredness of the envelope — a new
`schemaVersion: 2`, a MAJOR contract-set bump, and a data plane that hard-errors
on an envelope version it does not implement. Every in-flight request would fail
during any window where the two sides disagreed, to add a field that grants a
capability rather than removing one.

Optional is additive: no shape version moves, and the contract set goes
`1.1.0 → 1.2.0`.

**Absent means NO FAILOVER IS AUTHORIZED — never "choose freely."** That is the
state every envelope built before this field existed is in, and it is exactly the
behaviour a data plane reading no list already has: resolve the `target`, serve it
or fail. Because permission is granted by an entry, the absence of the list can
only ever narrow what may be served; there is no reading of an absent list that
widens it.

An EMPTY list is refused rather than treated as that state, because `[]` says "no
route is authorized at all", which contradicts an envelope built to be served.

The cost was stated plainly: until the edge populates the list, an envelope
carries none, and the data plane's failover stays off. That is not a regression —
it was the behaviour of the day this was written — but it did mean this ADR was
not self-executing. **The populating change landed on 2026-08-18** in
`inferenceEdge.service.ts`, for the `same_model` half: `resolveEdgeRoute` now
returns `permitted.kept[0]` as the route and the rest as `alternates`, and
`buildEnvelope` sends them as `authorizedRoutes` whenever the customer's
`fallback` controls authorize failover among them. The `cross_model` half now
resolves both later candidates of an explicitly selected routing profile and
each destination in `inference_routing_policy_fallbacks` to concrete deployments,
then applies the same viewer, modality, policy, capacity and pricing filters.

### No per-route price

Deliberately absent, for three independent reasons.

1. **The data plane measures, the control plane prices** (ADR 0006). A price the
   data plane can read is a price it can rank on, which re-derives
   `optimiseFor: 'price'` from values instead of from the order Oxy already sent —
   two authorities for one decision.
2. **The ceiling is already enforced, before forwarding.** Oxy sizes the hold
   against `ceilingPriceVersionId`, "the price version of the most expensive
   route the policy permits". Every entry is a route that policy permitted, so no
   failover among them can exceed the hold.
3. `priceVersionId` is on `INTERNAL_DEPLOYMENT_COLUMNS` as "the ledger's internal
   handle". Shipping it to the data plane would export a ledger identifier for a
   decision the data plane does not make.

## Alternatives rejected

**Send the resolved policy SNAPSHOT, as ADR 0010 originally described.** It is
the option the data plane's own report asks for first, and it requires a second
policy-enforcement engine — the eleven filtered controls, the empty-list-means-no-
allowlist branches, the subset-not-overlap region rule, the three-column
zero-retention test — written again in Go and kept in agreement with the
TypeScript one forever. Two engines that must agree is a compliance control with
a divergence date on it, and the divergence is silent: both sides would serve a
plausible route.

**Say plainly that Oxy enforces everything and the data plane only executes,
sending exactly one route.** Honest, and it concedes availability failover
permanently: a data plane holding one route can only fail the request when that
route is unavailable, so the platform has no failover at all and every provider
incident is a customer-visible outage. It also puts a control-plane round trip on
the recovery path of every failed attempt.

**Keep the reference and let the data plane fetch the policy from Oxy.** A
control-plane call on the hot path of every request, and a cache whose staleness
window is exactly where the compliance property lives — the same objection ADR
0006 rejects a read replica of the account graph for.

**An envelope-level `crossModelFallbackAllowed` boolean beside the list.** It
re-creates the state `inference_routing_policy_fallbacks` was designed to remove,
and "flag true, no cross-model entries" would need somebody to decide what it
means.

## Consequences

- **`@oxyhq/contracts` goes to 0.30.0 and must be published before the data plane
  can adopt this.** The data plane pins the published version and its contract
  drift gate goes red until it takes 0.30.0. Publishing is the control-plane
  side's move and comes first.
- **The edge populates the `same_model` half since 2026-08-18.** Nothing behaved
  differently on the merge of this ADR; the follow-up mapped `permitted.kept` onto
  `authorizedRoutes` in `inferenceEdge.service.ts`. Two things that ADR states as
  properties had to be MADE true by that change rather than merely relied on:
  - `fallback` is read at the edge. Authorization is gated on
    `fallback.disabled`/`sameModelDeployment`, so a policy that turned failover off
    gets a one-entry list — stated positively, never by omitting the field, so
    absence keeps exactly one meaning.
  - "the ceiling is already enforced, before forwarding" was NOT true of the code.
    `usage_reservations.ceiling_price_version_id` is documented as the most
    expensive route the policy permits, and the edge passed the ADMITTED route's
    price version — sound only while the envelope carried one route. The hold is
    now sized at the dearest authorized route, and an alternate whose ceiling
    cannot be quoted, or is quoted in another currency, is not authorized.
- **`cross_model` is explicit and bounded.** It is populated only from later
  candidates of the selected routing profile or from the pinned policy version's
  `authorizedCrossModel` rows. Every entry is resolved and filtered independently,
  labelled `authorizedByPolicy: true`, included in the hold ceiling and omitted
  when fallback is disabled.
- **A deployment id now crosses the boundary in the Oxy→data-plane direction.**
  `deploymentIdSchema` already documents the id as opaque to CUSTOMERS, and it is
  the data plane's own key rather than Oxy's, so this direction of exchange is the
  one ADR 0006 item 8 asks to have stated: Oxy names the deployment, the data
  plane resolves it against its inventory.
- **The data plane may now be told which deployment to use.** That answers half
  of the "who picks the current revision of an unpinned reference" question in the
  same report: when a list is present, Oxy picked, and the entry is
  revision-pinned so the `start` event's required pinned reference is available
  without the data plane choosing one.
- **`routingProfile` targets are unblocked without resolving the profile in the
  envelope.** A profile target with an authorized list is servable: the customer
  named no model, every destination is named and authorized one entry each, and
  the data plane still never chooses a candidate Oxy did not send.
- Nothing here gives the data plane a policy value, so a Kaana-side schema review
  stays a boundary review: a column holding a policy CONTROL is still forbidden;
  a write-once copy of an authorized route is the intended shape.

## What this changes in ADR 0006

- The responsibility matrix row *"Routing policy (what a customer configured) |
  **Oxy** | consumes a versioned policy snapshot"* is superseded. The data plane
  consumes a policy REFERENCE as provenance and an ordered list of ROUTES the
  policy authorized. It consumes no control value.
- The "What crosses the boundary" bullet *"Oxy → Kaana, per request: … the
  resolved routing policy snapshot and its version, and the reservation ceiling
  (ADR 0009)"* is superseded twice over: the snapshot is replaced by
  `authorizedRoutes` plus the reference, and no reservation travels — #1018 had
  already removed that half from ADR 0010 without correcting it here.
- Everything else in 0006 stands, including its central rule. The data plane
  still owns routing EXECUTION; what changes is that the set it executes over is
  now enumerated rather than derived.

## What this changes in ADR 0010

- The `InferenceEnvelope v1` block gains
  `authorizedRoutes?  [{ substitution, deploymentId, modelReference, provider,
  regions, authorizedByPolicy? }]`, optional, in preference order.
- The sentence *"The envelope carries a routing-policy REFERENCE, not a snapshot"*
  stands and is now complete: the reference is still provenance and still nothing
  downstream acts on, and the routes the policy authorized travel beside it.
- *"What the data plane is left to decide is RANKING among routes that already
  qualify — `optimiseFor`, plus failover within the destinations the policy
  authorized"* stands, and those destinations are now in the envelope. Before
  this ADR that clause described a capability the shape did not support.
- Edge step 5, *"resolve the routing policy, pin its version, and SELECT the
  route"*, becomes: resolve the policy, pin its version, and select the ordered
  set of routes it permits — refusing `policy_violation` when none qualifies, as
  now.
