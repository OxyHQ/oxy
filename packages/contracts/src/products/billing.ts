import { z } from 'zod';
import { oxyAccountIdSchema } from '../inference/identifiers';
const id = z.string().min(1).max(160);
const name = z.string().min(1).max(100);
const count = z.number().int().nonnegative().safe();
const period = z.object({ start: z.string().datetime(), end: z.string().datetime() }).strict()
  .refine(value => Date.parse(value.end) > Date.parse(value.start), 'Period end must follow start');
/** Self-service provenance; no payer/provider identifiers or balances in access metadata. */
export const productSubscriptionSummarySchema = z.object({ sourceId: id,
  status: z.enum(['active','trialing','past_due','unpaid','canceled','paused','incomplete','incomplete_expired']),
  period, cancelAtPeriodEnd: z.boolean(), canCancel: z.boolean(),
  offers: z.array(z.object({ segmentId: id, offerId: id, offerVersion: z.number().int().positive().safe(),
    displayName: name, origin: z.enum(['individual','bundle']), period, current: z.boolean(),
    products: z.array(z.object({ id, displayName: name }).strict()),
  }).strict()),
}).strict();
export const productSubscriptionsResponseSchema = z.object({ subscriptions: z.array(productSubscriptionSummarySchema) }).strict();
export const subscriptionCreditGrantSchema = z.object({ id, invoiceId: id,
  origin: z.enum(['subscription_payment','subscription_proration','subscription_promotional_grant']),
  period, granted: count, consumed: count, clawed: count, remaining: count,
  promotionId: id.nullable(), createdAt: z.string().datetime(),
}).strict().refine(value => BigInt(value.consumed) + BigInt(value.clawed) + BigInt(value.remaining) === BigInt(value.granted), 'Grant conservation differs');
export const subscriptionCreditGrantsResponseSchema = z.object({ grants: z.array(subscriptionCreditGrantSchema) }).strict();
export const cancelProductSubscriptionSchema = z.object({ sourceId: id, expectedSubjectAccountId: oxyAccountIdSchema.optional() }).strict();
export type ProductSubscriptionSummary = z.infer<typeof productSubscriptionSummarySchema>;
export type SubscriptionCreditGrant = z.infer<typeof subscriptionCreditGrantSchema>;
