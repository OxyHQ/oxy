import type { IncomingHttpHeaders } from 'node:http';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import {
  validateForegroundRequesterBearer,
  type ForegroundRequesterBinding,
} from './foregroundCapabilityRequester.service';
import { resolveFirstPartyTask, taskAllowsEffectiveAccount } from './firstPartyTasks.service';
import { ForbiddenError } from '../utils/error';

/** Resolve a session or durable task into an account, independently of any user-id header. */
export async function resolveServiceRequester(
  principal: LiveAgencyServicePrincipal,
  headers: IncomingHttpHeaders,
): Promise<ForegroundRequesterBinding | undefined> {
  const token = headers['x-oxy-requester-token'];
  const taskId = headers['x-oxy-task-id'];
  if (token === undefined && taskId === undefined) return undefined;
  if (principal.authority !== 'first_party' || (token !== undefined && taskId !== undefined))
    throw new ForbiddenError('One first-party requester proof is required.');
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
