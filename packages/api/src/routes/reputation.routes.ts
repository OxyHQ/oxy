import express from 'express';
import {
  awardReputationSchema,
  reputationBalanceSchema,
  reputationBalanceSummarySchema,
  reputationInfluenceResultSchema,
  reputationLeaderboardEntrySchema,
  reputationRuleSchema,
  reputationTransactionSchema,
  type ReputationBalance,
  type ReputationBalanceSummary,
  type ReputationInfluenceContext,
  type ReputationInfluenceResult,
  type ReputationLeaderboardEntry,
  type ReputationRule,
  type ReputationTransaction,
} from '@oxy.so/contracts';

import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import type { AuthenticatedRequest } from '../middleware/authUtils';
import { optionalAuthMiddleware } from '../middleware/optionalAuth';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler, sendSuccess, sendPaginated } from '../utils/asyncHandler';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import { resolveUserIdToObjectId, validatePagination } from '../utils/validation';
import { userIdentityFields } from '../utils/userTransform';
import reputationService, { readMetadata } from '../services/reputation.service';
import { REPUTATION_RULES_VERSION, type ReputationRuleDefinition } from '../services/reputationRules';
import {
  DEFAULT_TRANSACTION_LIMIT,
  MAX_TRANSACTION_LIMIT,
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  LEASE_SIGNED_ACTION,
  LEASE_COMPLETED_ACTION,
  CLEAN_MOVEOUT_ACTION,
  LEASE_DEFAULT_ACTION,
} from '../utils/reputation.constants';
import {
  reputationUserIdParams,
  reputationPaginationQuery,
  reputationInfluenceQuery,
} from '../schemas/reputation.schemas';

const router = express.Router();

const WINDOW_15_MIN = 15 * 60 * 1000;
const WINDOW_1_MIN = 60 * 1000;
const REQUIRED_AWARD_SCOPE = 'reputation:write';
const LEASE_AWARD_SCOPE = 'reputation:lease:write';
const LEASE_ACTION_TYPES = new Set([
  LEASE_SIGNED_ACTION,
  LEASE_COMPLETED_ACTION,
  CLEAN_MOVEOUT_ACTION,
  LEASE_DEFAULT_ACTION,
]);

/** Read limiter for public/auth read endpoints. */
const readLimiter = rateLimit({
  prefix: 'rl:reputation:read:',
  windowMs: WINDOW_15_MIN,
  max: 300,
});

/** Award limiter — service tokens award reputation. */
const awardLimiter = rateLimit({
  prefix: 'rl:reputation:award:',
  windowMs: WINDOW_1_MIN,
  max: 120,
});

/**
 * `reputation:write` awards any action in code; `reputation:lease:write` only
 * the Homiio lease actions, and only with a `sourceActionId`.
 */
function authorizeServiceAward(
  req: ServiceAuthRequest,
  actionType: string,
  sourceActionId: string | undefined
): void {
  const scopes = req.serviceApp?.scopes ?? [];
  if (scopes.includes(REQUIRED_AWARD_SCOPE)) {
    return;
  }
  if (!scopes.includes(LEASE_AWARD_SCOPE)) {
    throw new ForbiddenError(
      `Missing required scope: ${REQUIRED_AWARD_SCOPE} or ${LEASE_AWARD_SCOPE}`
    );
  }
  if (!LEASE_ACTION_TYPES.has(actionType)) {
    throw new ForbiddenError(`${LEASE_AWARD_SCOPE} cannot award this action type`);
  }
  if (!sourceActionId) {
    throw new ForbiddenError(`${LEASE_AWARD_SCOPE} requires sourceActionId`);
  }
}

/*
 * SERIALIZERS
 *
 * Every one of these returns a type owned by `@oxy.so/contracts` and hands the
 * DTO to that type's schema before it leaves the process. Two guards, and they
 * catch different things:
 *
 *  - The `const dto: <ContractType>` annotation is the COMPILE-TIME guard.
 *    Dropping a field the contract requires, adding one it does not declare
 *    (excess-property checking on the literal), or leaving a `Date` where the
 *    wire promises an ISO string all fail `tsc` and name the field. This is the
 *    structural link that was missing when `GET /:userId/balance` was
 *    view-split without the SDK type moving with it: the serializers returned
 *    `Record<string, unknown>` and imported no reputation type from anywhere,
 *    so nothing but human attention connected the two.
 *  - The `schema.parse(dto)` call is the RUNTIME guard, for what the compiler
 *    cannot see: a mongoose path typed as required that is actually absent on
 *    an old document, and any key the type system was told about but the
 *    document contradicts.
 *
 * Mongoose ids and dates are converted HERE, at the boundary — the contract
 * types every id as a string and every timestamp as an ISO 8601 string.
 * `Date.prototype.toJSON` already produced exactly `toISOString()`, so the
 * bytes on the wire are unchanged.
 */

/** Shape a transaction for the HTTP response. */
function serializeTransaction(
  txn: Awaited<ReturnType<typeof reputationService.listTransactions>>['items'][number]
): ReputationTransaction {
  // A nullable column reads as `null`; the contract spells an absent field
  // `undefined`. `?? undefined` at the boundary keeps `exactOptionalPropertyTypes`
  // honest and stops a `null` reaching a client that types the field optional.
  const dto: ReputationTransaction = {
    id: txn.id,
    userId: txn.userId,
    points: txn.points,
    actionType: txn.actionType,
    category: txn.category,
    applicationId: txn.applicationId ?? undefined,
    credentialId: txn.credentialId ?? undefined,
    sourceActionId: txn.sourceActionId ?? undefined,
    sourceActionType: txn.sourceActionType ?? undefined,
    targetEntityId: txn.targetEntityId ?? undefined,
    targetEntityType: txn.targetEntityType ?? undefined,
    status: txn.status,
    reversedTransactionId: txn.reversedTransactionId ?? undefined,
    reason: txn.reason ?? undefined,
    metadata: readMetadata(txn.metadata),
    createdByUserId: txn.createdByUserId ?? undefined,
    reviewedByUserId: txn.reviewedByUserId ?? undefined,
    reviewedAt: txn.reviewedAt?.toISOString(),
    createdAt: txn.createdAt.toISOString(),
    updatedAt: txn.updatedAt.toISOString(),
  };
  return reputationTransactionSchema.parse(dto);
}

/**
 * Shape a balance for its SUBJECT.
 *
 * Carries the platform's internal judgements about the person — the
 * `reliability` scoring, the `influence` weights that drive ranking and
 * moderation, and the positive/negative/per-category decomposition of the
 * total. None of that is public; third parties get {@link serializePublicBalance}.
 */
function serializeBalance(
  balance: Awaited<ReturnType<typeof reputationService.getBalance>>
): ReputationBalance {
  const dto: ReputationBalance = {
    userId: balance.userId,
    total: balance.total,
    positive: balance.positive,
    negative: balance.negative,
    breakdown: {
      content: balance.breakdown.content,
      social: balance.breakdown.social,
      trust: balance.breakdown.trust,
      moderation: balance.breakdown.moderation,
      physical: balance.breakdown.physical,
      penalties: balance.breakdown.penalties,
    },
    trustTier: balance.trustTier,
    influence: {
      defaultWeight: balance.influence.defaultWeight,
      reportWeight: balance.influence.reportWeight,
      moderationWeight: balance.influence.moderationWeight,
      rankingFeedbackWeight: balance.influence.rankingFeedbackWeight,
    },
    reliability: {
      accurateReports: balance.reliability.accurateReports,
      rejectedReports: balance.reliability.rejectedReports,
      reportAccuracyScore: balance.reliability.reportAccuracyScore,
      abuseScore: balance.reliability.abuseScore,
    },
    recalculatedAt: balance.recalculatedAt.toISOString(),
    updatedAt: balance.updatedAt.toISOString(),
  };
  return reputationBalanceSchema.parse(dto);
}

/**
 * Shape a balance for a caller who is not its subject — including
 * an anonymous one.
 *
 * Deliberately limited to the fields the already-public `GET
 * /reputation/leaderboard` publishes per user (`total` + `trustTier`), so an
 * untokened read of `/:userId/balance` exposes no class of signal that is not
 * public already. Everything else is withheld:
 *  - `reliability` — `abuseScore`, `reportAccuracyScore` and the confirmed /
 *    rejected report counts are the platform's internal abuse verdict on the
 *    person. `abuseScore >= ABUSE_RESTRICT_THRESHOLD` is a sanction.
 *  - `influence` — the moderation / report / ranking weights. Publishing them
 *    hands a manipulator a live readout of what their account is worth and how
 *    much any countermeasure has cost them.
 *  - `positive` / `negative` / `breakdown` — split the total into points earned
 *    versus penalties accrued, exposing sanction history the total alone hides.
 *  - `recalculatedAt` / `updatedAt` — a timing oracle for when the subject last
 *    had a reputation event.
 *
 * `trustTier` stays public because it is the contribution ladder this system
 * exists to publish, and the leaderboard already emits it. Note it doubles as
 * the punitive `restricted` marker, so a sanctioned account remains
 * publicly identifiable as such by tier.
 *
 * Adding a private field back here does not merely leak it: it fails to
 * compile, because `ReputationBalanceSummary` does not declare it.
 */
function serializePublicBalance(
  balance: Awaited<ReturnType<typeof reputationService.getBalance>>
): ReputationBalanceSummary {
  const dto: ReputationBalanceSummary = {
    userId: balance.userId,
    total: balance.total,
    trustTier: balance.trustTier,
  };
  return reputationBalanceSummarySchema.parse(dto);
}

/** Shape a rule for the HTTP response. */
function serializeRule(rule: ReputationRuleDefinition): ReputationRule {
  const dto: ReputationRule = {
    actionType: rule.actionType,
    points: rule.points,
    category: rule.category,
    description: rule.description,
    cooldownInMinutes: rule.cooldownInMinutes,
  };
  return reputationRuleSchema.parse(dto);
}

/**
 * Shape one leaderboard row.
 *
 * The leaderboard aggregate projects the subject user inline (see
 * `reputationService.getLeaderboard`), so `balance.userId` is a small user
 * projection here rather than an id. Its `name` goes through the same
 * `formatUserNameResponse` composition every other user DTO uses, so
 * `name.displayName` means the same thing on this surface as everywhere else.
 */
function serializeLeaderboardEntry(
  balance: Awaited<ReturnType<typeof reputationService.getLeaderboard>>['items'][number],
  rank: number
): ReputationLeaderboardEntry {
  // `userIdentityFields` is the SOLE definition of `id`/`name`/`username`/
  // `avatar` for every user DTO and reads the flat `name_first`/`name_last`
  // columns directly, so this surface cannot drift from the rest on
  // `name.displayName` — the field every ecosystem app reads.
  const identity = userIdentityFields(balance.user);
  const dto: ReputationLeaderboardEntry = {
    user: {
      id: balance.user.id,
      username: identity.username ?? '',
      name: identity.name,
      avatar: identity.avatar,
      publicKey: balance.user.publicKey ?? undefined,
    },
    total: balance.total,
    trustTier: balance.trustTier,
    rank,
  };
  return reputationLeaderboardEntrySchema.parse(dto);
}

/** Shape the influence read for the HTTP response. */
function serializeInfluenceResult(
  result: Awaited<ReturnType<typeof reputationService.getInfluence>>
): ReputationInfluenceResult {
  const dto: ReputationInfluenceResult = {
    context: result.context,
    weight: result.weight,
    influence: {
      defaultWeight: result.influence.defaultWeight,
      reportWeight: result.influence.reportWeight,
      moderationWeight: result.influence.moderationWeight,
      rankingFeedbackWeight: result.influence.rankingFeedbackWeight,
    },
  };
  return reputationInfluenceResultSchema.parse(dto);
}

// =============================================================================
// PUBLIC ROUTES (no auth)
// =============================================================================

/** GET /reputation/leaderboard — top users by lifetime total. */
router.get(
  '/leaderboard',
  readLimiter,
  validate({ query: reputationPaginationQuery }),
  asyncHandler(async (req, res) => {
    const { limit, offset } = validatePagination(
      req.query.limit,
      req.query.offset,
      MAX_LEADERBOARD_LIMIT,
      DEFAULT_LEADERBOARD_LIMIT
    );
    const { items, total } = await reputationService.getLeaderboard(limit, offset);
    const formatted = items.map((balance, index) =>
      serializeLeaderboardEntry(balance, offset + index + 1)
    );
    sendPaginated(res, formatted, total, limit, offset);
  })
);

/** GET /reputation/rules — the rules in code, with their version. */
router.get(
  '/rules',
  readLimiter,
  asyncHandler(async (_req, res) => {
    const rules = reputationService.listRules();
    sendSuccess(res, { version: REPUTATION_RULES_VERSION, rules: rules.map(serializeRule) });
  })
);

/**
 * GET /reputation/:userId/balance — derived totals + tier.
 *
 * Readable without a token so the public trust signal stays public, but the
 * RESPONSE IS VIEW-SPLIT: the subject themselves gets the
 * full balance, everyone else gets {@link serializePublicBalance}. Auth is
 * therefore optional rather than required — an invalid or absent token simply
 * resolves to the public view instead of rejecting the request.
 */
router.get(
  '/:userId/balance',
  readLimiter,
  validate({ params: reputationUserIdParams }),
  optionalAuthMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userObjectId = await resolveUserIdToObjectId(req.params.userId);
    const balance = await reputationService.getBalance(userObjectId);
    const callerId = req.user?._id?.toString();
    sendSuccess(
      res,
      callerId === userObjectId ? serializeBalance(balance) : serializePublicBalance(balance)
    );
  })
);

// =============================================================================
// AWARD (service token)
// =============================================================================

/**
 * POST /reputation/award.
 *
 * Only a source app awards reputation: a service token with the privileged
 * `reputation:write` scope reports an action, and the points come from the
 * rule in code (`services/reputationRules.ts`). No person — user or Oxy staff —
 * can award, reverse or edit anyone's reputation by hand. The `applicationId` /
 * `credentialId` are the token's; client-supplied values are ignored.
 */
router.post(
  '/award',
  awardLimiter,
  serviceAuthMiddleware,
  validate({ body: awardReputationSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const serviceApp = req.serviceApp;
    if (!serviceApp) {
      throw new ForbiddenError('Awarding reputation requires a service token');
    }
    authorizeServiceAward(req, req.body.actionType, req.body.sourceActionId);
    // The source app identity is the token's, never the client body's.
    const applicationId = serviceApp.appId;
    const credentialId = serviceApp.credentialId;

    const subjectObjectId = await resolveUserIdToObjectId(req.body.userId);

    const txn = await reputationService.award({
      userId: subjectObjectId,
      actionType: req.body.actionType,
      applicationId,
      credentialId,
      sourceActionId: req.body.sourceActionId,
      sourceActionType: req.body.sourceActionType,
      targetEntityId: req.body.targetEntityId,
      targetEntityType: req.body.targetEntityType,
      reason: req.body.reason,
      metadata: req.body.metadata,
    });

    sendSuccess(res, { transaction: serializeTransaction(txn) }, 201);
  })
);

// =============================================================================
// AUTHENTICATED USER ROUTES
// =============================================================================

router.use(authMiddleware);

/** Resolve the authenticated user id, or throw 401. */
function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }
  return userId;
}

/**
 * GET /reputation/:userId/transactions — paginated ledger (own only).
 *
 * A transaction's `metadata` names the THIRD PARTIES behind the award — the
 * attestor who physically met the subject, the voucher who staked on them, the
 * jury that validated them — so the ledger is readable only by its own
 * subject, never by another caller (Oxy staff included).
 */
router.get(
  '/:userId/transactions',
  readLimiter,
  validate({ params: reputationUserIdParams, query: reputationPaginationQuery }),
  asyncHandler(async (req: AuthRequest, res) => {
    const callerId = requireUserId(req);
    const userObjectId = await resolveUserIdToObjectId(req.params.userId);
    if (userObjectId !== callerId) {
      throw new ForbiddenError('You can only view your own transactions');
    }
    const { limit, offset } = validatePagination(
      req.query.limit,
      req.query.offset,
      MAX_TRANSACTION_LIMIT,
      DEFAULT_TRANSACTION_LIMIT
    );
    const { items, total } = await reputationService.listTransactions(
      userObjectId,
      limit,
      offset
    );
    sendPaginated(res, items.map(serializeTransaction), total, limit, offset);
  })
);

/**
 * GET /reputation/:userId/influence — capped weight(s) (own only).
 *
 * Influence weights are internal moderation/ranking signals — same class of
 * sensitive data as the `influence` block on the full balance view.
 */
router.get(
  '/:userId/influence',
  readLimiter,
  validate({ params: reputationUserIdParams, query: reputationInfluenceQuery }),
  asyncHandler(async (req: AuthRequest, res) => {
    const callerId = requireUserId(req);
    const userObjectId = await resolveUserIdToObjectId(req.params.userId);
    if (userObjectId !== callerId) {
      throw new ForbiddenError('You can only view your own influence');
    }
    const context = (req.query.context as ReputationInfluenceContext | undefined) ?? 'default';
    const result = await reputationService.getInfluence(userObjectId, context);
    sendSuccess(res, serializeInfluenceResult(result));
  })
);

export default router;
