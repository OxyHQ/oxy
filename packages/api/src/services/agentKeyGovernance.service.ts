/** Transferable account governance and self rotation; no permanent creator rights. */
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  AGENT_PROOF_AUDIENCE, AGENT_PROOF_TTL_MS, buildAgentProofMessage,
  type AgentKeyOperation, type AgentKeyOperationProof, type AgentProofAction, type AgentProofClaims,
} from '@oxy.so/contracts';
import { getDb, type Transaction } from '../config/postgres';
import { accountMembers } from '../db/schema/accountMembers';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { userAncestors } from '../db/schema/userAncestors';
import { users } from '../db/schema/users';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { authChallenges } from '../db/schema/authChallenges';
import { sessions } from '../db/schema/sessions';
import { authCodes } from '../db/schema/authCodes';
import { securityActivities } from '../db/schema/securityActivities';
import { effectivePermissionsForMember } from '../utils/accountRoles';
import { ApiError } from '../utils/error';
import { resolveEffectiveMembership } from './account.service';
import { readLiveAgentKey } from './agentKeyAuthority.service';
import { digestIdentityPayload } from './identityProof.service';
import SignatureService from './signature.service';
import sessionService from './session.service';
import { verifyReauth } from './reauth.service';

function denied() { return new ApiError(403, 'Current account governance is required', 'FORBIDDEN'); }
function invalid() { return new ApiError(401, 'Fresh proof is required for this operation', 'INVALID_AGENT_PROOF'); }

async function readMembership(tx: Transaction, actorId: string, accountId: string) {
    const ancestors = await tx.select({ ancestorId: userAncestors.ancestorId }).from(userAncestors)
      .where(eq(userAncestors.userId, accountId)).orderBy(asc(userAncestors.depth)).for('share');
    const path = ancestors.map((a) => a.ancestorId);
    const members = await tx.select().from(accountMembers).where(and(
      eq(accountMembers.memberUserId, actorId), eq(accountMembers.status, 'active'),
      inArray(accountMembers.accountId, [accountId, ...path]),
    )).orderBy(asc(accountMembers.id)).for('update');
    return resolveEffectiveMembership(members, accountId, path);
}

async function operationContext(tx: Transaction, sessionId: string, targetId: string, operation: AgentKeyOperation) {
  const [session] = await tx.select({ userId: sessions.userId, operatedByUserId: sessions.operatedByUserId,
    authMethodId: sessions.authMethodId, authMethodOwnerId: sessions.authMethodOwnerId,
  }).from(sessions).where(and(eq(sessions.sessionId, sessionId), eq(sessions.isActive, true), gt(sessions.expiresAt, new Date()))).limit(1);
  if (!session) throw invalid();
  const actorId = session.operatedByUserId ?? session.userId;
  // Stable ordering for a responsible bot managing another bot.
  await tx.select({ id: users.id }).from(users).where(inArray(users.id, [...new Set([actorId, targetId, session.userId])]))
    .orderBy(asc(users.id)).for('update');
  const [target] = await tx.select({ kind: users.kind, status: users.accountStatus, fence: accountClosureFences.accountId })
    .from(users).leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id)).where(eq(users.id, targetId));
  if (!target || target.kind !== 'bot' || target.status !== 'active' || target.fence) throw denied();
  // Re-read signer under account locks. Never infer the governor from an effective account id.
  const [actor] = await tx.select({ publicKey: users.publicKey, kind: users.kind, status: users.accountStatus,
    fence: accountClosureFences.accountId }).from(users)
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id)).where(eq(users.id, actorId));
  if (!actor || actor.status !== 'active' || actor.fence) throw invalid();
  let governorPublicKey = actor.kind === 'personal' ? actor.publicKey : null;
  const governorMethodId = session.authMethodId;
  if (governorMethodId) {
    if (session.authMethodOwnerId !== actorId) throw invalid();
    await tx.select({ id: userAuthMethods.id }).from(userAuthMethods).where(eq(userAuthMethods.id, governorMethodId)).for('update');
    const live = await readLiveAgentKey({ authMethodId: governorMethodId, authMethodOwnerId: actorId }, tx);
    if (!live) throw invalid();
    governorPublicKey = live.publicKey;
  } else if (actor.kind === 'bot') throw invalid();

  if (session.operatedByUserId) {
    const [subject] = await tx.select({ status: users.accountStatus, fence: accountClosureFences.accountId })
      .from(users).leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
      .where(eq(users.id, session.userId));
    const acting = await readMembership(tx, actorId, session.userId);
    if (!subject || subject.status !== 'active' || subject.fence || !acting
      || !effectivePermissionsForMember(acting.row).includes('account:act_as')) throw invalid();
  }
  // Session sign-out/replacement cannot interleave the final authorization.
  const [stillLive] = await tx.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.sessionId, sessionId), eq(sessions.isActive, true), gt(sessions.expiresAt, new Date()),
    eq(sessions.userId, session.userId),
    session.operatedByUserId ? eq(sessions.operatedByUserId, session.operatedByUserId) : isNull(sessions.operatedByUserId),
    session.authMethodId ? eq(sessions.authMethodId, session.authMethodId) : isNull(sessions.authMethodId),
    session.authMethodOwnerId ? eq(sessions.authMethodOwnerId, session.authMethodOwnerId) : isNull(sessions.authMethodOwnerId),
  )).for('update').limit(1);
  if (!stillLive) throw invalid();

  if (operation.operation === 'rotate') {
    if (actorId !== targetId || !governorMethodId) throw denied();
  } else {
    const membership = await readMembership(tx, actorId, targetId);
    if (!membership || !['owner', 'admin'].includes(membership.row.role)
      || !effectivePermissionsForMember(membership.row).includes('credentials:manage')) throw denied();
  }
  let publicKey: string;
  let methodId: string | null = operation.operation === 'rotate' ? governorMethodId : null;
  if (operation.operation === 'revoke') {
    const [method] = await tx.select({ publicKey: userAuthMethods.methodPublicKey }).from(userAuthMethods).where(and(
      eq(userAuthMethods.id, operation.methodId), eq(userAuthMethods.userId, targetId), eq(userAuthMethods.type, 'agent_key'),
    )).for('update');
    if (!method?.publicKey) throw new ApiError(404, 'Agent credential not found', 'NOT_FOUND');
    publicKey = method.publicKey;
    methodId = operation.methodId;
  } else {
    try { publicKey = SignatureService.canonicalizePublicKey(operation.publicKey); }
    catch { throw new ApiError(400, 'Invalid public key', 'BAD_REQUEST'); }
  }
  const action: AgentProofAction = { enroll: 'agent_enroll', recover: 'agent_recover', rotate: 'agent_rotate', revoke: 'agent_governance' }[operation.operation] as AgentProofAction;
  const payloadDigest = digestIdentityPayload({
    operation: operation.operation, publicKey, label: 'label' in operation ? operation.label : null,
    methodId, governorMethodId, governorPublicKey,
    retireCurrent: operation.operation === 'rotate' && operation.retireCurrent === true,
  });
  return { actorId, actorKind: actor.kind, governorPublicKey, governorMethodId, publicKey, methodId, action, payloadDigest };
}

type Context = Awaited<ReturnType<typeof operationContext>>;
function claimsFor(context: Context, targetId: string, challenge: string, expiresAt: Date): AgentProofClaims {
  return { version: 1, audience: AGENT_PROOF_AUDIENCE, action: context.action,
    accountId: targetId, actorId: context.actorId, authMethodId: context.methodId,
    publicKey: context.publicKey, payloadDigest: context.payloadDigest, challenge, expiresAt: expiresAt.getTime() };
}

export async function requestAgentKeyOperation(sessionId: string, targetId: string, operation: AgentKeyOperation) {
  return getDb().transaction(async (tx) => {
    const context = await operationContext(tx, sessionId, targetId, operation);
    const challenge = SignatureService.generateChallenge();
    const expiresAt = new Date(Date.now() + AGENT_PROOF_TTL_MS);
    await tx.insert(authChallenges).values({ challenge, expiresAt, publicKey: context.publicKey,
      purpose: context.action, actorId: context.actorId, accountId: targetId, bindingDigest: context.payloadDigest });
    return { claims: claimsFor(context, targetId, challenge, expiresAt), governorPublicKey: context.governorPublicKey };
  });
}

async function revokeMethods(tx: Transaction, targetId: string, methodId?: string) {
  const revoked = await tx.update(userAuthMethods).set({ revokedAt: new Date() }).where(and(
    eq(userAuthMethods.userId, targetId), eq(userAuthMethods.type, 'agent_key'), isNull(userAuthMethods.revokedAt),
    ...(methodId ? [eq(userAuthMethods.id, methodId)] : []),
  )).returning({ id: userAuthMethods.id, publicKey: userAuthMethods.methodPublicKey });
  if (revoked.length) {
    const ids = revoked.map((r) => r.id);
    await tx.update(sessions).set({ isActive: false }).where(inArray(sessions.authMethodId, ids));
    await tx.update(authCodes).set({ expiresAt: new Date(), usedAt: new Date() }).where(inArray(authCodes.authMethodId, ids));
    const keys = revoked.flatMap((r) => r.publicKey ? [r.publicKey] : []);
    if (keys.length) await tx.update(authChallenges).set({ used: true }).where(and(
      eq(authChallenges.accountId, targetId), inArray(authChallenges.publicKey, keys),
    ));
  }
  return revoked.map((r) => r.id);
}

export async function executeAgentKeyOperation(sessionId: string, targetId: string, operation: AgentKeyOperation, proof: AgentKeyOperationProof) {
  // Email/password reauth consumes its own action-bound code before the write;
  // the transaction below independently rechecks current membership and session.
  let reauthenticatedActorId: string | undefined;
  if (proof.reauth) {
    const auth = await sessionService.validateSessionById(sessionId, false, { useCache: false });
    if (!auth) throw invalid();
    const actorId = auth.session.operatedByUserId ?? auth.session.userId;
    const [actor] = await getDb().select({ kind: users.kind }).from(users).where(eq(users.id, actorId));
    if (actor?.kind !== 'personal') throw invalid();
    await verifyReauth(actorId, proof.reauth, 'credentials_manage');
    reauthenticatedActorId = actorId;
  }
  return getDb().transaction(async (tx) => {
    const context = await operationContext(tx, sessionId, targetId, operation);
    const [challenge] = await tx.select({ id: authChallenges.id, expiresAt: authChallenges.expiresAt })
      .from(authChallenges).where(and(
        eq(authChallenges.challenge, proof.challenge), eq(authChallenges.used, false),
        eq(authChallenges.purpose, context.action), eq(authChallenges.actorId, context.actorId),
        eq(authChallenges.accountId, targetId), eq(authChallenges.publicKey, context.publicKey),
        eq(authChallenges.bindingDigest, context.payloadDigest), gt(authChallenges.expiresAt, new Date()),
      )).for('update').limit(1);
    if (!challenge || !SignatureService.isTimestampFresh(proof.timestamp, AGENT_PROOF_TTL_MS)) throw invalid();
    const claims = claimsFor(context, targetId, proof.challenge, challenge.expiresAt);
    const reauthenticated = context.actorKind === 'personal' && reauthenticatedActorId === context.actorId;
    if (!reauthenticated && context.governorPublicKey) {
      if (!proof.governorSignature || !SignatureService.verifySignature(
        buildAgentProofMessage(claims, proof.timestamp, 'governor'), proof.governorSignature, context.governorPublicKey,
      )) throw invalid();
    } else if (!reauthenticated) throw invalid();
    if (operation.operation !== 'revoke' && (!proof.keySignature || !SignatureService.verifySignature(
      buildAgentProofMessage(claims, proof.timestamp), proof.keySignature, context.publicKey,
    ))) throw new ApiError(400, 'New key proof of possession required', 'KEY_PROOF_REQUIRED');
    await tx.update(authChallenges).set({ used: true }).where(eq(authChallenges.id, challenge.id));
    const revokedIds = operation.operation === 'recover'
      ? await revokeMethods(tx, targetId)
      : operation.operation === 'revoke'
        ? await revokeMethods(tx, targetId, operation.methodId)
        : operation.operation === 'rotate' && operation.retireCurrent && context.methodId
          ? await revokeMethods(tx, targetId, context.methodId) : [];
    let keyId = context.methodId;
    if (operation.operation !== 'revoke') {
      const [root] = await tx.select({ id: users.id }).from(users).where(sql`lower(btrim(${users.publicKey})) = ${context.publicKey}`);
      if (root) throw new ApiError(409, 'Public key is already registered', 'CONFLICT');
      const [created] = await tx.insert(userAuthMethods).values({
        userId: targetId, type: 'agent_key', methodPublicKey: context.publicKey, label: operation.label,
        enrolledByUserId: context.actorId,
        enrollmentMethod: operation.operation === 'rotate' ? 'rotation' : operation.operation === 'recover' ? 'recovery' : 'governor',
      }).onConflictDoNothing().returning({ id: userAuthMethods.id });
      if (!created) throw new ApiError(409, 'Public key is already registered', 'CONFLICT');
      keyId = created.id;
    }
    await tx.insert(securityActivities).values({
      userId: targetId, eventType: 'security_settings_changed', severity: 'high',
      eventDescription: `Agent credential ${operation.operation}`,
      metadata: { action: `agent_key.${operation.operation}`, actorAccountId: context.actorId,
        effectiveAccountId: targetId, methodId: keyId, revokedMethodIds: revokedIds },
    });
    return { methodId: keyId, revokedMethodIds: revokedIds };
  });
}
