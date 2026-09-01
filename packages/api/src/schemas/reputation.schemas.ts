/**
 * `/reputation` route-plumbing schemas.
 *
 * Only the params/query shapes that have no client-side counterpart live here.
 * Every REQUEST BODY the reputation endpoints accept — `awardReputationSchema`,
 * `createReputationDisputeSchema`, `resolveReputationDisputeSchema`,
 * `upsertReputationRuleSchema`, `reverseReputationTransactionSchema` — is owned
 * by `@oxyhq/contracts`, so the validation this server runs and the input types
 * `@oxyhq/core` exposes are one definition. Import those directly from
 * `@oxyhq/contracts`; do not re-declare them here.
 */
import { z } from 'zod';
import { reputationInfluenceContextSchema } from '@oxyhq/contracts';

/** Route params with :userId (ObjectId or publicKey accepted by the route). */
export const reputationUserIdParams = z.object({
  userId: z.string().trim().min(1),
});

/** Route params with :id (transaction id). */
export const reputationTransactionIdParams = z.object({
  id: z.string().trim().min(1),
});

/** Route params with :id (dispute id). */
export const reputationDisputeIdParams = z.object({
  id: z.string().trim().min(1),
});

/** Pagination query (?limit, ?offset). Coerced from string query values. */
export const reputationPaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** GET /reputation/:userId/influence — ?context= selects the weight axis. */
export const reputationInfluenceQuery = z.object({
  context: reputationInfluenceContextSchema.optional(),
});
