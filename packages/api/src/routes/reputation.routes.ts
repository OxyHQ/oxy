import express, { type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  awardReputationSchema,
  createReputationDisputeSchema,
  reputationBalanceSchema,
  reputationBalanceSummarySchema,
  reputationDisputeSchema,
  reputationInfluenceResultSchema,
  reputationLeaderboardEntrySchema,
  reputationRuleSchema,
  reputationTransactionSchema,
  resolveReputationDisputeSchema,
  reverseReputationTransactionSchema,
  upsertReputationRuleSchema,
  type ReputationBalance,
  type ReputationBalanceSummary,
  type ReputationDispute,
  type ReputationInfluenceContext,
  type ReputationInfluenceResult,
  type ReputationLeaderboardEntry,
  type ReputationRule,
  type ReputationTransaction,
} from '@oxyhq/contracts';

import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import type { AuthenticatedRequest } from '../middleware/authUtils';
import { optionalAuthMiddleware } from '../middleware/optionalAuth';
import { requireStaff } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler, sendSuccess, sendPaginated } from '../utils/asyncHandler';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import { resolveUserIdToObjectId, validatePagination } from '../utils/validation';
import { logger } from '../utils/logger';
import { userIdentityFields } from '../utils/userTransform';
import reputationService, { readMetadata } from '../services/reputation.service';
import {
  DEFAULT_TRANSACTION_LIMIT,
  MAX_TRANSACTION_LIMIT,
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  DEFAULT_DISPUTE_LIMIT,
  MAX_DISPUTE_LIMIT,
} from '../utils/reputation.constants';
import {
  reputationUserIdParams,
  reputationTransactionIdParams,
  reputationDisputeIdParams,
  reputationPaginationQuery,
  reputationInfluenceQuery,
} from '../schemas/reputation.schemas';

const router = express.Router();

const WINDOW_15_MIN = 15 * 60 * 1000;
const WINDOW_1_MIN = 60 * 1000;
const REQUIRED_AWARD_SCOPE = 'reputation:write';

/** Read limiter for public/auth read endpoints. */
const readLimiter = rateLimit({
  prefix: 'rl:reputation:read:',
  windowMs: WINDOW_15_MIN,
  max: 300,
});

/** Award limiter — service tokens / staff award reputation. */
const awardLimiter = rateLimit({
  prefix: 'rl:reputation:award:',
  windowMs: WINDOW_1_MIN,
  max: 120,
});

/** Mutating staff actions (reverse/void/recalculate/resolve/rules). */
const adminLimiter = rateLimit({
  prefix: 'rl:reputation:admin:',
  windowMs: WINDOW_15_MIN,
  max: 200,
});

/** Dispute creation limiter (per authenticated user). */
const disputeLimiter = rateLimit({
  prefix: 'rl:reputation:dispute:',
  windowMs: WINDOW_15_MIN,
  max: 30,
});

/**
 * A request that may carry EITHER an authenticated user (`req.user`) or a
 * service principal (`req.serviceApp`). Used by `/award`.
 */
interface UserOrServiceRequest extends AuthRequest, ServiceAuthRequest {}

/**
 * Accept either a user session token or a service token. Peeks at the verified
 * token's `type` claim and dispatches to the matching middleware. A `service`
 * token resolves `req.serviceApp`; anything else falls through to the regular
 * user `authMiddleware`.
 */
function requireReputationWriteScope(req: ServiceAuthRequest): void {
  const scopes = req.serviceApp?.scopes ?? [];
  if (!scopes.includes(REQUIRED_AWARD_SCOPE)) {
    throw new ForbiddenError(`Missing required scope: ${REQUIRED_AWARD_SCOPE}`);
  }
}

function authUserOrService(
  req: UserOrServiceRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    next(new UnauthorizedError('Invalid or missing authorization header'));
    return;
  }
  const token = authHeader.slice('Bearer '.length);
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) {
    logger.error('ACCESS_TOKEN_SECRET not configured');
    res.status(500).json({ error: 'Server configuration error', message: 'Server configuration error' });
    return;
  }
  let isServiceToken = false;
  try {
    const decoded = jwt.verify(token, secret) as { type?: string };
    isServiceToken = decoded.type === 'service';
  } catch {
    // Defer to the dispatched middleware to produce the precise 401 (expired vs
    // invalid). Treat an unverifiable token as a user token here.
    isServiceToken = false;
  }
  if (isServiceToken) {
    serviceAuthMiddleware(req, res, next);
    return;
  }
  authMiddleware(req, res, next);
}

/*
 * SERIALIZERS
 *
 * Every one of these returns a type owned by `@oxyhq/contracts` and hands the
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
 * Shape a balance for its SUBJECT (or platform staff).
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
 * Shape a balance for a caller who is NEITHER its subject nor staff — including
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

/** Shape a dispute for the HTTP response. */
function serializeDispute(
  dispute: Awaited<ReturnType<typeof reputationService.createDispute>>
): ReputationDispute {
  const dto: ReputationDispute = {
    id: dispute.id,
    transactionId: dispute.transactionId,
    userId: dispute.userId,
    reason: dispute.reason,
    status: dispute.status,
    evidence: dispute.evidence ?? undefined,
    resolvedAt: dispute.resolvedAt?.toISOString(),
    resolvedByUserId: dispute.resolvedByUserId ?? undefined,
    createdAt: dispute.createdAt.toISOString(),
    updatedAt: dispute.updatedAt.toISOString(),
  };
  return reputationDisputeSchema.parse(dto);
}

/** Shape a rule for the HTTP response. */
function serializeRule(
  rule: Awaited<ReturnType<typeof reputationService.upsertRule>>
): ReputationRule {
  const dto: ReputationRule = {
    id: rule.id,
    actionType: rule.actionType,
    points: rule.points,
    category: rule.category,
    description: rule.description,
    cooldownInMinutes: rule.cooldownInMinutes,
    isEnabled: rule.isEnabled,
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

/** GET /reputation/rules — enabled rules (for client display). */
router.get(
  '/rules',
  readLimiter,
  asyncHandler(async (_req, res) => {
    const rules = await reputationService.listEnabledRules();
    sendSuccess(res, { rules: rules.map(serializeRule) });
  })
);

/**
 * GET /reputation/:userId/balance — derived totals + tier.
 *
 * Readable without a token so the public trust signal stays public, but the
 * RESPONSE IS VIEW-SPLIT: the subject themselves and platform staff get the
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
    const isSubject = callerId === userObjectId;
    const isStaff = req.user?.isStaff === true;
    sendSuccess(
      res,
      isSubject || isStaff ? serializeBalance(balance) : serializePublicBalance(balance)
    );
  })
);

// =============================================================================
// STAFF-ONLY RULE WRITE (auth + staff)
// =============================================================================

/** POST /reputation/rules — upsert a rule (staff only). */
router.post(
  '/rules',
  adminLimiter,
  authMiddleware,
  requireStaff,
  validate({ body: upsertReputationRuleSchema }),
  asyncHandler(async (req, res) => {
    const rule = await reputationService.upsertRule(req.body);
    sendSuccess(res, { rule: serializeRule(rule) });
  })
);

// =============================================================================
// AWARD (service token OR staff)
// =============================================================================

/**
 * POST /reputation/award.
 *
 * Awarding is restricted to service tokens with the privileged
 * `reputation:write` scope (the canonical path — a source app reports an
 * action) and platform staff. Regular users may NOT award reputation
 * (no self-award). When called with a service token the `applicationId` /
 * `credentialId` are resolved from `req.serviceApp` and any client-supplied
 * values for those fields are ignored.
 */
router.post(
  '/award',
  awardLimiter,
  authUserOrService,
  validate({ body: awardReputationSchema }),
  asyncHandler(async (req: UserOrServiceRequest, res) => {
    const serviceApp = req.serviceApp;
    const user = req.user;

    let applicationId: string | undefined = req.body.applicationId;
    let credentialId: string | undefined = req.body.credentialId;
    let createdByUserId: string | undefined;

    if (serviceApp) {
      requireReputationWriteScope(req);

      // Canonical service path — source app identity is the token's, not the
      // client body's.
      applicationId = serviceApp.appId;
      credentialId = serviceApp.credentialId;
    } else if (user?.isStaff === true) {
      createdByUserId = user._id?.toString();
    } else {
      throw new ForbiddenError('Awarding reputation requires a service token or staff privileges');
    }

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
      createdByUserId,
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
 * GET /reputation/:userId/transactions — paginated ledger (own or staff).
 *
 * A transaction's `metadata` names the THIRD PARTIES behind the award — the
 * attestor who physically met the subject, the voucher who staked on them, the
 * jury that validated them — so the ledger is readable only by its own subject
 * and platform staff, never by an arbitrary authenticated caller.
 */
router.get(
  '/:userId/transactions',
  readLimiter,
  validate({ params: reputationUserIdParams, query: reputationPaginationQuery }),
  asyncHandler(async (req: AuthRequest, res) => {
    const callerId = requireUserId(req);
    const userObjectId = await resolveUserIdToObjectId(req.params.userId);
    if (userObjectId !== callerId && req.user?.isStaff !== true) {
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
 * GET /reputation/:userId/influence — capped weight(s) (own or staff).
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
    if (userObjectId !== callerId && req.user?.isStaff !== true) {
      throw new ForbiddenError('You can only view your own influence');
    }
    const context = (req.query.context as ReputationInfluenceContext | undefined) ?? 'default';
    const result = await reputationService.getInfluence(userObjectId, context);
    sendSuccess(res, serializeInfluenceResult(result));
  })
);

/** GET /reputation/:userId/disputes — a user's own disputes (auth). */
router.get(
  '/:userId/disputes',
  readLimiter,
  validate({ params: reputationUserIdParams, query: reputationPaginationQuery }),
  asyncHandler(async (req: AuthRequest, res) => {
    const callerId = requireUserId(req);
    const userObjectId = await resolveUserIdToObjectId(req.params.userId);
    if (userObjectId !== callerId && req.user?.isStaff !== true) {
      throw new ForbiddenError('You can only view your own disputes');
    }
    const { limit, offset } = validatePagination(
      req.query.limit,
      req.query.offset,
      MAX_DISPUTE_LIMIT,
      DEFAULT_DISPUTE_LIMIT
    );
    const { items, total } = await reputationService.listDisputesForUser(
      userObjectId,
      limit,
      offset
    );
    sendPaginated(res, items.map(serializeDispute), total, limit, offset);
  })
);

/** POST /reputation/disputes — open a dispute (auth; disputer = req.user). */
router.post(
  '/disputes',
  disputeLimiter,
  validate({ body: createReputationDisputeSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const callerId = requireUserId(req);
    const dispute = await reputationService.createDispute(
      req.body.transactionId,
      callerId,
      req.body.reason,
      req.body.evidence
    );
    sendSuccess(res, { dispute: serializeDispute(dispute) }, 201);
  })
);

/** GET /reputation/disputes — open dispute queue (staff). */
router.get(
  '/disputes',
  readLimiter,
  requireStaff,
  validate({ query: reputationPaginationQuery }),
  asyncHandler(async (req, res) => {
    const { limit, offset } = validatePagination(
      req.query.limit,
      req.query.offset,
      MAX_DISPUTE_LIMIT,
      DEFAULT_DISPUTE_LIMIT
    );
    const { items, total } = await reputationService.listOpenDisputes(limit, offset);
    sendPaginated(res, items.map(serializeDispute), total, limit, offset);
  })
);

// =============================================================================
// STAFF-ONLY MUTATIONS
// =============================================================================

/** POST /reputation/transactions/:id/reverse — reverse a transaction (staff). */
router.post(
  '/transactions/:id/reverse',
  adminLimiter,
  requireStaff,
  validate({ params: reputationTransactionIdParams, body: reverseReputationTransactionSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const reviewedByUserId = requireUserId(req);
    const result = await reputationService.reverseTransaction(req.params.id, {
      reviewedByUserId,
      reason: req.body.reason,
    });
    sendSuccess(res, {
      original: serializeTransaction(result.original),
      reversal: serializeTransaction(result.reversal),
    });
  })
);

/** POST /reputation/transactions/:id/void — void a transaction (staff). */
router.post(
  '/transactions/:id/void',
  adminLimiter,
  requireStaff,
  validate({ params: reputationTransactionIdParams, body: reverseReputationTransactionSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const reviewedByUserId = requireUserId(req);
    const txn = await reputationService.voidTransaction(req.params.id, {
      reviewedByUserId,
      reason: req.body.reason,
    });
    sendSuccess(res, { transaction: serializeTransaction(txn) });
  })
);

/** POST /reputation/:userId/recalculate — force a balance recompute (staff). */
router.post(
  '/:userId/recalculate',
  adminLimiter,
  requireStaff,
  validate({ params: reputationUserIdParams }),
  asyncHandler(async (req, res) => {
    const userObjectId = await resolveUserIdToObjectId(req.params.userId);
    const balance = await reputationService.recalculateBalance(userObjectId);
    sendSuccess(res, serializeBalance(balance));
  })
);

/** POST /reputation/disputes/:id/resolve — resolve a dispute (staff). */
router.post(
  '/disputes/:id/resolve',
  adminLimiter,
  requireStaff,
  validate({ params: reputationDisputeIdParams, body: resolveReputationDisputeSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const resolvedByUserId = requireUserId(req);
    const dispute = await reputationService.resolveDispute(req.params.id, {
      status: req.body.status,
      resolvedByUserId,
    });
    sendSuccess(res, { dispute: serializeDispute(dispute) });
  })
);

export default router;
