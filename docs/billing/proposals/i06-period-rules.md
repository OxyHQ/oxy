# PROPOSAL — subscription period rules (issue #1524, I06)

> **Status: PROPOSAL, pending Nate's decision. Not approved policy. Nothing
> here is implemented.** PR #1529 deliberately records these three cases
> without granting or clawing back anything (`not_granted` / `ignored` in
> `billing_stripe_events`). This file proposes what each case SHOULD do, with
> numbers, the Stripe evidence that would trigger it, the storage it needs and
> the tests that would prove it. Each section ends with a recommendation and
> its consequences; Nate decides.

## 0. What exists today (PR #1529) and the constraint that shapes everything

- Plans (`packages/api/src/routes/billing.ts`, `SUBSCRIPTION_PLANS`):
  **Pro** 10,000 credits / USD 29.99 / month; **Business** 50,000 credits /
  USD 99.99 / month.
- A period's credits are granted once, on `invoice.paid` with `billing_reason`
  `subscription_create` or `subscription_cycle`, `amount_paid > 0`, plan price,
  plan currency. Claimed atomically by the receipt row and the unique index
  `billing_transactions_subscription_period_key`
  `(stripe_subscription_id, stripe_subscription_period_start, type)`.
- Every delivery is a row in `billing_stripe_events` (unique Stripe event id,
  outcome, attempts). A handler that throws answers 500 and Stripe redelivers.
- Subscription mirror re-reads the provider and refuses a stale read.
- `billing_transactions` has `stripe_invoice_id` (new in #1529) and types
  `credit_purchase | subscription_payment | refund` (CHECK constraint).

**The constraint:** subscription credits are added to `user_credits.credits_paid`,
the SAME bucket as purchased top-ups (`db/credits.ts` `addCredits(…, 'paid')`),
and spending draws `credits_paid` first. There is no per-grant balance, so
"how much of THIS period's grant is still unconsumed" cannot be answered
honestly today. Any rule that depends on consumed vs unconsumed (§3) needs a
per-grant ledger first; that overlaps with I07 (#1525), which already plans
grants with origin and period. This proposal does not invent that split
retroactively: existing balances stay as they are.

Conventions in the examples: a 30-day period; credits are whole numbers and
always rounded **down** in the customer-visible direction of a grant, and
**down** in the direction of a clawback (we never take more than the rule
says).

## 1. Mid-period plan change (`billing_reason = subscription_update`)

### Evidence that triggers it

`invoice.paid` with `status = paid`, `billing_reason = subscription_update`,
`amount_paid > 0`, whose lines include proration lines
(`line.parent.subscription_item_details.proration = true`). The positive
proration line carries the NEW price and `line.period` = [change time, period
end]. The remaining fraction is
`r = (line.period.end − line.period.start) / (sub.current_period_end − sub.current_period_start)`,
taken from the provider re-read of the subscription, not from the event body.

A downgrade produces a credit (negative proration) and usually no paid
invoice, or a paid invoice of 0. It never triggers a grant.

### Proposed rule (P1)

- **Upgrade top-up:** `topup = floor((credits_new − credits_old) × r)`, only
  when positive. The base grant of the period (old plan, full) stays.
  Equivalent to "the period is worth `old × (1 − r) + new × r`".
- **Downgrade:** grant 0, claw back 0. The next `subscription_cycle` grants
  the new plan in full. Credits already granted are not reduced (consistent
  with Stripe crediting money, not removing service already paid).
- **Cap:** the sum of grants tied to one `(subscription, period_start)` never
  exceeds the credits of the highest plan held during that period. Prevents
  up/down/up cycling from adding more than a full higher-tier period.
- **Order-independence:** `topup` does not depend on whether the base grant has
  landed yet, so a proration `invoice.paid` delivered before the period's
  `subscription_cycle` `invoice.paid` grants the same.

### Examples (real plans)

| # | Scenario | r | Stripe charge (approx.) | Credits granted |
|---|---|---|---|---|
| 1a | Pro, upgrade to Business on day 10 | 20/30 | (99.99 − 29.99) × 0.667 ≈ USD 46.67 | base 10,000 + top-up floor(40,000 × 0.6667) = **26,666** → period total 36,666 |
| 1b | Business, downgrade to Pro on day 15 | 15/30 | credit ≈ USD 35.00 to next invoice | **0**; next cycle 10,000 |
| 1c | Pro → Business day 10, → Pro day 20, → Business day 25 | 20/30, —, 5/30 | two paid prorations | 10,000 + 26,666 + 0 + 6,666 = 43,332 ≤ cap 50,000 → **all granted** |
| 1d | Same as 1c but a fourth upgrade would push the total to 53,000 | — | — | granted only up to the cap: **50,000 − current total** |

### Storage needed (not in #1529)

- New `billing_transactions.type` value `subscription_proration` (CHECK
  constraint and enum change; migration).
- Partial unique index `(stripe_invoice_id, type) where stripe_invoice_id is
  not null and type = 'subscription_proration'` — one grant per proration
  invoice (a period can have several).
- The cap check runs inside the grant transaction after
  `select … from billing_subscriptions where stripe_subscription_id = $1 for
  update`, so two concurrent proration grants serialise.
- Already in #1529 and reused: `stripe_invoice_id`, `stripe_subscription_period_start`,
  the event ledger, the provider re-read.

### Tests (Given / When / Then)

| Case | Given | When | Then |
|---|---|---|---|
| upgrade | Pro period granted (10,000) | `invoice.paid` subscription_update, Business line, r = 20/30 | +26,666, one `subscription_proration` row |
| downgrade | Business period granted | `invoice.paid` subscription_update with amount_paid 0 | 0 granted, outcome `not_granted · downgrade` |
| replay | upgrade granted | same event id delivered again | ledger `duplicate`, balance unchanged |
| same invoice, new event id | upgrade granted | Stripe resend (new event id, same invoice) | unique `(invoice, type)` → `duplicate` |
| retry after failure | grant throws mid-transaction | redelivery | exactly one row, balance +26,666 once |
| out of order | no base grant yet | proration paid arrives first, then cycle paid | +26,666 then +10,000; total 36,666 either order |
| concurrency | two different proration invoices for the same period | delivered in parallel | serialised by the row lock; cap respected |
| cap | total already 43,332 | upgrade worth 9,668 | granted 6,668 (to 50,000), detail names the cap |
| unpaid | proration invoice `open`/failed | `invoice.payment_failed` | 0 granted |

### Recommendation and consequences

**Recommend P1** (top-up on paid upgrades, no clawback on downgrades, cap).
Consequences: customers who upgrade get usable credits immediately, which is
what they paid the proration for; downgrade never removes credits (simple,
no negative surprises; small revenue leakage bounded by one period); needs one
migration and the row lock. Alternative **P1-min**: grant nothing mid-period
and grant the new plan only at the next cycle — zero new storage, but an
upgrading customer pays the proration and gets no credits until the next
period (likely support tickets).

## 2. Zero-amount periods (trial, 100 % discount)

### Evidence that triggers it

`invoice.paid` with `status = paid`, `amount_paid = 0`, `billing_reason`
`subscription_create` or `subscription_cycle`, a line for a plan price, and
EITHER a trial line (the subscription re-read has `trial_end` covering
`line.period.start`) OR a `total_discount_amounts` entry whose discount
references a coupon/promotion code. Today this records `not_granted ·
invoice collected no money`.

### Proposed rule (P2)

Grant only what a **declared, versioned promotion** says, never "the plan's
credits because the invoice is paid":

```ts
// proposal — a code-reviewed registry, no env switch
const FREE_PERIOD_PROMOTIONS = {
  'trial:pro@v1':       { kind: 'trial',  plan: 'pro_monthly', credits: 2_000, oncePerAccount: true },
  'coupon:FOUNDERS100': { kind: 'coupon', plan: 'any',         creditsFraction: 1 },
};
```

- Trial periods match by plan; a coupon matches by its Stripe coupon id.
- A zero-amount invoice that matches nothing grants 0 and records
  `not_granted · zero-amount invoice without a declared promotion`. An ad-hoc
  100 % coupon created in the Stripe dashboard therefore grants nothing until
  someone declares it in code.
- `oncePerAccount` trials: at most one trial grant per account ever.
- Promotional credits are not purchased credits. Until I07 lands buckets, they
  go to `credits_paid` like today's grants (no new spend order); I07 decides
  whether they move to a promotional bucket.

### Examples (real plans)

| # | Scenario | Invoice | Credits granted |
|---|---|---|---|
| 2a | Pro with a declared 14-day trial (`trial:pro@v1`) | `subscription_create`, USD 0 | **2,000** (trial); at day 14 the `subscription_cycle` USD 29.99 invoice opens a NEW period and grants 10,000 |
| 2b | Pro with declared `FOUNDERS100` for 3 months | 3 × `subscription_cycle`, USD 0 | **10,000** each month (fraction 1); month 4 at USD 29.99 grants 10,000 as usual |
| 2c | Business with a 100 % coupon made by hand in the dashboard, not declared | `subscription_cycle`, USD 0 | **0**, `not_granted`, visible in the ledger |
| 2d | Same account starts a second Pro trial after cancelling | `subscription_create`, USD 0 | **0** (`oncePerAccount`) |

### Storage needed (not in #1529)

- `billing_transactions.type` value `subscription_promotional_grant` (CHECK
  change), a nullable `promotion_id` text column, and `amount_minor_units = 0`
  allowed for that type.
- The period idempotency index already covers it if the type is included in
  `subscriptionPeriodIdempotencyPredicate`, or a sibling partial index
  `(stripe_subscription_id, stripe_subscription_period_start, type)` for the
  new type.
- `oncePerAccount`: partial unique index `(user_id, promotion_id) where type =
  'subscription_promotional_grant' and promotion_id like 'trial:%'`.

### Tests (Given / When / Then)

| Case | Given | When | Then |
|---|---|---|---|
| declared trial | `trial:pro@v1` declared | USD 0 `subscription_create` paid within trial | +2,000, row with `promotion_id` |
| undeclared coupon | coupon not in registry | USD 0 `subscription_cycle` paid | 0, `not_granted` naming the coupon |
| replay | trial granted | same event again | `duplicate` |
| second trial | account already had a trial grant | new subscription, USD 0 trial | 0, `not_granted · trial already used` |
| trial → paid | trial granted | `subscription_cycle` USD 29.99 | +10,000, separate period key |
| out of order | — | the USD 29.99 cycle paid arrives before the trial's USD 0 paid | both granted, keys differ by period start |
| concurrency | — | two USD 0 invoices of two subscriptions of one account, in parallel | at most one trial grant (unique index) |
| retry | grant throws | redelivery | exactly one grant |

### Recommendation and consequences

**Recommend P2** with the registry starting **empty** (behaviour identical to
today) and adding a promotion by PR when marketing defines one. Consequences:
no silent free credits from dashboard coupons; trials are bounded and abuse is
limited to one per account; requires a migration and a small registry; product
decides the numbers per promotion.

## 3. Refunds, disputes and chargebacks

### Evidence that triggers it

`charge.refunded` (cumulative `charge.amount_refunded`, `charge.amount`,
`charge.invoice` → the paid invoice whose grant it concerns). Disputes:
`charge.dispute.created` and `charge.dispute.closed` (`status = lost | won`) —
these two events are NOT on the endpoint today; adding them means extending
`check-stripe-webhook-events.mjs` and the endpoint, both after approval.

### Proposed rule (P3)

Only the **unconsumed remainder of the specific grant** paid by the refunded
invoice is ever reduced. Never purchased credits, never another period's
grant, never below zero.

- Refunded fraction (cumulative): `f = amount_refunded / amount_paid` of that
  invoice, read from the provider (re-read the charge), not summed from events.
- Clawback target for the grant: `floor(granted × f)`.
- Applied now: `clawback = max(0, min(remaining_of_grant, target − already_clawed))`.
  Using the cumulative `f` and `already_clawed` makes several partial refunds,
  replays and reordering converge to the same result.
- Credits already consumed stay consumed. If support wants to refund less
  because credits were used, that is decided at refund time in Stripe, not by
  the webhook.
- Disputes: `dispute.created` records only; `dispute.closed` with `lost` is
  treated as `f = 1`; `won` changes nothing.

**Precondition:** a per-grant ledger (e.g. `credit_grants(id, user_id,
source_type, stripe_invoice_id, period_start, granted, remaining, clawed,
created_at)`) with a defined spend order. That ledger is I07's grants work. It
does **not** exist today, and the balance cannot be split retroactively.

### Examples (real plans)

| # | Scenario | Grant / remaining | Refund | Clawback |
|---|---|---|---|---|
| 3a | Pro period, full refund on day 2 | 10,000 / 9,200 | f = 1 | **9,200** (the 800 used stay used) |
| 3b | Business, half refunded as goodwill | 50,000 / 30,000 | f = 0.5 → target 25,000 | **25,000** |
| 3c | Business, half refunded, mostly used | 50,000 / 12,000 | f = 0.5 → target 25,000 | **12,000** (remaining caps it; never negative) |
| 3d | Pro, two partial refunds of USD 10 then USD 19.99 | 10,000 / 10,000 | f₁ = 10 / 29.99 = 0.3334 → target floor(10,000 × 0.3334) = 3,334; f₂ = 1 → target 10,000 | first **3,334**, then 10,000 − 3,334 = **6,666**; total 10,000 |
| 3e | Account holds 5,000 purchased + Pro grant remaining 0 | — | f = 1 | **0** — purchased credits untouched |

### Tests (Given / When / Then)

| Case | Given | When | Then |
|---|---|---|---|
| full refund | grant 10,000, remaining 9,200 | `charge.refunded` f = 1 | −9,200 from that grant only |
| partial | grant 50,000, remaining 30,000 | f = 0.5 | −25,000 |
| capped by remaining | remaining 12,000 | f = 0.5 | −12,000, balance never negative |
| replay | clawback applied | same event again | `duplicate`, no change |
| two partials | — | f = 0.333 then f = 1 (cumulative) | −3,334 then −6,666 |
| partials reordered | — | the f = 1 event processed before the f = 0.333 one | −10,000 then 0 (target already reached) |
| refund before grant | invoice not granted yet | `charge.refunded` f = 1 then `invoice.paid` | invoice.paid re-reads the charge, grants `floor(credits × (1 − f))` = 0 |
| purchased untouched | 5,000 purchased, grant remaining 0 | f = 1 | purchased still 5,000 |
| dispute lost | grant remaining 7,000 | `charge.dispute.closed` lost | −7,000 |
| dispute won | — | `charge.dispute.closed` won | nothing |
| concurrency | — | refund and spend at the same time | grant row locked; remaining never < 0 |
| retry | clawback throws | redelivery | exactly one adjustment row |

### Recommendation and consequences

**Recommend: keep today's behaviour (record, no automatic clawback) until I07's
per-grant ledger exists, then enable P3.** Consequences: today a refunded
customer keeps the credits of that period (exposure: at most one period's
credits per refund, visible in `billing_stripe_events` as `ignored · refund
recorded`, and support can act by hand). Enabling clawback against
`credits_paid` now would also eat purchased top-ups, which the issue's
invariants forbid. P3 then gives a precise, idempotent rule that never touches
other money.

## 4. Cross-cutting guarantees for all three rules

- **Idempotency:** every grant/adjustment is a row claimed by a unique key
  (period, proration invoice, promotion + period, refund per grant) inside the
  same transaction as the balance change; the Stripe event id ledger from
  #1529 is the outer layer.
- **Retries:** a failed balance change throws, the transaction rolls back, the
  ledger records `failed`, Stripe redelivers (as #1529 already does).
- **Out of order:** every decision re-reads the provider (subscription,
  charge) and uses cumulative values, so event order does not change the end
  state.
- **Concurrency:** grants for one subscription serialise on the
  `billing_subscriptions` row; clawbacks serialise on the grant row.
- **No money moves:** none of these rules creates a charge or a refund in
  Stripe; they only react to what Stripe already did.
