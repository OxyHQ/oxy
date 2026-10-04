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

**Nate approved the documented pilot on 2026-10-03 (#1526). Source implementation and rollout evidence remain separate.**
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

Approved pilot: 32 in flight and 5,000 admissions per UTC day. These are
configured limits with historical headroom, not measurements of current capacity.
Version `oxy-inference-economics/2026-10-04.2` restricts every signed
route (including failovers) to the exact deployment/model/provider tuples in
`config/inferenceEconomicPolicy.ts`. The existing three tuples remain at
`openai/gpt-oss-120b@observed-2026-09-01`:

- `dep_cerebras_gpt_oss_120b_observed_2026_09_01` / `cerebras`;
- `dep_groq_openai_gpt_oss_120b_observed_2026_09_01` / `groq`;
- `dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01` / `openrouter`.

One existing reviewed High route is additionally admitted:
`dep_openrouter_deepseek_deepseek_v4_flash_0731_observed_2026_09_01` /
`deepseek/deepseek-v4-flash-0731@observed-2026-09-01` / `openrouter`.
The 2026-10-04 read-only catalogue and signed Kaana inventory identified this
exact tuple. It retains its `platform_internal`, `standard_application_use`
permission and serving-provider terms; `commercialUseAllowed` remains false.
An explicit policy requiring commercial-use rights still excludes it. No model
class, Auto rule, permission, privacy field or catalogue row changes here.

This is exact identity matching; publication, signed fresh attestation, ordinary
model/provider/privacy gates and permission checks still apply. The pilot does
not open an unapproved provider or authorize a scoped decisions audience. Auto
can now admit its existing High class under the exact tuple; it still climbs
only upward from its classified level and never drops tools or falls back to
an Instant model to fit the pilot.

The controlled-input budget is at most **126976** for text completions;
decisions retain their **8192** base ceiling and independent scoped authority.
It counts UTF-8 serialized normalized
input, tools, tool choice and response format, plus explicit local allowances
of 256 base, 32 per message and 32 per tool. It includes roles, tool arguments
and schemas. Only text completions can satisfy this guard; unsupported modalities
and operations fail before claims or execution. This is a conservative budget
of content Oxy controls, **not** a certified maximum of provider tokens, hidden
prompts, framing or billable usage. No tokenizer or upstream consumption guarantee
is inferred. Strict provider-token enforcement requires a verified Kaana/provider
contract and tokenizer evidence.

Output uses `min(requested maxOutputTokens, 2048)`, or 2048 if omitted, before
capacity, price quotation and the signed attempt. An older Alia client requesting
4096 remains compatible; smaller requests keep their upper bound. Commercial
callers retain existing behavior. Real usage and cost provenance remain measured
separately; these controls do not establish a monetary provider-spend ceiling or
approve a tariff.

Before any durable admission claim, every candidate quote and the final signed
route set must be in USD and at most **0.05 USD**, compared with exact decimal
arithmetic. A tighter application or classifier ceiling still wins. The readback
tariff for the added High tuple was $0.0152 per million input/cached-input units
and $1.28 per million output/reasoning units, with zero per-request amount. At
126976 controlled-input units plus the shared 2048 output/reasoning ceiling,
its quote is $0.0045514752. This is a tariff quotation, not an upstream invoice
or retry-spend guarantee; unknown provider costs remain unknown. Source and
HTTP/SQL fixtures qualify admission, while production readiness and a real
reply still require the operator's exact image, signed route and live receipt.

### Deployment order and reversal

1. Deploy and verify Kaana #150's SQL NULL preservation before enabling the signed
   provider-attempt ingestion. NULL is unmeasured, never an empty measured array.
2. Apply Oxy migrations with the existing migrator, then deploy the reviewed backend
   and read back policy version, signed registry identities and durable usage/cost
   correlation before live pilot acceptance. No SDK publication precedes backend.
3. Keep Alia's current 4096 default safe through the backend cap; independently
   deploy reviewed Alia snapshot changes only after its backend dependencies exist.
4. Publish the final coordinated SDK package set, then adopt consumers and verify
   integration. Never use source candidates as proof of publication.

Rollback uses the previous reviewed backend image/task definition and disables
new ingestion through its existing rollout controls; retain migration data and
history. Do not erase measured records or rewrite unknown costs as zero. A prior
image lacking pilot guards is not a safe live pilot target; stop that workload
before reverting. Current model presence and endpoint readiness must be checked
via signed operator readback, not inferred from this configuration.

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
  can have measured or estimated upstream cost, so its evidence stays in the cost table.

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
- `providerCost`, reported or rate-card-estimated upstream amounts, with failed failovers included;
- `customerCharge`, from receipts only, which is always zero for `internal_metered`.

Unknown tariffs and costs appear as `unknownCount` beside each sum.
`GET /billing/cost-centers/spend` is unchanged and still reads receipts only.

## Not covered here

- The I10 candidate below adapts the Auto/Jev child and generation readback.
  Final integration, Alia's product price snapshot and deployed evidence remain
  pending; local implementation does not approve its production gates.
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


## I10 candidate compatibility and technical readback

The generated additive migration `0134` in the local #1516/#1529/#1531
composition adds nullable `parent_request_id` and nullable final authorization
columns. Its index must be regenerated over the final integration head, without
merging snapshot JSON by hand. Initial admitted model/provider/deployment and
ceiling remain immutable; Auto appends its final requalified authorization once.
The parent claims its key before any classifier can execute. Each parent/child
claim consumes one admission under the same application/environment concurrency
and UTC-day limits. A parent refused after the classifier executed retains its
key and settles as failed with estimated parent units; the child's measured
units remain independently durable. No commercial hold is introduced internally.

Scoped internal dispatch checks the exact retained durable claim and its expiry,
and the exact unexpired scoped permit. Commercial scoped dispatch retains its
promotional-only hold and charging authorization. `preapprovedManifest` stays
undefined; accounting readiness grants no provider/rights/privacy/capability or
source-review authority.

`GET /v1/generations/:id` returns the existing financial receipt at schema version
1 or an internal `metered_usage` record at version 2. The latter has its stored
usage, pinned tariff evidence and explicit `customerCharge.status: not_charged`;
it has no fabricated receipt ID, invoice or provider cost. Only settled technical
rows qualify. Read entitlement is the application plus `inference:usage:read`
scope, preserving the existing financial-receipt contract. A valid replacement
credential can read the application's historical records after key rotation,
owner transfer or a change of credential environment; authentication still
validates that credential and its environment before lookup. A supplied
delegated-user selector filters attribution. Omitting it permits the application's
records with or without delegated attribution. The selector does not prove user
identity or change financial treatment. Parent and child IDs return their own
record and preserve lineage.

Receipt-to-metering reconciliation remains a separate immutable matching step:
account, application, original credential, environment and null-safe delegated
attribution must all match exactly. Application-level read entitlement does not
relax that reconciliation join.

The SDK keeps `getGeneration(): Promise<OxyGenerationReceipt>` unchanged. A new
`getGenerationRecord(): Promise<OxyGenerationRecord>` admits either wire variant;
consumers narrow on `schemaVersion`. The legacy method throws a structured
protocol error for an internal record and points to the new method. Adding the
new method avoids changing an existing caller's financial TypeScript return type;
raw endpoint consumers must handle the versioned response. A local packed SDK
candidate is test evidence, not proof that Alia has adopted a published release.

The metadata-only Jev readback keeps its version-1 result when no Alia candidate
is supplied, and returns version 2 with an Alia candidate. Internal Alia readiness
uses versioned economics, existing workload identity and technical schema/count
proof instead of promotional funds. Commercial candidates retain funding proof.
The snapshot does not reserve capacity; `providerActivationAuthorized` is false.
Mention's status remains separate from Alia's candidate status.

The readback verifies the six required I10 columns with their types and
nullability, both validated lineage checks and the parent index before reporting
technical schema availability. A table present at migration 0133 alone is
insufficient. Capacity uses the same query as admission: all non-refused
application/environment rows in the two-day window, with live expiry for
concurrency and the current UTC day for daily limits, across economic treatments.
These observations are a read-only snapshot, not a reservation or activation grant.

### Bounded live feed read, 2026-10-02

The [projected evidence](internal-metered-feed-evidence-2026-10-02.json) records a
read-only HTTPS query signed with the existing Oxy edge identity, limit 25 and no
after cursor. The first page returned 25 attempts / 23 request IDs, all costs
unknown; 21 rows had an empty key classification. That empty string means the
classification was not supplied. The reader preserves it as provenance and does
not infer platform class, funding, eligibility or authorization. Missing, null,
non-string and oversized classifications remain invalid. Raw operator evidence
stays local with restricted file permissions; the committed fixture consistently
pseudonymizes opaque references and is a derived replay fixture.

The bounded Oxy database query used an existing tunnel and READ ONLY transaction,
5 s statement / 1 s lock timeout, exact 23 request IDs and projected columns. It found
no matching usage_reservations or usage_receipts. The current database did not
have the candidate metered/cost-attempt tables. This is evidence of no matches
in that sample, not successful admission/cost reconciliation.

**Before the first live ingestion**, deploy and verify the NULL-preserving
[Kaana#150](https://github.com/OxyHQ/Kaana/pull/150) producer fix through the normal
approval process. The captured old producer emitted units=[] for every row;
that wire value does not establish measured empty usage. Ingesting those facts
first would pin the immutable digest, and a later corrected units=null for the
same attempt must be rejected as a mismatch rather than rewriting history. The
local fixture proves transport compatibility, exact unknown-cost preservation,
idempotent replay and mismatch refusal only. It cannot certify measured units,
invoice amounts, live ingestion, rollout or provider readiness.
