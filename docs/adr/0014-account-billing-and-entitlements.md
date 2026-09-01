# ADR 0014 — A child account SHARES its nearest ancestor's balance and is bounded by budgets, never by allocated funds; a plan allowance and a balance are different types and are never summed

- Status: accepted
- Date: 2026-08-16
- Issue: #972 (sections 7.1, 7.4, 7.5)

## Context

ADR 0009 made spend exact and account-scoped: reserve → settle → refund, over
`billing_profiles`, `account_balances` and a double-entry journal, all keyed on
`users.id` — which IS an account id of any kind, personal through channel.

Three questions it deliberately left open are the ones this ADR answers, and all
three are shape decisions that every later reconciliation inherits.

**Which balance does a project spend?** `Application.ownerAccountId` is usually a
project account under an organization. Either the project draws on the
organization's money, or the organization moves money INTO the project.

**How is Stripe attached without becoming the ledger?** The epic's invariant is
that Stripe is a payment and invoicing processor and not the authoritative usage
ledger. Something still has to connect the two, or a charge can never be traced
to the balance it funded.

**What does a product (Alia) ask Oxy for?** An Alia plan may include an allowance
of inference. Oxy still records the exact underlying cost. If those two numbers
ever meet in one field, the failure the epic names outright — confusing a product
subscription with pay-as-you-go usage — has already happened.

The audit (`docs/audits/2026-08-15-account-and-application-ownership.md` §6)
supplied the starting state: account-scoped billing STORAGE existed, but a
profile could only come into being for an account somebody held a session AS. An
organization was billable by accident and a `channel` account never, while
nothing stopped a channel from owning an application.

## Decision

### 1. A child draws on the NEAREST ancestor with a billing profile

Resolution walks `user_ancestors` — the same materialised path
`resolveEffectiveMembership` walks — and takes the account itself first, then the
deepest ancestor. A project with no profile of its own spends its organization's
money; a project that is given one becomes independently billable and stops
inheriting.

Constraint is expressed as BUDGETS (`spending_limits`), never as allocated funds.

Why not allocate:

- Allocating means MOVING money between two accounts' balances, which creates a
  state where the organization has money and the project cannot spend it — a
  stranded balance and a support ticket, not a control.
- A budget is a LIMIT, not a store of value. It can be raised, lowered or removed
  without a financial transaction and it can never strand anything.
- This is not a dead end. An internal transfer between two accounts'
  `purchased_funds` is already a legal ledger entry, so genuine allocation can be
  built on top without changing the model — whereas unwinding allocation back to
  sharing would mean moving real money back.

The visible consequence is that a project's billing view names somebody else's
account. `AccountBillingState` therefore carries `billingAccountId` and
`inherited` beside the balance: a Console page showing an organization's money
under a project's name with no indication whose it is would be worse than showing
nothing.

**One inheritance rule, not two.** Product plans follow the same walk, for the
same reason: the payer is by definition the account that bought things on behalf
of this subtree. Two different inheritance rules over one account graph is how
"which organization am I really under" becomes a support ticket.

A profile is read at ANY status but inherited only while `active`. So a suspended
account sees its own suspension (`canSpend: false`) rather than being reported as
never provisioned — the audit's §6 distinction — while a suspended ancestor is
neither displayed nor drawn upon.

### 2. Stripe is attached by ONE row, and it is a reference

`billing_external_payments` records one processor charge, carrying both the
processor's reference and the `billing_ledger_entries` row it produced. It is the
only join between the two systems.

- `(provider, external_ref)` is UNIQUE, which is the second, independent webhook
  idempotency guard beside the journal's own `idempotency_key`. The two fail
  differently on purpose: the journal key is composed by application code and a
  change to how it is composed would silently reopen the double-credit; this one
  is the processor's own identifier and cannot drift.
- The row is written in the SAME transaction as the money it explains, so
  "the balance moved" and "here is the charge that moved it" can never disagree.
- The Stripe CUSTOMER link is not duplicated. `user_credits.stripe_customer_id`
  already carries a partial unique index and is what the subscription webhook
  resolves through; `users` is the account table, so it was always an
  account → customer link. A second column naming the same customer would be a
  second authority for one fact, and two Stripe-customer columns that disagree is
  money credited to the wrong account.

Reconciliation compares the two records and PUBLISHES the difference
(`billing_reconciliation_runs` + `_discrepancies`). It repairs nothing: a pass
that credited what it found would make the processor the ledger. Four finding
kinds, because they are four different operational problems —
`missing_in_ledger` costs a customer, `missing_in_external` costs Oxy,
`amount_mismatch` is both, `account_unresolved` is money nobody owns.

Auto-recharge stakes its claim BEFORE the card is charged
(`billing_auto_recharge_attempts`, unique on account + currency + window). Every
other idempotency guard in this schema protects a bookkeeping mistake; this one
protects a real-world side effect that no compensating row undoes.

### 3. An allowance is an integer count; money is an exact decimal; nothing sums them

`productEntitlementSchema` has three disjoint sections — `plan` + `allowances`,
`payAsYouGo`, `costCenter` — and no field that is both a count and an amount.
Allowances are `z.number().int()`; money is `exactDecimalSchema`. A consumer
cannot add them without a cast that review would catch.

An allowance does not change what a request COSTS. Oxy records the exact
underlying cost on the receipt; the allowance decides what Alia charges its user.
`productPlanSchema` therefore carries no price at all — a plan able to restate the
cost of a request would be a second pricing authority, and a receipt has one.

`payAsYouGo: null` means no account up the ancestry has a profile. That is a real
state and is NOT a zero balance: zero means "spent everything", null means
"nobody has decided who pays for this account yet".

### 4. A cost centre IS an account

`internal_cost_centers` labels an existing project account with a slug and a
title. No parallel hierarchy, no parent link, no column on any receipt — #972's
"exactly one account/organization/project hierarchy" applied to internal
accounting.

Attribution is the same nearest-ancestor walk, run over the APPLICATION's owner
account rather than over `usage_receipts.account_id`. Those two ids genuinely
differ: the receipt's account is the PAYER (resolved through the inheritance walk
above), while a cost centre asks which internal workload incurred the charge,
which is `applications.owner_account_id` per ADR 0007. With one organization
paying for five project accounts — exactly workstream 14's shape — reading the
receipt's own column would attribute all five workloads to the organization and
every per-team report would be the same number.

### 5. Deleting an account is answered, not attempted

Every financial table references `users` with `ON DELETE RESTRICT`. The delete
path now asks `describeAccountFinancialHolds` BEFORE its first destructive step,
and the blocking set is DERIVED from `pg_constraint` rather than listed, so it
cannot stop covering the next financial table somebody adds.

- A live subscription refuses the delete outright. Cancelling somebody's payment
  agreement as a side effect is not that route's decision, and if the processor
  were unreachable the alternative would delete the account and leave it billing.
- A held reservation refuses. Money neither spent nor returned.
- Retained financial history ARCHIVES rather than deletes: optional data
  (mailboxes, identity backup, sessions, social graph) is erased, and the account
  row survives with the records that reference it, marked
  `account_status = 'archived'` — an existing state that already resolves to no
  membership and no authority.

Profile ANONYMISATION is explicitly out of scope here. Releasing a username and
clearing an email is a separate decision with its own consequences (a released
handle is immediately claimable), and it belongs to #972 section 12's
deletion/export work.

## Consequences, including the ones that cost something

- **A project cannot be given a hard-walled sub-budget of money.** It gets a
  ceiling, and the ceiling is enforced before execution. A customer who wants
  genuinely separate funds gives the project its own billing profile, which is
  supported and makes it independently billable.
- **A per-project spending limit is a limit on the ORGANIZATION's balance.** So a
  project that exhausts its budget stops, but a project whose organization runs
  out of money also stops even with budget left. That is the accurate model of
  what is happening and the alternative (allocation) hides it until reconciliation.
- **Resolving a Stripe customer for an account creates its `user_credits` row**,
  which carries the platform's free API-credit tier. A product entitlement appears
  on an account that only wanted to pay for inference. It is harmless — the two
  are separate balances and the entitlement interface reports them separately —
  and it is strictly better than a second customer column.
- **An account with retained financial history keeps its username and email.**
  Stated rather than implied, because a reader will otherwise assume "deleted"
  means "gone".
- **The Stripe half is unverified.** There is no Stripe account in development, so
  checkout, portal, the off-session recharge and the reconciliation adapter are
  exercised against fakes and against nothing in reality. What IS verified is
  everything that lives in this database, including a redelivered webhook
  crediting exactly once.
