/**
 * The reputation view guard, without Zod. Schemas: `../reputation.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  ReputationBalance,
  ReputationBalanceSummary,
  ReputationBalanceView,
} from '../reputation';

/**
 * The fields the full {@link ReputationBalance} carries beyond the public
 * {@link ReputationBalanceSummary} that the API sends ALL-OR-NOTHING. The
 * runtime discriminant between the two views.
 *
 * The V2 blocks (`conduct`, `contribution`, …) are deliberately NOT listed:
 * they are optional on the wire, so requiring them here would make a balance
 * from a server that predates them fail to narrow, hiding the whole private
 * view. Read a V2 block by checking that block.
 */
export const FULL_BALANCE_FIELDS = [
  'positive',
  'negative',
  'breakdown',
  'influence',
  'reliability',
  'recalculatedAt',
  'updatedAt',
] as const satisfies readonly (keyof Omit<ReputationBalance, keyof ReputationBalanceSummary>)[];

/**
 * Whether a balance came back as the SUBJECT view, and so carries the
 * breakdown / influence / reliability blocks.
 *
 * Checks every extra field rather than one representative: the point of the
 * guard is that the caller then dereferences those blocks, so a partial payload
 * must not narrow.
 *
 * @param balance - A balance from `getReputationBalance`.
 */
export function isFullReputationBalance(
  balance: ReputationBalanceView,
): balance is ReputationBalance {
  return FULL_BALANCE_FIELDS.every((field) => field in balance);
}
