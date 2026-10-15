import { safetyOrganizationIdentities } from '../services/organization-directory.service';
import {
  safetyProfileRequestSchema,
  safetyProfileBatchRequestSchema,
  safetyMessageRequestSchema,
  safetyMessageBatchRequestSchema,
  safetyContactRequestSchema,
  safetyContentRequestSchema,
  safetyContentBatchRequestSchema,
  safetyPublicationRequestSchema,
  safetyPurchaseRequestSchema,
  safetyPurchaseListQuerySchema,
} from '../schemas/supervision.schemas';
import { Router, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  messagingSessionsInputSchema,
  messagingSessionsResponseSchema,
  safetyErrorSchema,
  safetyOrganizationsInputSchema,
  safetyOrganizationsResponseSchema,
  safetyPeopleInputSchema,
  safetyPeopleResponseSchema,
  publicationPolicySchema,
  publicationPoliciesInputSchema,
  publicationPoliciesResponseSchema,
  profileAccessBatchInputSchema,
  profileAccessBatchResponseSchema,
  profileAccessInputSchema,
  profileAccessDecisionSchema,
  messageAccessInputSchema,
  messageAccessBatchResponseSchema,
  deliveryAccessBatchInputSchema,
  contactAccessInputSchema,
  contactAccessResponseSchema,
  contentAccessInputSchema,
  contentAccessBatchInputSchema,
  contentAccessBatchResponseSchema,
  deliveryAccessInputSchema,
  safetyDecisionSchema,
  safetyRequesterSchema,
  safetySessionInputSchema,
  safetySessionValidationSchema,
  supervisionInviteInputSchema,
  supervisionAcceptInputSchema,
  supervisionContactInputSchema,
  supervisionReviewInputSchema,
  purchaseReviewInputSchema,
  supervisionStateSchema,
  supervisionInvitationSchema,
  supervisionContactsResponseSchema,
  purchaseEffectsSchema,
  purchaseApprovalSchema,
  purchaseApprovalListSchema,
  reservePurchaseSchema,
  confirmPurchaseSchema,
  cancelPurchaseSchema,
  accountActorChainFromSession,
} from '@oxy.so/contracts';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import {
  resolveLiveAgencyServicePrincipal,
  type LiveAgencyServicePrincipal,
} from '../services/agencyServicePrincipal.service';
import sessionService from '../services/session.service';
import { formatUserResponse } from '../utils/userTransform';
import { verifyReauth } from '../services/reauth.service';
import * as supervision from '../services/supervision.service';
import * as policy from '../services/supervisionPolicy.service';
import { resolveLiveMcpAccessToken } from '../services/mcpOAuth.service';
import { resolveMcpConnectionState } from '../services/mcpConnection.service';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
const router = Router();
router.use((_req, res, next) => {
  res.locals.apiErrorFormat = 'nested';
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const handler =
  (
    fn: (req: AuthRequest & ServiceAuthRequest, res: Response) => Promise<unknown>,
  ): RequestHandler =>
  (req, res) => {
    void fn(req, res).catch((error: unknown) => {
      if (error instanceof z.ZodError)
        return res.status(422).json({
          error: { code: 'validation_failed', message: 'Check the safety request fields' },
        });
      if (error instanceof supervision.SafetyError)
        return res
          .status(error.status)
          .json({ error: { code: error.code, message: error.message } });
      if (error instanceof ApiError)
        return res.status(error.statusCode).json({
          error: {
            code: error.statusCode === 401 ? 'reauth_required' : 'forbidden',
            message:
              error.statusCode === 401
                ? 'Confirm it is you before this safety change'
                : 'Safety authorization failed',
          },
        });
      logger.error(
        'Safety operation failed',
        error instanceof Error ? error : new Error('Safety operation failed'),
      );
      return res.status(503).json({
        error: {
          code: 'service_unavailable',
          message: 'Safety authorization is temporarily unavailable',
        },
      });
    });
  };
const limit = rateLimit({
  prefix: 'rl:safety:decisions:',
  windowMs: 60000,
  max: 6000,
  errorFormat: 'nested',
  keyGenerator: (req) => (req as ServiceAuthRequest).serviceApp?.appId ?? hashedIpKey(req),
});
async function principal(req: ServiceAuthRequest): Promise<LiveAgencyServicePrincipal> {
  if (!req.serviceApp)
    throw new supervision.SafetyError(
      401,
      'unauthorized',
      'A consumer service identity is required',
    );
  const live = await resolveLiveAgencyServicePrincipal(req.serviceApp);
  if (!live || !live.scopes.includes('safety:decide'))
    throw new supervision.SafetyError(403, 'forbidden', 'Consumer authority is no longer active');
  return live;
}
async function requester(
  token: string | null,
  live: LiveAgencyServicePrincipal,
): Promise<string | null> {
  if (token === null) return null;
  const validated = await sessionService.validateSession(token, {
    allowSupervisedPolicyEvaluation: true,
  });
  if (!validated)
    throw new supervision.SafetyError(
      401,
      'unauthorized',
      'The original authorized session is required',
    );
  if (validated.session.applicationId && validated.session.applicationId !== live.applicationId)
    throw new supervision.SafetyError(
      403,
      'forbidden',
      'The session belongs to another application',
    );
  return validated.session.userId;
}
async function serviceContext(req: ServiceAuthRequest, requireUser: boolean) {
  const live = await principal(req);
  const proof = safetyRequesterSchema.parse(req.body.requester);
  let user: string | null;
  if ('connectionToken' in proof) {
    const resolved = await resolveLiveMcpAccessToken(proof.connectionToken, live.applicationId);
    if (!resolved)
      throw new supervision.SafetyError(
        401,
        'unauthorized',
        'The connection is invalid or revoked',
      );
    const connection = await resolveMcpConnectionState(resolved.grant);
    user = connection.active_account_id;
    if (
      (await policy.isSupervised(user)) ||
      (await policy.isSupervised(resolved.grant.principalUserId))
    )
      throw new supervision.SafetyError(403, 'forbidden', 'Supervised delegation is not supported');
  } else user = await requester(proof.accessToken, live);
  if (requireUser && !user)
    throw new supervision.SafetyError(401, 'unauthorized', 'The original user session is required');
  return { live, user };
}
// Routes declare their own action; a client cannot choose another capability to weaken a domain decision.
router.use('/service', serviceAuthMiddleware, limit);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetySessionInputSchema
 * @response 200 safetySessionValidationSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/session',
  handler(async (req, res) => {
    const input = safetySessionInputSchema.parse(req.body),
      live = await principal(req);
    const validated = await sessionService.validateSession(input.accessToken, {
      allowSupervisedPolicyEvaluation: true,
    });
    if (!validated || validated.session.sessionId !== input.sessionId)
      throw new supervision.SafetyError(401, 'unauthorized', 'Invalid original session');
    if (validated.session.applicationId && validated.session.applicationId !== live.applicationId)
      throw new supervision.SafetyError(403, 'forbidden', 'Session consumer mismatch');
    if (
      ((await policy.isSupervised(validated.session.userId)) ||
        (!!validated.session.operatedByUserId &&
          (await policy.isSupervised(validated.session.operatedByUserId)))) &&
      !policy.consumerSupports(live, input.action)
    )
      throw new supervision.SafetyError(
        403,
        'forbidden',
        'This consumer action is not supported for supervised accounts',
      );
    res.json(
      safetySessionValidationSchema.parse({
        valid: true,
        sessionId: validated.session.sessionId,
        expiresAt: validated.session.expiresAt.toISOString(),
        lastActivity: validated.session.lastActiveAt.toISOString(),
        user: formatUserResponse(validated.user),
        actor: accountActorChainFromSession({
          subjectAccountId: validated.session.userId,
          operatedByAccountId: validated.session.operatedByUserId,
        }),
      }),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyProfileRequestSchema
 * @response 200 profileAccessDecisionSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/profile-access',
  handler(async (req, res) => {
    safetyProfileRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, false);
    const input = profileAccessInputSchema.parse(req.body.input);
    const result = await policy.decideProfiles([input.subjectAccountId], user, live);
    const decision = result.items[0]?.decision;
    if (!decision)
      throw new supervision.SafetyError(
        503,
        'service_unavailable',
        'Profile policy is unavailable',
      );
    const reason =
      decision.reason === 'allowed'
        ? 'public'
        : ['public', 'owner', 'blocked', 'unavailable'].includes(decision.reason)
          ? decision.reason
          : 'private';
    res.json(
      profileAccessDecisionSchema.parse({ allowed: decision.allowed, reason, policyVersion: '1' }),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyProfileBatchRequestSchema
 * @response 200 profileAccessBatchResponseSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/profile-access-batch',
  handler(async (req, res) => {
    safetyProfileBatchRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, false);
    const input = profileAccessBatchInputSchema.parse(req.body.input);
    res.json(
      profileAccessBatchResponseSchema.parse(
        await policy.decideProfiles(input.subjectAccountIds, user, live),
      ),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyMessageRequestSchema
 * @response 200 safetyDecisionSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/message-access',
  handler(async (req, res) => {
    safetyMessageRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, true);
    if (!user) throw new supervision.SafetyError(401, 'unauthorized', 'Requester required');
    const input = messageAccessInputSchema.parse(req.body.input);
    res.json(
      safetyDecisionSchema.parse(
        await policy.decideMessages(input.participantAccountIds, user, live),
      ),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyContactRequestSchema
 * @response 200 contactAccessResponseSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/contact-access',
  handler(async (req, res) => {
    safetyContactRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, true);
    if (!user) throw new supervision.SafetyError(401, 'unauthorized', 'Requester required');
    const input = contactAccessInputSchema.parse(req.body.input);
    res.json(
      contactAccessResponseSchema.parse(
        await policy.decideContacts(input.targetAccountIds, user, live),
      ),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyPublicationRequestSchema
 * @response 200 publicationPolicySchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/publication-policy',
  handler(async (req, res) => {
    safetyPublicationRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, true);
    if (!user) throw new supervision.SafetyError(401, 'unauthorized', 'Original author required');
    const result = await policy.publicationPolicies([user], live);
    res.json(publicationPolicySchema.parse(result.items[0]?.policy));
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody publicationPoliciesInputSchema
 * @response 200 publicationPoliciesResponseSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/publication-policies',
  handler(async (req, res) => {
    const live = await principal(req);
    if (!policy.consumerSupports(live, 'content-publication'))
      throw new supervision.SafetyError(
        403,
        'forbidden',
        'Reviewed background publication authority is required',
      );
    const input = publicationPoliciesInputSchema.parse(req.body);
    res.json(
      publicationPoliciesResponseSchema.parse(
        await policy.publicationPolicies(input.authorAccountIds, live),
      ),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyContentRequestSchema
 * @response 200 safetyDecisionSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/content-access',
  handler(async (req, res) => {
    safetyContentRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, false);
    const input = contentAccessInputSchema.parse(req.body.input);
    const result = await policy.decideContent([input], user, live);
    res.json(safetyDecisionSchema.parse(result.items[0]?.decision));
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyContentBatchRequestSchema
 * @response 200 contentAccessBatchResponseSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/content-access-batch',
  handler(async (req, res) => {
    safetyContentBatchRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, false);
    const input = contentAccessBatchInputSchema.parse(req.body.input);
    res.json(
      contentAccessBatchResponseSchema.parse(await policy.decideContent(input.items, user, live)),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody deliveryAccessInputSchema
 * @response 200 safetyDecisionSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/delivery-access',
  handler(async (req, res) => {
    const live = await principal(req),
      input = deliveryAccessInputSchema.parse(req.body);
    if (!policy.consumerSupports(live, 'messaging-delivery'))
      throw new supervision.SafetyError(
        403,
        'forbidden',
        'Reviewed delivery authority is required',
      );
    res.json(
      safetyDecisionSchema.parse(
        await policy.decideMessages(input.participantAccountIds, input.senderAccountId, live),
      ),
    );
  }),
);
/**
 * Evaluate bounded conversations using one live policy graph.
 * @requestBody safetyMessageBatchRequestSchema
 * @response 200 messageAccessBatchResponseSchema Per-resource decisions.
 * @response 401 safetyErrorSchema Requester required.
 * @response 403 safetyErrorSchema Consumer refused.
 * @response 422 safetyErrorSchema Invalid batch.
 * @response 503 safetyErrorSchema Authority unavailable.
 */
router.post(
  '/service/message-access-batch',
  handler(async (req, res) => {
    const { input } = safetyMessageBatchRequestSchema.parse(req.body);
    const { live, user } = await serviceContext(req, true);
    if (!user) throw new supervision.SafetyError(401, 'unauthorized', 'Requester required');
    res.json(
      messageAccessBatchResponseSchema.parse(
        await policy.decideMessagesBatch(
          input.items.map((item) => ({ ...item, senderAccountId: user })),
          live,
        ),
      ),
    );
  }),
);
/**
 * Decide background delivery using live contacts without impersonating a sender.
 * @requestBody deliveryAccessBatchInputSchema
 * @response 200 messageAccessBatchResponseSchema Per-resource decisions.
 * @response 401 safetyErrorSchema Consumer required.
 * @response 403 safetyErrorSchema Consumer refused.
 * @response 422 safetyErrorSchema Invalid batch.
 * @response 503 safetyErrorSchema Authority unavailable.
 */
router.post(
  '/service/delivery-access-batch',
  handler(async (req, res) => {
    const input = deliveryAccessBatchInputSchema.parse(req.body);
    const live = await principal(req);
    if (!policy.consumerSupports(live, 'messaging-delivery'))
      throw new supervision.SafetyError(
        403,
        'forbidden',
        'Reviewed delivery authority is required',
      );
    res.json(
      messageAccessBatchResponseSchema.parse(await policy.decideMessagesBatch(input.items, live)),
    );
  }),
);
/**
 * Revalidate original recipient proofs before realtime delivery. This grants no resource access.
 * @requestBody messagingSessionsInputSchema
 * @response 200 messagingSessionsResponseSchema Minimal correlated live identities.
 * @response 401 safetyErrorSchema Consumer required.
 * @response 403 safetyErrorSchema Consumer refused.
 * @response 422 safetyErrorSchema Invalid batch.
 * @response 503 safetyErrorSchema Authority unavailable.
 */
router.post(
  '/service/messaging-sessions',
  handler(async (req, res) => {
    const input = messagingSessionsInputSchema.parse(req.body);
    const live = await principal(req);
    if (!policy.consumerSupports(live, 'messaging-delivery'))
      throw new supervision.SafetyError(
        403,
        'forbidden',
        'Reviewed delivery authority is required',
      );
    const proofs = await sessionService.validateSessionProofs(
      input.items.map((item) => item.accessToken),
    );
    res.json(
      messagingSessionsResponseSchema.parse({
        items: input.items.map((item, index) => {
          const proof = proofs[index];
          if (
            !proof ||
            (proof.session.applicationId && proof.session.applicationId !== live.applicationId) ||
            (proof.supervised && !policy.consumerSupports(live, 'messaging'))
          )
            return { requestId: item.requestId, allowed: false };
          return { requestId: item.requestId, allowed: true, accountId: proof.session.userId };
        }),
      }),
    );
  }),
);
async function purchasing(req: ServiceAuthRequest) {
  const live = await principal(req);
  if (!policy.consumerSupports(live, 'purchases'))
    throw new supervision.SafetyError(403, 'forbidden', 'Reviewed purchase authority is required');
  return live;
}
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody safetyPurchaseRequestSchema
 * @response 201 purchaseApprovalSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/purchases',
  handler(async (req, res) => {
    safetyPurchaseRequestSchema.parse(req.body);
    const live = await purchasing(req);
    const token = z
      .object({ accessToken: z.string().min(1).max(16384) })
      .strict()
      .parse(req.body.requester).accessToken;
    const child = await requester(token, live);
    if (!child)
      throw new supervision.SafetyError(401, 'unauthorized', 'Original requester required');
    res
      .status(201)
      .json(
        purchaseApprovalSchema.parse(
          await supervision.requestPurchase(
            live.applicationId,
            child,
            purchaseEffectsSchema.parse(req.body.input),
          ),
        ),
      );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody reservePurchaseSchema
 * @response 200 purchaseApprovalSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/purchases/reserve',
  handler(async (req, res) => {
    const live = await purchasing(req);
    res.json(
      purchaseApprovalSchema.parse(
        await supervision.reservePurchase(
          live.applicationId,
          reservePurchaseSchema.parse(req.body),
        ),
      ),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody confirmPurchaseSchema
 * @response 200 purchaseApprovalSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/purchases/confirm',
  handler(async (req, res) => {
    const live = await purchasing(req);
    res.json(
      purchaseApprovalSchema.parse(
        await supervision.finishPurchase(
          live.applicationId,
          confirmPurchaseSchema.parse(req.body),
          true,
        ),
      ),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody cancelPurchaseSchema
 * @response 200 purchaseApprovalSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/service/purchases/cancel',
  handler(async (req, res) => {
    const live = await purchasing(req);
    res.json(
      purchaseApprovalSchema.parse(
        await supervision.finishPurchase(
          live.applicationId,
          cancelPurchaseSchema.parse(req.body),
          false,
        ),
      ),
    );
  }),
);

router.use(
  '/supervision',
  (_req, res, next) => {
    res.locals.supervisedSelfOperation = true;
    next();
  },
  authMiddleware,
  rateLimit({
    prefix: 'rl:safety:self:',
    windowMs: 60000,
    max: 120,
    errorFormat: 'nested',
    keyGenerator: (req) => (req as AuthRequest).user?._id?.toString() ?? hashedIpKey(req),
  }),
);
function personal(req: AuthRequest) {
  if (!req.user || req.user.kind !== 'personal' || req.oxyToken?.principalUserId !== req.user._id)
    throw new supervision.SafetyError(
      403,
      'forbidden',
      'A personal account must confirm its own safety action',
    );
  return req.user._id.toString();
}
/**
 * Authoritative supervised-personal policy operation.
 * @response 200 supervisionStateSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.get(
  '/supervision',
  handler(async (req, res) =>
    res.json(supervisionStateSchema.parse(await supervision.getSupervisionState(personal(req)))),
  ),
);
/**
 * Minimal existing employer identities for an authenticated personal account.
 * @requestBody safetyOrganizationsInputSchema
 * @response 200 safetyOrganizationsResponseSchema Minimal organization identities.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/supervision/organizations',
  handler(async (req, res) => {
    res.json(
      safetyOrganizationsResponseSchema.parse(
        await safetyOrganizationIdentities(
          personal(req),
          safetyOrganizationsInputSchema.parse(req.body),
        ),
      ),
    );
  }),
);
/**
 * Minimal identities for supervision selection and existing relationships.
 * @requestBody safetyPeopleInputSchema
 * @response 200 safetyPeopleResponseSchema Minimal identities.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/supervision/people',
  handler(async (req, res) => {
    res.json(
      safetyPeopleResponseSchema.parse(
        await supervision.supervisionPeople(personal(req), safetyPeopleInputSchema.parse(req.body)),
      ),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody supervisionInviteInputSchema
 * @response 201 supervisionInvitationSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/supervision/invitations',
  handler(async (req, res) => {
    const actor = personal(req),
      input = supervisionInviteInputSchema.parse(req.body);
    await verifyReauth(actor, input.reauth, 'supervision');
    res
      .status(201)
      .json(
        supervisionInvitationSchema.parse(
          await supervision.inviteGuardian(actor, input.guardianAccountId),
        ),
      );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody supervisionAcceptInputSchema
 * @response 200 supervisionStateSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/supervision/invitations/:id/accept',
  handler(async (req, res) => {
    const actor = personal(req),
      input = supervisionAcceptInputSchema.parse(req.body);
    await verifyReauth(actor, input.reauth, 'supervision');
    res.json(
      supervisionStateSchema.parse(await supervision.acceptInvitation(req.params.id, actor)),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @response 204 none No content.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.delete(
  '/supervision/invitations/:id',
  handler(async (req, res) => {
    await supervision.cancelInvitation(req.params.id, personal(req));
    res.status(204).end();
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @response 200 supervisionContactsResponseSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.get(
  '/supervision/contacts/:childId',
  handler(async (req, res) =>
    res.json(
      supervisionContactsResponseSchema.parse(
        await supervision.listContacts(req.params.childId, personal(req)),
      ),
    ),
  ),
);
const contactChange = (approve: boolean) =>
  handler(async (req, res) => {
    const actor = personal(req),
      input = supervisionContactInputSchema.parse(req.body);
    await verifyReauth(actor, input.reauth, 'supervision');
    await supervision.changeContact(input.childAccountId, input.contactAccountId, actor, approve);
    res.status(204).end();
  });
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody supervisionContactInputSchema
 * @response 204 none No content.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.put('/supervision/contacts', contactChange(true));
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody supervisionContactInputSchema
 * @response 204 none No content.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.delete('/supervision/contacts', contactChange(false));
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody supervisionReviewInputSchema
 * @response 204 none No content.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/supervision/review',
  handler(async (req, res) => {
    const actor = personal(req),
      input = supervisionReviewInputSchema.parse(req.body);
    await verifyReauth(actor, input.reauth, 'supervision');
    await supervision.reviewSupervision(actor, input);
    res.status(204).end();
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @response 200 purchaseApprovalSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.get(
  '/supervision/purchases/:id',
  handler(async (req, res) => {
    res.json(
      purchaseApprovalSchema.parse(await supervision.getPurchase(req.params.id, personal(req))),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestQuery safetyPurchaseListQuerySchema
 * @response 200 purchaseApprovalListSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.get(
  '/supervision/purchases',
  handler(async (req, res) => {
    const { cursor } = safetyPurchaseListQuerySchema.parse(req.query);
    res.json(
      purchaseApprovalListSchema.parse(await supervision.listPurchases(personal(req), cursor)),
    );
  }),
);
/**
 * Authoritative supervised-personal policy operation.
 * @requestBody purchaseReviewInputSchema
 * @response 200 purchaseApprovalSchema Success.
 * @response 401 safetyErrorSchema Request refused.
 * @response 403 safetyErrorSchema Request refused.
 * @response 404 safetyErrorSchema Request refused.
 * @response 409 safetyErrorSchema Request refused.
 * @response 422 safetyErrorSchema Request refused.
 * @response 429 safetyErrorSchema Request refused.
 * @response 503 safetyErrorSchema Request refused.
 */
router.post(
  '/supervision/purchases/:id/review',
  handler(async (req, res) => {
    const actor = personal(req),
      input = purchaseReviewInputSchema.parse(req.body);
    await verifyReauth(actor, input.reauth, 'supervision_purchase');
    res.json(
      purchaseApprovalSchema.parse(
        await supervision.reviewPurchase(req.params.id, actor, input.decision),
      ),
    );
  }),
);
export default router;
