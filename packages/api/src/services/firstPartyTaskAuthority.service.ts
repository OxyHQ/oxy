import { resolveFirstPartyTask, taskAllowsEffectiveAccount } from './firstPartyTasks.service';
import {
  firstPartyExecutionAuthorizationInputSchema,
  catalogToolAllowsActor,
  type FirstPartyExecutionAuthorizationInput,
} from '@oxy.so/contracts';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { capabilityExecutionAuthorizations } from '../db/schema/agency';
import { activeCapabilityCatalog } from './capabilityCatalog.service';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import { validateForegroundRequesterBearer } from './foregroundCapabilityRequester.service';
import { readSessionAgentBinding } from './agentKeyAuthority.service';
import { isTrustedApplication } from '../utils/trustedApplication';
import { BadRequestError, ForbiddenError } from '../utils/error';
import { capabilityLimitError } from './capabilityLimitPolicy';
import { autonomousSensitiveToolLimitError } from './capabilityGrantPolicy';
import { resolveDelegatedRequester } from './firstPartyDelegation.service';
import { platformReceiver } from '../utils/firstPartyDelegation';

export async function liveFirstPartyCatalog(appSlug: string) {
  const registration = await activeCapabilityCatalog(appSlug);
  if (!registration || registration.source !== 'first_party') return null;
  const [row] = await getDb()
    .select({
      app: applications,
      ownerStatus: users.accountStatus,
      fence: accountClosureFences.accountId,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(eq(applications.id, registration.registeredByApplicationId))
    .limit(1);
  return row?.app.status === 'active' &&
    row.ownerStatus === 'active' &&
    row.fence === null &&
    isTrustedApplication(row.app)
    ? registration
    : null;
}

/**
 * Where an own execution authorization's person comes from: the service's
 * declared authority (ADR 0066), or, until every caller migrates, a present
 * session or a durable task.
 */
export type FirstPartyAuthorizationSource =
  | { kind: 'delegated'; requesterAccountId?: string }
  | { kind: 'session'; subjectToken: string }
  | { kind: 'task'; taskId: string };

/** The tool operation names requester, actor, resource and lifetime; never an app grant. */
export async function createFirstPartyTaskAuthorization(
  raw: FirstPartyExecutionAuthorizationInput,
  source: FirstPartyAuthorizationSource,
  presenter: LiveAgencyServicePrincipal,
) {
  const input = firstPartyExecutionAuthorizationInputSchema.parse(raw);
  if (presenter.authority !== 'first_party')
    throw new ForbiddenError('A live Oxy workload is required.');
  const task =
    source.kind === 'task' ? await resolveFirstPartyTask(source.taskId, presenter) : null;
  if (source.kind === 'task' && !task)
    throw new ForbiddenError('Task authority is no longer active.');
  const proven = task
    ? {
        principalAccountId: task.requesterAccountId,
        subjectAccountId: task.effectiveAccountId,
        sessionId: task.requesterSessionId as string | null,
        digest: task.requesterSessionBindingDigest as string | null,
        expiresAt: task.expiresAt as Date | null,
      }
    : source.kind === 'session'
      ? await validateForegroundRequesterBearer(source.subjectToken, presenter)
      : null;
  if (
    source.kind !== 'delegated' &&
    (!proven ||
      (task
        ? !(await taskAllowsEffectiveAccount(task, input.resource.effectiveAccountId, input.actor))
        : proven.subjectAccountId !== input.resource.effectiveAccountId))
  ) {
    throw new ForbiddenError('The resource must belong to the authenticated requester account.');
  }
  const registration = await liveFirstPartyCatalog(input.resource.appId);
  if (
    !registration ||
    registration.id !== input.expectedCatalog.registrationId ||
    registration.version !== input.expectedCatalog.version ||
    registration.digest !== input.expectedCatalog.digest
  ) {
    throw new BadRequestError('The current Oxy tool catalogue is required.');
  }
  const tool = registration.catalog.tools.find((entry) => entry.name === input.tool);
  if (
    !tool ||
    !tool.exposure.includes('internal') ||
    !tool.resourceTypes.includes(input.resource.resourceType) ||
    !catalogToolAllowsActor(tool, input.actor.type)
  )
    throw new ForbiddenError('The tool is not available to this actor and resource.');
  const delegate = async (requesterAccountId: string | undefined) => ({
    ...(await resolveDelegatedRequester({
      applicationId: presenter.applicationId,
      on: platformReceiver('tools'),
      effect: tool.effect === 'read' ? 'read' : 'write',
      accountId: input.resource.effectiveAccountId,
      requesterAccountId:
        requesterAccountId ??
        (input.actor.type === 'requester'
          ? input.actor.accountId
          : input.resource.effectiveAccountId),
    })),
    sessionId: null,
    digest: null,
    expiresAt: null,
  });
  if (source.kind !== 'delegated' && !proven)
    throw new ForbiddenError('The resource must belong to the authenticated requester account.');
  const requester =
    source.kind === 'delegated' ? await delegate(source.requesterAccountId) : proven;
  if (!requester)
    throw new ForbiddenError('The resource must belong to the authenticated requester account.');
  if (
    input.actor.type === 'requester' &&
    (input.actor.accountId !== requester.principalAccountId || input.kind !== 'direct_request')
  ) {
    throw new ForbiddenError('Requester identity must match the original request.');
  }
  if (input.actor.type === 'alia' && input.actor.ownerAccountId !== requester.subjectAccountId) {
    throw new ForbiddenError('Assistant account must match the original request.');
  }
  if (input.actor.type === 'agent') {
    const [actor] = await getDb()
      .select({ kind: users.kind, status: users.accountStatus })
      .from(users)
      .where(eq(users.id, input.actor.accountId))
      .limit(1);
    if (actor?.kind !== 'bot' || actor.status !== 'active')
      throw new ForbiddenError('An active bot actor is required.');
  }
  if (
    input.kind === 'direct_request'
      ? !input.runId || input.automationId !== undefined
      : !input.automationId || input.runId !== undefined || input.stepId !== undefined
  ) {
    throw new BadRequestError('The task must bind its direct run or its automation identity.');
  }
  if (
    task &&
    input.kind === 'automation' &&
    (task.originKind !== 'automation' || input.automationId !== task.originId)
  ) {
    throw new BadRequestError('Automation identity must match its root task.');
  }
  const now = new Date();
  const expiresAt = new Date(input.expiresAt);
  const maxLifetime = input.kind === 'direct_request' ? 15 * 60_000 : 366 * 24 * 60 * 60_000;
  if (
    expiresAt <= now ||
    expiresAt.getTime() - now.getTime() > maxLifetime ||
    (requester.expiresAt !== null &&
      (task || input.kind === 'direct_request') &&
      expiresAt > requester.expiresAt)
  )
    throw new BadRequestError('Task lifetime is out of range.');
  // This is operation policy, derived from a direct request or scheduled task.
  const maximumAutonomy =
    input.kind === 'automation'
      ? 'autonomous'
      : tool.effect === 'read'
        ? 'read_only'
        : 'execute_on_request';
  const limitError =
    capabilityLimitError(input.limits, [tool], input.resource.resourceType) ||
    autonomousSensitiveToolLimitError(maximumAutonomy, tool, input.limits);
  if (limitError) throw new BadRequestError(limitError);
  const agentBinding = task
    ? task.requesterAuthMethodId
      ? { authMethodId: task.requesterAuthMethodId }
      : null
    : requester.sessionId
      ? await readSessionAgentBinding(requester.sessionId, requester.principalAccountId)
      : null;
  const [authorization] = await getDb()
    .insert(capabilityExecutionAuthorizations)
    .values({
      authority: 'first_party',
      taskId: task?.id ?? null,
      kind: input.kind,
      requesterAccountId: requester.principalAccountId,
      requesterAuthMethodId: agentBinding?.authMethodId ?? null,
      requesterSessionId: requester.sessionId,
      requesterSessionBindingDigest: requester.digest,
      requesterCatalogRegistrationId: registration.id,
      requesterCatalogVersion: registration.version,
      requesterCatalogDigest: registration.digest,
      ownerAccountId: input.resource.effectiveAccountId,
      coordinatorApplicationId: presenter.applicationId,
      coordinatorCredentialId: presenter.credentialId,
      actorType: input.actor.type,
      actorAccountId: input.actor.type === 'alia' ? null : input.actor.accountId,
      resourceApp: input.resource.appId,
      effectiveAccountId: input.resource.effectiveAccountId,
      resourceType: input.resource.resourceType,
      resourceKey: input.resource.resourceId,
      tool: input.tool,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      automationId: input.automationId ?? null,
      maximumAutonomy,
      limits: input.limits,
      expiresAt,
    })
    .returning();
  return authorization;
}
