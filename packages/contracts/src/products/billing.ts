import { integerCheck, safeNumberCheck } from '../numberChecks';
import { isoDateTime, utf16MaxLength, utf16MinLength } from '../stringChecks';
import { z } from 'zod';
import { oxyAccountIdSchema } from '../inference/identifiers';
const id = z.string().check(utf16MinLength(1)).check(utf16MaxLength(160));
const name = z.string().check(utf16MinLength(1)).check(utf16MaxLength(100));
const count = z.number().check(integerCheck()).nonnegative().check(safeNumberCheck());
const period = z
  .object({ start: z.string().check(isoDateTime()), end: z.string().check(isoDateTime()) })
  .strict()
  .refine(
    (value) => Date.parse(value.end) > Date.parse(value.start),
    'Period end must follow start',
  );
/** Self-service provenance; no payer/provider identifiers or balances in access metadata. */
export const productSubscriptionSummarySchema = z
  .object({
    sourceId: id,
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
    period,
    cancelAtPeriodEnd: z.boolean(),
    canCancel: z.boolean(),
    canRenew: z.boolean().optional(),
    offers: z.array(
      z
        .object({
          segmentId: id,
          offerId: id,
          offerVersion: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
          displayName: name,
          origin: z.enum(['individual', 'bundle']),
          period,
          current: z.boolean(),
          products: z.array(z.object({ id, displayName: name }).strict()),
        })
        .strict(),
    ),
  })
  .strict();
export const productSubscriptionsResponseSchema = z
  .object({ subscriptions: z.array(productSubscriptionSummarySchema) })
  .strict();
export const subscriptionCreditGrantSchema = z
  .object({
    id,
    invoiceId: id,
    origin: z.enum([
      'subscription_payment',
      'subscription_proration',
      'subscription_promotional_grant',
    ]),
    period,
    granted: count,
    consumed: count,
    clawed: count,
    remaining: count,
    promotionId: id.nullable(),
    createdAt: z.string().check(isoDateTime()),
  })
  .strict()
  .refine(
    (value) =>
      BigInt(value.consumed) + BigInt(value.clawed) + BigInt(value.remaining) ===
      BigInt(value.granted),
    'Grant conservation differs',
  );
export const subscriptionCreditGrantsResponseSchema = z
  .object({ grants: z.array(subscriptionCreditGrantSchema) })
  .strict();
export const cancelProductSubscriptionSchema = z
  .object({
    sourceId: id,
    actionId: z
      .string()
      .check(utf16MinLength(8))
      .check(utf16MaxLength(160))
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    expectedSubjectAccountId: oxyAccountIdSchema.optional(),
  })
  .strict();
export type ProductSubscriptionSummary = z.infer<typeof productSubscriptionSummarySchema>;
export type SubscriptionCreditGrant = z.infer<typeof subscriptionCreditGrantSchema>;

/** Remote acceptance is distinct from completed local reconciliation. */
export const productSubscriptionCancellationResultSchema = z.union([
  z.object({ sourceId: id, cancelAtPeriodEnd: z.literal(true) }).strict(),
  z.object({ sourceId: id, reconciliationPending: z.literal(true) }).strict(),
]);
export type ProductSubscriptionCancellationResult = z.infer<
  typeof productSubscriptionCancellationResultSchema
>;

export type ProductSubscriptionsResponse = z.infer<typeof productSubscriptionsResponseSchema>;
export type SubscriptionCreditGrantsResponse = z.infer<
  typeof subscriptionCreditGrantsResponseSchema
>;
export type CancelProductSubscription = z.infer<typeof cancelProductSubscriptionSchema>;
