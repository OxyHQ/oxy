# Routing controls and fallback semantics

A routing policy is the customer-facing configuration of *which* routes their
requests may take. Oxy stores, validates and versions it; a data plane executes
it (ADR 0006).

**Read [What is enforced today](#what-is-enforced-today) before relying on any
control on this page.** Policies are stored, validated, versioned, inherited, and
the exact version a request ran under is recorded on its receipt. Thirteen of
the controls are now also applied to the candidate routes before one is chosen,
and a request no route satisfies is REFUSED rather than downgraded. One is not
enforced and is named as such.

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
bearer** through the account graph, needing `inference:routing:read` to read and
`inference:routing:write` to write on BOTH lanes (with inheritance and per-member
revokes coming from the same resolver the applications routes use), and a
**service token** by scope — `inference:routing:read` to read,
`inference:routing:write` to write, and only ever for its OWN application or that
application's owner account. `inference:routing:write` is staff-granted, because
it changes what other people's requests do.

Those two permissions replaced `app:read`/`app:update` and
`account:read`/`account:update`, and the narrowing is the point: `app:update`
conferred "publish an OTA update", "change the webhook URL" AND "repoint where
inference is served from" as one string, so an account that wanted an `editor` who
could edit an application but not touch routing had no way to say so. An `editor`
therefore no longer writes a routing policy and a `billing` member no longer reads
one; both are restorable for an individual member through `permission_grants`. The
permission is spelled the same as the scope on purpose — see the header of
`packages/api/src/utils/accountRoles.ts` for why that is one word for one power
and not the two lanes collapsing. The equivalent for BYOK, and the full list of
what makes these high-privilege, is in [byok.md](./byok.md).

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
   check.

`fallback` governs a SWITCH between routes rather than the qualification of one,
so it is not a predicate over a single candidate and does not appear in the
filter below. It is enforced in two places instead:

- **Before the request is forwarded.** The request Oxy sends its data plane
  enumerates the routes it is authorized to be served on, in preference order — a
  destination that is not in that list cannot be failed over to, whatever the data
  plane decides. `fallback.sameModelDeployment` is what puts the other
  deployments of your model in it; `fallback.disabled` is what leaves it holding
  only the route your request was admitted on. **An application with no routing
  policy at all authorizes no failover**, because there is no policy version a
  switch could be recorded against.
- **When the switch is recorded**, as rule 3 describes.

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
- **`fallback.disabled` and `fallback.sameModelDeployment`**, by deciding which
  routes the forwarded request authorizes — see "Fallback: two features, two
  switches" above. A hold is sized against the most expensive route in that list,
  so failing over to a dearer deployment can never cost more than the request was
  admitted for.
- **Routing-profile targets.** Oxy expands the profile's ordered candidates,
  applies the same viewer, modality, policy and pricing checks to each, and sends
  only the surviving revision-pinned deployments in `authorizedRoutes`. Kaana
  executes within that signed list and cannot invent a destination. With
  fallback disabled the list contains only the admitted primary.

### Enforced against the candidate routes

Thirteen controls are applied to the whole candidate set **before** one is
picked, so a conforming route ranked second is served rather than a
non-conforming route ranked first:

`requireZeroDataRetention`, `prohibitTrainingOnCustomerData`,
`requireCommercialUseRights`, `allowedLicenseIds`, `providerAllowlist`,
`providerDenylist`, `allowedRegions`, `deniedRegions`, `oxyHostedOnly`,
`byokPreference`, `dedicatedCapacity`, `maxPricePerUnit`, `maxPricePerRequest`.

The last two read the candidate's published price rather than a column on the
route, and their edges are their own section: [the price
ceilings](#the-price-ceilings).

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
  requirement and does not qualify. An empty deployment set means no regional
  attestation, not “everywhere”; it fails both an allow-list and a deny-list and
  is eligible only when neither regional control is present.
- **The signed route descriptor is an exact Kaana inventory identity.** Oxy
  copies `internal_route_id` into `deploymentId` and the deployment's complete
  `regions` set without aliases, inferred infrastructure regions or
  normalization. A row with no internal route id is refused before reservation;
  Kaana independently refuses any provider, model-reference or region-set drift
  against that inventory id.
- **`requireZeroDataRetention` needs the route to actually not retain**, not
  merely to be capable of it. `zeroDataRetentionAvailable` is a capability; a
  route carrying it while still retaining payloads by default is excluded.

Three of the controls read the DEPLOYMENT's own data policy rather than the
provider organisation's default, because a zero-retention endpoint from a
provider that otherwise retains is a real and important case.

### The price ceilings

Both are compared against the price version the candidate route is **actually
charged at** — the one a hold is sized against and the receipt is settled at, not
whichever version happens to be `active` for that model and provider now.

- **`maxPricePerUnit`** — for each unit you cap, the route's published rate for
  that same unit. Rates are compared as rates, so a ceiling of `$0.000004` per
  one token bounds a price of `$3.00` per a million; a price exactly AT the
  ceiling is admitted.
- **`maxPricePerRequest`** — the route's flat `requests` fee, which is charged
  once per request whatever the token counts turn out to be, so a route whose fee
  alone exceeds your ceiling can never serve a request within it.

Three edges, decided rather than left to whichever branch was written first:

- **A ceiling in a different currency from the route's price EXCLUDES the route.**
  It is never converted — there is no exchange-rate authority in this system, and
  a comparison across currencies is not a comparison. All the ceilings in one
  policy share a currency by construction.
- **A route that publishes NO price at all is EXCLUDED by any ceiling.** A promise
  about what a request will cost cannot be kept by a route whose price nobody has
  published. With no ceiling set, the same route answers `no_route_available` with
  an unpriced-route reason instead, which is an Oxy gap rather than yours.
- **A unit the route's published price does not charge for does NOT exclude it.**
  A published version states what a route charges for completely, so a ceiling on
  something it never bills is trivially kept — capping `video_milliseconds` does
  not withhold every text model.

**`maxPricePerRequest` is not yet a complete spend control.** What is enforced is
the candidate-level floor above; comparing the ESTIMATED cost of one particular
request against the same limit belongs at the edge, beside the quote, and is not
implemented. What bounds spend is the reservation, the account balance and the
spending limits — see [billing.md](./billing.md#spending-limits).

### Not enforced

One, named in code beside the filter, in `UNFILTERED_ROUTING_CONTROLS`, with its
reason. A control that ends up in neither list fails `tsc` by name, so this list
cannot silently grow.

- **`optimiseFor`** — a RANKING among the routes that already qualify, which is
  routing execution (ADR 0006). It can never exclude a candidate. The remaining
  integration gap is explicit: Oxy currently orders concrete deployment
  candidates by provider slug, while Kaana follows the signed order and receives
  no `optimiseFor` value. Therefore neither side applies this control today.
  Routing-profile score ordering is a separate mechanism and does not close it.

Enforcement of eleven controls landed in
[#1012](https://github.com/OxyHQ/oxy/pull/1012), closing
[#1011](https://github.com/OxyHQ/oxy/issues/1011), which is where the reasoning
about why a stored-but-unenforced compliance constraint is worse than a missing
feature is recorded. The two price ceilings were the last of the inert ones and
were enforced under [#972](https://github.com/OxyHQ/oxy/issues/972); they left
`UNFILTERED_ROUTING_CONTROLS` in the same change, because a control listed as
inert while it filters is the next reader's bug.

### Route-switch records exist and nothing writes one

`GET /applications/:applicationId/route-switches` is served, and
`recordRouteSwitch` — which looks an authorisation up rather than trusting a
claim — is fed by Kaana reports only after the live signed path is enabled. The
source mechanism exists; an empty production list before a verified canary is
not evidence that no switch happened.

---

## How to use this today

Configure the policy you actually want. Thirteen of its controls decide which
routes qualify, and a request none of them satisfies fails loudly rather than
being served by something you forbade.

Two caveats that matter more than they look:

- **A price ceiling is not a complete spend control.** It bounds the RATE a route
  may charge you at, and for a whole request only the flat per-request fee — not
  what a particular request adds up to. Use a spending limit and the account
  balance for that — see [billing.md](./billing.md#spending-limits).
- **You cannot observe any of it yet.** The catalogue is empty, so no candidate
  is ever filtered in practice; every model you name answers `model_not_found`
  first. The enforcement is real and tested against fixtures that supply their
  own candidates, which is the only way it could be tested over an empty
  catalogue.

If a residency or retention requirement is contractual, a routing policy now
expresses it AND is enforced. Reading the chosen route's own `dataPolicy` and
`regions` back from the catalogue — see [data-policy.md](./data-policy.md) — is
still the way to verify it once there is a catalogue to read.
