/**
 * Money and usage units for the inference contracts.
 *
 * The non-negotiable invariant this file exists to make structural: **customer
 * charges never use floating-point values as the financial source of truth.**
 * A JS `number` cannot represent `0.1 + 0.2` exactly, and an inference ledger
 * adds millions of small amounts, so a float total is wrong by construction
 * rather than by accident.
 *
 * Every amount and every price is one representation: {@link exactDecimalSchema},
 * an exact decimal STRING at the scale ADR 0009 declares. Amounts are not
 * integer minor units, and that is the ADR's decision rather than an oversight:
 * one token costs several orders of magnitude less than one cent, so rounding
 * per request would make a customer's bill depend on how their client chunked
 * its work. Rounding happens ONCE, at the invoice boundary, and is itself a
 * ledger entry.
 *
 * A string is also what the driver hands back — `postgres.js` decodes `NUMERIC`
 * as a string — so keeping it a string on the wire means accidental JS
 * arithmetic fails loudly instead of silently losing precision. Money
 * arithmetic happens in SQL or in a decimal type, never in a JS `number`.
 *
 * Units are carried separately from money in every shape: a receipt says both
 * "204 output tokens" and "0.003060000000 USD", and neither is derived from the
 * other at read time. That separation is what lets a price version change
 * without rewriting settled history.
 *
 * Decided in: docs/adr/0009-usage-reservation-and-settlement.md.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Money                                                                     */
/* -------------------------------------------------------------------------- */

/** ISO 4217 alpha-3 currency code, e.g. `USD`. */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 alpha-3 code');

/**
 * The declared fractional scale of every amount and price in this contract, and
 * of the `NUMERIC` columns the ledger stores them in.
 *
 * Twelve digits is sub-minor-unit precision by a wide margin: at $3 per million
 * input tokens, one token costs `0.000003000000`, which this scale represents
 * exactly. Amounts are compared and summed NUMERICALLY, never as text — `3.0`
 * and `3.000000000000` are one amount written two ways.
 */
export const INFERENCE_MONEY_SCALE = 12;

/**
 * An exact non-negative decimal, carried as a STRING so no parse step can turn
 * it into a float on the way past. Up to 18 integer digits and
 * {@link INFERENCE_MONEY_SCALE} fractional digits.
 *
 * Non-negative: direction is carried by the SHAPE — a receipt debits, a refund
 * credits — so a stray sign can never silently invert an entry.
 *
 * No exponent form: `1e-6` and `0.000001` are the same number, but only one of
 * them survives a naive string comparison, a cache key or a log grep intact.
 *
 * Branded, so a bare `string` is not assignable and an amount cannot arrive
 * from string concatenation that was never checked. Producers construct one
 * with `exactDecimalSchema.parse(value)`.
 */
export const exactDecimalSchema = z
  .string()
  .regex(
    /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,12})?$/,
    'must be an exact non-negative decimal string without an exponent',
  )
  .brand<'ExactDecimal'>();

/**
 * An amount of money: the exact decimal plus the currency it is in.
 *
 * `.strict()` so a payload carrying a convenience float beside the exact value
 * (`{ amount: '18.06', amountFloat: 18.06 }`) is REJECTED rather than stripped.
 * A stripped float is the more dangerous outcome: it disappears silently here
 * and survives in the producer, where it is the value somebody eventually
 * displays.
 */
export const moneySchema = z
  .object({
    amount: exactDecimalSchema,
    currency: currencyCodeSchema,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Usage units                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of units inference is metered in.
 *
 * Time is carried in integer MILLISECONDS rather than seconds so that no unit
 * quantity is ever fractional: a 12.5-second transcription is `12500`, exactly,
 * and the "units are integers" rule holds for every modality instead of holding
 * for tokens and being quietly broken by audio.
 */
export const USAGE_UNITS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'requests',
  'images',
  'audio_input_milliseconds',
  'audio_output_milliseconds',
  'video_milliseconds',
  'characters',
  'embeddings',
] as const;

export const usageUnitSchema = z.enum(USAGE_UNITS);

/**
 * A metered quantity of ONE unit. Never money — a quantity carries no price and
 * no currency, so a consumer cannot mistake a token count for an amount owed.
 */
export const usageQuantitySchema = z
  .object({
    unit: usageUnitSchema,
    quantity: z.number().int().nonnegative().safe(),
  })
  .strict();

/**
 * Where a metered quantity came from.
 *
 * Kept explicit because the three are not interchangeable when a charge is
 * disputed: `provider_reported` is the upstream's own count, `oxy_measured` is
 * counted by the platform (streamed bytes, wall-clock milliseconds), and
 * `estimated` is a reconstruction used when a provider returned no usage at
 * all. An estimate that is indistinguishable from a reported number is an
 * estimate nobody can later reconcile or refund against.
 */
export const USAGE_SOURCES = ['provider_reported', 'oxy_measured', 'estimated'] as const;

export const usageSourceSchema = z.enum(USAGE_SOURCES);

/**
 * A price for one unit, as `amount` per `per` units — `per` because a price
 * quoted per single token would need more fractional digits than it is worth
 * ("$3.00 per 1000000 input_tokens" is how every provider quotes it, and how
 * every customer reads it).
 */
export const unitPriceSchema = z
  .object({
    unit: usageUnitSchema,
    amount: exactDecimalSchema,
    per: z.number().int().positive().safe(),
    currency: currencyCodeSchema,
  })
  .strict();

export type CurrencyCode = z.infer<typeof currencyCodeSchema>;
export type ExactDecimal = z.infer<typeof exactDecimalSchema>;
export type Money = z.infer<typeof moneySchema>;
export type UsageUnit = z.infer<typeof usageUnitSchema>;
export type UsageSource = z.infer<typeof usageSourceSchema>;
export type UsageQuantity = z.infer<typeof usageQuantitySchema>;
export type UnitPrice = z.infer<typeof unitPriceSchema>;
