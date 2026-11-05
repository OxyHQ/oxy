import { resolveRequesterContext } from './requesterContext.service';
import type { IncomingHttpHeaders } from 'node:http';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import {
  validateForegroundRequesterBearer,
  type ForegroundRequesterBinding,
} from './foregroundCapabilityRequester.service';
import { resolveFirstPartyTask, taskAllowsEffectiveAccount } from './firstPartyTasks.service';
import { resolveCapabilityRequester, requireRequesterEffect } from './capabilityRequester.service';
import { ForbiddenError } from '../utils/error';

/** Resolve a session or durable task into an account, independently of any user-id header. */
export async function resolveServiceRequester(
  principal: LiveAgencyServicePrincipal,
  headers: IncomingHttpHeaders,
  effect: 'read' | 'write' = 'read',
): Promise<ForegroundRequesterBinding | undefined> {
  const token = headers['x-oxy-requester-token'];
  const taskId = headers['x-oxy-task-id'];
  const ticket = headers['x-oxy-capability-ticket'];
  const context = headers['x-oxy-requester-context'];
  const proofs = [token, taskId, ticket, context].filter((proof) => proof !== undefined);
  if (proofs.length === 0) return undefined;
  if (principal.authority !== 'first_party' || proofs.length !== 1)
    throw new ForbiddenError('One first-party requester proof is required.');
  if (context !== undefined) {
    const resolved =
      typeof context === 'string' ? await resolveRequesterContext(context, principal) : null;
    if (
      !resolved ||
      (headers['x-oxy-user-id'] !== undefined &&
        headers['x-oxy-user-id'] !== resolved.binding.subjectAccountId)
    )
      throw new ForbiddenError('The forwarded requester context is no longer valid.');
    return resolved.binding;
  }
  if (ticket !== undefined) {
    const requester =
      typeof ticket === 'string' ? await resolveCapabilityRequester(ticket, principal) : null;
    if (
      !requester ||
      (headers['x-oxy-user-id'] !== undefined &&
        headers['x-oxy-user-id'] !== requester.subjectAccountId)
    )
      throw new ForbiddenError('The original operation does not authorize this requester.');
    requireRequesterEffect(requester, effect);
    return requester;
  }
  if (token !== undefined) {
    const requester =
      typeof token === 'string' ? await validateForegroundRequesterBearer(token, principal) : null;
    if (!requester) throw new ForbiddenError('Invalid requester proof.');
    return requester;
  }
  const task =
    typeof taskId === 'string' && taskId.length <= 128
      ? await resolveFirstPartyTask(taskId, principal)
      : null;
  if (!task) throw new ForbiddenError('The original task is no longer authorized.');
  const selected = headers['x-oxy-user-id'] ?? task.effectiveAccountId;
  if (
    typeof selected !== 'string' ||
    selected.length > 128 ||
    !(await taskAllowsEffectiveAccount(task, selected, {
      type: task.actorType,
      accountId: task.actorAccountId ?? undefined,
    }))
  )
    throw new ForbiddenError('The selected account is outside the original task.');
  return {
    sessionId: task.requesterSessionId,
    principalAccountId: task.requesterAccountId,
    subjectAccountId: selected,
    digest: task.requesterSessionBindingDigest,
    expiresAt: task.expiresAt,
  };
}
