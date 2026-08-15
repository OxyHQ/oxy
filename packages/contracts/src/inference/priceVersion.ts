/**
 * Price versions — the immutable snapshots customer pricing is quoted and
 * settled against.
 *
 * A price is never edited in place. A change publishes a NEW version that
 * supersedes the old one, and every settled receipt keeps the id of the version
 * it was priced with. That is what makes an invoice reproducible a year later:
 * the receipt does not say "3.00 per million tokens", it says "priced under
 * `pv_2026_08`", and that version still exists, unchanged, with its own
 * effective window.
 *
 * Prices are exact decimal strings (see `money.ts`), never floats, and they are
 * quoted per unit. The amount a customer owes is computed from them and is
 * carried in the same exact form, so no step of the calculation passes through
 * a representation that cannot hold the value.
 *
 * Decided in: docs/adr/0009-usage-reservation-and-settlement.md.
 */

import { z } from 'zod';
import {
  inferenceTimestampSchema,
  modelReferenceSchema,
  inferenceProviderSlugSchema,
} from './identifiers';
import { currencyCodeSchema, unitPriceSchema } from './money';

/**
 * Lifecycle of a price version.
 *
 * `draft` is quotable in Console previews but may never price a receipt;
 * `active` is what live requests are priced with; `superseded` priced receipts
 * in the past and still resolves for them forever.
 */
export const priceVersionStatusSchema = z.enum(['draft', 'active', 'superseded']);

/**
 * A published set of customer prices for one model reference on one provider.
 *
 * Scoped to a `(modelReference, provider)` pair rather than to a model alone
 * because the same model costs different amounts on different providers, and a
 * receipt has to be reproducible against the route that actually served it.
 */
export const priceVersionSchema = z
  .object({
    /** See `version.ts`: served on its own by the catalogue, so it is versioned. */
    schemaVersion: z.literal(1),
    priceVersionId: z.string().min(1).max(128),
    status: priceVersionStatusSchema,
    modelReference: modelReferenceSchema,
    provider: inferenceProviderSlugSchema,
    currency: currencyCodeSchema,
    unitPrices: z.array(unitPriceSchema).min(1),
    effectiveFrom: inferenceTimestampSchema,
    /** Absent while this version is the current one. */
    effectiveUntil: inferenceTimestampSchema.optional(),
    /** The version this one replaced, absent for the first version of a route. */
    supersedesPriceVersionId: z.string().min(1).max(128).optional(),
    createdAt: inferenceTimestampSchema,
  })
  .superRefine((priceVersion, ctx) => {
    const units = priceVersion.unitPrices.map((price) => price.unit);
    if (new Set(units).size !== units.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPrices'],
        message: 'a unit may be priced only once per price version',
      });
    }

    for (const [index, price] of priceVersion.unitPrices.entries()) {
      if (price.currency !== priceVersion.currency) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unitPrices', index, 'currency'],
          message: 'every unit price must be quoted in the price version currency',
        });
      }
    }

    // Compared as instants, not as strings: `…T00:00:00Z` and `…T00:00:00.000Z`
    // are the same moment and sort differently as text.
    if (
      priceVersion.effectiveUntil !== undefined &&
      Date.parse(priceVersion.effectiveUntil) <= Date.parse(priceVersion.effectiveFrom)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'a price version must stop applying after it started applying',
      });
    }

    // A superseded version priced requests during a window that has closed. Left
    // open, it is indistinguishable from the current one when a receipt is
    // re-priced years later — which is the one job this record exists to do.
    if (priceVersion.status === 'superseded' && priceVersion.effectiveUntil === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'a superseded price version must record when it stopped applying',
      });
    }
  });

/**
 * The price snapshot a settled receipt keeps.
 *
 * The unit prices are COPIED onto the receipt, not just referenced, so a receipt
 * remains readable even if the price version record is later archived, and so
 * that a mistake in the copy is visible as a disagreement with the version it
 * names rather than silently invisible.
 */
export const priceSnapshotSchema = z
  .object({
    priceVersionId: z.string().min(1).max(128),
    currency: currencyCodeSchema,
    unitPrices: z.array(unitPriceSchema).min(1),
  })
  .strict();

export type PriceVersionStatus = z.infer<typeof priceVersionStatusSchema>;
export type PriceVersion = z.infer<typeof priceVersionSchema>;
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;
