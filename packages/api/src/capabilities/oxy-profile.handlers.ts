import { randomUUID } from 'node:crypto';
import { recommendationRequestSchema, type CapabilityTicketClaims } from '@oxy.so/contracts';
import { buildRecommendations, isExcludableUserType } from '../routes/profiles';
import { userService } from '../services/user.service';
import graphCache from '../utils/graphCache';
import { PAGINATION } from '../utils/constants';
import { reauthorizeCapabilityTicket } from '../services/capabilityAuthority.service';
import { persistCapabilityAuditEvent } from '../services/capabilityRuntimeStore.service';

/** Domain logic is shared with HTTP; identity is always signed and live checked. */
export async function executeOxyProfileRead(
  input: Readonly<Record<string, unknown>>,
  claims: CapabilityTicketClaims,
): Promise<Record<string, unknown>> {
  if (
    Date.now() >= claims.exp * 1000 ||
    claims.actor.type !== 'requester' ||
    claims.autonomy !== 'read_only' ||
    claims.resource.appId !== 'oxy' ||
    claims.resource.resourceType !== 'account' ||
    claims.resource.resourceId !== claims.resource.effectiveAccountId
  )
    throw new Error('Foreground authority refused');
  const requireCurrent = async () => {
    const decision = await reauthorizeCapabilityTicket(claims);
    if (!decision.allowed || Date.now() >= claims.exp * 1000)
      throw new Error('Foreground authority withdrawn');
  };
  await requireCurrent();
  const subject = claims.resource.effectiveAccountId;
  let result: Record<string, unknown>;
  if (claims.tool === 'recommendProfiles') {
    const body = recommendationRequestSchema.strict().parse(input);
    // Application.id is the exact profile/signal key; it is not an app slug.
    const applicationId = claims.coordinator.applicationId;
    if (body.clientId !== undefined && body.clientId !== applicationId)
      throw new Error('Presenting application mismatch');
    result = {
      recommendations: await buildRecommendations(subject, {
        limit: body.limit ?? PAGINATION.DEFAULT_LIMIT,
        offset: body.offset ?? 0,
        excludeTypes: (body.excludeTypes ?? []).filter(isExcludableUserType),
        excludeIds: body.excludeIds ?? [],
        clientId: applicationId,
        boosts: body.boosts,
        signalWeights: body.signalWeights,
      }),
    };
  } else if (claims.tool === 'readViewerGraph') {
    if (Object.keys(input).length !== 0) throw new Error('Viewer graph accepts no selector');
    const cached = await graphCache.get(subject);
    const graph = cached ?? (await userService.getViewerGraph(subject));
    if (!cached) await graphCache.set(subject, graph);
    result = { ...graph };
  } else throw new Error('Foreground read tool refused');
  // Do not release private data after an I/O wait if authority was withdrawn.
  await requireCurrent();
  await persistCapabilityAuditEvent({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    requesterAccountId: claims.requesterAccountId,
    coordinator: claims.coordinator,
    executor: claims.actor,
    effectiveAccountId: subject,
    resource: claims.resource,
    appId: 'oxy',
    tool: claims.tool,
    capabilities: claims.capabilities,
    policyDecision: { allowed: true, reason: 'current_present_requester' },
    result: { status: 'succeeded' },
    rollback: { supported: false, attempted: false },
    correlation: { runId: claims.runId, stepId: claims.stepId, capabilityTicketId: claims.jti },
  });
  // Audit persistence is also an I/O boundary. Recheck after the last await
  // before releasing data; an audit write cannot keep withdrawn authority alive.
  await requireCurrent();
  return result;
}
