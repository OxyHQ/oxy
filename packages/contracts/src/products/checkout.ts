import { integerCheck, safeNumberCheck } from '../numberChecks';
import { urlCheck, utf16MaxLength, utf16MinLength } from '../stringChecks';
import { z } from 'zod';
import { oxyAccountIdSchema } from '../inference/identifiers';
export const checkoutBillingAddressSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    state: z.string().check(utf16MinLength(1)).check(utf16MaxLength(100)).optional(),
    postalCode: z.string().check(utf16MinLength(1)).check(utf16MaxLength(32)).optional(),
    city: z.string().check(utf16MinLength(1)).check(utf16MaxLength(100)).optional(),
    line1: z.string().check(utf16MinLength(1)).check(utf16MaxLength(200)).optional(),
    line2: z.string().check(utf16MinLength(1)).check(utf16MaxLength(200)).optional(),
  })
  .strict();
export type CheckoutBillingAddress = z.infer<typeof checkoutBillingAddressSchema>;
export const personalPlanCheckoutRequestSchema = z
  .object({
    expectedSubjectAccountId: oxyAccountIdSchema,
    presentation: z.enum(['hosted', 'embedded']).optional(),
    billingAddress: checkoutBillingAddressSchema.optional(),
    offerId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    offerVersion: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
    idempotencyKey: z
      .string()
      .check(utf16MinLength(8))
      .check(utf16MaxLength(160))
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();
/** Ephemeral payer capability, never stored in an Oxy checkout row or browser persistence. */
export const embeddedProductCheckoutSchema = z
  .object({
    transport: z.literal('checkout_session'),
    subjectAccountId: oxyAccountIdSchema,
    productId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    offerId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
    offerVersion: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
    merchantId: z.string().check(utf16MinLength(1)),
    mode: z.enum(['test', 'live']),
    environment: z.enum(['development', 'test', 'staging', 'production']),
    sessionId: z.string().check(utf16MinLength(1)),
    clientSecret: z.string().check(utf16MinLength(1)),
    publishableKey: z.string().check(utf16MinLength(1)),
    currency: z.literal('USD'),
    amountMinorUnits: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
    interval: z.enum(['month', 'year']),
    tax: z
      .object({
        subtotalMinorUnits: z.number().check(integerCheck()).nonnegative().check(safeNumberCheck()),
        taxMinorUnits: z.number().check(integerCheck()).nonnegative().check(safeNumberCheck()),
        totalMinorUnits: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
        inclusive: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type EmbeddedProductCheckout = z.infer<typeof embeddedProductCheckoutSchema>;

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
      embeddedCheckout: embeddedProductCheckoutSchema.optional(),
      checkoutStatus: z.enum(['open', 'complete', 'expired']).optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('closed'),
      reason: z.literal('billing_location_required').optional(),
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

export const productCheckoutConfigurationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unconfigured') }).strict(),
  z
    .object({
      state: z.literal('ready'),
      subjectAccountId: oxyAccountIdSchema,
      productId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
      merchantId: z.string().check(utf16MinLength(1)),
      mode: z.enum(['test', 'live']),
      environment: z.enum(['development', 'test', 'staging', 'production']),
      publishableKey: z.string().check(utf16MinLength(1)),
      paymentMethods: z.array(
        z
          .object({
            id: z.enum(['card', 'bank', 'installments', 'faircoin']),
            available: z.boolean(),
            reason: z.string().optional(),
          })
          .strict(),
      ),
      offers: z.array(
        z
          .object({
            offerId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
            offerVersion: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
            amountMinorUnits: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
            currency: z.literal('USD'),
            interval: z.enum(['month', 'year']),
          })
          .strict(),
      ),
    })
    .strict(),
]);
export type ProductCheckoutConfiguration = z.infer<typeof productCheckoutConfigurationSchema>;
