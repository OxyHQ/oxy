# Observability: what you can ask this platform, and what you cannot

Issue [#972](https://github.com/OxyHQ/oxy/issues/972) workstream 16
(**Observability**) and the *Audit and controls* half of workstream 12. Status of
the whole picture: [README.md](./README.md).

**There is no metrics library in this repository, and that is a decision rather
than a gap.** What exists instead is a durable, queryable record — one request id
that joins the edge, the ledger, the usage stream and the customer's receipt —
plus structured `pino` logs. This page says which questions that record already
answers, which it answers only after infrastructure work that belongs to
`~/Oxy/oxy-infra`, and which it cannot answer at all yet because there is no data
plane.

**Those numbers are now SERVED, not merely queryable.**
`GET /inference/admin/metrics` (staff-gated, `routes/inferenceAdmin.ts`) answers
all nine of the metrics workstream 16 names, from the durable record. See
[What is served, and what is still only a query](#what-is-served-and-what-is-still-only-a-query).

---

## The correlation column: one `requestId`, five places

`allocateRequestId()` mints a UUID in `edgeGate`
(`packages/api/src/routes/inferenceEdge.ts`) **before authentication**, so a
request that is refused at the door is still traceable. It then appears in:

| Where | Column / field |
|---|---|
| The response, on every path including errors | `X-Oxy-Request-Id`, and `requestId` in the Oxy-native body |
| The envelope handed to the data plane | `attribution.requestId` |
| The financial hold | `usage_reservations.request_id` |
| The usage stream | `inference_usage_events.request_id` |
| The customer's receipt | `usage_receipts.request_id`, resolved by `GET /v1/generations/:id` |

Two further tables carry it for the events that have one:
`usage_refunds.request_id` and `inference_route_switch_events.request_id`.

All five legs are asserted together in
`packages/api/src/routes/__tests__/inferenceEdge.test.ts`
(`describe('requestId correlation')`), against a real Postgres and a real
credential. Each row read is scoped to the fixture's own account and asserted to
EXIST before its value is compared — "no row matched" and "the row matched and
agreed" are otherwise the same green.

### The data-plane leg is enforced, not merely sent

Oxy cannot assert what the data plane writes in its own logs, because there is no
data plane ([README.md](./README.md)). What it *can* assert, and does, is the
enforcement: `validateCompletion` refuses a usage report whose `requestId` is not
the one that was sent, with `internal_error`, and settles the hold at zero rather
than charging it. A report about somebody else's request can therefore never
become this customer's receipt — which is what makes the correlation a guarantee
rather than a coincidence.

---

## Metrics: why there is no `prom-client`, and what carries the numbers instead

The epic asks for metrics on request rate, error rate, time to first token, total
latency, cancellation, fallback, reserve failures, settlement lag and
reconciliation drift.

Every one of those is a property of a request this platform already writes a
durable row for. `inference_usage_events` is append-only, one row per admitted
request, and `inference_usage_daily_rollups` folds it into counters in the same
transaction. Adding a counter registry beside those tables would have produced a
second, weaker copy of the same numbers: in-process, lost on every deploy, and —
with no scrape target configured anywhere — read by nobody. **An unexported
counter is not observability, and a dependency nothing scrapes is worse than a
documented absence.**

That is not a hypothetical shape. The API already has one:
`middleware/performance.ts` is mounted globally in `server.ts` and records every
request's duration into `utils/performanceMonitor.ts` — an in-memory ring buffer
capped at 1000 samples, keyed by `METHOD /path`, exposed as JSON at
`GET /metrics` behind `authMiddleware` + `requireStaff`. It gives `p50/p95/p99`
for `POST /v1/responses` as a whole, and nothing else: no breakdown by account,
application, model or provider, per-instance only, discarded on every deploy, and
polled by nobody because reading it needs a staff session bearer. A second
registry would have had exactly those properties. The durable table is the one
worth filling.

What was missing was smaller and more specific: three columns that existed and
that nothing ever wrote. `inference_usage_events.latency_ms`,
`.time_to_first_token_ms` and `.route_switches` were declared, constrained and
never written — a metric surface that is indistinguishable, from a query, from a
metric surface that is correctly zero. The edge now fills them:

- **`latency_ms`** — Oxy's own measurement, from the monotonic instant `edgeGate`
  received the request to the telemetry write. It therefore includes
  authentication, admission, routing, the reservation, the forward and the
  settlement. It is deliberately NOT the data plane's
  `completedAt - startedAt`: that measures the upstream and would call it the
  platform's, and the difference between the two is exactly the overhead a
  control plane is answerable for.
- **`time_to_first_token_ms`** — forwarded from the data plane's usage report
  when it reports one, and left NULL when it does not. Never imputed: the first
  token is produced upstream, and a fabricated number here would enter every
  dashboard as a fact. It is NULL on every row today because **no deployment
  configures a data plane**, not because the edge cannot stream — it can, on both
  public dialects, since the signed relay hop landed.
- **`route_switches`** — forwarded from the same report, and surfaced as a
  `route_switch` frame on both dialects. This is the fallback metric; it is `0` on
  every row today for the same reason.

### What each named metric is derivable from, today

| Metric | Source | Available now? |
|---|---|---|
| Request rate | `inference_usage_daily_rollups.request_count` | Yes |
| Error rate | `.error_count` (status ≥ 400), or `inference_usage_events.status_code` | Yes |
| Cancellation | `outcome = 'cancelled'` on the event and the rollup | Yes |
| Total latency | `inference_usage_events.latency_ms` | Yes, per event — the rollup carries no latency column, and adding one is a migration |
| Time to first token | `inference_usage_events.time_to_first_token_ms` | Column ready, edge streams; NULL until a data plane is CONFIGURED and reports one |
| Fallback | `inference_usage_events.route_switches`, and `inference_route_switch_events` for the customer-visible receipt | Column ready, edge forwards it; `0` until a configured data plane switches a route. **The `serving_provider` column is NOT updated alongside it** — see below |
| Reserve failures | `inference_usage_events` rows with `status_code = 402` (`insufficient_balance`, `spending_limit_exceeded`), plus the `inference.edge.reservation_refused` log line | Yes |
| Settlement lag | `usage_receipts.settled_at − usage_reservations.created_at`, joined on `usage_receipts.reservation_id` | Yes |
| Reconciliation drift | `billing_reconciliation_runs` / `_discrepancies`, filled by the scheduled pass | Yes — see [Reconciliation drift is a stream](#reconciliation-drift-is-a-stream-not-a-staff-triggered-pass) |

## What is served, and what is still only a query

`GET /inference/admin/metrics?from=&to=[&accountId=][&applicationId=]` —
`routes/inferenceAdmin.ts`, behind `authMiddleware` + `requireStaff`, reading
`services/inferenceMetrics.service.ts`. Nine metrics, one window, one payload.

**Why it is not on `GET /metrics`.** That endpoint is process-local: an in-memory
ring buffer keyed by `METHOD /path`, one instance's view, discarded on every
deploy. Everything on the new route is a query over the durable record, so the
answer is identical from any instance and survives a deploy. Those are two
different kinds of number, and putting them under one key would invite a reader to
compare them. The new route lives on the existing staff mount rather than getting
one of its own, for the reason `GET /inference/admin/rollout` does: a second staff
surface is a second gate to keep correct.

**Staff-only, and why that is not incidental.** Request counts per application are
customer data; a settlement-lag distribution is Oxy's own operational figure. No
query behind the route reads `upstream_wholesale_cost_*` or any price column, so
Oxy's commercial position cannot appear on a metric. No field is derived from a
user IP, and none can be — the columns do not exist.

**Counts come from the rollups; money never does.** `inference_usage_daily_rollups`
has no cost, credit or amount column at all — the units/money split is enforced by
the schema rather than by a convention — and its grain is a UTC `date`. So request,
error and cancellation counts are read from it, and every money figure on this route
comes from the financial tables: settlement lag from `usage_receipts.settled_at`
against `usage_reservations.created_at`, and the reconciliation totals from
`billing_reconciliation_runs`. A spend figure has one source, `usage_receipts`
(`billed_amount`, `settled_at`, with `usage_receipts_account_id_settled_at_idx` for
exactly that shape) — and no metric here derives one from a telemetry sum.

| Metric | Served as | Source |
|---|---|---|
| Request rate | `requests.requestCount` | `inference_usage_daily_rollups.request_count` |
| Error rate | `requests.errorCount` + `errorRateBps` | `.error_count` (status ≥ 400) |
| Cancellation | `requests.cancelledCount` + `cancellationRateBps` | rollup rows with `outcome = 'cancelled'` |
| Total latency | `totalLatencyMs` — p50/p95/p99/max | `inference_usage_events.latency_ms` |
| Time to first token | `timeToFirstTokenMs` — **`state: 'pending'`** | `.time_to_first_token_ms` |
| Fallback | `fallback` — **`state: 'pending'`** | `.route_switches` |
| Reserve failures | `reserveFailures.refusedRequests` | events with `status_code = 402` |
| Settlement lag | `settlementLagMs` — p50/p95/p99/max | `usage_receipts.settled_at − usage_reservations.created_at` |
| Unmeasured settlements | `unmeasuredSettlements.receiptCount` | `usage_receipts` where `usage_source = 'estimated'` — see below |
| Reconciliation drift | `reconciliationDrift` | `billing_reconciliation_runs` / `_discrepancies` |

### Two metrics have NO DATA YET, and say so rather than reporting zero

`timeToFirstTokenMs` and `fallback` come back as
`{ state: 'pending', reason, observedRows, rowsCarryingValue }` — never `0`. A
metric that reads zero when it means "unmeasurable" is indistinguishable from one
that is correctly zero, and the second reading is the one a dashboard takes.

- **`time_to_first_token_ms` is NULL on every row.**
  `reason: 'no_first_token_time_reported'`.
- **`route_switches` is `0` on every row.** `reason: 'no_route_switch_reported'`.
  The column is `NOT NULL DEFAULT 0`, so "reported no switch" and "reported
  nothing" are the same stored value — which is why the predicate is
  `route_switches > 0` and not `is not null`.

**The reason is not that the edge cannot produce them, and this page used to say it
was.** That claim was true and stopped being true: since the signed relay hop
landed the edge streams both public dialects, forwards the data plane's own
`timeToFirstTokenMs` and `routeSwitches` when a usage report carries them, and
surfaces `route_switch` frames on both dialects. What is absent is a **data
plane**. `resolveRelayDataPlane()` answers `absent` unless `RELAY_BASE_URL`,
`RELAY_EDGE_SIGNING_KEY_ID` and `RELAY_EDGE_SIGNING_PRIVATE_KEY` are all set, and
no deployment sets them — so nothing has ever streamed and no route has ever
switched.

That distinction gets a **field, not a comment**, because it is the one that will
matter the day Relay is deployed: `dataPlane` on the payload reports
`configured | absent | unreadable` straight from the resolver. With `absent`, a
pending first-token time needs no investigation. With `configured`, the same
pending means the data plane is not reporting what it should — a bug, and one that
would otherwise look identical. `unreadable` is reported rather than folded into
`absent`, because a deployment that believes it configured a data plane and has not
is the most confusing of the three.

Both discriminators are **derived**: `rowsCarryingValue` is a `count()` over the
column and `dataPlane` is read from the environment resolver, so neither arm is
hardcoded and both stop being pending by themselves.
`services/__tests__/inferenceMetrics.service.test.ts` carries the positive control
that proves it — a row with a first-token time surfaces as `measured` with real
percentiles — and a mutation counting NULLs as samples makes the pending case
report `state: 'measured', p50Ms: 0`, which the same test rejects.

`pending` additionally distinguishes `observedRows: 0` (nothing happened) from
`observedRows: 12, rowsCarryingValue: 0` (things happened; none carried the value).
Both are asserted.

One number this metric is NOT: `inference_route_switch_events` is the
customer-visible record of a switch and has its own writer. `fallback` counts the
telemetry column instead, so the two are different figures and are deliberately not
compared here.

### `unmeasuredSettlements` gives a partial index its first reader

`usage_receipts_estimated_idx` is partial on `(settled_at) WHERE usage_source =
'estimated'` and was commented "the reconciliation queue: estimated receipts
awaiting a provider's real figures". A census over non-test source finds
`'estimated'` in exactly three places — the schema enum, the ledger's reason
mapping, and the index predicate itself — and **no query, job, alert or endpoint**.
A partial index nothing reads is write amplification on the largest financial
table, and a queue nobody drains is worse than a documented absence.

Rather than drop the index, this surface reads it, with a query that is
deliberately the index's own shape: same predicate, ranging on the same leading
column. The index comment has been corrected too, because "awaiting a provider's
real figures" implies a drainer that does not exist — there is no ingestion path
for a provider's retrospective usage.

What these rows actually are: requests the data plane reported nothing for, settled
at ZERO with refund reason `usage_unavailable`, so the customer was not charged and
Oxy absorbed the upstream cost. So **a rising count means the data plane is losing
usage reports**, not that a backlog is building. `settledReceipts` is reported
beside it as the denominator, and `latestSettledAt` so a stale figure is visibly
stale.

Distinct from a `zero-usage` REFUSAL ([billing.md](./billing.md#refuse-never-estimate-972-73)),
which writes no receipt at all and therefore never appears here.

### There is no latency column on the rollup, deliberately

A rollup row is counters folded by `ON CONFLICT DO UPDATE`. The only latency
figures that survive that fold are a sum and a count — a MEAN, the one latency
statistic that hides the tail that p95 and p99 exist to show. Percentiles are not
foldable: `p95(a ∪ b)` is not derivable from `p95(a)` and `p95(b)`. So no migration
was taken. The honest limitation is that a latency percentile is unanswerable for a
window older than the ninety days `inference_usage_events` keeps, which a mean
column would have answered wrongly rather than not at all. The window is bounded at
ninety days for the same reason: a wider one cannot yield more samples, so
answering it would misstate the range the numbers cover.

### The provider dimension is absent, and that is a known gap

No metric on this route is broken down by serving provider. The edge writes
`route.provider` — the provider it ADMITTED — at all nine of its telemetry,
receipt and rollup sites, and never reads `completion.usage.servingProvider`, the
provider the data plane REPORTS. A same-model failover would therefore be billed
and recorded against the original provider, so a per-provider error rate served
here would be confidently wrong for exactly the traffic it exists to explain.
Because `inference_usage_daily_rollups`' primary key includes `serving_provider`,
that traffic also folds into the wrong rollup bucket permanently. A follow-up fixes
the write side; this surface declines to publish the dimension until then rather
than publish it misattributed. `inferenceReporting.service.ts` still groups the
customer's own usage by provider and inherits the same gap.

### Reconciliation drift is a stream, not a staff-triggered pass

`POST /billing/accounts/:accountId/reconciliation` remains, unchanged, for
investigating one account over an arbitrary window. A drift *metric* needs a
series, so the same comparison also runs on a timer:
`runScheduledReconciliation` in `services/billingReconciliation.service.ts`,
registered in `server.ts` beside the reservation-expiry and auto-recharge sweeps.
It reconciles one complete hour at a time, one hour behind the clock so a late
`payment_intent.succeeded` webhook is not reported as `missing_in_ledger`.

**`oxy-api` runs N ECS tasks and every one of them registers every sweep.** A job
that simply fired on each would write N run rows per window, make N Stripe scans
and record N copies of every finding — the drift metric would then read N× reality,
which is worse than not having it. The interlock is the auto-recharge sweeper's,
transferred: **claim the window before calling the processor, and do nothing at all
if you did not win it.** The claim is the `running` run row this module already
writes first, taken under a transaction-scoped `pg_try_advisory_xact_lock`:

- the lock makes the read-then-insert atomic across tasks, so two cannot both
  insert. `try`, never a blocking wait — a loser has nothing to do;
- a `completed` row for the window means it is done; skip;
- a `running` row inside its lease means another task is mid-pass; skip;
- a `running` row OLDER than the lease is a crashed pass: it is marked `failed`
  and the window reclaimed. This is where the design differs from auto-recharge,
  and why it is not a copy. A lost auto-recharge window costs nothing because the
  next one retries the same account; a reconciliation window is a distinct FACT, so
  a claim stranded by a dead task would leave a permanent hole in the series;
- a `failed` row means the window's drift is UNKNOWN, not zero, so it is retried.
  (Auto-recharge deliberately keeps a declined claim — a declined card declines
  again. Nothing about a Stripe outage says the next attempt fails, and reporting
  no drift for an unread window is the "cron that hides drift" this module
  refuses.)

The advisory lock is released when the claim transaction commits, before the
processor is called: after that the `running` row IS the claim, and holding a
database lock across a third-party HTTP call would tie a Postgres connection to
Stripe's latency.

With no `STRIPE_SECRET_KEY` the sweep returns `processor-unconfigured` and claims
nothing, exactly as `runAutoRechargeSweep` does — so a development deployment logs
nothing per interval and a deployment that later configures Stripe still reconciles
the windows it skipped.

Two reporting consequences worth stating, because both are ways this metric could
be read wrongly:

- **`reconciliationDrift.latest` is the newest completed pass, never a sum.**
  Scheduled windows can overlap after a reclaim, and an unresolved discrepancy is
  re-reported by every pass that sees it — that is how this module expresses
  resolution. Summing across runs counts one problem several times.
- **Discrepancy counts by kind are `observationsByKind`, not distinct findings**,
  for the same reason. The field name says so.
- **A quiet platform still produces a run row.** The pass always runs in
  `DEFAULT_LEDGER_CURRENCY` even when the window holds no payments, so a completed
  run with both totals zero says "the pass ran and found nothing" — which is what
  distinguishes it from a dead scheduler, whose signature is no run row at all.

### What the scrape side waits on, and who owns it

Serving the numbers is this repository's and is done. Turning them into
dashboards and alerts is `~/Oxy/oxy-infra`'s. Specifically:

1. **A scrape or export target.** The API runs on ECS Fargate behind one ALB, and
   there is no Prometheus, no OTLP collector and no managed APM pointed at it.
   Neither `GET /metrics` nor `GET /inference/admin/metrics` is an exposition
   format, and turning either into one is also an authorization decision: request
   counts per application are customer data and both gates are `requireStaff` — a
   collector would need a credential that is not a staff user's session bearer,
   which is a decision, not a detail.
2. **A query surface over Postgres.** Everything in the table above is SQL. The
   cheapest first step is a scheduled query, not an instrumentation library.
3. **Alert routing.** Named below as explicitly out of scope.

**Measured, so nobody re-checks it:** `~/Oxy/oxy-infra` holds 58 Terraform files
with zero `aws_cloudwatch_metric_alarm`, zero `aws_sns_topic` and zero
`aws_cloudwatch_dashboard`. CloudWatch appears there only as log groups
(`terraform/ecs.tf`, group `/oxy/ecs`). The concrete shape the export half would
take, when somebody takes it:

- an `aws_sns_topic` plus an `aws_cloudwatch_metric_alarm` over a metric filter on
  the `/oxy/ecs` log group — the `inference.edge.reservation_refused` and
  `billing.reconciliation.drift` lines are already structured for it; **or**
- a scheduled query against Postgres calling
  `GET /inference/admin/metrics`, which is why that route reports a `state` per
  metric rather than a bare number: a scheduled query has to be able to tell "no
  data yet" from "zero" without a human reading it.

Neither is being added here. **There is no alert manager, no on-call rotation and
no paging policy in either repository**, so an alarm added today would fire into
nothing — and an alert that fires into nothing is worse than none, because it reads
as coverage. The alarm is an `oxy-infra` PR that has to land *after* a destination
exists, not before.

Whatever form it takes, one rule is not negotiable: **no metric label may be
derived from a user IP** — raw, hashed or geo-derived. An account id or an
application id as a label is fine; anything IP-derived is the same violation as a
column, and metrics labels are the classic way it gets reintroduced. Prompts and
responses are the same: a label or a log line carrying a message body is the same
violation as persisting one.

### Not built here, on purpose

These are named in workstream 16 and belong to `~/Oxy/oxy-infra`, or to a
workstream that does not exist yet. They are listed so a reader finds the reason
rather than assuming an oversight.

- **Alerts for ledger imbalance and duplicate event ids** — an alert needs a
  destination. There is no alert manager, no on-call route and no paging policy
  in this repository, and an alert that fires into nothing is worse than none
  because it reads as coverage. The invariants themselves are enforced
  structurally instead — duplicate event ids by
  `ON CONFLICT … DO NOTHING RETURNING`, imbalance by a `reserved_balance >= 0`
  check plus balance-row serialization — so what is missing is the notification,
  not the guarantee. Shape and owner: above.
- **Alerts for provider error and cost spikes** — the same, and additionally
  blocked twice over: on a provider existing to have an error rate, and on the
  reported-vs-admitted provider gap described above, which would make a
  per-provider rate wrong before anyone alerted on it.
- **Audit dashboards for credential and billing changes** — the tables and their
  read functions exist (`listCredentialAuditEvents`, the provider-connection
  audit read); no Console surface renders them yet, which is workstream 9's
  "Webhooks/audit events where applicable". This is a Console task, not an
  observability one.
- **Status-page signals from customer-safe model availability** — the catalogue
  is empty and no deployment has health, so every signal would be a constant.
  What it waits on is specific and is not Oxy's to build: a **deployment-health
  source the data plane owns** — per-deployment reachability and error rate, on the
  side that actually talks to a provider. Oxy can serve the customer-safe
  projection of it (`inference_deployments.status` and the catalogue's own
  availability scope are already customer-safe), but a status page needs the
  liveness half, and this control plane has no way to observe it. Until then every
  signal would read "operational" whatever was happening upstream, which is worse
  than an absent status page.

---

## Audit: staff actions vs customer actions

Workstream 12 requires the two to be distinguishable. They are, and the mechanism
is worth stating because it is not a column.

**The credential trail records only customer actions, by construction.** The
three routes that write an actor-bearing row into
`application_credential_audit_events` — credential create, rotate and revoke —
are gated by `requireAppPermission`, which resolves access ONLY through
`accountService.resolveEffectiveAccess` over `Application.ownerAccountId`.
`isStaff` is not consulted anywhere on that path and grants nothing there. So
every `actor_user_id` on that table is an account member acting as a customer,
including an Oxy employee acting on their own account — which is the correct
reading, because the authority they used was their membership and not their staff
flag.

**Staff-authorised decisions are recorded elsewhere.** The catalogue's staff
surface (`routes/inferenceAdmin.ts`, `requireStaff`) writes
`inference_deployments.permission_state_changed_by_user_id`,
`.permission_state_note`, `.legal_reviewed_by_user_id` and
`.legal_review_evidence_ref`. The two kinds of action are told apart by WHERE the
record is, not by a flag on it.

That is true today and would stop being true **silently** the first time a staff
support route is given a write into the credential trail. So it is pinned by a
test rather than left to be re-derived:
`packages/api/src/routes/__tests__/machineCredentials.test.ts`, *"the staff flag
opens no door into a customer's credential trail"* — a caller carrying `isStaff`
and no membership is refused create, rotate and revoke, no row names them, and
the same revoke from the account member succeeds and writes one. The control is
what stops the three refusals reading the same as routes that refuse everybody.

### Where the actor is thinner than the trail suggests

1. **`billing_ledger_entries` — CLOSED** (issue #1023 part 2, migration `0046`).
   A promotional grant is issued by staff (`POST /billing/accounts/:accountId/grants`,
   `requireStaff`) and used to land as `kind = 'promotional_grant'` with no record
   of which staff member issued it: the KIND of action was distinguishable, the
   person was not. The table now carries `actor_kind` + `actor_user_id`, with
   three states that cannot be read into one another — `('staff', <users.id>)`,
   `('machine', null)` for the entries no person authors (`reservation_hold`,
   `settlement`, `reservation_expiry`, a processor top-up), and `(null, null)`
   for rows written before the column existed, which were NOT back-filled. The
   full argument, including why "no person authored it" has to be a value rather
   than a blank, is in [billing.md](./billing.md#who-authored-an-entry).
2. **The BYOK trail cannot tell a person from a service token — CLOSED**
   (issue #1043, migration `0049_inference_provider_connection_actor`).
   `inference_provider_connection_audit_events.actor_user_id` used to be written
   from `authorOf(principal)`, which returned the calling user's id for a session
   principal and the **owning account's** id for a service-token one. Both landed
   in the same column, so "a member rotated this connection" and "an application
   rotated it with a service token" read identically, on every event with an actor
   — create, validate, rotate, disable, enable, revoke.

   The row now carries `actor_kind`, one of
   `PROVIDER_CONNECTION_ACTOR_KINDS` = `user | service | platform`, with a CHECK
   enumerating the legal combinations. `authorOf` is gone from that path in favour
   of a discriminated-union `actorOf`, so the two incoherent rows the CHECK refuses
   — a `user` with no id, a `service` or `platform` carrying one — are not
   expressible in TypeScript either: a writer that omits the kind fails `tsc`
   rather than the database. `used` remains NULL-actor by CHECK, which the column's
   nullable first branch admits.

### Least-privilege admin roles: today there is exactly one tier

`middleware/requireStaff.ts` is a single boolean — `req.user.isStaff` — set only
by hand in the database, with no self-service grant. Every staff-gated surface in
the API uses the same guard: the inference catalogue admin routes, staff billing
(grants, invoices, reconciliation), cost centres, moderation, reputation, topics,
the app store, platform stats and location-cache administration. **A staff member
who can retire a model route can also issue promotional credit**, and nothing
records which of those two things a given staff account is supposed to do.

The smallest real split, proposed and deliberately not built here because it is a
schema change and a policy decision rather than an observability one:

- Replace the boolean with a **staff role set** on the user (`catalogue`,
  `billing`, `moderation`, `platform`), keeping `isStaff` as "holds at least one".
- Make `requireStaff` take the role it requires — `requireStaff('billing')` —
  so the guard names its authority at the call site and an unannotated staff
  route stops type-checking.
- Grant the money-moving surfaces (`grants`, `invoices`, `reconciliation`) their
  own role, because they are the ones with no compensating control: a wrongly
  approved catalogue route is retired again, a wrongly issued grant is money.

Two further workstream-12 items are **out of scope here and unbuilt**: rate limits
and fraud controls before prepaid public inference (gated on a launch that cannot
happen — there is no data plane — and on anomaly detection, which is its own body
of work), and the privacy/security review gate on public launch, which is a
process decision rather than code.
