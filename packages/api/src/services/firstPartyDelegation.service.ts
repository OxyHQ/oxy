/**
 * An Oxy service acting for a person (ADR 0066): what its registry entry
 * declares, checked live, recorded where the person can see it.
 *
 * There is nothing per person behind it: no session, task, grant or consent,
 * and nothing that lapses. What bounds it:
 *
 * - the service is a live registered workload of an Oxy application
 *   (`authority: first_party`, checked by the service middleware before this);
 * - its registry entry declares the receiver and the effect (`actsForPeople`);
 * - the accounts are live, the person is a person, and when the account acted
 *   on is not the person's own they hold `account:act_as` over it now;
 * - the receiver's own rules still run after this (ownership, privacy,
 *   sharing, tenancy, limits);
 * - every use is counted in `first_party_delegation_activity`.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { firstPartyDelegationActivity } from '../db/schema/firstPartyDelegationActivity';
import { users } from '../db/schema/users';
import { SEED_APPS } from '../scripts/seedOxyApplicationsSpecs';
import {
  declaredDelegation,
  type DelegationEffect,
  type DelegationReceiver,
} from '../utils/firstPartyDelegation';
import { ForbiddenError } from '../utils/error';
import accountService from './account.service';
import { isSupervised } from './supervisionPolicy.service';

/** The accounts a first-party service acts for, after the live checks. */
export interface DelegatedRequester {
  readonly kind: 'delegated';
  /** The person it acts for. */
  readonly principalAccountId: string;
  /** The account it acts on: the person's own, or one they operate. */
  readonly subjectAccountId: string;
  readonly applicationId: string;
  readonly receiver: DelegationReceiver;
  readonly effect: DelegationEffect;
}

export interface DelegationRequest {
  /** The calling application (the live workload's). */
  readonly applicationId: string;
  readonly on: DelegationReceiver;
  readonly effect: DelegationEffect;
  /** The account acted on (`X-Oxy-User-Id`). */
  readonly accountId: string;
  /** The person who asked, when not `accountId` (`X-Oxy-Requester-Id`). */
  readonly requesterAccountId?: string;
}

/** The refusal an undeclared use gets; stable so callers and tests can match it. */
export const UNDECLARED_DELEGATION_MESSAGE =
  'This Oxy service does not declare acting for people here (first_party_capability_not_declared).';

function exactId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

/**
 * Resolve and record one use. Throws `ForbiddenError` when the service does not
 * declare it or the accounts do not hold. `record: false` only re-checks an
 * operation whose use was already recorded (a tool authorization's ticket).
 */
export async function resolveDelegatedRequester(
  request: DelegationRequest,
  options: { record?: boolean } = {},
): Promise<DelegatedRequester> {
  if (!declaredDelegation(SEED_APPS, request.applicationId, request.on, request.effect))
    throw new ForbiddenError(UNDECLARED_DELEGATION_MESSAGE);
  const subject = request.accountId;
  const principal = request.requesterAccountId ?? request.accountId;
  if (!exactId(subject) || !exactId(principal))
    throw new ForbiddenError('An exact account id is required.');
  const ids = [...new Set([principal, subject])];
  const accounts = await getDb()
    .select({
      id: users.id,
      kind: users.kind,
      status: users.accountStatus,
      type: users.type,
      fence: accountClosureFences.accountId,
    })
    .from(users)
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(inArray(users.id, ids));
  const person = accounts.find((account) => account.id === principal);
  if (
    accounts.length !== ids.length ||
    accounts.some((account) => account.status !== 'active' || account.fence !== null) ||
    person?.kind !== 'personal' ||
    person.type !== 'local'
  )
    throw new ForbiddenError('The account is not available.');
  if ((await Promise.all(ids.map((id) => isSupervised(id)))).some(Boolean))
    throw new ForbiddenError('Supervised accounts are not acted for by services.');
  if (subject !== principal) {
    const access = await accountService.resolveEffectiveAccess(principal, subject);
    if (!access?.permissions.includes('account:act_as'))
      throw new ForbiddenError('The person does not operate this account.');
  }
  if (options.record !== false)
    await recordDelegatedUse({
      accountId: subject,
      requesterAccountId: principal,
      applicationId: request.applicationId,
      receiver: request.on,
      effect: request.effect,
    });
  return {
    kind: 'delegated',
    principalAccountId: principal,
    subjectAccountId: subject,
    applicationId: request.applicationId,
    receiver: request.on,
    effect: request.effect,
  };
}

/** Count one use for the day (UTC). */
export async function recordDelegatedUse(use: {
  accountId: string;
  requesterAccountId: string;
  applicationId: string;
  receiver: DelegationReceiver;
  effect: DelegationEffect;
}): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await getDb()
    .insert(firstPartyDelegationActivity)
    .values({ ...use, day })
    .onConflictDoUpdate({
      target: [
        firstPartyDelegationActivity.accountId,
        firstPartyDelegationActivity.requesterAccountId,
        firstPartyDelegationActivity.applicationId,
        firstPartyDelegationActivity.receiver,
        firstPartyDelegationActivity.effect,
        firstPartyDelegationActivity.day,
      ],
      set: {
        count: sql`${firstPartyDelegationActivity.count} + 1`,
        lastAt: sql`now()`,
      },
    });
}

/** What Oxy's services did for `accountId` (as account acted on or as the person), newest first. */
export async function listDelegatedActivity(accountId: string, limit = 200) {
  return getDb()
    .select({
      applicationId: firstPartyDelegationActivity.applicationId,
      accountId: firstPartyDelegationActivity.accountId,
      requesterAccountId: firstPartyDelegationActivity.requesterAccountId,
      receiver: firstPartyDelegationActivity.receiver,
      effect: firstPartyDelegationActivity.effect,
      day: firstPartyDelegationActivity.day,
      count: firstPartyDelegationActivity.count,
      firstAt: firstPartyDelegationActivity.firstAt,
      lastAt: firstPartyDelegationActivity.lastAt,
    })
    .from(firstPartyDelegationActivity)
    .where(
      sql`${firstPartyDelegationActivity.accountId} = ${accountId} or ${firstPartyDelegationActivity.requesterAccountId} = ${accountId}`,
    )
    .orderBy(sql`${firstPartyDelegationActivity.lastAt} desc`)
    .limit(limit);
}
