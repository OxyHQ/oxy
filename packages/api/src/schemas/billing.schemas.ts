import {
  integerCheck,
  isoDateTime,
  safeNumberCheck,
  urlCheck,
  utf16MaxLength,
  utf16MinLength,
} from '@oxy.so/contracts';
import { z } from '@oxy.so/zod4';
import { productSubscriptionCancellationResultSchema } from '@oxy.so/contracts';

// POST /billing/checkout/credits
export const checkoutCreditsSchema = z.object({
  packageId: z.string().trim().check(utf16MinLength(1)),
  successUrl: z.string().check(urlCheck()),
  cancelUrl: z.string().check(urlCheck()),
});

// POST /billing/checkout/subscription
export const checkoutSubscriptionSchema = z.object({
  planId: z.string().trim().check(utf16MinLength(1)),
  successUrl: z.string().check(urlCheck()),
  cancelUrl: z.string().check(urlCheck()),
});

// POST /billing/portal
export const portalSchema = z.object({
  returnUrl: z.string().check(urlCheck()),
});

// GET /billing/transactions
export const transactionsQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

/** These selectors name the mirror row, never an arbitrary provider subscription. */
export const cancelCreditSubscriptionSchema = z
  .object({
    subscriptionId: z.string().guid(),
    expectedSubjectAccountId: z
      .string()
      .check(utf16MinLength(1))
      .check(utf16MaxLength(160))
      .optional(),
  })
  .strict();
export const namedProductCancellationResponseSchema =
  productSubscriptionCancellationResultSchema.options[0];
export const pendingProductCancellationResponseSchema =
  productSubscriptionCancellationResultSchema.options[1];
const creditSubscriptionSchema = z
  .object({
    _id: z.string().guid(),
    userId: z.string().check(utf16MinLength(1)),
    stripeCustomerId: z.string().check(utf16MinLength(1)),
    stripeSubscriptionId: z.string().check(utf16MinLength(1)),
    stripePriceId: z.string().check(utf16MinLength(1)),
    status: z.enum([
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'canceled',
      'paused',
      'incomplete',
      'incomplete_expired',
    ]),
    currentPeriodStart: z.string().check(isoDateTime()),
    currentPeriodEnd: z.string().check(isoDateTime()),
    cancelAtPeriodEnd: z.boolean(),
    plan: z
      .object({
        name: z.string(),
        creditsPerMonth: z.number().check(integerCheck()).nonnegative().check(safeNumberCheck()),
        price: z.number().check(integerCheck()).nonnegative().check(safeNumberCheck()),
        currency: z.string().regex(/^[a-z]{3}$/),
      })
      .strict(),
    createdAt: z.string().check(isoDateTime()),
    updatedAt: z.string().check(isoDateTime()),
  })
  .strict();
export const creditSubscriptionsResponseSchema = z
  .object({ subscriptions: z.array(creditSubscriptionSchema) })
  .strict();
export const namedCreditCancellationResponseSchema = z
  .object({ subscription: creditSubscriptionSchema })
  .strict();
