# Routing controls and fallback semantics

A routing policy is the customer-facing configuration of *which* routes their
requests may take. Oxy stores, validates and versions it; a data plane executes
it (ADR 0006).

**Read [What is enforced today](#what-is-enforced-today) before relying on any
control on this page.** Policies are stored, validated, versioned, inherited, and
the exact version a request ran under is recorded on its receipt. Eleven of the
controls are now also applied to the candidate routes before one is chosen, and
a request no route satisfies is REFUSED rather than downgraded. Two are not
enforced and are named as such.

Status of the whole platform: [README.md](./README.md).

---

## Where a policy lives

A policy is scoped to an **account** or to an **application**, and both live
under `/inference/routing-policies`:

| Endpoint | Does |
|---|---|
| `GET`/`POST /accounts/:accountId` | read / create the account-scoped policy |
| `GET`/`POST /applications/:applicationId` | read / create an application-scoped policy |
| `GET`/`POST /:policyId/versions` | list versions / append a new current one |
| `GET /:policyId/versions/:policyVersion` | read one exact version |
| `GET /:policyId` | the policy and its current version |
| `POST /:policyId/archive` | retire it |
| `GET /applications/:applicationId/route-switches` | the customer-visible route-switch record |

Two principals reach these, and they are authorised differently: a **user
bearer** through the account graph (`app:read`/`app:update`,
`account:read`/`account:update`, with inheritance and per-member revokes coming
from the same resolver the applications routes use), and a **service token** by
scope — `inference:routing:read` to read, `inference:routing:write` to write,
and only ever for its OWN application or that application's owner account.
`inference:routing:write` is staff-granted, because it changes what other
people's requests do.

### Writes append; nothing is edited and nothing is deleted

A change is a new **version**, and the previous one stays exactly as it was, so
a receipt naming it still resolves. There is no `DELETE`: one that archived
would be a lie, and one that deleted would let a customer make a past charge
unexplainable. `POST /:policyId/archive` retires a policy instead.

### Inheritance is one hop, and it is worth knowing which

The application's own policy wins. Failing that, the **owner account's**
account-scoped policy applies. Failing that, `none` — which is a real answer
rather than a gap: the request is served under the platform default, and the
receipt records `{ routingPolicyId: 'platform-default', policyVersion: 1 }` so
the charge stays explainable.

There is no walk up the account tree. An account-scoped policy on a *parent*
account is not inherited by a child project account's applications; that child
needs its own.

---

## The controls

| Control | Means |
|---|---|
| `defaultTarget` | the model or routing profile used when a request names none |
| `providerAllowlist` / `providerDenylist` | which providers may serve. Empty allowlist means "no allowlist" |
| `allowedRegions` / `deniedRegions` | data residency. Empty allowed list means "no constraint" |
| `requireZeroDataRetention` | only routes that retain no payloads |
| `prohibitTrainingOnCustomerData` | only routes that do not train on your data |
| `maxPricePerUnit`, `maxPricePerRequest` | ceilings on what a route may cost you |
| `optimiseFor` | `price`, `latency`, `throughput` or `balanced`, among the routes that qualify |
| `oxyHostedOnly` | only Oxy's own hosting of open-weight models |
| `allowedLicenseIds`, `requireCommercialUseRights` | licence and usage-right constraints |
| `fallback` | see below |
| `byokPreference` | `disabled`, `prefer` or `require` — your own provider credential |
| `dedicatedCapacity` | `disabled`, `prefer` or `require` — reserved capacity rather than shared endpoints |

### Contradictions are rejected, not resolved

The controls are flat and independent, matching what Console renders — which
means a contradictory combination is *expressible*, and must therefore be
**refused at write time** rather than quietly settled by whichever field an
executor happens to read first. A `400` names the field:

- a provider in both the allowlist and the denylist;
- a region in both;
- `fallback.disabled` together with `sameModelDeployment` or any authorized
  cross-model destination;
- `oxyHostedOnly` together with `byokPreference: 'require'` — a BYOK route runs
  on your upstream account, which is by definition not Oxy's hosting;
- two price ceilings for one unit, or ceilings in mixed currencies.

A `defaultTarget` naming a model that is not in the catalogue also fails at
write time, rather than becoming a request that quietly resolves to nothing.

---

## Fallback: two features, two switches

Conflating them is what the platform's "never silently substituted" invariant
forbids.

- **Same-model deployment failover** (`fallback.sameModelDeployment`) — a
  different deployment of the *same* revision. An availability decision; you got
  what you asked for.
- **Cross-model fallback** (`fallback.authorizedCrossModel`) — a different model
  or revision. **A list of model references you named**, never a boolean:
  "allow fallback" without naming the destination is exactly the silent
  substitution being prevented.
- **`fallback.disabled`** — fail the request rather than serve it elsewhere.

Three rules hold above the configuration:

1. **A request that pinned a revision (`<publisher>/<model>@<revision>`) is
   never subject to cross-model fallback**, whatever the policy says. It asked
   for exactly those weights and is served or refused.
2. **An allowed switch is reported to the customer.** In-stream as a
   `route_switch` event, and on the record at
   `GET /applications/:applicationId/route-switches`.
3. **An unauthorized cross-model switch has no representation.** The
   `route_switch` shape requires `authorizedByPolicy: true` as a literal for a
   model-scope switch, and the server LOOKS THE AUTHORISATION UP against the
   policy version's own authorisation rows rather than accepting the producer's
   claim — a claim a caller makes about its own permission is not a permission
   check. That is where `fallback` is enforced: it governs a SWITCH between
   routes rather than the qualification of one, so it is not a predicate over a
   single candidate and does not appear in the filter below.

---

## What is enforced today

This is the part to read twice.

### Enforced

- **`defaultTarget`.** A request naming no model is resolved against the pinned
  policy version's default. A request naming none with no default is refused
  with `invalid_request`.
- **The policy version is pinned at admission and recorded.** The envelope and
  the settled receipt both carry `{ routingPolicyId, policyVersion }`, read from
  the version resolved at the start of the request rather than from whatever is
  current at settlement.
- **No silent model substitution.** If a data plane returned a completion whose
  resolved model differs from the one the edge admitted, the request is refused
  with `policy_violation` and the hold is released. A substitution is legitimate
  only when the destination is named in the policy version's own authorisation
  rows; anything else is one nobody permitted.
- **An application with no policy passes `UNCONSTRAINED_ROUTING` by name**, not
  by omission. There is no default parameter on the route resolver, so "this one
  is unconstrained" is a sentence somebody wrote rather than an argument nobody
  supplied — which is exactly how the data-handling controls came to be stored,
  versioned and never read.
- **Write-time validation**, as listed above.
- **A routing-profile target is refused** at the edge, with `no_route_available`
  and `param: routingProfile`. Choosing among a profile's candidates is routing
  EXECUTION, which belongs to the data plane; the control plane picking one
  would be inventing a routing decision it has no way to test.

### Enforced against the candidate routes

Eleven controls are applied to the whole candidate set **before** one is picked,
so a conforming route ranked second is served rather than a non-conforming route
ranked first:

`requireZeroDataRetention`, `prohibitTrainingOnCustomerData`,
`requireCommercialUseRights`, `allowedLicenseIds`, `providerAllowlist`,
`providerDenylist`, `allowedRegions`, `deniedRegions`, `oxyHostedOnly`,
`byokPreference`, `dedicatedCapacity`.

**When no candidate satisfies your policy the request is REFUSED**, with
`policy_violation` (403, never retryable), and the message names the controls
that excluded every route — so the answer points at a setting you can change
rather than at a support ticket. It is never downgraded to a route the policy
forbade, and never served as though the policy were absent.

That refusal is reachable only when a candidate survived the selectability
predicate. A model that does not exist, or that your credential may not see,
still answers `model_not_found`, so a policy refusal can never be produced by a
model that was never there.

Two readings worth stating outright, because the alternatives look reasonable:

- **`allowedRegions` is a subset test, not an overlap.** A deployment declares
  every region it may serve from, and which one it picks is the data plane's — so
  a route that MAY run outside your allowed set cannot honour a residency
  requirement and does not qualify.
- **`requireZeroDataRetention` needs the route to actually not retain**, not
  merely to be capable of it. `zeroDataRetentionAvailable` is a capability; a
  route carrying it while still retaining payloads by default is excluded.

Three of the controls read the DEPLOYMENT's own data policy rather than the
provider organisation's default, because a zero-retention endpoint from a
provider that otherwise retains is a real and important case.

### Stored, versioned, pinned onto the receipt — and NOT enforced

Two, and only two. Both are named in code beside the filter, in
`UNFILTERED_ROUTING_CONTROLS`, with the reason; a control that ends up in neither
list fails `tsc` by name.

- **`maxPricePerUnit`** — a candidate's price lives on the ledger's price
  versions, and comparing exact decimals is arithmetic this repository does
  exclusively in SQL. A ceiling also has to decide what an unpriced route and a
  foreign-currency ceiling mean. Reported rather than half-enforced.
- **`maxPricePerRequest`** — cannot be a candidate filter at all: what a REQUEST
  costs is only known once its unit ceiling has been estimated, which happens
  after a route is chosen and priced.

**Do not rely on either as a spend control.** The controls that do bound spend
are the reservation, the account balance and the spending limits — see
[billing.md](./billing.md#spending-limits).

`optimiseFor` is not in either list in the same sense: it is a RANKING among
routes that already qualify, which is routing execution and therefore the data
plane's (ADR 0006). It can never exclude a candidate.

Enforcement landed in [#1012](https://github.com/OxyHQ/oxy/pull/1012), closing
[#1011](https://github.com/OxyHQ/oxy/issues/1011), which is where the reasoning
about why a stored-but-unenforced compliance constraint is worse than a missing
feature is recorded. Measured on `main` at `da404475`, 2026-08-16.

### Route-switch records exist and nothing writes one

`GET /applications/:applicationId/route-switches` is served, and
`recordRouteSwitch` — which looks an authorisation up rather than trusting a
claim — has no production caller. Route switches are reported BY the data plane,
and there is no data plane. An empty list is the correct answer; it is not
evidence that no switch happened.

---

## How to use this today

Configure the policy you actually want. Eleven of its controls decide which
routes qualify, and a request none of them satisfies fails loudly rather than
being served by something you forbade.

Two caveats that matter more than they look:

- **The price ceilings are not spend controls.** Use a spending limit and the
  account balance — see [billing.md](./billing.md#spending-limits).
- **You cannot observe any of it yet.** The catalogue is empty, so no candidate
  is ever filtered in practice; every model you name answers `model_not_found`
  first. The enforcement is real and tested against fixtures that supply their
  own candidates, which is the only way it could be tested over an empty
  catalogue.

If a residency or retention requirement is contractual, a routing policy now
expresses it AND is enforced. Reading the chosen route's own `dataPolicy` and
`regions` back from the catalogue — see [data-policy.md](./data-policy.md) — is
still the way to verify it once there is a catalogue to read.
