# Runbook — Stripe renewal grants: cutover, missed periods and recovery

Subscription credits are granted on the evidence of a **paid invoice**
(`invoice.paid`), once per `(subscription, period_start)`, and every webhook
delivery is recorded in `billing_stripe_events` (issue #1524). This file is what
to do around that: the cutover, finding a period that was never granted, and
granting it without a second charge or a second grant.

Nothing here moves money. No step creates a charge, a refund or a Stripe object;
every step is a read, or a re-run of the same idempotent handler Stripe itself
would trigger.

## 1. Trigger

- **Cutover** of the change in #1524 (one time).
- A subscriber reports a period with no credits.
- `billing_stripe_events` shows `failed` rows, or `not_granted` rows whose reason
  is not expected (see the table in §3).

## 2. Cutover prerequisites

1. **The Stripe webhook endpoint for `https://api.oxy.so/billing/webhook` must
   send `invoice.paid`.** Before this change the endpoint only needed the
   `customer.subscription.*`, `checkout.session.completed` and
   `payment_intent.succeeded` events; renewals are no longer granted from
   `customer.subscription.updated`. Without `invoice.paid`, renewals stop granting.
   `invoice.payment_failed` and `charge.refunded` are recorded when sent and are
   optional. Changing the endpoint's event list is a production change in the
   Stripe dashboard and needs its own approval.

   **Mandatory preflight, before the deploy and after any edit of the
   endpoint** (read-only: it only lists webhook endpoints; a restricted key
   with read access to webhook endpoints is enough, and the key is never
   printed):

   ```bash
   STRIPE_SECRET_KEY=<restricted key, webhook endpoints: read> \
     node packages/api/scripts/check-stripe-webhook-events.mjs
   # OXY_STRIPE_WEBHOOK_URL=… to check an endpoint other than
   # https://api.oxy.so/billing/webhook
   ```

   Exit `0` = exactly one enabled endpoint for the Oxy URL sends every event
   the handler requires (or `*`); `1` = not ready (no endpoint, disabled, two
   enabled endpoints, or a required event such as `invoice.paid` missing — the
   output names it); `2` = could not check (no key, Stripe error). Do not
   deploy on `1` or `2`. Its required/optional lists are pinned to the
   handler's `switch` by `check-stripe-webhook-events.test.mjs`, which CI runs,
   so a newly handled event cannot be forgotten here.

   *Option for Nate (not done):* run the same preflight as a step of
   `deploy-aws.yml` before the API deploy, with a read-only restricted key in
   the deploy environment. That changes the deploy workflow and adds a
   credential, so it needs approval; until then it is a manual step and its
   output is pasted into the deploy record.
2. Migration `0131_billing_stripe_event_ledger` is additive (`pre` phase): a new
   table and two nullable columns. It rewrites no row.
3. Periods already granted by the old path keep their receipts. The idempotency
   key is unchanged, so the `invoice.paid` for an already-granted period records
   `duplicate` and grants nothing. The deploy cannot double-grant a period.

## 3. Reading the ledger

```sql
-- What happened to one invoice or subscription, newest first.
select stripe_event_id, type, outcome, outcome_detail, attempts, created_at, processed_at
from billing_stripe_events
where stripe_object_id = :object_id
order by stripe_created_at desc;

-- Everything that did not grant or failed in the last 7 days.
select type, outcome, outcome_detail, count(*)
from billing_stripe_events
where created_at > now() - interval '7 days'
  and outcome in ('failed', 'not_granted')
group by 1, 2, 3 order by 4 desc;
```

| `outcome` / `outcome_detail` | Meaning | Action |
|---|---|---|
| `granted` | Credits landed, receipt links the invoice | none |
| `duplicate` | The period had already been granted | none |
| `failed` | Handler threw; Stripe will redeliver | Watch `attempts`. Persistent: §4 |
| `not_granted` · `invoice payment failed` / `invoice status is …` | No payment collected | none — the paid invoice grants later |
| `not_granted` · `billing_reason subscription_update …` | Mid-period plan change | **Open decision** (§6). Do not grant by hand |
| `not_granted` · `invoice currency … does not match` | Price set up in another currency | Fix the Stripe price; then §4 |
| `not_granted` · `invoice collected no money` | Trial / 100% discount | **Open decision** (§6) |
| `not_granted` · `no invoice line for a plan price` | Price id not in `STRIPE_*_PRICE_ID` | Fix the env binding; then §4 |
| `not_granted` · `no account for the Stripe customer` | Customer not linked in `user_credits` | Investigate the link; then §4 |
| `ignored` · `refund recorded; no credit clawback is defined` | Refund | **Open decision** (§6) |
| `stale` | A newer provider read already held | none |

## 4. Recovering a missed period

The only supported recovery is to have Stripe **resend the original
`invoice.paid` event** (Dashboard → Developers → Events → the event → Resend,
or `stripe events resend <evt_id>`). That re-runs the same handler with the same
evidence:

- only `granted` and `duplicate` are settled; any other outcome (`failed`,
  `not_granted` after a price/currency/env fix, …) is re-evaluated on resend;
- the grant is guarded by `billing_transactions_subscription_period_key`, so a
  resend of an already-granted period writes nothing;
- never insert a receipt or credits by hand.

Verify: the event row reads `granted` (or `duplicate`), and

```sql
select stripe_invoice_id, amount_minor_units, currency, credits, created_at
from billing_transactions
where stripe_subscription_id = :subscription_id and type = 'subscription_payment'
order by stripe_subscription_period_start;
```

shows exactly one row per period.

## 5. Backfill of past missed periods

Periods missed **before** the cutover (a late first delivery under the old
five-minute window) have no ledger row. Finding them is read-only: list paid
`subscription_create` / `subscription_cycle` invoices from Stripe for each
mirrored subscription and compare against `billing_transactions` by
`(stripe_subscription_id, stripe_subscription_period_start)`. Each gap is
resolved by resending that invoice's `invoice.paid` event (§4) — idempotent,
no charge, no change to any balance except the grant the payment already earned.
Stripe keeps events for 30 days; older gaps need a decision, not a script.

**Not executed.** Running it is a production action and needs approval.

## 6. Open decisions (not encoded; nothing is guessed)

Concrete proposals with examples and tests, pending decision:
[docs/billing/proposals/i06-period-rules.md](../billing/proposals/i06-period-rules.md).

- Credits for a mid-period plan change (`subscription_update`, prorated).
- Credits for a zero-amount period (trial, full discount).
- Whether a refund claws back credits already granted for its period.

## 7. Rollback

Revert the deploy. The new table and columns are additive and unread by the old
code. A period granted under the new path keeps its receipt, and the old path's
`customer.subscription.updated` grant is guarded by the same period key — a
rollback cannot double-grant either.


## Reconciliation review, 2026-10-02

The read-only preflight now checks the SDK's `Stripe.API_VERSION` against the
endpoint's explicit version, and `livemode` against `OXY_STRIPE_MODE` (default
`live`). A test key cannot certify a live deployment. An endpoint inheriting
an unverified account default version fails this check. Setting an explicit
version or enabling events in Stripe remains a separately authorized action.
Paths are case-sensitive. Pagination errors cannot certify a partial list.

The invoice handler traverses all embedded/remaining invoice lines before
selecting a grant. It accepts exactly one non-prorated subscription-item line
for the invoice subscription, a known price, quantity one, matching currency,
positive line amount and a valid period. Multiple recurring items/periods require
an explicit mapping and are recorded without granting. It never compares a
historical invoice's period to today's subscription period: a late paid invoice
can legitimately refer to a previous cycle. Pagination failures respond 500 and
leave the grant retryable.

Stripe describes [line parent and period semantics](https://docs.stripe.com/api/invoice-line-item/object)
and [webhook endpoint API version and mode](https://docs.stripe.com/api/webhook_endpoints/object).
No live Stripe inspection was performed during this review.
