import express from 'express';
import { z } from 'zod';
import {
  resourceDomainOwnershipRequestSchema,
  resourceDomainOwnershipResponseSchema,
} from '@oxy.so/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { resolveLiveAgencyServicePrincipal } from '../services/agencyServicePrincipal.service';
import accountService from '../services/account.service';
import sessionService from '../services/session.service';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { resolveMachineCredential } from '../middleware/machineCredential';
import { verifyServiceToken, type ServiceTier } from '../middleware/serviceToken';
import { validate } from '../middleware/validate';
import { CLARITY_BACKEND_APPLICATION_ID } from '../config/firstPartyApplications';
import { getDb } from '../config/postgres';
import { userVerifiedDomains } from '../db/schema/userVerifiedDomains';

const router = express.Router();

const bodySchema = z.object({ token: z.string().min(1).max(16_384) }).strict();

type Introspection = {
  active: boolean;
  accountId?: string;
  applicationId?: string;
  credentialId?: string;
  environment?: string;
  delegatedUserId?: string;
  /** Internal (one of Oxy's own applications) or external; see `ServiceTier`. */
  tier?: ServiceTier;
  authority?: 'first_party' | 'external';
  audience?: string;
  scopes?: string[];
  permissions: string[];
  expiresAt?: string;
};

const inactive = (): Introspection => ({ active: false, scopes: [], permissions: [] });

function requireCanonicalClarityBackend(
  request: ServiceAuthRequest,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (request.serviceApp?.appId === CLARITY_BACKEND_APPLICATION_ID) {
    next();
    return;
  }
  response.status(403).json({
    error: 'Forbidden',
    message: 'Resource authority endpoints are restricted to the canonical Clarity backend',
  });
}

/**
 * Resource-server token introspection for Clarity. The authenticated CALLER is
 * the canonical Clarity backend application; `body.token` is the independent
 * credential whose effective tenant identity Clarity needs to authorize.
 */
router.post(
  '/introspect',
  serviceAuthMiddleware,
  (request: ServiceAuthRequest, response, next) => {
    if (
      request.serviceApp?.authority === 'first_party' ||
      request.serviceApp?.appId === CLARITY_BACKEND_APPLICATION_ID
    )
      return next();
    response.status(403).json({ error: 'resource_server_identity_required' });
  },
  validate({ body: bodySchema }),
  async (request: ServiceAuthRequest, response, next) => {
    try {
      const token = request.body.token as string;
      const receiver = request.serviceApp;
      if (!receiver) return response.json(inactive());
      const expectedAudience = `oxy-service:${receiver.appId}` as const;
      const ownService = verifyServiceToken(token, expectedAudience);
      if (ownService.ok && ownService.payload.authority === 'first_party') {
        if (
          receiver.authority !== 'first_party' ||
          ownService.payload.environment !== receiver.environment
        )
          return response.json(inactive());
        const principal = await resolveLiveAgencyServicePrincipal(ownService.payload);
        if (!principal || principal.authority !== 'first_party') return response.json(inactive());
        return response.json({
          active: true,
          authority: 'first_party',
          audience: expectedAudience,
          accountId: principal.ownerAccountId,
          applicationId: principal.applicationId,
          credentialId: principal.credentialId,
          environment: ownService.payload.environment,
          tier: 'internal',
          permissions: [],
          expiresAt: new Date((ownService.payload.exp as number) * 1000).toISOString(),
        } satisfies Introspection);
      }
      // The legacy resource-key/session projection remains Clarity's external API.
      if (receiver.appId !== CLARITY_BACKEND_APPLICATION_ID) return response.json(inactive());
      const machine = await resolveMachineCredential(token);
      if (machine.ok) {
        return response.json({
          active: true,
          accountId: machine.principal.ownerAccountId,
          applicationId: machine.principal.applicationId,
          credentialId: machine.principal.credentialId,
          environment: machine.principal.environment,
          // A machine credential (`oxy_sk_`) is the third-party lane.
          tier: 'external',
          authority: 'external',
          scopes: machine.principal.scopes,
          permissions: [],
        } satisfies Introspection);
      }
      if (token.startsWith('oxy_sk_')) return response.json(inactive());

      const service = verifyServiceToken(token);
      if (service.ok && service.payload.authority !== 'first_party') {
        const principal = await resolveLiveAgencyServicePrincipal(service.payload);
        if (!principal) return response.json(inactive());
        return response.json({
          active: true,
          accountId: principal.ownerAccountId,
          applicationId: principal.applicationId,
          credentialId: principal.credentialId,
          environment: service.payload.environment,
          tier: 'external',
          authority: 'external',
          scopes: [...(principal.scopes ?? [])],
          permissions: [],
          expiresAt: service.payload.exp
            ? new Date(service.payload.exp * 1_000).toISOString()
            : undefined,
        } satisfies Introspection);
      }

      const session = await sessionService.validateSession(token).catch(() => null);
      const identity = session?.token;
      if (!session || !identity?.applicationId) return response.json(inactive());
      const operatorId = identity.principalUserId;
      const access = await accountService.resolveEffectiveAccess(
        operatorId,
        identity.subjectAccountId,
        session.session.sessionId,
      );
      return response.json({
        active: true,
        accountId: identity.subjectAccountId,
        applicationId: identity.applicationId,
        delegatedUserId: identity.principalUserId,
        tier: 'external',
        authority: 'external',
        scopes: [...identity.scopes],
        permissions: access?.permissions ?? [],
      } satisfies Introspection);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/domains/verify',
  serviceAuthMiddleware,
  requireCanonicalClarityBackend,
  validate({ body: resourceDomainOwnershipRequestSchema }),
  async (request, response, next) => {
    try {
      const { accountId, verifiedDomainId, originHost } = request.body;
      const [domain] = await getDb()
        .select({
          id: userVerifiedDomains.id,
          userId: userVerifiedDomains.userId,
          domain: userVerifiedDomains.domain,
          verifiedAt: userVerifiedDomains.verifiedAt,
          method: userVerifiedDomains.method,
        })
        .from(userVerifiedDomains)
        .where(
          and(
            eq(userVerifiedDomains.id, verifiedDomainId),
            eq(userVerifiedDomains.userId, accountId),
            sql`lower(${userVerifiedDomains.domain}) = ${originHost}`,
          ),
        )
        .limit(1);

      response.json(
        resourceDomainOwnershipResponseSchema.parse({
          verified: Boolean(domain),
          accountId,
          verifiedDomainId,
          originHost,
          ...(domain
            ? {
                verifiedAt: domain.verifiedAt.toISOString(),
                method: domain.method,
              }
            : {}),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

export default router;
