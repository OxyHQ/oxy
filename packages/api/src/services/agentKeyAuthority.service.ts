/** Live autonomous signer checks shared by session validation and account RBAC. */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { sessions } from '../db/schema/sessions';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { ApiError } from '../utils/error';

export interface AgentKeyBinding {
  authMethodId: string;
  authMethodOwnerId: string;
}

/** Linearize a standing grant/write with key revocation and account closure. */
export async function lockLiveAgentKeyForAuthorization(
  tx: Transaction,
  binding: AgentKeyBinding,
  actorId: string,
): Promise<void> {
  if (binding.authMethodOwnerId !== actorId) {
    throw new ApiError(401, 'Autonomous signer does not match principal', 'INVALID_SESSION');
  }
  await tx.select({ id: users.id }).from(users).where(eq(users.id, actorId)).for('share');
  await tx
    .select({ id: userAuthMethods.id })
    .from(userAuthMethods)
    .where(eq(userAuthMethods.id, binding.authMethodId))
    .for('update');
  if (!(await readLiveAgentKey(binding, tx))) {
    throw new ApiError(401, 'Autonomous credential unavailable', 'INVALID_SESSION');
  }
}

/** Carry the credential of the principal, even when the subject is an organization. */
export async function readSessionAgentBinding(
  sessionId: string | undefined,
  actorId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AgentKeyBinding | undefined> {
  if (!sessionId) throw new ApiError(401, 'Live approving session required', 'INVALID_SESSION');
  const [session] = await db
    .select({
      userId: sessions.userId,
      operatorId: sessions.operatedByUserId,
      methodId: sessions.authMethodId,
      ownerId: sessions.authMethodOwnerId,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.sessionId, sessionId),
        eq(sessions.isActive, true),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!session || (session.operatorId ?? session.userId) !== actorId) {
    throw new ApiError(401, 'Live approving session required', 'INVALID_SESSION');
  }
  if (session.methodId && session.ownerId === actorId) {
    const binding = { authMethodId: session.methodId, authMethodOwnerId: actorId };
    if (await readLiveAgentKey(binding, db)) return binding;
    throw new ApiError(401, 'Autonomous credential revoked', 'INVALID_SESSION');
  }
  const [actor] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, actorId));
  if (!actor || actor.kind === 'bot' || session.methodId || session.ownerId) {
    throw new ApiError(401, 'Autonomous credential required', 'INVALID_SESSION');
  }
  return undefined;
}

export async function readLiveAgentKey(
  binding: AgentKeyBinding,
  db: DatabaseOrTransaction = getDb(),
) {
  const [row] = await db
    .select({
      id: userAuthMethods.id,
      userId: userAuthMethods.userId,
      publicKey: userAuthMethods.methodPublicKey,
    })
    .from(userAuthMethods)
    .innerJoin(users, eq(users.id, userAuthMethods.userId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(
      and(
        eq(userAuthMethods.id, binding.authMethodId),
        eq(userAuthMethods.userId, binding.authMethodOwnerId),
        eq(userAuthMethods.type, 'agent_key'),
        isNull(userAuthMethods.revokedAt),
        eq(users.kind, 'bot'),
        eq(users.accountStatus, 'active'),
        isNull(accountClosureFences.accountId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A bare account id never proves autonomous self authority. */
export async function liveAgentSessionOwns(
  sessionId: string,
  actorId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [session] = await db
    .select({
      userId: sessions.userId,
      operatedByUserId: sessions.operatedByUserId,
      authMethodId: sessions.authMethodId,
      authMethodOwnerId: sessions.authMethodOwnerId,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.sessionId, sessionId),
        eq(sessions.isActive, true),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (
    !session ||
    !session.authMethodId ||
    !session.authMethodOwnerId ||
    (session.operatedByUserId ?? session.userId) !== actorId ||
    session.authMethodOwnerId !== actorId
  )
    return false;
  return !!(await readLiveAgentKey(
    { authMethodId: session.authMethodId, authMethodOwnerId: actorId },
    db,
  ));
}
