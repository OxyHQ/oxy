import express from 'express';
import { z } from 'zod';
import {
  resourceDomainOwnershipRequestSchema,
  resourceDomainOwnershipResponseSchema,
} from '@oxy.so/contracts';
import { and, eq, sql } from 'drizzle-orm';
import accountService from '../services/account.service';
import sessionService from '../services/session.service';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { resolveMachineCredential } from '../middleware/machineCredential';
import { verifyServiceToken } from '../middleware/serviceToken';
import { validate } from '../middleware/validate';
import { NATIVE_PRODUCT_AGENTS } from '../config/nativeProductAgents';
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
  scopes: string[];
  permissions: string[];
  expiresAt?: string;
};

const inactive = (): Introspection => ({ active: false, scopes: [], permissions: [] });

function requireCanonicalClarityBackend(
  request: ServiceAuthRequest,
  response: express.Response,
  next: express.NextFunction
): void {
  if (request.serviceApp?.appId === NATIVE_PRODUCT_AGENTS.products.clarity.backendApplication.id) {
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
  requireCanonicalClarityBackend,
  validate({ body: bodySchema }),
  async (request: ServiceAuthRequest, response, next) => {
    try {
      const token = request.body.token as string;
      const machine = await resolveMachineCredential(token);
      if (machine.ok) {
        return response.json({
          active: true,
          accountId: machine.principal.ownerAccountId,
          applicationId: machine.principal.applicationId,
          credentialId: machine.principal.credentialId,
          environment: machine.principal.environment,
          scopes: machine.principal.scopes,
          permissions: [],
        } satisfies Introspection);
      }
      if (token.startsWith('oxy_sk_')) return response.json(inactive());

      const service = verifyServiceToken(token);
      if (service.ok) {
        return response.json({
          active: true,
          accountId: service.payload.ownerAccountId,
          applicationId: service.payload.appId,
          credentialId: service.payload.credentialId,
          environment: service.payload.environment,
          scopes: service.payload.scopes,
          permissions: [],
          expiresAt: service.payload.exp
            ? new Date(service.payload.exp * 1_000).toISOString()
            : undefined,
        } satisfies Introspection);
      }

      const session = await sessionService.validateSession(token).catch(() => null);
      const identity = session?.token;
      if (!identity?.applicationId) return response.json(inactive());
      const access = await accountService.resolveEffectiveAccess(
        identity.principalUserId,
        identity.subjectAccountId
      );
      return response.json({
        active: true,
        accountId: identity.subjectAccountId,
        applicationId: identity.applicationId,
        delegatedUserId: identity.principalUserId,
        scopes: [...identity.scopes],
        permissions: access?.permissions ?? [],
      } satisfies Introspection);
    } catch (error) {
      next(error);
    }
  }
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
            sql`lower(${userVerifiedDomains.domain}) = ${originHost}`
          )
        )
        .limit(1);

      response.json(resourceDomainOwnershipResponseSchema.parse({
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
      }));
    } catch (error) {
      next(error);
    }
  }
);

export default router;
