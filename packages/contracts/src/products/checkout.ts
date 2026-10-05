import { z } from 'zod';
import { oxyAccountIdSchema } from '../inference/identifiers';
export const personalPlanCheckoutRequestSchema = z.object({
  expectedSubjectAccountId: oxyAccountIdSchema,
  offerId: z.string().min(1).max(160), offerVersion: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(8).max(160).regex(/^[a-zA-Z0-9_-]+$/),
}).strict();
/** No grant or subscription is created by checkout completion in the browser. */
export const personalPlanCheckoutResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unconfigured'), reason: z.enum(['provider_unconfigured', 'offer_unconfigured', 'price_unconfigured']) }).strict(),
  z.object({ state: z.literal('pending'), intentId: z.string().min(1).max(160), checkoutUrl: z.string().url().startsWith('https://') }).strict(),
  z.object({ state: z.literal('closed'), intentId: z.string().min(1).max(160) }).strict(),
  z.object({ state: z.literal('fulfilled'), intentId: z.string().min(1).max(160) }).strict(),
]);
export type PersonalPlanCheckoutRequest = z.infer<typeof personalPlanCheckoutRequestSchema>;
export type PersonalPlanCheckoutResult = z.infer<typeof personalPlanCheckoutResultSchema>;
