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
  billingInvoiceSchema,
  billingModeSchema,
  billingProfileStatusSchema,
  currencyCodeSchema,
  exactDecimalSchema,
} from '@oxyhq/contracts';
import { LEDGER_AUTHORITATIVE_NOTE } from './inferenceReporting.schemas';

/** An id in a path segment. Bounded so a pathological path is refused early. */
const idParam = z.string().min(1).max(128);

export const accountBillingParams = z.object({ accountId: idParam }).strict();

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

/*
 * The spending-limit REQUEST shapes live in `inferenceReporting.schemas.ts`,
 * beside the router that owns the budget surface (#972 workstream 8). A second
 * set here would be a second answer to what a budget is, on a table both would
 * write.
 */

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

/**
 * The invoice list, stamped the way every money figure on `/inference/reporting`
 * is stamped.
 *
 * `source` and `consistency` are required `z.literal`s rather than optional
 * strings, so a producer cannot omit them and a reader is never left guessing
 * whether a number is the authoritative ledger or an eventually-consistent
 * telemetry rollup. The constants are imported from the router that established
 * the convention rather than restated, because two spellings of
 * "authoritative" is exactly the drift the convention exists to prevent.
 *
 * The ROWS stay `billingInvoiceSchema` from `@oxyhq/contracts`: the invoice is a
 * shared shape, and the envelope is this API's way of describing what kind of
 * number it just handed over.
 */
export const accountInvoicesSchema = z
  .object({
    schemaVersion: z.literal(1),
    consistency: z.literal('authoritative'),
    source: z.literal('financial_ledger'),
    note: z.literal(LEDGER_AUTHORITATIVE_NOTE),
    rows: z.array(billingInvoiceSchema),
  })
  .strict();

export type AccountInvoicesDto = z.input<typeof accountInvoicesSchema>;

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
 *
 * ## Why the boolean arm exists: a TRANSFORMING schema must be IDEMPOTENT here
 *
 * `middleware/validate.ts` writes its parsed output BACK onto `req.query`, and
 * every route in this repository then parses again in the handler to obtain a
 * typed value without a cast. For a schema that only narrows strings, the second
 * parse is a no-op. For a schema that TRANSFORMS, it is fed its own output —
 * so a string-only `includeRetired` sees a boolean, raises `invalid_type`
 * outside any validation boundary, and the route answers 500.
 *
 * That is not hypothetical: `GET /billing/cost-centers` did exactly this on
 * EVERY request, including the default one with no parameter at all, from the day
 * it was written until `routes/__tests__/staffCapabilityGates.test.ts` called it.
 * No test had ever issued the request.
 *
 * So the schema accepts its own output as well as its input. The refusal
 * behaviour is unchanged — `'no'`, `'0'`, `'FALSE'` and `''` are still refused
 * rather than guessed, which is the property the paragraph above is about.
 */
export const costCenterListQuery = z
  .object({
    includeRetired: z
      .union([z.enum(['true', 'false']).transform((value) => value === 'true'), z.boolean()])
      .default(false),
  })
  .strict();
