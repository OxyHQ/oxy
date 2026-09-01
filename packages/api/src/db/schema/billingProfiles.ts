/**
 * `billing_profiles` — which Oxy ACCOUNT pays, and on what terms.
 *
 * The audit (`docs/audits/2026-08-15-account-and-application-ownership.md` §6)
 * found the gap this closes, and stated it more precisely than the epic did:
 * account-scoped billing STORAGE already existed (`user_credits` is keyed on
 * `users.id`, which is an account id of any kind) — what was missing was any way
 * for a non-personal account to acquire one other than a human holding
 * `account:act_as`, switching into it, and loading a billing page. For a
 * `channel` account it was impossible outright, because switching into a channel
 * is refused, while nothing stops a channel from owning an application.
 *
 * So this is not a second copy of `user_credits`. The two answer different
 * questions and must not be merged:
 *
 *  - `user_credits` is the API-CREDIT product: whole, indivisible counts of a
 *    prepaid entitlement, refreshed daily, sold in packs. ADR 0009 is explicit
 *    that product subscriptions such as Alia plans stay distinct from
 *    pay-as-you-go inference spend and must not become one balance.
 *  - `billing_profiles` + `account_balances` are pay-as-you-go inference MONEY:
 *    exact `NUMERIC` amounts in a currency, reserved before execution and
 *    settled against a receipt.
 *
 * ## No Stripe customer id here, deliberately
 *
 * `user_credits.stripe_customer_id` already exists, carries a partial unique
 * index, and is what `handleSubscriptionUpdate` resolves a webhook back through
 * (`routes/billing.ts`). A second column naming the same Stripe customer would
 * be a second authority for one fact, and the failure mode of two Stripe
 * customer columns that disagree is money credited to the wrong account. The
 * Stripe link stays where the live webhook already reads it; this table holds
 * the TERMS, and `billing_invoices.external_invoice_ref` holds the per-invoice
 * reconciliation reference.
 *
 * ## Child projects share the nearest ancestor's profile — argued, not assumed
 *
 * #972 asks whether child projects share the parent balance or receive
 * allocated budgets. **They share, and are constrained by budgets rather than by
 * separate funds**, with one exception: a project that has a billing profile of
 * its own becomes independently billable. The resolution rule is therefore
 * "draw on the NEAREST ancestor (including self) that has a profile", walked
 * over the existing `user_ancestors` path — the same materialised path
 * `resolveEffectiveMembership` already walks, so billing inheritance and
 * permission inheritance cannot come to different answers about the tree.
 *
 * Why not allocated funds by default:
 *
 *  - Allocating funds means MOVING money between two accounts' balances, which
 *    creates a state where an organization has money and its project cannot
 *    spend — a stranded balance and a support ticket, not a control.
 *  - A budget is a LIMIT, not a store of value. It can be raised, lowered or
 *    removed without a financial transaction, and it can never strand funds.
 *    `spending_limits` is where a per-project ceiling lives.
 *  - This is not a dead end: an internal transfer between two accounts'
 *    `purchased_funds` is already a legal ledger entry, so genuine allocation
 *    can be built on top without changing the model.
 *
 * ## `ON DELETE RESTRICT`
 *
 * The same posture `billing_transactions` already takes, and for the same
 * reason: this is the record of who is financially responsible, and deleting the
 * account must not silently delete it. Account erasure therefore needs an
 * explicit retention decision — which is already true today for any account with
 * a `billing_transactions` row, so this widens an existing requirement rather
 * than introducing a new class of it.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, inList, updatedAt } from '@oxyhq/db';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { users } from './users';

/**
 * How an account pays.
 *
 * `prepaid` spends a balance it topped up in advance; `invoiced` draws against a
 * credit limit and is billed in arrears. Both settle through the same ledger —
 * the difference is only which account a reservation draws from.
 */
export const BILLING_MODES = ['prepaid', 'invoiced'] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

/** Whether the profile may currently spend. */
export const BILLING_PROFILE_STATUSES = ['active', 'suspended', 'closed'] as const;

export type BillingProfileStatus = (typeof BILLING_PROFILE_STATUSES)[number];

export const billingProfiles = pgTable(
  'billing_profiles',
  {
    /**
     * The billable principal, and the primary key. `users` IS the account table
     * — `kind` is personal / organization / project / bot / channel — so this
     * accepts an account of any kind, including the two (`channel`, `bot`) that
     * cannot be switched into and therefore could never have acquired a balance
     * under the pre-existing bearer-subject-only provisioning path.
     */
    accountId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),

    currency: currencyCode(),
    billingMode: text({ enum: BILLING_MODES }).notNull().default('prepaid'),
    status: text({ enum: BILLING_PROFILE_STATUSES }).notNull().default('active'),

    /**
     * How far an `invoiced` account may draw before a reservation is refused.
     * Zero for a `prepaid` account, where it is not consulted at all — the
     * available amount is the prepaid balance.
     */
    creditLimit: exactAmount().notNull().default('0'),

    /** Top the balance up automatically when it falls below the threshold. */
    autoRechargeEnabled: boolean().notNull().default(false),
    autoRechargeThreshold: exactAmount(),
    autoRechargeAmount: exactAmount(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // "Which invoiced accounts are near their limit" and the auto-recharge
    // sweep both scan by mode.
    index('billing_profiles_billing_mode_status_idx').on(t.billingMode, t.status),

    check(
      'billing_profiles_billing_mode_check',
      sql`${t.billingMode} in (${sql.raw(inList(BILLING_MODES))})`
    ),
    check(
      'billing_profiles_status_check',
      sql`${t.status} in (${sql.raw(inList(BILLING_PROFILE_STATUSES))})`
    ),
    check('billing_profiles_currency_check', currencyCodeCheck(t.currency)),
    check('billing_profiles_credit_limit_check', sql`${t.creditLimit} >= 0`),
    // An enabled auto-recharge with no threshold or no amount is a setting that
    // silently does nothing — the shape a customer reads as "on" and that never
    // fires. An IMPLICATION rather than a biconditional: the two values may be
    // configured before the feature is switched on.
    check(
      'billing_profiles_auto_recharge_check',
      sql`not ${t.autoRechargeEnabled}
        or (${t.autoRechargeThreshold} is not null and ${t.autoRechargeAmount} is not null)`
    ),
    check(
      'billing_profiles_auto_recharge_amounts_check',
      sql`(${t.autoRechargeThreshold} is null or ${t.autoRechargeThreshold} >= 0)
        and (${t.autoRechargeAmount} is null or ${t.autoRechargeAmount} > 0)`
    ),
  ]
);
