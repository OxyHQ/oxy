# Routing controls and fallback semantics

A routing policy is the customer-facing configuration of *which* routes their
requests may take. Oxy stores, validates and versions it; a data plane executes
it (ADR 0006).

**Read [What is enforced today](#what-is-enforced-today) before relying on any
control on this page.** The control plane is real and complete: policies are
stored, validated, versioned, inherited, and the exact version a request ran
under is recorded on its receipt. Almost none of them changes which route is
chosen yet, because route selection does not consult the policy.

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
   policy version rather than accepting the producer's claim — a claim a caller
   makes about its own permission is not a permission check.

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
  with `policy_violation` and the hold is released. No policy today authorises
  any substitution, so a differing model is a substitution nobody permitted.
- **Write-time validation**, as listed above.
- **A routing-profile target is refused** at the edge, with `no_route_available`
  and `param: routingProfile`. Choosing among a profile's candidates is routing
  EXECUTION, which belongs to the data plane; the control plane picking one
  would be inventing a routing decision it has no way to test.

### Stored, versioned, pinned onto the receipt — and NOT consulted

Everything else. Route selection (`resolveEdgeRoute`) filters candidate
deployments on availability scope, commercial permission state, deployment
status, revision and the presence of a price — and **reads no field of the
resolved routing policy at all**. So today:

`providerAllowlist`, `providerDenylist`, `allowedRegions`, `deniedRegions`,
`requireZeroDataRetention`, `prohibitTrainingOnCustomerData`, `maxPricePerUnit`,
`maxPricePerRequest`, `optimiseFor`, `oxyHostedOnly`, `allowedLicenseIds`,
`requireCommercialUseRights`, `fallback.*`, `byokPreference` and
`dedicatedCapacity` change nothing about which route is chosen.

**Why this matters more than an ordinary missing feature.** A customer can set
"zero retention required", the API accepts it, the version is recorded, and the
receipt says the request ran under that policy version. Every visible signal says
the constraint is in force. It is not. Add a deployment without zero data
retention to the catalogue and requests from that customer would be routed to
it, with a receipt still naming the policy version that forbade it — a
compliance claim the system cannot honour, recorded as though it had been.

It is unreachable in the way that matters right now, because the catalogue is
empty and no route is selected at all. That is precisely why it is being fixed
before the catalogue is seeded rather than after: the failure only becomes
visible once there is more than one candidate deployment, and by then the
receipts asserting the false claim already exist.

Tracked as [OxyHQ/oxy#1011](https://github.com/OxyHQ/oxy/issues/1011) for the
three data-handling constraints specifically; the wider list above is the same
gap with a wider blast radius.

**Measured 2026-08-16: #1011 was open, and PR
[#1012](https://github.com/OxyHQ/oxy/pull/1012) — "enforce the routing policy
against candidate routes, and refuse when none qualifies" — was open and
unmerged.** This section describes `main` as it stood at that moment. If #1012
has landed by the time you read this, re-derive the enforced list from
`resolveEdgeRoute` in `packages/api/src/services/inferenceCatalogue.service.ts`
rather than trusting the table above, and correct it here.

### Route-switch records exist and nothing writes one

`GET /applications/:applicationId/route-switches` is served, and
`recordRouteSwitch` — which looks an authorisation up rather than trusting a
claim — has no production caller. Route switches are reported BY the data plane,
and there is no data plane. An empty list is the correct answer; it is not
evidence that no switch happened.

---

## How to use this today

Configure the policy you actually want. It will be recorded correctly, versioned
correctly and pinned onto every request, and none of it is wasted work — the
enforcement gap is in the route resolver, not in the stored policy.

But do not treat a stored constraint as a compliance control until this page says
it is enforced. If a residency or retention requirement is contractual, the
answer today is the catalogue's own `dataPolicy` and `regions` fields on the
route you select explicitly — see [data-policy.md](./data-policy.md) — not a
routing policy that would filter for you.
