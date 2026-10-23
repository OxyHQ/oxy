import { firstPartyTaskInputSchema, type FirstPartyTaskInput } from '@oxy.so/contracts';
import { and, eq, gt, isNull, inArray } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { firstPartyTasks } from '../db/schema/agency';
import { users } from '../db/schema/users';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { ForbiddenError, BadRequestError } from '../utils/error';
import {
  validateForegroundRequesterBearer,
  revalidateForegroundRequester,
} from './foregroundCapabilityRequester.service';
import { readSessionAgentBinding, readLiveAgentKey } from './agentKeyAuthority.service';
import {
  resolveLiveAgencyCoordinator,
  type LiveAgencyServicePrincipal,
} from './agencyServicePrincipal.service';
import accountService from './account.service';
import { isSupervised } from './supervisionPolicy.service';

export type FirstPartyTaskRow = typeof firstPartyTasks.$inferSelect;

export async function createFirstPartyTask(
  raw: FirstPartyTaskInput,
  subjectToken: string,
  presenter: LiveAgencyServicePrincipal,
) {
  const input = firstPartyTaskInputSchema.parse(raw);
  if (presenter.authority !== 'first_party')
    throw new ForbiddenError('A live Oxy workload is required.');
  const requester = await validateForegroundRequesterBearer(subjectToken, presenter);
  if (!requester || requester.subjectAccountId !== input.effectiveAccountId)
    throw new ForbiddenError('Original requester proof is required.');
  if (input.actor.type === 'requester' && input.actor.accountId !== requester.principalAccountId)
    throw new ForbiddenError('Requester identity does not match.');
  if (input.actor.type === 'alia' && input.actor.ownerAccountId !== input.effectiveAccountId)
    throw new ForbiddenError('Assistant identity does not match.');
  if (input.actor.type === 'agent') {
    const [actor] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, input.actor.accountId))
      .limit(1);
    if (actor?.kind !== 'bot' || actor.accountStatus !== 'active')
      throw new ForbiddenError('An active bot actor is required.');
  }
  const now = new Date();
  const expiresAt = new Date(input.expiresAt);
  const maximumLifetime = input.origin.kind === 'request' ? 15 * 60_000 : 366 * 24 * 60 * 60_000;
  if (
    expiresAt <= now ||
    expiresAt.getTime() - now.getTime() > maximumLifetime ||
    (input.origin.kind === 'request' && expiresAt > requester.expiresAt)
  )
    throw new BadRequestError('Task lifetime is out of range.');
  const signer = await readSessionAgentBinding(requester.sessionId, requester.principalAccountId);
  const [task] = await getDb()
    .insert(firstPartyTasks)
    .values({
      originKind: input.origin.kind,
      originId: input.origin.id,
      requesterAccountId: requester.principalAccountId,
      effectiveAccountId: requester.subjectAccountId,
      requesterSessionId: requester.sessionId,
      requesterSessionBindingDigest: requester.digest,
      requesterAuthMethodId: signer?.authMethodId ?? null,
      coordinatorApplicationId: presenter.applicationId,
      coordinatorCredentialId: presenter.credentialId,
      actorType: input.actor.type,
      actorAccountId: input.actor.type === 'alia' ? null : input.actor.accountId,
      expiresAt,
    })
    .returning();
  return task;
}

/** Shared by derivation and every ticket use; an identifier alone grants nothing. */
export async function resolveFirstPartyTask(
  taskId: string,
  coordinator: { applicationId: string; credentialId: string },
): Promise<FirstPartyTaskRow | null> {
  const presenter = await resolveLiveAgencyCoordinator(
    coordinator.applicationId,
    coordinator.credentialId,
    'first_party',
  );
  if (!presenter || presenter.authority !== 'first_party') return null;
  const [task] = await getDb()
    .select()
    .from(firstPartyTasks)
    .where(
      and(
        eq(firstPartyTasks.id, taskId),
        eq(firstPartyTasks.coordinatorApplicationId, coordinator.applicationId),
        eq(firstPartyTasks.coordinatorCredentialId, coordinator.credentialId),
        isNull(firstPartyTasks.revokedAt),
        gt(firstPartyTasks.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!task) return null;
  const subjectIds = [
    ...new Set([
      task.requesterAccountId,
      task.effectiveAccountId,
      ...(task.actorAccountId ? [task.actorAccountId] : []),
    ]),
  ];
  const subjects = await getDb()
    .select({
      id: users.id,
      status: users.accountStatus,
      kind: users.kind,
      fence: accountClosureFences.accountId,
    })
    .from(users)
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(inArray(users.id, subjectIds));
  if (
    subjects.length !== subjectIds.length ||
    subjects.some(
      (subject) =>
        subject.status !== 'active' ||
        subject.fence !== null ||
        (task.actorType === 'agent' &&
          subject.id === task.actorAccountId &&
          subject.kind !== 'bot'),
    )
  )
    return null;
  if ((await Promise.all(subjectIds.map(isSupervised))).some(Boolean)) return null;
  const access = await accountService.resolveEffectiveAccess(
    task.requesterAccountId,
    task.effectiveAccountId,
  );
  if (!access || !access.permissions.includes('account:act_as')) return null;
  if (
    task.requesterAuthMethodId &&
    !(await readLiveAgentKey({
      authMethodId: task.requesterAuthMethodId,
      authMethodOwnerId: task.requesterAccountId,
    }))
  )
    return null;
  if (
    task.originKind === 'request' &&
    !(await revalidateForegroundRequester(
      {
        sessionId: task.requesterSessionId,
        principalAccountId: task.requesterAccountId,
        subjectAccountId: task.effectiveAccountId,
        digest: task.requesterSessionBindingDigest,
      },
      presenter,
    ))
  )
    return null;
  return task;
}

export async function revokeFirstPartyTask(
  taskId: string,
  presenter: LiveAgencyServicePrincipal,
): Promise<void> {
  if (presenter.authority !== 'first_party')
    throw new ForbiddenError('A live Oxy workload is required.');
  await getDb()
    .update(firstPartyTasks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(firstPartyTasks.id, taskId),
        eq(firstPartyTasks.coordinatorApplicationId, presenter.applicationId),
        eq(firstPartyTasks.coordinatorCredentialId, presenter.credentialId),
      ),
    );
}

/** A bot's self tools require the original requester to operate that exact bot. */
export async function taskAllowsEffectiveAccount(
  task: FirstPartyTaskRow,
  effectiveAccountId: string,
  actor: { type: string; accountId?: string },
): Promise<boolean> {
  if (effectiveAccountId === task.effectiveAccountId) return true;
  if (
    actor.type !== 'agent' ||
    actor.accountId !== effectiveAccountId ||
    task.actorType !== 'agent' ||
    task.actorAccountId !== effectiveAccountId
  )
    return false;
  const access = await accountService.resolveEffectiveAccess(
    task.requesterAccountId,
    effectiveAccountId,
  );
  return access?.permissions.includes('account:act_as') === true;
}
