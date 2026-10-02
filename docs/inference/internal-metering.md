# Internal metering: usage and cost without a charge

How the edge treats inference between Oxy's own products, and how usage and
cost are recorded for every request. Decided in
[#1526](https://github.com/OxyHQ/oxy/issues/1526) (plan item I09 of #1519).
Concepts: [README.md](./README.md). Money protocol: [billing.md](./billing.md).

## Two economic treatments

| Treatment | Who | Money | Still enforced |
|---|---|---|---|
| `commercial` | every caller by default | reserve → settle → refund ([ADR 0009](../adr/0009-usage-reservation-and-settlement.md)) while charging is armed; shadow metering while it is not | everything |
| `internal_metered` | a product relationship Oxy configured, e.g. Alia → Kaana | none: no billing profile, hold, receipt, promotional grant, `platform_revenue` entry or transfer between products | scopes, revocation, routing policy, model eligibility, privacy, provider gates, idempotency, **technical capacity** |

`internal_metered` is not shadow metering. Shadow metering is a rollout state
of the commercial path. The internal treatment holds nothing whether or not
charging is armed, so one installation serves both treatments at once.

### What decides it

`config/inferenceEconomicPolicy.ts`, after authentication, from the
authenticated principal only:

- the application, by its pinned immutable id;
- the environment and the lane (`service_token`, the workload/service lane);
- the application row's live `is_internal`.

Nothing the caller sends selects it: no header, body field, bot kind, agent
id or delegated user. Being an official app doesn't select it either, and
neither does sending the request through Alia. Every caller the policy does
not name is `commercial`. The policy is versioned data in code
(`INFERENCE_ECONOMIC_POLICY_VERSION`), so there is no environment switch.
Changing it means a reviewed commit that bumps the version.

Configured today: `alia-kaana`, Alia's application in `production` on the
`service_token` lane.

### Technical capacity replaces the hold's implicit limit

Each relationship declares `maxConcurrentRequests` and `maxRequestsPerUtcDay`
per application + environment. Running out of capacity answers `rate_limited`
(concurrency) or `quota_exceeded` (daily) and never asks for a top-up.

**Alia → Kaana limits are a proposal pending approval (#1526), not policy.**
Measured from production `inference_usage_events`, Alia, 2026-09-02..10-02
(read-only aggregates, charging off, 7 distinct subjects):

| Measured | Value |
| --- | --- |
| Requests, 30 days | 937 over 19 active days |
| Per UTC day | median 18, p95 148, max 185 |
| Busiest minute | 16 |
| In flight at once (overlap of latency windows) | max 3 |
| Latency | mean 2.5 s, p95 8.9 s, max 70 s |
| Tokens per request | ~4,029 in, ~70 out (82 % on `openai/gpt-oss-120b`) |
| Published tariff, 30 days (estimate at the highest active gpt-oss-120b card) | ≈ USD 1.65 |

Proposed: 32 in flight (~10x the measured peak) and 5,000 a day (~27x the
busiest day). Both are estimates with headroom, not measured capacity. Counts
do not bound cost: the worst case of 5,000 requests a day is ≈ USD 96 at
gpt-oss-120b prices with a 46k-token prompt, but far more on the most
expensive active card, so model eligibility (the routing policy) or a daily
tariff ceiling is what bounds spend — the second is a proposal, not built.

## Durable records

| Table | One row per | Written | Holds |
|---|---|---|---|
| `inference_metered_usage` | admitted request | claimed at admission, settled once | treatment + policy version, attribution, cost-centre snapshot, admitted route, ceiling, units, outcome, **tariff snapshot**, receipt link only when charged |
| `inference_provider_cost_attempts` | upstream attempt (`request_id`, `attempt_index`) | read from Kaana's signed operator feed | provider cost with its provenance (`provider_reported`, `rate_card`, `unknown`), served or failed-over, units as typed columns (`units_measured = false` when Kaana never measured them; an unknown unit refuses the page), outcome |

- **Idempotency no longer depends on a hold.** The admission claim is unique
  on the ledger key among rows that were not refused. Concurrent retries of
  one `Idempotency-Key` execute once, for every treatment. A request refused
  before forwarding frees its key, as a declined reservation always did.
- **Snapshots.** The tariff is priced from the pinned price version when the
  request settles and copied onto the row. A later price, cost centre or
  policy version never rewrites it.
- **Unknown is not zero.** An unpriceable tariff is `unpriced` with no amount.
  An attempt Kaana could not cost has no amount and no currency, which the
  database enforces with a CHECK constraint.
- **Failovers keep their cost.** A failed attempt is on no receipt but is
  still invoiced upstream, so it stays in the cost table.

### The Kaana feed

`services/kaanaProviderCostFeed.service.ts` reads
`POST /internal/v1/provider-telemetry/attempts` every minute. Each read is
signed with the existing edge key under the domain
`oxy-kaana-provider-telemetry:v1` (Kaana `docs/cost.md`), so no new
credential exists. Ingestion is idempotent on the attempt key. A redelivery
with different facts is refused and logged as
`inference.provider_cost.replay_mismatch`, never overwritten. The cursor
advances by compare-and-set.

## Reports

`GET /billing/cost-centers/usage?periodStart=…&periodEnd=…&currency=USD`
(staff) reports per cost centre and treatment. It keeps four figures apart:

- units;
- `tariff`, what the published price would have charged. This is not a cost;
- `providerCost`, what upstreams invoiced, with failed failovers included;
- `customerCharge`, from receipts only, which is always zero for `internal_metered`.

Unknown tariffs and costs appear as `unknownCount` beside each sum.
`GET /billing/cost-centers/spend` is unchanged and still reads receipts only.

## Not covered here

- The Auto/Jev semantic classifier child still requires a charged commercial
  parent. An internal parent keeps the deterministic floor until I10 decouples
  the child.
- `GET /v1/generations/:id` reads receipts, so it has nothing to return for an
  internal request.
- Provider gates (`decisionAvailability`, Kaana's reviewed audiences) are
  unchanged and stay closed.

## Cost coverage and terminal recovery

Provider cost `amount` includes known subtotals, including a rate-card attempt
with `costComplete=false`. `knownCount` counts complete attempts only;
`partialCount` counts incomplete known subtotals, `unknownCount` counts attempts
without an amount, `missingRequestCount` counts requests with no ingested attempt,
and `otherCurrencyCount` counts priced attempts excluded from the requested
currency. `providerReportedAmount`/`providerReportedCount` separately show
provider-reported evidence; `estimatedAmount`/`estimatedCount` show immutable
rate-card estimates. Their sum is the known subtotal, never an asserted invoice. Missing feed evidence never asserts zero provider cost.

An expired admission without terminal evidence is reported as `expiredCount`,
not `inFlightCount`. It retains its idempotency key and never permits replay.
The recorded usage and cost feed can still be reconciled later. Kaana's operator
feed preserves historical SQL NULL units as JSON null, distinct from a measured
empty list. An attempt's units or cost alone do not prove a request terminated.

Every API task reconciles committed commercial receipts to usage every 60 seconds.
This repairs a crash after the immutable receipt committed and before its usage
link: the receipt must match request, idempotency key and authenticated account,
application, credential, environment and delegated-user attribution. An existing
terminal usage row is only linked if its measurements agree; contradictory rows
are excluded before the batch limit and are never overwritten. The reconciler
makes no inference request or financial write. Failed financial settlement still
records technical usage when storage is available. If an internal terminal write
was lost and no authoritative terminal record exists, expiry remains explicitly
unresolved; neither a fabricated zero nor a provider retry is a recovery strategy.
