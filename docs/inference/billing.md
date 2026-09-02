# Exact billing: reserve, settle, refund

Money is decided **before** a request executes, settled against an exact receipt
afterwards, and corrected only by appending. This page is the developer-facing
reading of
[ADR 0009](../adr/0009-usage-reservation-and-settlement.md), which is the
decision record.

**The edge calls this on every request.** It reserves before anything is
forwarded and settles on every path out, including the path where there is
nothing to forward to: a request that cannot be served releases its hold before
the refusal returns, so a refused request costs nothing. A successful Kaana path
settles against the normalized usage report and pinned price version; proving
that this happened in production requires a live request and ledger readback,
not this source contract.

Your own numbers are readable at `/inference/reporting` — balance, usage, spend,
pending reservations, settled charges, an export, and budgets. See
[what your account owes and holds](#what-your-account-owes-and-holds).

---

## The protocol

```text
1. RESERVE   at the Oxy edge, before anything reaches the data plane
             ceiling = requests:1 + f(input units, max output units,
                                       every authorized route's price version)
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

`maxPricePerRequest` is checked before this protocol begins. The catalogue may
prefilter the unavoidable flat `requests: 1` fee, but the edge decides the cap
from the complete maximum quote for this request at each routing priority. Only
cap- and currency-matching candidates can become the selected route or enter the
signed authorized set. If none survives, the edge returns `policy_violation`
(403) with no reservation and no Kaana call.

### Exact deployment identity on every usage shape

The v2 terminal normalized usage report and the v2 partial streamed `usage`
event both require the exact Kaana `deploymentId`. Oxy accepts either form only
when the ID resolves to exactly one route in the request's signed
`authorizedRoutes`; a terminal report must also match that route's
revision-pinned model and provider. Oxy never fills a missing ID from the
admitted route and never resolves usage by provider name, model name or list
position.

Missing, unauthorized, ambiguous or contradictory identity fails closed. A
present terminal report that fails validation invalidates the metering evidence.
The same rule applies before identity can be read: if any known Kaana frame is
malformed or fails its per-shape schema — including a v1 `usage_report` where v2
is required — every terminal and partial measurement accumulated for the request
is discarded. The edge must not reinterpret that protocol failure as “no report
arrived” and fall back to an earlier partial event.

### Refuse, never estimate (#972 §7.3)

A step 3 that cannot be done exactly is **refused**, not approximated. If the data
plane reports a `completed` request and accounts for nothing — no units, or units
that are all zero — `settle` answers `zero-usage` and writes nothing at all: no
receipt, no refund, no journal entry. You get an error, your hold stands, and the
expiry sweep returns the money within about a minute of the deadline.

**It used to bill nothing and return `200`, which is the bug this closes.** A
provider that omitted its usage block yielded a silently free request, and a free
request is not a gift — it is a completion with no receipt, which no invoice can
explain and no support conversation can settle.

The alternative was to estimate and charge. It was rejected because the trade is
not symmetric: refusing costs **Oxy** the upstream spend on a rare provider bug,
while estimating costs **you** money nobody can reconcile afterwards. `usage_receipts`
already holds that line for its own reasons — "an estimate indistinguishable from a
reported figure is one nobody can reconcile" — so the loss is taken on the side
that can absorb it and can see it.

Requests that failed, were cancelled, or delivered partial output and metered
nothing still settle at **zero** exactly as before. Nothing was delivered, so zero
is the right charge; the change is only about a request that claims to have
completed.

`estimated` receipts still exist for the not-completed cases above, and one thing
about them is worth stating plainly because this document used to imply otherwise:
**nothing reconciles them later.** There is no path by which a provider's
retrospective usage arrives, so an `estimated` receipt is final, settled at zero,
with Oxy absorbing the upstream cost. Their count is served to Oxy staff as
`unmeasuredSettlements`, where a rising number means the data plane is losing usage
reports.

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

## Every unit is counted once

**The units on your receipt partition your request: nothing is counted twice.**
Kaana reports `{ unit: 'requests', quantity: 1 }` for every attempted request;
that unit is orthogonal to the token partitions below and is charged exactly
once. Every servable price version must therefore declare an explicit
`requests` price. Its amount may be zero, but the row may not be absent: absence
means the price version cannot price the units Kaana emits, not that the fee is
implicitly zero.

`cached_input_tokens` is not part of `input_tokens`, and `reasoning_tokens` is
not part of `output_tokens` — they are separate lines, each with its own price.
A 10 000-token prompt of which 9 000 came from cache is billed as 1 000 input
tokens plus 9 000 cached input tokens, at the cache's own (lower) price, and the
charge is the sum of the lines. That is what lets a cache discount be a discount
rather than a footnote.

Every OpenAI-compatible provider states the same request the other way round:
their `prompt_tokens` INCLUDES the cached tokens and their `completion_tokens`
INCLUDES the reasoning tokens, with the children repeated underneath as details.
Both readings are defensible; only one of them can be priced by summing.

So `POST /v1/chat/completions` returns the nested numbers a stock OpenAI client
expects — `prompt_tokens` covers the whole prompt, `prompt_tokens_details.cached_tokens`
and `completion_tokens_details.reasoning_tokens` break it down — while
`X-Oxy-Usage-Input-Tokens`, `X-Oxy-Usage-Cached-Input-Tokens`,
`X-Oxy-Usage-Output-Tokens` and `X-Oxy-Usage-Reasoning-Tokens` carry the four
disjoint numbers your receipt was priced from. Either view reconstructs the
other; adding the OpenAI numbers to the Oxy ones does not, and is the one
arithmetic that will disagree with your bill.

## Price versions and snapshots

Every priced route carries a price version, and every settled receipt stores a
**snapshot** of the prices it used — not a foreign key that could later resolve
differently. A price change publishes a new version and never edits an old one:
`draft` may be quoted in a preview and can never price a receipt, `active` prices
live requests, `superseded` keeps resolving for the receipts it priced, forever.

The mandatory `requests` row is also part of the reservation proof. Every hold
scenario includes `requests: 1`, including all four completion extrema that put
the prompt ceiling on either `input_tokens` or `cached_input_tokens` and the
generation ceiling on either `output_tokens` or `reasoning_tokens`. The edge
quotes each authorized route with the ledger's exact `NUMERIC`
`amount × quantity / per` arithmetic and reserves the largest result. Equivalently,
for each completion route the covering amount is the `requests: 1` fee plus
`promptCeiling × max(input rate, cached-input rate)` plus
`outputCeiling × max(output rate, reasoning rate)`, compared without converting
the decimal amounts to JavaScript `Number`. Both parent and child rates must be
present; an absent `cached_input_tokens` or `reasoning_tokens` price fails the
final quote even when the other rate would have been larger. Readiness also
fails closed for the complete route set if any servable price version omits the
`requests` row, even when its intended fee was zero.

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

## Who authored an entry

Every journal entry carries `actor_kind` and `actor_user_id`, which take exactly
three states:

| `actor_kind` | `actor_user_id` | Meaning |
|---|---|---|
| `staff` | a `users.id` | A named platform staff member authored it. Today that is a promotional grant and closing an invoice period. |
| `machine` | null | **No person authored it, by design** — a Stripe webhook, the reservation expiry sweep, the inference edge settling a request. |
| null | null | The entry was written **before the column existed** (before migration `0046`). |

The third state is not a fourth kind of author and it is not a machine: those
rows predate the question, nothing was back-filled, and nothing ever will be —
the table is append-only, and stamping a historical row `machine` would assert
"no person authored this" about an entry whose author was simply never recorded.
Those are precisely the two readings this pair exists to keep apart.

`machine` is a value rather than an absence for the same reason. If "nobody
authored it" were spelled as a blank, it would be indistinguishable from an
author the system failed to capture, and that difference is the entire question
the moment anybody reads the journal.

There is one `machine` value rather than a taxonomy of automations. An automated
writer's own attribution already lives on the document the entry names: a
settlement names its reservation, which carries the application, the credential
and the request id; a top-up names its processor payment, which carries Stripe's
own reference.

Authorship is not optional to a writer. `EntryInput.actor` is a required
discriminated union on the only code path that inserts into
`billing_ledger_entries`, so a new writer that does not state its author does not
compile, and a `staff` author with nobody named is not constructible. The
database CHECK is the second line, for anything reaching the table another way.

## The cases that decide the behaviour you will see

| Situation | What happens |
|---|---|
| Balance or credit limit insufficient | Rejected at the edge before execution. No reservation, no upstream call, no charge. |
| You cancel mid-stream | The units actually produced are settled; the rest is refunded. Cancellation is a normal terminal state, not an error. |
| Provider fails before producing output | Settle zero, refund the whole reservation. |
| Provider fails after partial output | Settle the produced units exactly, refund the rest. Partial output is billable output. |
| Provider omits usage, on a request that did NOT complete | Settle zero, refund the whole reservation, and mark the receipt **estimated** — which records "usage was never measured" rather than "usage was zero". You are not charged. |
| Provider omits usage on a request it says COMPLETED | The settlement is **refused** and you get an error rather than a free completion. Nothing is billed and your hold is released by the expiry sweep. See "Refuse, never estimate" below. |
| A reservation with no settlement by its deadline | Expired after 15 minutes and released as a refund carrying a `reservation_expiry` journal entry — never a silent release. The sweep that does this runs every minute, so a hold is released within about a minute of its deadline; every path out of the edge settles its own hold, so no reservation reaches its deadline today. |
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
| Retention | 90 days, swept hourly — see [data-policy.md](./data-policy.md#how-long-oxy-keeps-what-it-does-keep) | Set by legal and reconciliation requirements, **never** swept, and a test fails if a financial table is added to the sweep registry |

The telemetry stream carries **no money column**, and that is the strongest
available form of "telemetry must not become the financial ledger": a
customer-visible billed figure has nowhere to come from except a receipt. It is
enforced by the schema rather than remembered by a reviewer.

So: a usage dashboard may lag, and may under-count on a recorder failure. **A
bill may not.** Never reconcile against a telemetry sum; read the ledger.

## What your account owes and holds

`/inference/reporting` reads both of the tables above and says which one each
answer came from, in the answer itself:

| Endpoint | Reads |
|---|---|
| `GET /accounts/:accountId/balance` | the ledger |
| `GET /accounts/:accountId/spend`, `/charges`, `/charges/export`, `/reservations` | the ledger |
| `GET /accounts/:accountId/usage`, `GET /applications/:applicationId/usage` | the telemetry rollups |
| `GET /accounts/:accountId/spending-limits`, `/spending-limits/alerts` | budgets |
| `POST /accounts/:accountId/spending-limits`, `PATCH /spending-limits/:id` | the only writes here |

Every ledger response is stamped
`{ source: 'financial_ledger', consistency: 'authoritative' }` and every usage
response `{ source: 'usage_telemetry_rollups', consistency: 'eventual' }`. Both
stamps are required literals on the response schemas, so neither can be dropped
and neither can be swapped — which is what makes "which kind of number is this"
answerable from the payload rather than from a docs page.

**Another account's numbers answer 404, never 403**, so this surface cannot be
used to discover which account, application, credential or budget ids exist.

Two lanes: the account lane (balance, account-wide usage and spend,
reservations, charges, exports, budgets) is **user-only** and needs
`billing:read`, or `billing:manage` for a budget write — an account-wide
financial view is not scoped to one application, and #972 treats
organization-wide billing controls as high-privilege. The application lane takes
either a user bearer (`usage:read` for units, `billing:read` for money) or a
service token carrying `inference:usage:read` whose own application is the one
being asked about.

The account's billing profile, payment method, invoices, portal, grants and
auto-recharge live at `/billing/accounts/:accountId` — see
[ADR 0014](../adr/0014-account-billing-and-entitlements.md).

## Payments are not the ledger

Stripe remains the payment, payment-method, tax/invoice and hosted-portal
processor. It is **not** the real-time balance authority: its view is eventually
consistent, aggregated on its own schedule, and it cannot refuse a request. Oxy's
ledger totals are reconciled *against* Stripe charges and invoices, in that
direction.

Product subscriptions (Alia plans and similar) stay distinct from pay-as-you-go
inference spend. A plan may include an allowance while Oxy still records the
underlying exact inference cost; the two are not merged into one balance.
