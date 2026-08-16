/**
 * Request shapes for `/billing/accounts` and `/billing/cost-centers`
 * (issue #972, sections 7.1, 7.4 and 7.5).
 *
 * Every body is `.strict()`. On a billing surface that is not stylistic: a
 * stripped extra key still existed upstream of the parse, and the keys somebody
 * would try to smuggle in here are `billingMode` and `creditLimit` — the two
 * that decide whether an account may spend money it does not have. The route
 * gates those on staff as well; the schema is what makes an unexpected shape
 * stop at the boundary rather than being quietly discarded.
 *
 * Amounts are `exactDecimalSchema` from `@oxyhq/contracts`, never `z.number()`.
 * A JSON number cannot carry `0.000003` losslessly through every client, and the
 * ledger's whole arrangement is that money is an exact decimal STRING from the
 * wire to the column. A `z.number()` here would be the one place the invariant
 * is broken, and it would be broken silently.
 */

import { z } from 'zod';
import {
  billingModeSchema,
  billingProfileStatusSchema,
  currencyCodeSchema,
  exactDecimalSchema,
  spendingAlertThresholdBpsSchema,
  spendingLimitEnforcementSchema,
  spendingLimitPeriodSchema,
  spendingLimitScopeSchema,
} from '@oxyhq/contracts';

/** An id in a path segment. Bounded so a pathological path is refused early. */
const idParam = z.string().min(1).max(128);

export const accountBillingParams = z.object({ accountId: idParam }).strict();

export const spendingLimitParams = z
  .object({ accountId: idParam, limitId: idParam })
  .strict();

export const costCenterSlugParams = z
  .object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) })
  .strict();

export const reconciliationRunParams = z.object({ runId: idParam }).strict();

/**
 * An ISO instant in a query string or body.
 *
 * A string with an explicit `datetime()` check rather than `z.coerce.date()`:
 * coercion accepts `'not a date'` as `Invalid Date` in some zod versions and
 * hands the route an object whose `toISOString()` throws. Parsing to a `Date`
 * happens in the handler, after the shape is known good.
 */
const isoInstant = z.string().datetime();

/**
 * Provision an account's own billing profile.
 *
 * Every field is optional. The defaults — `USD`, `prepaid`, no credit limit —
 * are the schema column's, so an empty body provisions the conservative shape: a
 * prepaid account that can spend exactly what it has topped up.
 */
export const provisionBillingBody = z
  .object({
    currency: currencyCodeSchema.optional(),
    billingMode: billingModeSchema.optional(),
    creditLimit: exactDecimalSchema.optional(),
  })
  .strict();

/**
 * Update a billing profile.
 *
 * `autoRecharge` is nested and its two amounts are `.nullable()`: `null` clears
 * a configured value, `undefined` leaves it alone. They are different requests,
 * and collapsing them would make turning auto-recharge off impossible without
 * also re-sending the amounts it should have had.
 */
export const updateBillingProfileBody = z
  .object({
    status: billingProfileStatusSchema.optional(),
    billingMode: billingModeSchema.optional(),
    creditLimit: exactDecimalSchema.optional(),
    autoRecharge: z
      .object({
        enabled: z.boolean().optional(),
        threshold: exactDecimalSchema.nullable().optional(),
        amount: exactDecimalSchema.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Create a spending limit.
 *
 * The scope target is validated for CONSISTENCY here and for OWNERSHIP in the
 * service — two different questions. This refine only says a body naming
 * `scope: 'application'` must carry an application id; whether that application
 * belongs to the account paying is a database question and is answered against
 * the account graph, not against the request.
 */
export const createSpendingLimitBody = z
  .object({
    scope: spendingLimitScopeSchema,
    scopeAccountId: idParam.optional(),
    scopeApplicationId: idParam.optional(),
    scopeApplicationCredentialId: idParam.optional(),
    period: spendingLimitPeriodSchema,
    limitAmount: exactDecimalSchema,
    enforcement: spendingLimitEnforcementSchema.optional(),
    alertThresholdBps: z.array(spendingAlertThresholdBpsSchema).max(5).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.scope === 'account' && value.scopeAccountId !== undefined) ||
      (value.scope === 'application' && value.scopeApplicationId !== undefined) ||
      (value.scope === 'credential' && value.scopeApplicationCredentialId !== undefined),
    { message: 'the scope target must match the scope' },
  );

/**
 * Update a spending limit.
 *
 * The SCOPE is absent on purpose. Re-pointing a limit at a different application
 * would silently re-interpret every alert already recorded against it — the
 * notification rows key on `(limit, period_start, threshold)` and carry no scope
 * of their own. Moving a budget is delete plus create.
 */
export const updateSpendingLimitBody = z
  .object({
    limitAmount: exactDecimalSchema.optional(),
    enforcement: spendingLimitEnforcementSchema.optional(),
    alertThresholdBps: z.array(spendingAlertThresholdBpsSchema).max(5).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

export const spendingLimitAlertsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

/**
 * Start a hosted checkout that funds the account balance.
 *
 * The redirect URLs are checked against the platform allowlist in the route, the
 * same way `/billing/checkout/credits` checks its own — an open redirect on a
 * payment page is a phishing surface, and this schema deliberately does not try
 * to express that rule, because a URL allowlist belongs where the allowlist is.
 */
export const topUpCheckoutBody = z
  .object({
    amount: exactDecimalSchema,
    currency: currencyCodeSchema.optional(),
    successUrl: z.string().url().max(2048),
    cancelUrl: z.string().url().max(2048),
  })
  .strict();

export const accountPortalBody = z
  .object({ returnUrl: z.string().url().max(2048) })
  .strict();

/**
 * Issue promotional credit. Staff-only at the route.
 *
 * `idempotencyKey` is REQUIRED and supplied by the caller, not generated here: a
 * grant is money, the operator issuing it usually has a ticket or campaign id to
 * key it on, and a server-generated key would make a double-submitted form two
 * grants.
 */
export const promotionalGrantBody = z
  .object({
    amount: exactDecimalSchema,
    currency: currencyCodeSchema.optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

/** Close a billing period into an invoice. Staff-only at the route. */
export const closeInvoicePeriodBody = z
  .object({
    currency: currencyCodeSchema.optional(),
    periodStart: isoInstant,
    periodEnd: isoInstant,
  })
  .strict();

/** Run a reconciliation pass over a window. Staff-only at the route. */
export const reconciliationBody = z
  .object({
    currency: currencyCodeSchema.optional(),
    periodStart: isoInstant,
    periodEnd: isoInstant,
  })
  .strict();

/** Register an internal cost centre. Staff-only at the route. */
export const registerCostCenterBody = z
  .object({
    accountId: idParam,
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    label: z.string().min(1).max(120),
  })
  .strict();

export const costCenterSpendQuery = z
  .object({
    currency: currencyCodeSchema.optional(),
    periodStart: isoInstant,
    periodEnd: isoInstant,
  })
  .strict();

/**
 * `includeRetired` as an explicit two-value enum, NOT `z.coerce.boolean()`.
 *
 * Query strings arrive as strings and `z.coerce.boolean()` is `Boolean(value)`,
 * so the literal `'false'` coerces to TRUE. A client asking to hide retired cost
 * centres would get them anyway, and only omitting the parameter entirely — via
 * the default — would ever mean false. The transform below is what makes the
 * flag say what it reads as.
 */
export const costCenterListQuery = z
  .object({
    includeRetired: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();
