import { utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import express from 'express';
import { z } from 'zod';
import {
  type ResourcePrincipal,
  resourceDomainOwnershipRequestSchema,
  resourceDomainOwnershipResponseSchema,
} from '@oxy.so/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { resolveLegacyResourceWorkload } from '../services/legacyResourceWorkload.service';
import { validateForegroundRequesterBearer } from '../services/foregroundCapabilityRequester.service';
import {
  resolveLiveAgencyServicePrincipal,
  resolveLiveExternalServicePrincipal,
} from '../services/agencyServicePrincipal.service';
import accountService from '../services/account.service';
import { resolveExternalResourceSession } from '../services/resourceSessionAuthority.service';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { resolveMachineCredential } from '../middleware/machineCredential';
import { verifyServiceToken, type ServiceTier } from '../middleware/serviceToken';
import { validate } from '../middleware/validate';
import { CLARITY_BACKEND_APPLICATION_ID } from '../config/firstPartyApplications';
import { getDb } from '../config/postgres';
import { userVerifiedDomains } from '../db/schema/userVerifiedDomains';

const router = express.Router();

const bodySchema = z
  .object({ token: z.string().check(utf16MinLength(1)).check(utf16MaxLength(16_384)) })
  .strict();

type Introspection = ResourcePrincipal & {
  /** Removed with the legacy resource receiver projection at final cutover. */
  tier?: ServiceTier;
  delegatedUserId?: string;
};
const inactive = () => ({ active: false, scopes: [], permissions: [] });

async function requireCanonicalClarityBackend(
  request: ServiceAuthRequest,
  response: express.Response,
  next: express.NextFunction,
): Promise<void> {
  try {
    const receiver = request.serviceApp;
    if (receiver?.appId === CLARITY_BACKEND_APPLICATION_ID) {
      const principal =
        receiver.authority === 'first_party'
          ? await resolveLiveAgencyServicePrincipal(receiver)
          : await resolveLegacyResourceWorkload(receiver);
      if (principal?.authority === 'first_party') {
        next();
        return;
      }
    }
  } catch (error) {
    next(error);
    return;
  }
  response.status(403).json({
    error: 'Forbidden',
    message: 'Resource authority endpoints are restricted to the canonical Clarity backend',
  });
}

/**
 * Registered resource receivers introspect signed service tokens and own sessions.
 * External raw keys and OAuth sessions remain the canonical Clarity resource API.
 * The receiver authenticates independently from the bearer being inspected.
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
      const receiverPrincipal =
        receiver.authority === 'first_party'
          ? await resolveLiveAgencyServicePrincipal(receiver)
          : ((await resolveLegacyResourceWorkload(receiver)) ??
            (await resolveLiveAgencyServicePrincipal(receiver)));
      // An old Clarity service key is not a first-party receiver merely because of its app ID.
      if (!receiverPrincipal)
        return response.status(403).json({ error: 'resource_server_identity_required' });
      const modernReceiver = receiver.authority === 'first_party';
      const expectedAudience = `oxy-service:${receiver.appId}` as const;
      const ownService = verifyServiceToken(token, expectedAudience);
      if (ownService.ok && ownService.payload.authority === 'first_party') {
        if (
          receiver.authority !== 'first_party' ||
          ownService.payload.environment !== receiver.environment
        )
          return response.json(inactive());
        const principal = await resolveLiveAgencyServicePrincipal(ownService.payload);
        if (principal?.authority !== 'first_party') return response.json(inactive());
        return response.json({
          active: true,
          kind: 'service',
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
      // Finite v1 caller bridge. Exact signed audience, live binding and immutable
      // inventory tuple are required; neither an API key nor registry branding qualifies.
      const legacyService = verifyServiceToken(token);
      if (legacyService.ok && legacyService.payload.environment === receiver.environment) {
        const legacy = await resolveLegacyResourceWorkload(legacyService.payload);
        if (legacy && receiverPrincipal.authority === 'first_party') {
          const base = {
            active: true as const,
            kind: 'service' as const,
            accountId: legacy.ownerAccountId,
            applicationId: legacy.applicationId,
            credentialId: legacy.credentialId,
            environment: legacyService.payload.environment,
            audience: 'oxy-api',
            tier: 'internal' as const,
            permissions: [],
            expiresAt: new Date((legacyService.payload.exp as number) * 1000).toISOString(),
          };
          // Old Clarity validates scopes even for its internal tier. Only this
          // authenticated v1 receiver sees the old shape during its rolling upgrade.
          return response.json(
            modernReceiver
              ? { ...base, authority: 'first_party' }
              : { ...base, scopes: [...(legacyService.payload.scopes ?? [])] },
          );
        }
      }

      if (modernReceiver) {
        const human = await validateForegroundRequesterBearer(token, receiverPrincipal);
        if (human) {
          const operatorId = human.principalAccountId;
          const access = await accountService.resolveEffectiveAccess(
            operatorId,
            human.subjectAccountId,
            human.sessionId,
          );
          if (!access) return response.json(inactive());
          return response.json({
            active: true,
            kind: 'session',
            authority: 'first_party',
            accountId: human.subjectAccountId,
            requesterAccountId: human.principalAccountId,
            effectiveAccountId: human.subjectAccountId,
            applicationId: null,
            tier: 'internal',
            permissions: access.permissions,
            expiresAt: human.expiresAt.toISOString(),
          } satisfies Introspection);
        }
      }
      const service = ownService.ok ? ownService : legacyService;
      if (service.ok && service.payload.authority !== 'first_party') {
        if (service.payload.environment !== receiver.environment) return response.json(inactive());
        const principal = await resolveLiveExternalServicePrincipal(service.payload);
        if (!principal) return response.json(inactive());
        return response.json({
          active: true,
          kind: 'service',
          accountId: principal.ownerAccountId,
          applicationId: principal.applicationId,
          credentialId: principal.credentialId,
          audience: ownService.ok ? expectedAudience : 'oxy-api',
          environment: service.payload.environment,
          tier: 'external',
          authority: 'external',
          scopes: [...(principal.scopes ?? [])],
          permissions: [],
          expiresAt: new Date((service.payload.exp as number) * 1_000).toISOString(),
        } satisfies Introspection);
      }

      // The legacy resource-key/session projection remains Clarity's external API.
      if (receiver.appId !== CLARITY_BACKEND_APPLICATION_ID) return response.json(inactive());
      const machine = await resolveMachineCredential(token);
      if (machine.ok) {
        return response.json({
          active: true,
          kind: 'key',
          accountId: machine.principal.ownerAccountId,
          applicationId: machine.principal.applicationId,
          credentialId: machine.principal.credentialId,
          environment: machine.principal.environment,
          // A machine credential (`oxy_sk_`) is the third-party lane.
          tier: 'external',
          authority: 'external',
          scopes: machine.principal.scopes,
          ...(machine.principal.expiresAt ? { expiresAt: machine.principal.expiresAt } : {}),
          permissions: [],
        } satisfies Introspection);
      }
      if (token.startsWith('oxy_sk_')) return response.json(inactive());

      const session = await resolveExternalResourceSession(token);
      if (!session) return response.json(inactive());
      const operatorId = session.requesterAccountId;
      const access = await accountService.resolveEffectiveAccess(
        operatorId,
        session.effectiveAccountId,
        session.sessionId,
      );
      if (!access) return response.json(inactive());
      return response.json({
        active: true,
        kind: 'session',
        accountId: session.accountId,
        requesterAccountId: session.requesterAccountId,
        effectiveAccountId: session.effectiveAccountId,
        applicationId: session.applicationId,
        delegatedUserId: session.requesterAccountId,
        expiresAt: session.expiresAt,
        tier: 'external',
        authority: 'external',
        scopes: session.scopes,
        permissions: access.permissions,
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
