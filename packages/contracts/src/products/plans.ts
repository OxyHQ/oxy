import { z } from 'zod';
import { productBenefitSchema } from './access';

/** Approved display terms never identify or activate a billing-provider price. */
export const personalPlanDisplayPriceSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinorUnits: z.number().int().positive().safe(),
    interval: z.literal('month'),
    trial: z.literal('none'),
    taxTreatment: z.literal('inclusive'),
    merchantTotal: z.literal('final'),
  })
  .strict();

/** Public discovery is separate from customer access. No provider or owner IDs. */
export const personalPlanCatalogueSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(['unconfigured', 'configured']),
    purchase: z.literal('unavailable'),
    plans: z.array(
      z
        .object({
          offerId: z.string().min(1).max(160),
          offerVersion: z.number().int().positive().safe(),
          displayName: z.string().min(1).max(100),
          audience: z.literal('personal'),
          kind: z.literal('oxy_one'),
          price: personalPlanDisplayPriceSchema.optional(),
          benefits: z.array(
            z
              .object({ displayName: z.string().min(1).max(100), benefit: productBenefitSchema })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (value) => (value.state === 'unconfigured') === (value.plans.length === 0),
    'Catalogue state must match published plans',
  );
export type PersonalPlanCatalogue = z.infer<typeof personalPlanCatalogueSchema>;
