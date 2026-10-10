import { z } from 'zod';
import { productSubscriptionCancellationResultSchema } from '@oxy.so/contracts';

// POST /billing/checkout/credits
export const checkoutCreditsSchema = z.object({
  packageId: z.string().trim().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

// POST /billing/checkout/subscription
export const checkoutSubscriptionSchema = z.object({
  planId: z.string().trim().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

// POST /billing/portal
export const portalSchema = z.object({
  returnUrl: z.string().url(),
});

// GET /billing/transactions
export const transactionsQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

/** These selectors name the mirror row, never an arbitrary provider subscription. */
export const cancelCreditSubscriptionSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    expectedSubjectAccountId: z.string().min(1).max(160).optional(),
  })
  .strict();
export const namedProductCancellationResponseSchema =
  productSubscriptionCancellationResultSchema.options[0];
export const pendingProductCancellationResponseSchema =
  productSubscriptionCancellationResultSchema.options[1];
const creditSubscriptionSchema = z
  .object({
    _id: z.string().uuid(),
    userId: z.string().min(1),
    stripeCustomerId: z.string().min(1),
    stripeSubscriptionId: z.string().min(1),
    stripePriceId: z.string().min(1),
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
    currentPeriodStart: z.string().datetime(),
    currentPeriodEnd: z.string().datetime(),
    cancelAtPeriodEnd: z.boolean(),
    plan: z
      .object({
        name: z.string(),
        creditsPerMonth: z.number().int().nonnegative().safe(),
        price: z.number().int().nonnegative().safe(),
        currency: z.string().regex(/^[a-z]{3}$/),
      })
      .strict(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const creditSubscriptionsResponseSchema = z
  .object({ subscriptions: z.array(creditSubscriptionSchema) })
  .strict();
export const namedCreditCancellationResponseSchema = z
  .object({ subscription: creditSubscriptionSchema })
  .strict();
