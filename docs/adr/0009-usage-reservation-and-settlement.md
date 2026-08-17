# ADR 0009 — Spend is reserved before execution, settled against an exact receipt, and reversed by appending

- Status: accepted
- Date: 2026-08-15
- Issue: #972

## Context

The billing surface that exists today was built for credit packs and product
subscriptions, not for metered inference:

- `user_credits` (`packages/api/src/db/schema/userCredits.ts:58`) is keyed on
  `users.id` as its primary key (`:65-67`) and holds `bigint` credit counts. Its
  header states the reason integers were chosen: a spendable balance must not be
  a float.
- `billing_transactions` (`packages/api/src/db/schema/billingTransactions.ts:154`)
  stores money as `amount_minor_units bigint` (`:179`) — exact, and the right
  precedent.
- `api_key_usage_events.credits_used` is `double precision`
  (`packages/api/src/db/schema/apiKeyUsageEvents.ts:95`), on a table that
  self-deletes after 90 days (`API_KEY_USAGE_RETENTION_SECONDS`, `:54`) and has
  no account column (`:83-87`). It is telemetry, and it is the only place a
  per-request "cost" is currently recorded.
- Stripe is wired for checkout, subscriptions, the customer portal and webhooks
  (`packages/api/src/routes/billing.ts:107-362`), all behind `authMiddleware`,
  so the principal is the signed-in user.

None of `price_versions`, `usage_reservations`, `usage_receipts` or
`billing_ledger_entries` exists in `packages/api/src/db/schema/` — verified
2026-08-15. There is no reservation concept at all: nothing authorizes spend
before a request executes, so a request that cannot be paid for is discovered
after the provider has already been billed.

Three properties inference needs and the present system does not have: a charge
that is decided *before* execution, an amount that is exact rather than a float,
and a settlement that is idempotent under retries and event redelivery.

## Decision

**Reserve → settle → refund, keyed by stable ids, exact arithmetic, append-only
history.**

### The protocol

```text
1. RESERVE   at the Oxy edge, before the envelope reaches Relay
             ceiling = f(input units, max output units, allowed route price ceiling)
             insufficient balance / credit limit  →  reject; nothing is forwarded
2. EXECUTE   Relay runs the request and returns a normalized usage receipt
3. SETTLE    exact charge derived from the receipt and the pinned price version
4. REFUND    release (reservation − settled) atomically with the settlement
```

Reserve and settle-plus-refund are each **one transaction**. The refund is not a
later step that could be missed; a settlement that does not also release the
remainder of its reservation is an incomplete write, not a partial success.

### Exact amounts

- **Money is exact `NUMERIC`.** Per-request amounts use a fixed, declared scale
  with sub-minor-unit precision, because one token costs several orders of
  magnitude less than one minor unit and rounding per request would make the
  charge depend on how a client chunked its work. Invoice-level aggregation
  rounds **once**, at the invoice boundary, and the rounding is itself a ledger
  entry rather than a discarded remainder.
- **`double precision` is forbidden for any customer-facing amount.** The
  existing `api_key_usage_events.credits_used` stays a float *and stays
  telemetry*; it is never read to produce a bill. Where the exact billed amount
  is shown to a customer, it comes from the ledger, never from a telemetry sum.
- **Units are not money.** Token counts, milliseconds, image counts and character
  counts are stored as integers in their own columns, separately from the amount
  they priced into. A unit total and a charge are independently auditable.
- **Read the driver's decoding before doing arithmetic.** `postgres.js` decodes
  `numeric` and `bigint` as strings while drizzle types them as `number`; here
  that is a feature, not a hazard, because it makes accidental float arithmetic
  in JavaScript fail loudly rather than silently lose precision. Money arithmetic
  happens in SQL or in a decimal type, never in a JS `number`.

### Idempotency

Every reserve, settle and refund call is idempotent on a **stable id supplied by
the caller**, not on a generated one:

- reservation → `requestId` (ADR 0007), allocated at edge admission
- settlement → `(requestId, generationId?)` from the Relay receipt
- refund → the settlement's own id
- external events (Stripe webhooks, Relay redeliveries) → the provider's event id

A repeated call returns the original outcome and writes nothing new. The
implementation shape is `ON CONFLICT … DO NOTHING RETURNING` rather than
catch-the-duplicate-and-recover: a duplicate key and a dropped connection are
indistinguishable inside a `catch`, so an exception handler would answer "already
settled" to an infrastructure failure.

### Price versions

Every priced entity carries a **price version**, and every settled receipt stores
a **snapshot** of the prices it used — not a foreign key that could later resolve
differently. A price change is a new version; it never edits an old one. A
receipt must remain reproducible after the price it was computed under is
withdrawn.

### Immutable history

Settled receipts and ledger entries are **append-only**. A correction is a
compensating entry that references the original, never an update or a delete.
This is the same rule the reputation ledger already follows, and for the same
reason: a mutated financial record cannot be distinguished from a correct one
after the fact.

### The cases that decide the design

| Situation | Behaviour |
|---|---|
| Balance/credit limit insufficient | Reject at the edge before execution. No reservation, no upstream call, no charge. |
| Client cancels mid-stream | Settle the units actually produced, refund the remainder. Cancellation is a normal terminal state, not an error. |
| Upstream provider fails before producing output | Settle zero, refund the whole reservation. A failed request the customer got nothing from is not billable. |
| Upstream fails after partial output | Settle the produced units exactly; refund the rest. Partial output is billable output. |
| Provider omits usage, and the report does not claim to have completed | Settle ZERO units, mark the receipt **estimated**, refund the whole hold with reason `usage_unavailable`. The receipt says "usage was never measured" rather than "usage was zero" — a distinction any later reconciliation depends on, and the reason this is a settlement and not a bare release. |
| Provider omits usage on a report that claims `completed` | **REFUSE the settlement** (`zero-usage`) and write nothing. See "Refuse, never estimate" below. |
| Reservation exists with no settlement after its deadline | Expire and refund it. An expiry is a refund with a reason, and it is emitted as an event; it is never a silent release. |
| Retry of a settled request | Idempotent no-op returning the original receipt. |
| Redelivered webhook or Relay event | Idempotent no-op on the provider event id. |
| BYOK route | The upstream provider bills the customer directly; Oxy settles only its own platform/service fee, and the receipt says so. |

**No path may charge twice, and no path may execute unreserved.** Those are the
two properties the tests in workstream 16 must falsify rather than confirm: the
duplicate-charge test must be able to fail, and the unreserved-execution test
must assert the wrong answer is not produced, not merely that the right one is.

### Refuse, never estimate — a change to this ADR (#972 §7.3)

**This supersedes what the "provider omits usage" row of the table above used to
say.** It read: "Settle from Oxy's own measurement of the normalized units, mark
the receipt as **estimated**, and reconcile against the provider's later reported
figures." Two things were wrong with it, and both are recorded here rather than
quietly edited away, because a reader who implemented against the old row needs to
know which part changed.

**The behaviour changed, by the owner's decision.** A `completed` report that
metered nothing is now REFUSED, not estimated. The trade is not symmetric:

- refusing costs **Oxy** the upstream spend on a rare provider bug;
- estimating costs the **customer** money nobody can reconcile afterwards, which
  `usage_receipts`' own schema already refuses in as many words — "an estimate
  indistinguishable from a reported figure is one nobody can reconcile".

So the loss is taken on the side that can absorb it and can see it. `settle`
returns `zero-usage`, nothing is written — no receipt, no refund, no journal
entry — the hold stands, and the expiry sweep returns the customer's money on its
own while the edge's existing loud branch makes the provider bug visible. There is
deliberately no refund *reason* for this case, because there is no refund row: the
remainder comes back through expiry, under `reservation_expiry`.

**`failed`, `cancelled` and `partial` with zero units still settle at zero**, and
must keep doing so — nothing was delivered, so zero is the correct charge, and a
zero-unit receipt is how this ADR records an upstream failure that produced
nothing. The bug was specifically a request claiming to have COMPLETED while
accounting for nothing.

**The second wrong thing was the reconciliation.** "reconcile against the
provider's later reported figures" describes a mechanism that does not exist and
has no owner: there is no ingestion path for a provider's retrospective usage, so
nothing arrives to reconcile an `estimated` receipt against. The `estimated`
receipts that remain (the first row of the table) are settled at zero and Oxy
absorbs the cost; a rising count of them means the data plane is losing usage
reports, not that a backlog is building. They are surfaced as
`unmeasuredSettlements` on the staff metrics surface rather than left to imply a
queue somebody drains.

Enforced on both sides of the wire, and it takes both: `inferenceUsageReportSchema`
refuses `completed` with an EMPTY unit array, so that shape is unrepresentable —
but `usageQuantitySchema` permits `quantity: 0`, so a report of units that are all
zero still validates and is caught by the ledger instead. The schema closes "no
units"; the ledger closes "units that sum to zero".

## Alternatives rejected

**Charge after the fact from telemetry.** It is what the code does today, it is
one less write on the hot path, and it makes overspend structurally undetectable
until after the money is gone. It also puts the financial record on a 90-day
self-deleting table.

**Reserve an estimate and settle by adjusting it in place.** Mutating a
settlement is how a ledger stops being auditable; two adjustments racing produce
a plausible number nobody can reconstruct.

**Use Stripe meters as the real-time balance.** Stripe's view is eventually
consistent, aggregated on their schedule, and cannot refuse a request. It is a
payment and invoicing processor; the epic's invariant says so, and reconciliation
against it is the correct relationship.

**Integer nano-units instead of `NUMERIC`.** Also exact, and it moves the scale
decision from the schema into every reader's head. `NUMERIC` states the scale
where the value lives and makes the arithmetic the database's problem.

## Consequences

- The tables of workstream 7.2 (`price_versions`, `usage_reservations`,
  `usage_receipts`, `billing_ledger_entries`, balance projections, budgets,
  invoice references) are all new; none exists today, so this is greenfield
  schema and there is nothing to migrate away from.
- The billable principal becomes the account (ADR 0007), which is a change to
  the existing user-keyed `user_credits` and to every Stripe flow currently
  resolving the signed-in user. Product subscriptions such as Alia plans stay
  distinct from pay-as-you-go inference spend and must not be merged into one
  balance.
- Reservation sits on the request's latency path. Its cost is a measured budget,
  and "reserve failures" and "settlement lag" are named metrics in workstream 16
  precisely because this step can fail in ways a request-count metric cannot see.
- Shadow metering — measuring and settling into the ledger without charging —
  runs before any customer is charged, so ledger imbalance and duplicate event
  ids are detected on real traffic while the blast radius is zero.
- Financial records outlive telemetry. Receipt and ledger retention is set by
  legal and reconciliation requirements, never by the 90-day telemetry window,
  and a customer deletion preserves the legally required financial record while
  removing optional payload data.
