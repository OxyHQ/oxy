# Exact billing: reserve, settle, refund

Money is decided **before** a request executes, settled against an exact receipt
afterwards, and corrected only by appending. This page is the developer-facing
reading of
[ADR 0009](../adr/0009-usage-reservation-and-settlement.md), which is the
decision record.

**Nothing calls this from a request path yet.** The tables, the protocol and its
tests landed as not-yet-called code
(`packages/api/src/services/inferenceLedger.service.ts`); the public inference
edge that will reserve before forwarding and settle on a usage report is
workstream 4. Landing it this way makes that a single rewiring commit rather
than one welded change, and means it alters no behaviour of the running system.

---

## The protocol

```text
1. RESERVE   at the Oxy edge, before anything reaches the data plane
             ceiling = f(input units, max output units, allowed route price ceiling)
             insufficient balance or credit limit → reject; nothing is forwarded
2. EXECUTE   the data plane runs the request and returns a normalized usage receipt
3. SETTLE    exact charge, derived from the receipt and the pinned price version
4. REFUND    release (reservation − settled), atomically with the settlement
```

Reserve is one transaction. Settle-plus-refund is one transaction. The refund is
not a later step that could be missed: a settlement that does not also release
the remainder of its reservation is an incomplete write, not a partial success.

Two properties hold across every path, and they are what the tests must be able
to falsify rather than confirm: **no path may charge twice, and no path may
execute unreserved.**

## The account is the payer, not a user

The billable principal is the Oxy account that owns the application — see
[attribution.md](./attribution.md). A delegated end user never appears in a
balance check or as a ledger payer.

Child project accounts share their nearest ancestor's balance rather than
receiving allocated funds. A budget is a **ceiling on spend, never a store of
value**: it can be raised, lowered or removed with no financial transaction, and
it can never strand money the way a sub-balance can.

## Exact amounts

- **Money is exact `NUMERIC`** with sub-minor-unit precision, because one token
  costs several orders of magnitude less than one minor unit and per-request
  rounding would make your charge depend on how you chunked your work.
  Aggregation rounds **once**, at the invoice boundary, and that rounding is
  itself a ledger entry rather than a discarded remainder.
- **`double precision` is forbidden for any customer-facing amount.** Money
  arithmetic happens in SQL or in a decimal type, never in a JavaScript `number`.
  The Postgres driver decoding `numeric` as a string is a feature here: an
  accidental float operation fails loudly instead of silently losing precision.
- **Units are not money.** Token counts, milliseconds, image counts and character
  counts live in their own integer columns, separately from the amount they
  priced into, so a unit total and a charge are independently auditable.

## Price versions and snapshots

Every priced route carries a price version, and every settled receipt stores a
**snapshot** of the prices it used — not a foreign key that could later resolve
differently. A price change publishes a new version and never edits an old one:
`draft` may be quoted in a preview and can never price a receipt, `active` prices
live requests, `superseded` keeps resolving for the receipts it priced, forever.

A receipt must stay reproducible after the price it was computed under has been
withdrawn, and after a model revision has been retired from the catalogue. That
is why price versions are scoped to `(model reference, provider)` as plain text
with no foreign key into the catalogue: a financial record must never become
unwritable because a catalogue row moved.

## Idempotency

Every reserve, settle and refund is idempotent on a **stable id supplied by the
caller**, never a generated one:

| Operation | Key |
|---|---|
| reservation | `requestId`, allocated at edge admission |
| settlement | `(requestId, generationId?)` from the usage receipt |
| refund | the settlement's own id |
| external events (payment webhooks, data-plane redeliveries) | the provider's event id |

A repeated call returns the original outcome and writes nothing new. It is
implemented as `ON CONFLICT … DO NOTHING RETURNING`, not as
catch-the-duplicate: a duplicate key and a dropped connection are
indistinguishable inside a `catch`, so an exception handler would answer "already
settled" to an infrastructure failure.

## Immutable history

Settled receipts and ledger entries are append-only, enforced by the database. A
correction is a compensating record — a refund row, or a supplementary receipt
naming the receipt it corrects — never an update and never a delete. A mutated
financial record cannot be distinguished from a correct one after the fact.

## The cases that decide the behaviour you will see

| Situation | What happens |
|---|---|
| Balance or credit limit insufficient | Rejected at the edge before execution. No reservation, no upstream call, no charge. |
| You cancel mid-stream | The units actually produced are settled; the rest is refunded. Cancellation is a normal terminal state, not an error. |
| Provider fails before producing output | Settle zero, refund the whole reservation. |
| Provider fails after partial output | Settle the produced units exactly, refund the rest. Partial output is billable output. |
| Provider omits usage | Settle from Oxy's own measurement, mark the receipt **estimated**, reconcile later against the provider's reported figures. The estimate is labelled as one on the receipt and in your usage view. |
| A reservation with no settlement by its deadline | Expired and refunded, with a reason, as an emitted event — never a silent release. |
| Retry of a settled request | Idempotent no-op returning the original receipt. |
| Redelivered webhook or data-plane event | Idempotent no-op on the provider event id. |
| BYOK route | Your upstream provider bills you directly; Oxy settles only its own platform fee, and the receipt says so. |

One refusal is worth calling out because it looks like a bug: if the exact charge
comes out **above** the hold that authorised it, the settlement is refused and
nothing is written. Both alternatives are worse — capping the charge at the hold
makes the receipt's arithmetic disagree with its own price snapshot, and charging
past the hold is exactly the unreserved execution this design exists to prevent.
The hold is left in place and released at its deadline, so the money comes back
on its own while the discrepancy stays loud.

## Spending limits

Limits exist at account, project, application and credential level — three scope
columns, because **a project is an account**, so an account-scoped limit on a
project account *is* the project-level limit.

- `hard_stop` refuses the reservation: nothing is forwarded and nothing is spent.
- `soft_stop` allows it and reports that the limit was passed, for a customer who
  would rather be warned than interrupted.

Both are evaluated **before** execution, in the same transaction as the balance
check. A limit consulted after the provider has been billed is not a limit.

Alert thresholds are basis points of the limit, from a closed set (7500 = 75%).

---

## Why your dashboard and your bill are different numbers

This is intentional and you should design for it.

| | Usage telemetry | Financial ledger |
|---|---|---|
| Tables | `inference_usage_events`, `inference_usage_daily_rollups` | `usage_receipts`, `usage_refunds`, `usage_reservations`, `billing_ledger_entries` |
| Contains money? | **No cost, credit or amount column at all** | Yes, exact `NUMERIC` |
| Consistency | Eventually consistent — written outside any ledger transaction, and can lag or, on a recorder failure, miss a request | Transactional |
| Retention | 90 days, swept | Set by legal and reconciliation requirements, never swept |

The telemetry stream carries **no money column**, and that is the strongest
available form of "telemetry must not become the financial ledger": a
customer-visible billed figure has nowhere to come from except a receipt. It is
enforced by the schema rather than remembered by a reviewer.

So: a usage dashboard may lag, and may under-count on a recorder failure. **A
bill may not.** Never reconcile against a telemetry sum; read the ledger.

## Payments are not the ledger

Stripe remains the payment, payment-method, tax/invoice and hosted-portal
processor. It is **not** the real-time balance authority: its view is eventually
consistent, aggregated on its own schedule, and it cannot refuse a request. Oxy's
ledger totals are reconciled *against* Stripe charges and invoices, in that
direction.

Product subscriptions (Alia plans and similar) stay distinct from pay-as-you-go
inference spend. A plan may include an allowance while Oxy still records the
underlying exact inference cost; the two are not merged into one balance.
