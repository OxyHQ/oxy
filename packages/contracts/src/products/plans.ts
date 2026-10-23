import { integerCheck, safeNumberCheck } from '../numberChecks';
import { utf16MaxLength, utf16MinLength } from '../stringChecks';
import { z } from 'zod';
import { productBenefitSchema } from './access';

/** Approved display terms never identify or activate a billing-provider price. */
export const personalPlanDisplayPriceSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinorUnits: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
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
    purchase: z.enum(['unavailable', 'available']),
    plans: z.array(
      z
        .object({
          offerId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
          offerVersion: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
          displayName: z.string().check(utf16MinLength(1)).check(utf16MaxLength(100)),
          audience: z.literal('personal'),
          kind: z.literal('oxy_one'),
          price: personalPlanDisplayPriceSchema.optional(),
          benefits: z.array(
            z
              .object({
                displayName: z.string().check(utf16MinLength(1)).check(utf16MaxLength(100)),
                benefit: productBenefitSchema,
              })
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

export const productPlanCatalogueSchema = z
  .object({
    schemaVersion: z.literal(1),
    productId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    purchase: z.enum(['unavailable', 'available']),
    plans: z.array(
      z
        .object({
          productId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
          offerId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
          offerVersion: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
          displayName: z.string().check(utf16MinLength(1)).check(utf16MaxLength(100)),
          price: personalPlanDisplayPriceSchema.extend({ interval: z.enum(['month', 'year']) }),
        })
        .strict(),
    ),
  })
  .strict();
export type ProductPlanCatalogue = z.infer<typeof productPlanCatalogueSchema>;
