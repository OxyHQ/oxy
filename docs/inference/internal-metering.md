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
