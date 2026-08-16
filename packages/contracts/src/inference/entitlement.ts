/**
 * Product entitlements — the interface a first-party product (Alia) queries to
 * learn what an account is entitled to, WITHOUT learning anything it could
 * mistake for a balance.
 *
 * ## The separation this file is
 *
 * #972 states the failure mode outright: confusing a product subscription with
 * pay-as-you-go inference usage. So the two live in disjoint shapes here, and
 * the separation is structural rather than documented:
 *
 *  - {@link productEntitlementSchema} carries PLAN and ALLOWANCES. Allowances
 *    are whole integer counts of a product entitlement (API credits, included
 *    requests) — `z.number().int()`, never `exactDecimalSchema`, so an allowance
 *    is not even the same TYPE as money and cannot be added to one.
 *  - `accountBalanceSchema` (in `accountBilling.ts`) carries MONEY, as exact
 *    decimal strings.
 *
 * There is no field anywhere that is both, and no schema that sums them. A
 * consumer wanting "what can this account do right now" reads both sections and
 * presents both; a consumer that only wanted one is not handed the other in a
 * form it can accidentally arithmetic.
 *
 * ## Allowances do not change what a request COSTS
 *
 * An Alia plan may include an allowance of inference. Oxy still records the
 * exact underlying cost of every request against the account's ledger — the
 * allowance is a PRODUCT-side entitlement that decides what Alia charges its
 * user, not a discount applied to the receipt. That is why
 * {@link productEntitlementSchema} names no price and no currency: a plan that
 * could restate the cost of a request would be a second pricing authority, and
 * a receipt has exactly one.
 *
 * ## Cost centres
 *
 * A first-party cost centre IS an Oxy project account — `users.kind` already has
 * `project`, and an application's `ownerAccountId` already points at one. So a
 * cost centre adds a LABEL and a slug to an account rather than a parallel
 * hierarchy, which is the epic's "do not add a second organization model" rule
 * applied to internal accounting.
 *
 * Decided in: docs/adr/0014-account-billing-and-entitlements.md.
 */

import { z } from 'zod';
import { oxyAccountIdSchema } from './identifiers';
import { billingModeSchema } from './accountBilling';
import { currencyCodeSchema, exactDecimalSchema } from './money';

/* -------------------------------------------------------------------------- */
/*  Plans and allowances                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The statuses a subscription may be mirrored in.
 *
 * All of the processor's, not just the ones this platform sells: a mirror that
 * cannot represent what it mirrors freezes at its previous value, and a
 * subscription the processor moved to `paused` would keep granting a plan
 * nobody is paying for.
 */
export const PRODUCT_PLAN_STATUSES = [
  'active',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'past_due',
  'paused',
  'trialing',
  'unpaid',
] as const;

export const productPlanStatusSchema = z.enum(PRODUCT_PLAN_STATUSES);

/**
 * The statuses that mean the plan is LIVE.
 *
 * Exported because "is this entitlement in force" must have one answer across
 * Oxy and every product consuming it — a consumer deriving its own list is how
 * `past_due` comes to be honoured in one place and refused in another.
 */
export const LIVE_PRODUCT_PLAN_STATUSES = ['active', 'trialing'] as const;

/**
 * One allowance included in a plan.
 *
 * `remaining` is optional and absent means "not metered against this allowance
 * here" — NOT zero. A consumer that read an absent allowance as exhausted would
 * refuse a user who has spent nothing.
 */
export const planAllowanceSchema = z
  .object({
    /** A stable machine name, e.g. `api_credits_per_month`. */
    key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    /** Whole units included per period. Never money. */
    included: z.number().int().nonnegative().safe(),
    remaining: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

/**
 * The plan an account is on, if any.
 *
 * `price` is deliberately absent. What a customer pays for their plan is the
 * processor's record and this platform's `billing_transactions`; restating it
 * here would put a second price authority in the one interface whose whole job
 * is to keep product pricing and inference cost apart.
 */
export const productPlanSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    status: productPlanStatusSchema,
    live: z.boolean(),
    currentPeriodStart: z.string().datetime(),
    currentPeriodEnd: z.string().datetime(),
    cancelAtPeriodEnd: z.boolean(),
    allowances: z.array(planAllowanceSchema),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Pay-as-you-go position                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The account's inference-spend position, summarised for a product consumer.
 *
 * A REDUCTION of `accountBillingStateSchema`, not a copy: a product asking "may
 * this account run another request" needs to know whether spending is possible
 * and roughly how much room is left, and does not need the bucket breakdown.
 * `promotionalBalance` and `purchasedBalance` are still separate — the rule that
 * a grant and a purchase are never one number does not relax because the
 * consumer is first-party.
 */
export const payAsYouGoEntitlementSchema = z
  .object({
    /** The account that actually pays — the nearest ancestor with a profile. */
    billingAccountId: oxyAccountIdSchema,
    currency: currencyCodeSchema,
    billingMode: billingModeSchema,
    purchasedBalance: exactDecimalSchema,
    promotionalBalance: exactDecimalSchema,
    availableToSpend: exactDecimalSchema,
    /** False when the profile is suspended, closed, or out of room. */
    canSpend: z.boolean(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Cost centres                                                              */
/* -------------------------------------------------------------------------- */

export const COST_CENTER_STATUSES = ['active', 'retired'] as const;

export const costCenterStatusSchema = z.enum(COST_CENTER_STATUSES);

/**
 * An internal cost centre — an Oxy account that first-party spend is attributed
 * to, with a stable slug so a report can name it without an id.
 *
 * The account IS the cost centre; this shape only labels it. There is no
 * `parentId` here for the same reason: the account graph already has one, and a
 * second parent link would be a second hierarchy that can disagree with it.
 */
export const costCenterSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    accountId: oxyAccountIdSchema,
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    label: z.string().min(1).max(120),
    status: costCenterStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * What one cost centre spent over a window.
 *
 * `billedAmount` comes from settled receipts — the FINANCIAL ledger — never from
 * telemetry sums, per #972 workstream 8. `requestCount` is a count of receipts,
 * so the two are always about the same set of rows.
 */
export const costCenterSpendSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    costCenter: costCenterSchema,
    currency: currencyCodeSchema,
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    billedAmount: exactDecimalSchema,
    requestCount: z.number().int().nonnegative().safe(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  The interface Alia queries                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything a product needs to decide what an account may do, in one read.
 *
 * The three sections never merge:
 *
 *  - `plan` + `allowances` — the product subscription.
 *  - `payAsYouGo` — inference money. `null` when the account has no billing
 *    profile anywhere up its ancestry, which is a REAL and distinct state from a
 *    zero balance: nobody has decided who pays for this account yet.
 *  - `costCenter` — where first-party spend is booked, `null` for a customer.
 */
export const productEntitlementSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    accountId: oxyAccountIdSchema,
    plan: productPlanSchema.nullable(),
    /**
     * Allowances in force right now, whether they came from a plan or from the
     * platform's own free tier. Whole counts; never money.
     */
    allowances: z.array(planAllowanceSchema),
    payAsYouGo: payAsYouGoEntitlementSchema.nullable(),
    costCenter: costCenterSchema.nullable(),
    /** When this view was computed. Entitlements are eventually consistent. */
    resolvedAt: z.string().datetime(),
  })
  .strict();

export type ProductPlanStatus = z.infer<typeof productPlanStatusSchema>;
export type PlanAllowance = z.infer<typeof planAllowanceSchema>;
export type ProductPlan = z.infer<typeof productPlanSchema>;
export type PayAsYouGoEntitlement = z.infer<typeof payAsYouGoEntitlementSchema>;
export type CostCenterStatus = z.infer<typeof costCenterStatusSchema>;
export type CostCenter = z.infer<typeof costCenterSchema>;
export type CostCenterSpend = z.infer<typeof costCenterSpendSchema>;
export type ProductEntitlement = z.infer<typeof productEntitlementSchema>;
