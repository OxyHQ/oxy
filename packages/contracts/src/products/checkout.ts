import { integerCheck, safeNumberCheck } from '../numberChecks';
import { urlCheck, utf16MaxLength, utf16MinLength } from '../stringChecks';
import { z } from '@oxy.so/zod4';
import { oxyAccountIdSchema } from '../inference/identifiers';
export const personalPlanCheckoutRequestSchema = z
  .object({
    expectedSubjectAccountId: oxyAccountIdSchema,
    offerId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    offerVersion: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
    idempotencyKey: z
      .string()
      .check(utf16MinLength(8))
      .check(utf16MaxLength(160))
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();
/** No grant or subscription is created by checkout completion in the browser. */
export const personalPlanCheckoutResultSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('unconfigured'),
      reason: z.enum(['provider_unconfigured', 'offer_unconfigured', 'price_unconfigured']),
    })
    .strict(),
  z
    .object({
      state: z.literal('pending'),
      intentId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
      checkoutUrl: z.string().check(urlCheck()).startsWith('https://').optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('closed'),
      intentId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    })
    .strict(),
  z
    .object({
      state: z.literal('fulfilled'),
      intentId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    })
    .strict(),
]);
export type PersonalPlanCheckoutRequest = z.infer<typeof personalPlanCheckoutRequestSchema>;
export type PersonalPlanCheckoutResult = z.infer<typeof personalPlanCheckoutResultSchema>;

/** Explicit individual product offer; still owned and paid through Oxy. */
export const productPlanCheckoutRequestSchema = personalPlanCheckoutRequestSchema
  .extend({
    productId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
  })
  .strict();
export type ProductPlanCheckoutRequest = z.infer<typeof productPlanCheckoutRequestSchema>;

export const productSubscriptionRenewalRequestSchema = z
  .object({
    expectedSubjectAccountId: oxyAccountIdSchema,
    sourceId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    idempotencyKey: personalPlanCheckoutRequestSchema.shape.idempotencyKey,
  })
  .strict();
export type ProductSubscriptionRenewalRequest = z.infer<
  typeof productSubscriptionRenewalRequestSchema
>;
