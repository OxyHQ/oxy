/** Approved P2: declarations are versioned code; the initial registry is empty. */
import { z } from 'zod';
import { ConflictError } from '../utils/error';
const id = z.string().min(1).max(160);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const declarationSchema = z.object({ id, planId: id, kind: z.enum(['trial','coupon']),
  couponId: id.nullable(), credits: count, oncePerAccount: z.boolean() }).strict()
  .refine(v => v.kind === 'coupon' ? v.couponId !== null : v.couponId === null, 'Promotion evidence differs');
export type FreePeriodPromotion = z.infer<typeof declarationSchema>;
/** Trial 2k and FOUNDERS100 in the proposal are examples, never live offers. */
export const FREE_PERIOD_PROMOTIONS: readonly FreePeriodPromotion[] = Object.freeze([]);
export function resolveFreePeriodPromotion(input: { planId: string; amountPaid: number; trialCoversPeriod: boolean; couponIds: string[] },
  declarations: readonly FreePeriodPromotion[] = FREE_PERIOD_PROMOTIONS): FreePeriodPromotion | null {
  if (input.amountPaid !== 0) throw new ConflictError('Promotion requires a zero-amount paid invoice');
  id.parse(input.planId); for (const value of input.couponIds) id.parse(value);
  const registry = declarations.map(value => declarationSchema.parse(value));
  if (new Set(registry.map(value => value.id)).size !== registry.length) throw new ConflictError('Duplicate promotion declaration');
  const matches = registry.filter(value => value.planId === input.planId
    && (value.kind === 'trial' ? input.trialCoversPeriod : value.couponId !== null && input.couponIds.includes(value.couponId)));
  if (matches.length > 1) throw new ConflictError('Ambiguous zero-amount promotion');
  return matches[0] ?? null;
}
