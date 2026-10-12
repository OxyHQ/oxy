# ADR 0038 — Kaana owns provider keys, costs and routing; Oxy owns customers and limits

- Status: accepted (phase 1 implemented; phase 2 planned)
- Date: 2026-10-12
- Decided by: the owner of Oxy
- Supersedes, for phase 1: ADR 0036 decision 4 (a synced route's funding is
  known only for a provider with exactly one enabled promotional key) and the
  part of ADR 0037's context and consequences that rely on Kaana running each
  deployment on one key. ADR 0037's guarantee — Alia Pro/Ultra spend only
  credit — is kept and now enforced by Kaana too.
- Plans, for phase 2: superseding ADR 0027 decision 5 and ADR 0036 decision 2
  (provider prices in Oxy), the cross-provider ranking of `routing.md`, and
  Oxy's resolution of power levels (`power-levels.md`).
- Counterpart: Kaana `docs/adr/0001-kaana-owns-provider-keys-costs-and-routing.md`.
  Compatible with Alia ADR 0010 (Kaana = inference API; Oxy = platform and
  Console holding every CUSTOMER API key).

## Context

Oxy Console is to Oxy what Google Cloud Console is to Google: developer
accounts, application IDs, developers' API keys, customer credits, billing,
quotas and limits — what Oxy CHARGES. Kaana is everything AI: it holds every
provider key and must be able to use any key of any provider as it sees fit.

The code said otherwise. Kaana ran each deployment on one exact key and
refused to choose among several (Kaana `key-pools.md` before Kaana ADR 0001).
Oxy held the provider economics: reviewed provider prices
(`config/kaanaReviewedProviderRoutes.ts`), the funding class of a route
(`services/kaanaCredentialEconomics.service.ts`: "exactly one enabled
promotional key", else `standard_payg`), the cross-provider order
(`routing.md`, "Ranking after qualification") and the signed
`authorizedRoutes` list. A second Anthropic grant could only be used by
duplicating thirteen deployments and teaching Oxy to rank them, and enabling
it would have collapsed Anthropic to `standard_payg` and taken Claude away
from Alia Pro and Ultra (ADR 0037).

## Decision

1. **Kaana owns provider keys, provider costs and routing**: what providers
   charge, each key's economics (free, promotional/trial credit, prepaid,
   paid; its funding account) and which provider and key serve a request.
2. **Oxy owns customers and limits**: who may call, what they asked for, what
   they may spend, and the policy the request must satisfy. Oxy tells Kaana
   the model (or level) and the limits; Kaana chooses within them and returns
   what it really cost; Oxy bills from Kaana's receipt. **Kaana never spends
   beyond what Oxy authorized.**
3. **The order is always free → credits → paid, for the SAME requested
   model, across all providers and all keys.** If some provider serves the
   requested model for free, serve it there; if not, where Oxy holds credits
   (promotional or credit grants, prepaid); only then a paid one. A different
   model is never substituted because it is cheaper or free. Hard constraints
   always win over the order: the route must accept the request's parameters,
   and data retention/privacy, the price ceiling and any funding ceiling Oxy
   sends (Alia Pro/Ultra = credits only) are never relaxed. Within one tier:
   cheaper first, then the existing latency and health signals.
4. **Power levels move to Kaana (phase 2).** Kaana owns which models belong to
   `auto`, `instant`, `medium`, `high`, `xhigh`, `pro` and `ultra`, and
   resolves them. A request for a LEVEL means any model of that level, so the
   order of decision 3 applies across all its models, providers and keys. A
   request for a CONCRETE model keeps the strict rule: that model only.

## Phase 1 — implemented

Kaana (OxyHQ/Kaana, ADR 0001):

- a deployment is (provider, upstream model) and executes on its provider's
  key pool, free → promotional/trial → prepaid → paid → unstated; a spent or
  refused key moves the same attempt to the next key, a transient failure moves
  the same request's retry, a request fault never moves; exact bindings are
  optional operator pins;
- a deployment is withheld from the inventory only when no key of its pool can
  serve it;
- with contract set 3.8.0 Kaana honours `authorizedRoutes[].maxFundingTier`
  and reports `usage.fundingTier`.

Oxy (this change):

1. **Contract set 3.8.0, `@oxy.so/contracts` 4.12.0.** `inferenceFundingTierSchema`
   (`free`, `credit`, `paid`); an optional `maxFundingTier` on an authorized
   route (refused beside a customer credential); an optional `fundingTier` on
   the normalized usage report. Additive; 3.6.0 and 3.7.0 stay the scoped and
   private Auto sets.
2. **A provider's funding is the best AVAILABLE tier among its enabled keys**
   (`kaanaCredentialEconomics.service.ts`). With any promotional key whose
   evidence says the grant is available, the provider's synced routes are
   `promotional_credit` (valid until the last available grant's window ends),
   because Kaana spends that grant first. With every grant spent or throttled,
   the routes are `standard_payg` when the provider holds another key Kaana
   walks on to, or the grants' own `exhausted`/`rate_limited` state when they
   are all it has. A provider with no promotional key, and a failed read, stay
   `standard_payg`. A second key never collapses a provider into paid.
3. **ADR 0037's lane is signed credit-only.** A route the Pro/Ultra lane
   admits on its promotional funding carries `maxFundingTier: "credit"`, so
   Kaana walks only free and credit keys of that provider and, when they are
   spent, refuses the route — the XHigh fallback signed beside it serves —
   instead of falling through to a paid Anthropic key. Without the ceiling,
   decision 2 plus Kaana's pool walk would let a request Oxy authorized on
   promotional funding be served by a paid key of the same provider. The
   ordinary fallback carries no ceiling.
4. **A breach is evidence, not a refusal.** A usage report stating a tier
   dearer than the route's ceiling logs `inference.edge.funding_ceiling_breached`
   and still settles: the provider work is done and refusing the report would
   leave it unaccounted. A report stating no tier (a data plane before 3.8.0)
   says nothing.

Customer prices do not change: a request is still charged at its admitted
route's Oxy price version. The served tier is the platform's cost fact; the
exact key, its label and its cost stay on Kaana's signed operator feed and
never reach a customer.

### Rollout order (phase 1)

1. Merge and deploy Kaana's pool change (OxyHQ/Kaana, ADR 0001 step 1).
2. Merge this change; publish `@oxy.so/contracts` 4.12.0 with the reviewed
   release workflow; deploy the API. A Kaana before step 3 ignores
   `maxFundingTier` — safe only while no provider holds a paid or unstated key
   beside the credit keys a credit-only route relies on, which is the case
   (both Anthropic keys are promotional).
3. Kaana pins 4.12.0 and honours the ceiling and reports the tier.
4. Remove the 13 `dep_anthropic_*` pins and enable Anthropic's second key
   (Kaana `operating.md`, "Moving a pinned provider onto its pool").

## Phase 2 — plan, not implemented

Goal: Oxy stops choosing deployments. It sends the requested model or level,
the customer's limits and the policy; Kaana picks provider and key.

### What moves from Oxy to Kaana

| Today in Oxy | Moves to Kaana as |
|---|---|
| reviewed provider prices, `config/kaanaReviewedProviderRoutes.ts` (`price`, `source`, `upstreamModelId`) | reviewed rate cards in Kaana's `internal/providercost` registry (it already versions rate cards, migration 0015); the accepted-control statement is already Kaana's adapter statement and is deleted here |
| provider list prices synced into `price_versions` per deployment (ADR 0027 decision 5) | Kaana's cost model per (provider, key, model); Oxy's `price_versions` become per MODEL LINE (or per level): what Oxy charges, set by Oxy, independent of which provider serves |
| funding class and state on `inference_deployment_routing_scores`, `kaanaCredentialEconomics.service.ts`, `fundingPriorityFor` | Kaana's key funding (already authoritative after phase 1); Oxy's copy is deleted |
| cross-provider ranking (`routing.md`, "Ranking after qualification"; price/latency/balanced scores; `rankRoutes`) | Kaana's selection: hard constraints, then free → credits → paid across every (provider, key) serving the model, cheaper first within a tier (from its cost model), then health and latency |
| power levels: `inferencePowerLevels.service.ts`, the reviewed `powerClass` of a model, `docs/inference/power-levels.md` | Kaana's level → models map; a level request is resolved by Kaana across all models of the level |

What stays in Oxy: accounts, application IDs, customer API keys, credits,
balances, reservations, receipts, quotas, the customer price list, routing
POLICY (the limits), and the catalogue a customer sees.

### Contract changes

1. A new request envelope version (v5) carrying the TARGET and the LIMITS
   instead of a route list: `target` is `{kind: "model", modelLine}` or
   `{kind: "level", level}`; `limits` carries `maxPricePerRequest` (Oxy's own
   currency amount the hold was sized for), `maxUpstreamCostPerRequest` (what
   Kaana may spend upstream, which Oxy derives so its margin never goes
   negative), `maxFundingTier`, and the policy constraints Kaana must satisfy
   itself: zero data retention, no training on customer data, region
   allow/deny lists, provider allow/deny lists, commercial-use rights,
   licence allow-list, BYOK preference and credential. The `routingPolicy`
   reference stays as provenance. v2 with `authorizedRoutes` stays for scoped,
   private Auto and exact-deployment calls.
2. The usage report gains the upstream cost of the request as an operator-only
   amount (`upstreamCost`, exact decimal, currency) beside `fundingTier`.
   Kaana's rule becomes "no amount reaches a CUSTOMER" instead of "no amount
   in an inference response"; Oxy strips it at the edge exactly as it strips
   the deployment id.
3. Kaana's catalogue publishes per model line the hard-constraint facts it
   will evaluate (data policy per provider, regions, accepted parameters), so
   Oxy can show a customer what a policy allows without choosing a route.
4. Contract set 4.0.0 (a new envelope version is a MAJOR per `version.ts`).

### Migration and compatibility

1. Move the reviewed Anthropic prices into Kaana rate cards; Kaana's catalogue
   sync keeps emitting `listPrices`, so Oxy runs unchanged.
2. Kaana implements v5 selection behind a flag and a SHADOW mode: Oxy keeps
   signing v2 routes and also sends the v5 target and limits on an operator
   path; Kaana logs which deployment and key it would have chosen. Compare for
   a week; every disagreement must be explained by decision 3 or fixed.
3. Introduce per-model-line Oxy price versions (migration), populated from the
   current deployment prices of each line's primary route; both coexist.
4. Switch Alia (`platform_internal`) to v5 first, then official apps, then
   public API keys. A caller on v2 keeps working.
5. Move power-level resolution: Kaana resolves levels for v5 requests; Oxy's
   resolver stays only for v2 callers, then is deleted. Resolve first the
   open conflict below.
6. Delete Oxy's ranking: `kaanaCredentialEconomics.service.ts`, funding
   columns of the routing scorecards, `kaanaReviewedProviderRoutes.ts`,
   `fundingPriorityFor`, the per-deployment price sync, the score renewal
   workflows — each in its own reviewed migration once no v2 caller depends
   on it.

### How billing stays correct

- The CHARGE never depends on Kaana's choice: Oxy prices the request from its
  own per-model (or per-level) price version, sizes the hold from that price
  and the maximum units, and settles from Kaana's reported units — exactly as
  today, minus the per-deployment price.
- The COST is Kaana's receipt: `upstreamCost` and `fundingTier` on the usage
  report, reconciled against the per-attempt operator feed by request id.
  Oxy records margin = charge − cost per request.
- `maxUpstreamCostPerRequest` is the guardrail: Kaana refuses a route whose
  worst-case cost exceeds it before calling upstream, so a request can never
  cost more than Oxy authorized; a report over it is a breach logged and
  alarmed like `funding_ceiling_breached`.
- Oxy re-checks every served deployment against the signed inventory
  snapshot: provider and data policy inside the limits it sent. A violation is
  a `policy_violation`, as an unauthorized route is today.

## Open conflict (not phase 1)

The owner's product fact "in Alia end users pick only levels, never concrete
models" contradicts Alia's AGENTS.md and Alia ADR 0012, which make Alia's
picker the real `publisher/model` catalogue with no modes or route profiles.
It must be settled before phase 2 step 5 changes how Alia's requests are
resolved.

## Consequences

- Enabling a second key of a provider no longer needs any Oxy change: Kaana
  orders it by funding and Oxy's scorecard keeps the provider's best available
  tier.
- Oxy still ranks deployments across providers until phase 2; within a
  deployment the key is Kaana's choice, and Oxy's scorecard describes the
  provider, not a key.
- A route signed credit-only can fail over only along its signed routes; it
  never spends money Oxy did not authorize.
