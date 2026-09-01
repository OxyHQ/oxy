/**
 * Civic / Commons Routes (Fase 1 — public DNI card; Fase 2 — real-life attestation)
 *
 * Mounted at `/civic` (beside `/identity`):
 *  - `GET  /civic/:userId/card`   — the user's signed, verifiable "DNI" card (public).
 *  - `POST /civic/attestations`   — submit a real-life counterparty attestation (auth).
 *
 * The card route is public, cacheable, CORS-open (`Access-Control-Allow-Origin:
 * *`), no auth/CSRF — a public card is meant to be scanned by anyone. The
 * attestation route is Bearer-authenticated (the counterparty submits a record
 * they signed with their own key), so no app-local CSRF (bearer-write rule).
 * More civic routes (validations, personhood) arrive in Fase 2 Part B / Fase 3.
 */

import { Router, type Request, type Response } from 'express';
import { authMiddleware, serviceAuthMiddleware, type AuthRequest, type ServiceAuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { getIO } from '../utils/socket';
import {
  signedRecordEnvelopeSchema,
  validationOpenRequestSchema,
  type SignedRecordEnvelope,
  type CredentialStatus,
} from '@oxyhq/contracts';
import { requireStaff } from '../middleware/requireStaff';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { personhoodStatuses } from '../db/schema/personhoodStatuses';
import { users } from '../db/schema/users';
import { buildSignedPublicCard } from '../services/civic/publicCard.service';
import { submitRealLifeAttestation, type RealLifeRejectionReason } from '../services/civic/realLife.service';
import {
  openValidationRequest,
  submitVote,
  denyValidation,
  getValidatorInbox,
  type VoteRejectionReason,
} from '../services/civic/validator.service';
import {
  vouchForPerson,
  withdrawVouch,
  recomputePersonhood,
  type VouchRejectionReason,
} from '../services/civic/personhood.service';
import {
  issueCredential,
  listCredentialsForHolder,
  verifyCredential,
  revokeCredential,
  type CredentialIssueRejectionReason,
} from '../services/civic/credential.service';

const router = Router();

const REQUIRED_VALIDATION_SCOPE = 'reputation:write';

const attestationLimiter = rateLimit({
  prefix: 'rl:civic:attest:',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many attestation submissions. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:attest:${userId}` : `civic:attest:ip:${hashedIpKey(req)}`;
  },
});

const validationLimiter = rateLimit({
  prefix: 'rl:civic:validate:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many validation requests. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:validate:${userId}` : `civic:validate:ip:${hashedIpKey(req)}`;
  },
});

/** Personhood vouch + withdraw — the staked web-of-trust writes. */
const vouchLimiter = rateLimit({
  prefix: 'rl:civic:vouch:',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many vouch operations. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:vouch:${userId}` : `civic:vouch:ip:${hashedIpKey(req)}`;
  },
});

/** Public personhood-status reads. */
const personhoodReadLimiter = rateLimit({
  prefix: 'rl:civic:personhood:read:',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many personhood status requests. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:personhood:read:${userId}` : `civic:personhood:read:ip:${hashedIpKey(req)}`;
  },
});

/** Staff-only personhood recompute. */
const personhoodAdminLimiter = rateLimit({
  prefix: 'rl:civic:personhood:admin:',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many personhood admin operations. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:personhood:admin:${userId}` : `civic:personhood:admin:ip:${hashedIpKey(req)}`;
  },
});

/** Issue a verifiable credential (the issuer signs; HIGH-value write). */
const credentialIssueLimiter = rateLimit({
  prefix: 'rl:civic:credential:issue:',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many credential issuance requests. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:credential:issue:${userId}` : `civic:credential:issue:ip:${hashedIpKey(req)}`;
  },
});

/** Public credential reads (a holder's credential list). */
const credentialReadLimiter = rateLimit({
  prefix: 'rl:civic:credential:read:',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many credential requests. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:credential:read:${userId}` : `civic:credential:read:ip:${hashedIpKey(req)}`;
  },
});

/** Public credential verification (offline-style verify by record id). */
const credentialVerifyLimiter = rateLimit({
  prefix: 'rl:civic:credential:verify:',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many credential verification requests. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:credential:verify:${userId}` : `civic:credential:verify:ip:${hashedIpKey(req)}`;
  },
});

/** Credential revocation (issuer-only write). */
const credentialRevokeLimiter = rateLimit({
  prefix: 'rl:civic:credential:revoke:',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many credential revocation requests. Please slow down.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `civic:credential:revoke:${userId}` : `civic:credential:revoke:ip:${hashedIpKey(req)}`;
  },
});

/** Map a credential-issuance rejection reason to the HTTP error to throw. */
function throwForCredentialIssueReason(reason: CredentialIssueRejectionReason): never {
  switch (reason) {
    case 'holder_not_found':
      throw new NotFoundError('Credential holder not found');
    case 'self_credential':
      throw new ForbiddenError(`Credential rejected: ${reason}`);
    case 'chain_conflict':
    case 'bad_seq':
    case 'chain_fork':
    case 'chain_gap':
    case 'stale_issued_at':
      throw new ConflictError(`Credential rejected: ${reason}`);
    default:
      throw new BadRequestError(`Credential rejected: ${reason}`);
  }
}

/** Assert the service credential can open reputation-mutating validation workflows. */
function assertValidationScope(req: ServiceAuthRequest): void {
  const scopes = req.serviceApp?.scopes ?? [];
  if (!scopes.includes(REQUIRED_VALIDATION_SCOPE)) {
    throw new ForbiddenError(`Missing required scope: ${REQUIRED_VALIDATION_SCOPE}`);
  }
}

/** Map a vote rejection reason to the HTTP error the route should throw. */
function throwForVoteReason(reason: VoteRejectionReason): never {
  switch (reason) {
    case 'request_not_found':
      throw new NotFoundError('Validation request not found');
    case 'request_closed':
    case 'already_voted':
      throw new ConflictError(`Vote rejected: ${reason}`);
    case 'not_selected':
      throw new ForbiddenError('You are not on this validation jury');
    default:
      throw new BadRequestError(`Vote rejected: ${reason}`);
  }
}

/** Map a real-life rejection reason to the HTTP error the route should throw. */
function throwForRealLifeReason(reason: RealLifeRejectionReason): never {
  switch (reason) {
    case 'subject_not_found':
      throw new NotFoundError('Attestation subject not found');
    case 'nonce_used':
    case 'chain_conflict':
    case 'bad_seq':
    case 'chain_fork':
      throw new ConflictError(`Attestation rejected: ${reason}`);
    case 'self_attestation':
    case 'excluded_graph_neighbor':
    case 'excluded_shared_device':
      throw new ForbiddenError(`Attestation rejected: ${reason}`);
    default:
      throw new BadRequestError(`Attestation rejected: ${reason}`);
  }
}

/** Map a personhood-vouch rejection reason to the HTTP error the route throws. */
function throwForVouchReason(reason: VouchRejectionReason): never {
  switch (reason) {
    case 'subject_not_found':
      throw new NotFoundError('Vouch subject not found');
    case 'already_vouched':
    case 'chain_conflict':
    case 'bad_seq':
    case 'chain_fork':
    case 'chain_gap':
    case 'stale_issued_at':
      throw new ConflictError(`Vouch rejected: ${reason}`);
    case 'self_vouch':
    case 'voucher_below_threshold':
    case 'excluded_self':
    case 'excluded_graph_neighbor':
    case 'excluded_shared_device':
      throw new ForbiddenError(`Vouch rejected: ${reason}`);
    default:
      throw new BadRequestError(`Vouch rejected: ${reason}`);
  }
}

/** Headers shared by every public civic response. */
function setPublicCardHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
}

/**
 * GET /civic/:userId/card — the user's signed public DNI card (public).
 * Returns `{ card, attestation }`; `attestation` is `null` only when the Oxy
 * signing key is unconfigured (dev). Unknown / invalid id → 404.
 */
router.get(
  '/:userId/card',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;

    const signed = await buildSignedPublicCard(userId);
    if (!signed) {
      throw new NotFoundError('Card not found');
    }

    setPublicCardHeaders(res);
    res.json(signed);
  }),
);

/**
 * POST /civic/attestations — submit a real-life counterparty attestation (auth).
 * Body is the counterparty's signed `real_life_attestation` envelope; the server
 * verifies it, enforces nonce single-use + freshness + graph-exclusion + the
 * per-pair cooldown, stores it, and awards the subject the HIGH-weight points.
 * Returns `RealLifeAttestationResult` on success.
 */
router.post(
  '/attestations',
  authMiddleware,
  attestationLimiter,
  validate({ body: signedRecordEnvelopeSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const attestorUserId = req.user?._id?.toString();
    if (!attestorUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await submitRealLifeAttestation(req.body as SignedRecordEnvelope, attestorUserId);
    if (!result.ok) {
      throwForRealLifeReason(result.reason);
    }

    // Level-2 card feedback: tell the subject (A) their attestation landed.
    // Best-effort — a missing io (tests, boot) must never fail the request.
    const io = getIO();
    if (io) {
      io.to(`user:${result.subjectUserId}`).emit('civic:attested', {
        subjectUserId: result.subjectUserId,
        byUserId: result.attestorUserId,
        recordId: result.recordId,
        points: result.points,
        at: new Date().toISOString(),
      });
    }

    res.status(201).json({
      accepted: true,
      recordId: result.recordId,
      subjectUserId: result.subjectUserId,
      attestorUserId: result.attestorUserId,
      points: result.points,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/*  Validator jury (Fase 2 Part B)                                            */
/* -------------------------------------------------------------------------- */

/**
 * POST /civic/validations — open a validation request (service-token only).
 * An internal service opens a request on behalf of a user action; the jury is
 * selected server-side. Returns `{ requestId, selectedValidatorCount, expiresAt }`.
 */
router.post(
  '/validations',
  serviceAuthMiddleware,
  validationLimiter,
  validate({ body: validationOpenRequestSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertValidationScope(req);

    const { subjectUserId, actionType, sourceActionId, payload, highValue } = req.body;
    // Was an ObjectId-FORMAT check, which would reject every uuid v7 id minted
    // after the cutover. The 400 is a real contract for a body field, so the
    // check becomes EXISTENCE — otherwise an unknown subject reaches the
    // `subject_user_id` foreign key and answers 500 instead of 400.
    const [subject] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, String(subjectUserId)))
      .limit(1);
    if (!subject) {
      throw new BadRequestError('Invalid subjectUserId');
    }

    const request = await openValidationRequest({
      subjectUserId,
      actionType,
      sourceActionId,
      payload,
      highValue,
      applicationId: req.serviceApp?.appId,
    });

    res.status(201).json({
      requestId: request.id,
      selectedValidatorCount: request.selectedValidatorIds.length,
      expiresAt: request.expiresAt.toISOString(),
    });
  }),
);

/**
 * GET /civic/validations/inbox — the caller's pending jury duties (auth).
 * Returns `{ requests: ValidationRequestSummary[] }`.
 */
router.get(
  '/validations/inbox',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const requests = await getValidatorInbox(userId);
    res.json({
      requests: requests.map((request) => ({
        id: request.id,
        subjectUserId: request.subjectUserId,
        actionType: request.actionType,
        payload: request.payload,
        payloadHash: request.payloadHash,
        status: request.status,
        highValue: request.highValue,
        expiresAt: request.expiresAt.toISOString(),
      })),
    });
  }),
);

/**
 * POST /civic/validations/:id/vote — cast a SIGNED verdict (auth). Body is the
 * juror's `validation_verdict` envelope. Returns `ValidationVoteResult`.
 */
router.post(
  '/validations/:id/vote',
  authMiddleware,
  validationLimiter,
  validate({ body: signedRecordEnvelopeSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await submitVote(req.params.id, userId, req.body as SignedRecordEnvelope);
    if (!result.ok) {
      throwForVoteReason(result.reason);
    }

    res.status(201).json({
      recorded: true,
      requestId: req.params.id,
      verdict: result.verdict,
      status: result.status,
    });
  }),
);

/**
 * POST /civic/validations/:id/deny — recuse from a request (auth). The juror is
 * removed from the jury and the request is re-tallied.
 */
router.post(
  '/validations/:id/deny',
  authMiddleware,
  validationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await denyValidation(req.params.id, userId);
    if (!result.ok) {
      if (result.reason === 'request_not_found') {
        throw new NotFoundError('Validation request not found');
      }
      if (result.reason === 'not_selected') {
        throw new ForbiddenError('You are not on this validation jury');
      }
      throw new ConflictError(`Deny rejected: ${result.reason}`);
    }

    res.json({ denied: true });
  }),
);

/* -------------------------------------------------------------------------- */
/*  Proof-of-personhood web-of-trust (Fase 3)                                 */
/* -------------------------------------------------------------------------- */

/**
 * POST /civic/personhood/vouch — vouch that another user is a real person (auth).
 * Body is the caller's signed, self-issued `personhood_vouch` envelope (the
 * subject is referenced by `record.about`). The server verifies it, enforces the
 * voucher-eligibility (personhood ≥ τ) + graph-exclusion gates, stakes the
 * voucher, awards the subject `personhood_vouched`, and recomputes the subject's
 * personhood. The voucher id is resolved server-side from the session — never
 * from the body.
 */
router.post(
  '/personhood/vouch',
  authMiddleware,
  vouchLimiter,
  validate({ body: signedRecordEnvelopeSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const voucherUserId = req.user?._id?.toString();
    if (!voucherUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await vouchForPerson(req.body as SignedRecordEnvelope, voucherUserId);
    if (!result.ok) {
      throwForVouchReason(result.reason);
    }

    res.status(201).json({
      accepted: true,
      recordId: result.recordId,
      subjectUserId: result.subjectUserId,
      voucherUserId: result.voucherUserId,
      stakeAmount: result.stakeAmount,
      points: result.points,
    });
  }),
);

/**
 * DELETE /civic/personhood/vouch/:subjectUserId — withdraw the caller's active
 * vouch for a subject (auth). The vouch flips to `withdrawn` and the subject is
 * recomputed (which may demote them below θ).
 */
router.delete(
  '/personhood/vouch/:subjectUserId',
  authMiddleware,
  vouchLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const voucherUserId = req.user?._id?.toString();
    if (!voucherUserId) {
      throw new UnauthorizedError('Authentication required');
    }
    const { subjectUserId } = req.params;

    const result = await withdrawVouch(voucherUserId, subjectUserId);
    if (!result.ok) {
      throw new NotFoundError('No active vouch found for this subject');
    }

    res.json({ withdrawn: true });
  }),
);

/**
 * GET /civic/personhood/:userId — a user's public personhood status. Read-only:
 * returns the cached snapshot, or a zeroed `unverified` shape when none exists
 * yet (never persists / recomputes on a public read). Unknown / invalid id → 404.
 */
router.get(
  '/personhood/:userId',
  personhoodReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    // The `isValidObjectId` guard is DELETED, not ported. Its only effect was to
    // answer 404 for an id that is not 24 hex chars, and after the cutover EVERY
    // new account id is a uuid v7 — so keeping it would 404 the whole new id
    // space. An id that matches no row already returned this zeroed
    // `unverified` shape, so a malformed one now answers the same way.
    const [status] = await getDb()
      .select()
      .from(personhoodStatuses)
      .where(eq(personhoodStatuses.userId, userId))
      .limit(1);
    setPublicCardHeaders(res);
    res.json({
      userId,
      score: status?.score ?? 0,
      isRealPerson: status?.isRealPerson ?? false,
      vouchCount: status?.vouchCount ?? 0,
      realLifeCount: status?.realLifeCount ?? 0,
      biometricBound: status?.biometricBound ?? false,
      sybilPenalty: status?.sybilPenalty ?? 0,
      breakdown: status
        ? {
            vouchSignal: status.breakdownVouchSignal,
            realLifeSignal: status.breakdownRealLifeSignal,
            biometricSignal: status.breakdownBiometricSignal,
            evidence: status.breakdownEvidence,
            sybilPenalty: status.breakdownSybilPenalty,
            seed: status.breakdownSeed,
          }
        : null,
      updatedAt: status?.updatedAt ?? null,
    });
  }),
);

/**
 * POST /civic/personhood/:userId/recompute — force a personhood recompute for a
 * user (staff only). Re-aggregates vouches/real-life/biometric − sybil and
 * re-mirrors `User.verified`.
 */
router.post(
  '/personhood/:userId/recompute',
  authMiddleware,
  requireStaff,
  personhoodAdminLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { userId } = req.params;

    const status = await recomputePersonhood(userId);
    res.json({
      userId,
      score: status.score,
      isRealPerson: status.isRealPerson,
      vouchCount: status.vouchCount,
      realLifeCount: status.realLifeCount,
      biometricBound: status.biometricBound,
      sybilPenalty: status.sybilPenalty,
      // The `breakdown` subdocument is six prefixed columns now; the WIRE shape
      // is unchanged, so it is reassembled here at the serializer boundary.
      breakdown: {
        vouchSignal: status.breakdownVouchSignal,
        realLifeSignal: status.breakdownRealLifeSignal,
        biometricSignal: status.breakdownBiometricSignal,
        evidence: status.breakdownEvidence,
        sybilPenalty: status.breakdownSybilPenalty,
        seed: status.breakdownSeed,
      },
      updatedAt: status.updatedAt,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/*  Verifiable Credentials (Fase 4)                                           */
/* -------------------------------------------------------------------------- */

/**
 * POST /civic/credentials — issue a verifiable credential (auth — issuer).
 * Body is the issuer's SELF-ISSUED, signed `credential` envelope (the holder is
 * referenced by `record.about`). The server verifies the signature + the issuer
 * VM + chain continuity, stores the signed record, and projects a queryable
 * credential row. All claim data comes from the SIGNED envelope — the issuer id
 * is resolved server-side from the session, never from the body.
 */
router.post(
  '/credentials',
  authMiddleware,
  credentialIssueLimiter,
  validate({ body: signedRecordEnvelopeSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const issuerUserId = req.user?._id?.toString();
    if (!issuerUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await issueCredential(req.body as SignedRecordEnvelope, issuerUserId);
    if (!result.ok) {
      throwForCredentialIssueReason(result.reason);
    }

    res.status(201).json({ accepted: true, credential: result.credential });
  }),
);

/**
 * GET /civic/credentials/by-record/:recordId/verify — verify a credential by the
 * signed record id (public). Recomputes the canonical signing input and verifies
 * the signature against the ISSUER DID's current verification method, then checks
 * revocation/expiry. Returns `{ valid, reason?, credential }`. Registered BEFORE
 * `/:holderUserId` so `by-record` is never captured as a holder id.
 */
router.get(
  '/credentials/by-record/:recordId/verify',
  credentialVerifyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { recordId } = req.params;
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new NotFoundError('Credential not found');
    }

    const result = await verifyCredential(recordId);
    setPublicCardHeaders(res);
    res.json(result);
  }),
);

/**
 * GET /civic/credentials/:holderUserId — list a holder's credentials (public-ish).
 * Optional `?status=active|revoked|expired` filters by stored status. Credentials
 * are issuer-signed attestations a holder collects to SHOW, so the list is public
 * (mirrors the card/personhood reads); an unknown holder yields an empty list.
 */
router.get(
  '/credentials/:holderUserId',
  credentialReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { holderUserId } = req.params;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && status !== 'active' && status !== 'revoked' && status !== 'expired') {
      throw new BadRequestError('Invalid status filter');
    }

    const credentials = await listCredentialsForHolder(holderUserId, {
      status: status as CredentialStatus | undefined,
    });
    setPublicCardHeaders(res);
    res.json({ credentials });
  }),
);

/**
 * POST /civic/credentials/:id/revoke — revoke a credential (auth — issuer only).
 * Only the original user issuer may revoke. Flips the credential to `revoked`.
 */
router.post(
  '/credentials/:id/revoke',
  authMiddleware,
  credentialRevokeLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const issuerUserId = req.user?._id?.toString();
    if (!issuerUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await revokeCredential(req.params.id, issuerUserId);
    if (!result.ok) {
      if (result.reason === 'not_found') {
        throw new NotFoundError('Credential not found');
      }
      if (result.reason === 'not_issuer') {
        throw new ForbiddenError('Only the original issuer may revoke this credential');
      }
      throw new ConflictError(`Revoke rejected: ${result.reason}`);
    }

    res.json({ revoked: true, credential: result.credential });
  }),
);

export default router;
