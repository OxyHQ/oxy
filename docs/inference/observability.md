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
  token is produced upstream, this edge does not stream, and a fabricated number
  here would enter every dashboard as a fact. It is NULL on every row today, and
  will stay NULL until a streaming data plane exists.
- **`route_switches`** — forwarded from the same report. This is the fallback
  metric; it is `0` on every row today for the same reason.

### What each named metric is derivable from, today

| Metric | Source | Available now? |
|---|---|---|
| Request rate | `inference_usage_daily_rollups.request_count` | Yes |
| Error rate | `.error_count` (status ≥ 400), or `inference_usage_events.status_code` | Yes |
| Cancellation | `outcome = 'cancelled'` on the event and the rollup | Yes |
| Total latency | `inference_usage_events.latency_ms` | Yes, per event — the rollup carries no latency column, and adding one is a migration |
| Time to first token | `inference_usage_events.time_to_first_token_ms` | Column ready; NULL until a streaming data plane reports one |
| Fallback | `inference_usage_events.route_switches`, and `inference_route_switch_events` for the customer-visible receipt | Column ready; `0` until a data plane switches a route |
| Reserve failures | `inference_usage_events` rows with `status_code = 402` (`insufficient_balance`, `spending_limit_exceeded`), plus the `inference.edge.reservation_refused` log line | Yes |
| Settlement lag | `usage_receipts.settled_at − usage_reservations.created_at`, joined on `usage_receipts.reservation_id` | Yes |
| Reconciliation drift | `POST /billing/accounts/:accountId/reconciliation` publishes each pass; `GET .../reconciliation` lists them | Yes, on demand — it is a staff-run pass, not a stream |

### What the scrape side waits on, and who owns it

Turning those queries into dashboards and alerts is `~/Oxy/oxy-infra`'s, not this
repository's. Specifically:

1. **A scrape or export target.** The API runs on ECS Fargate behind one ALB with
   no metrics endpoint, no Prometheus, no OTLP collector and no managed APM. A
   `/metrics` route here would be an endpoint nothing polls — and one that would
   need its own authorization decision, since request counts per application are
   customer data.
2. **A query surface over Postgres.** Everything in the table above is SQL. The
   cheapest first step is a scheduled query, not an instrumentation library.
3. **Alert routing.** Named below as explicitly out of scope.

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
  because it reads as coverage.
- **Alerts for provider error and cost spikes** — the same, and additionally
  blocked on a provider existing to have an error rate.
- **Audit dashboards for credential and billing changes** — the tables and their
  read functions exist (`listCredentialAuditEvents`, the provider-connection
  audit read); no Console surface renders them yet, which is workstream 9's
  "Webhooks/audit events where applicable".
- **Status-page signals from customer-safe model availability** — the catalogue
  is empty and no deployment has health, so every signal would be a constant.

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

### Two places the actor is genuinely thinner than the trail suggests

Both need a column, so both are recorded here rather than changed:

1. **`billing_ledger_entries` carries no actor at all.** A promotional grant is
   issued by staff (`POST /billing/accounts/:accountId/grants`, `requireStaff`)
   and lands as `kind = 'promotional_grant'` with no record of which staff member
   issued it. The KIND of action is distinguishable — only staff can grant, and
   only the payment processor can `top_up` — but the person is not. Recording one
   is an `actor_user_id` column on an append-only, trigger-protected financial
   table, which is a migration and a decision about what a NULL there means for
   the entries no person authors (`reservation_hold`, `settlement`,
   `reservation_expiry`).
2. **The BYOK trail cannot tell a person from a service token.**
   `inference_provider_connection_audit_events.actor_user_id` is written from
   `authorOf(principal)`, which returns the calling user's id for a session
   principal and the **owning account's** id for a service-token principal. Both
   land in the same column, so "a member rotated this connection" and "an
   application rotated it with a service token" read identically. That applies to
   every event with an actor — create, validate, rotate, disable, enable, revoke;
   `used` is already NULL-actor by CHECK. Telling them apart needs a principal
   kind on the row, which is a column.

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
