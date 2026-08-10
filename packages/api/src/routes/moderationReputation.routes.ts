/**
 * `/reputation/moderation` — the HTTP surface of the reputation bridge.
 *
 * FOUR SEPARATE AUTHORITIES, and keeping them separate is the security model:
 *
 *  - `reputation:moderation:apply` (service credential) submits decisions and
 *    reversals. It is NOT `reputation:write`: that broad scope can mint arbitrary
 *    points for arbitrary users, every official application already holds it, and
 *    granting it here would hand the moderation bridge ledger-write authority it
 *    has no use for. This scope can only submit a DECISION; the engine derives
 *    the figures.
 *  - `reputation:binding:register` (service credential) registers identity
 *    bindings, and only with the SUBJECT'S OWN access token as proof.
 *  - Platform staff run reconciliation and read an incident's effects.
 *  - The SUBJECT reads their own conduct standing and the explanations behind it.
 *
 * WHAT THIS ROUTER NEVER EXPOSES
 *
 * There is no endpoint that accepts points, risk, standing or duration. Not
 * because it would be unauthorized, but because the shape does not exist: the
 * request schema has no such field, so a caller cannot express "penalise this
 * person by N". That is what makes the direction one-way rather than merely
 * policed.
 *
 * `applicationId` for a binding registration comes from the CREDENTIAL. The
 * decision event names a `reportedApplicationId` in the body instead — see the
 * contract's own comment for why that is safe here and what the two independent
 * gates on it are.
 */

import express, { type Response } from 'express';
import {
  finalizeModerationDecisionSchema,
  moderationDecisionEventSchema,
  registerIdentityBindingSchema,
  reverseModerationEffectSchema,
  type ApplyModerationDecisionResult,
  type IdentityBinding as IdentityBindingDto,
  type ModerationEffect as ModerationEffectDto,
  type ReputationConduct,
  type ReverseModerationEffectResult,
  applyModerationDecisionResultSchema,
  identityBindingSchema,
  moderationEffectSchema,
  reputationConductSchema,
  reverseModerationEffectResultSchema,
} from '@oxyhq/contracts';

import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import { requireStaff } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import { resolveUserIdToObjectId } from '../utils/validation';
import type { IdentityBindingRecord } from '../services/identityBinding.service';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { moderationEffects } from '../db/schema/moderationEffects';
import type { ModerationEffectRow } from '../services/moderationReputation.service';
import moderationReputationService from '../services/moderationReputation.service';
import { registerIdentityBinding } from '../services/identityBinding.service';
import reputationService from '../services/reputation.service';

const router = express.Router();

const WINDOW_1_MIN = 60 * 1000;
const WINDOW_15_MIN = 15 * 60 * 1000;

/** The scope that may submit a decision for consequence derivation. */
const APPLY_SCOPE = 'reputation:moderation:apply';

/** The scope that may register an identity binding. */
const BINDING_SCOPE = 'reputation:binding:register';

/**
 * Effect submission limiter. Generous, because a legitimate emitter retries an
 * at-least-once delivery and every retry is idempotent — throttling a retry only
 * delays a consequence that was already decided.
 */
const applyLimiter = rateLimit({
  prefix: 'rl:reputation:moderation:apply:',
  windowMs: WINDOW_1_MIN,
  max: 120,
});

/** Binding registration limiter. */
const bindingLimiter = rateLimit({
  prefix: 'rl:reputation:moderation:binding:',
  windowMs: WINDOW_1_MIN,
  max: 120,
});

/** Staff reconciliation / read limiter. */
const staffLimiter = rateLimit({
  prefix: 'rl:reputation:moderation:staff:',
  windowMs: WINDOW_15_MIN,
  max: 200,
});

/** Subject-facing read limiter. */
const readLimiter = rateLimit({
  prefix: 'rl:reputation:moderation:read:',
  windowMs: WINDOW_15_MIN,
  max: 300,
});

/**
 * Require a service credential carrying `scope`.
 *
 * A user session, however privileged, can never satisfy this: the bridge is a
 * service-to-service boundary, and letting a staff session stand in would make
 * "a moderation service emitted this decision" unfalsifiable.
 */
function requireServiceScope(req: ServiceAuthRequest, scope: string): void {
  const serviceApp = req.serviceApp;
  if (!serviceApp) {
    throw new UnauthorizedError('This endpoint requires a service credential');
  }
  if (!serviceApp.scopes?.includes(scope)) {
    throw new ForbiddenError(`Missing required scope: ${scope}`);
  }
}

/*
 * SERIALIZERS
 *
 * Each returns a type owned by `@oxyhq/contracts` and hands the DTO to that
 * type's schema before it leaves the process — the `const dto: <ContractType>`
 * annotation is the compile-time guard (a missing field, an undeclared one, or a
 * `Date` where the wire promises an ISO string all fail `tsc` and name the
 * field), and `schema.parse` is the runtime one.
 */

/** Shape an effect for the HTTP response. */
function serializeEffect(effect: ModerationEffectRow): ModerationEffectDto {
  const dto: ModerationEffectDto = {
    id: effect.id,
    incidentId: effect.incidentId,
    caseId: effect.caseId,
    decisionId: effect.decisionId,
    decisionRevision: effect.decisionRevision,
    principalId: effect.principalId,
    effectType: effect.effectType,
    status: effect.status,
    points: effect.points,
    activeRisk: effect.activeRisk,
    severity: effect.severity,
    repetitionMultiplier: effect.repetitionMultiplier,
    multiFindingMultiplier: effect.multiFindingMultiplier,
    idempotencyKey: effect.idempotencyKey,
    transactionId: effect.transactionId,
    strikeId: effect.strikeId ?? undefined,
    reversalTransactionId: effect.reversalTransactionId ?? undefined,
    // The three policy versions were one embedded subdocument; they are three
    // columns now, and the WIRE shape is unchanged.
    policyVersions: {
      universal: effect.policyVersionUniversal,
      application: effect.policyVersionApplication,
      oxyConduct: effect.policyVersionOxyConduct,
    },
    appliedAt: effect.appliedAt.toISOString(),
    reversedAt: effect.reversedAt?.toISOString(),
  };
  return moderationEffectSchema.parse(dto);
}

/**
 * Shape a binding for the registering application.
 *
 * Carries no proof material: the user's token was verified and discarded, never
 * stored, so there is nothing here for a compromised application to replay.
 */
function serializeBinding(binding: IdentityBindingRecord): IdentityBindingDto {
  const dto: IdentityBindingDto = {
    id: binding.id,
    applicationId: binding.applicationId,
    userId: binding.userId,
    localPrincipalId: binding.localPrincipalId,
    bindingType: binding.bindingType,
    status: binding.status,
    verifiedAt: binding.verifiedAt.toISOString(),
    createdAt: binding.createdAt.toISOString(),
  };
  return identityBindingSchema.parse(dto);
}

/** Shape the conduct block for the subject's own read. */
function serializeConduct(
  conduct: Awaited<ReturnType<typeof reputationService.getBalance>>['conduct']
): ReputationConduct {
  const dto: ReputationConduct = {
    standing: conduct.standing,
    activeRisk: conduct.activeRisk,
    activeStrikes: conduct.activeStrikes,
    nextExpiryAt: conduct.nextExpiryAt?.toISOString(),
  };
  return reputationConductSchema.parse(dto);
}

// =============================================================================
// SERVICE-CREDENTIAL ROUTES (the bridge itself)
// =============================================================================

/**
 * POST /reputation/moderation/effects — submit a published decision.
 *
 * Answers 200 whether or not a consequence was derived. `applied: false` with a
 * `skipReason` is a SUCCESS: the event was accepted and durably recorded as
 * producing no effect, so the emitter stops retrying instead of hammering a
 * permanent error over something that will never change (a sandboxed
 * application, a local-only finding, an inconclusive decision).
 */
router.post(
  '/effects',
  applyLimiter,
  serviceAuthMiddleware,
  validate({ body: moderationDecisionEventSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    requireServiceScope(req, APPLY_SCOPE);

    const result = await moderationReputationService.applyModerationDecision(req.body, {
      emitterApplicationId: req.serviceApp?.appId ?? '',
      emitterCredentialId: req.serviceApp?.credentialId,
    });

    const dto: ApplyModerationDecisionResult = {
      applied: result.applied,
      effect: result.effect ? serializeEffect(result.effect) : undefined,
      skipReason: result.skipReason,
      idempotent: result.idempotent,
    };
    sendSuccess(res, applyModerationDecisionResultSchema.parse(dto));
  })
);

/**
 * POST /reputation/moderation/effects/reverse — an appeal overturned a decision.
 *
 * Produces a COMPENSATING ledger entry and clears the active risk. The original
 * transaction is never edited: the history survives, the net balance and the
 * standing are corrected.
 */
router.post(
  '/effects/reverse',
  applyLimiter,
  serviceAuthMiddleware,
  validate({ body: reverseModerationEffectSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    requireServiceScope(req, APPLY_SCOPE);

    const result = await moderationReputationService.reverseModerationDecision(
      req.body.decisionId,
      req.body.decisionRevision,
      req.body.reason,
      req.serviceApp!.credentialId
    );

    const dto: ReverseModerationEffectResult = {
      reversed: result.reversed.map(serializeEffect),
      idempotent: result.idempotent,
    };
    sendSuccess(res, reverseModerationEffectResultSchema.parse(dto));
  })
);

/**
 * POST /reputation/moderation/effects/finalize — confirm a consequence landed.
 *
 * The recovery path for a lost dispatch: the effect and its strike are the
 * durable record, so re-deriving the snapshot from them is always safe. It
 * creates nothing — a consequence cannot be conjured from a decision id.
 */
router.post(
  '/effects/finalize',
  applyLimiter,
  serviceAuthMiddleware,
  validate({ body: finalizeModerationDecisionSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    requireServiceScope(req, APPLY_SCOPE);

    const effects = await moderationReputationService.finalizeModerationDecision(
      req.body.decisionId,
      req.body.decisionRevision
    );
    sendSuccess(res, { effects: effects.map(serializeEffect) });
  })
);

/**
 * POST /reputation/moderation/bindings — register an identity binding.
 *
 * `applicationId` comes from the credential. The proof is the USER'S OWN access
 * token: an application can only hold one if the person signed in to it through
 * Oxy, which is what makes this a proof of presence rather than a claim. The
 * token is verified and discarded.
 */
router.post(
  '/bindings',
  bindingLimiter,
  serviceAuthMiddleware,
  validate({ body: registerIdentityBindingSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    requireServiceScope(req, BINDING_SCOPE);

    const binding = await registerIdentityBinding({
      applicationId: req.serviceApp?.appId ?? '',
      credentialId: req.serviceApp?.credentialId,
      localPrincipalId: req.body.localPrincipalId,
      userProofToken: req.body.userProofToken,
    });
    sendSuccess(res, { binding: serializeBinding(binding) }, 201);
  })
);

// =============================================================================
// USER-SESSION ROUTES
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
 * GET /reputation/moderation/standing/:userId — conduct standing (own or staff).
 *
 * Owner-or-staff, never public. Standing names a sanction, and the public
 * surface publishes a contribution tier and a general signal — not the fact that
 * someone is currently under moderation consequence.
 */
router.get(
  '/standing/:userId',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const callerId = requireUserId(req);
    const userObjectId = await resolveUserIdToObjectId(req.params.userId);
    if (userObjectId !== callerId && req.user?.isStaff !== true) {
      throw new ForbiddenError('You can only view your own conduct standing');
    }
    const balance = await reputationService.getBalance(userObjectId);
    sendSuccess(res, serializeConduct(balance.conduct));
  })
);

/**
 * GET /reputation/moderation/effects/mine — the effects on the caller.
 *
 * The explanation surface: what a consequence was, what it cost, which
 * multipliers produced it and under which policy version — the information a
 * person needs in order to appeal. Deliberately owner-scoped and deliberately
 * WITHOUT the taxonomy code or any third party: an explanation must not become a
 * dossier about the people a moderation system protects.
 */
router.get(
  '/effects/mine',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const callerId = requireUserId(req);
    const effects = await getDb()
      .select()
      .from(moderationEffects)
      .where(eq(moderationEffects.principalId, callerId))
      .orderBy(desc(moderationEffects.appliedAt))
      .limit(100);
    sendSuccess(res, { effects: effects.map(serializeEffect) });
  })
);

// =============================================================================
// STAFF ROUTES
// =============================================================================

/**
 * POST /reputation/moderation/incidents/:incidentId/reconcile — audit + repair.
 *
 * Finds the two silent failure shapes a dropped background job produces: points
 * deducted with no strike behind them, and a consequence still active after a
 * later revision superseded it. Neither errors on its own, so nothing but a
 * reconciliation pass ever notices.
 */
router.post(
  '/incidents/:incidentId/reconcile',
  staffLimiter,
  requireStaff,
  asyncHandler(async (req, res) => {
    const result = await moderationReputationService.reconcileModerationIncident(
      req.params.incidentId
    );
    sendSuccess(res, result);
  })
);

/** GET /reputation/moderation/incidents/:incidentId/effects — an incident's effects (staff). */
router.get(
  '/incidents/:incidentId/effects',
  staffLimiter,
  requireStaff,
  asyncHandler(async (req, res) => {
    const effects = await getDb()
      .select()
      .from(moderationEffects)
      .where(eq(moderationEffects.incidentId, req.params.incidentId))
      .orderBy(asc(moderationEffects.decisionRevision));
    sendSuccess(res, { effects: effects.map(serializeEffect) });
  })
);

export default router;
