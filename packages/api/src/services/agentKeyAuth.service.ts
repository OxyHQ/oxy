/** Autonomous sign-in: live key + action-bound one-use proof + ordinary session. */
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import {
  AGENT_PROOF_AUDIENCE, AGENT_PROOF_TTL_MS, buildAgentProofMessage,
  type AgentProofClaims, type AgentSignature,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { authChallenges } from '../db/schema/authChallenges';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { ApiError } from '../utils/error';
import SignatureService from './signature.service';
import sessionService from './session.service';
import securityActivityService from './securityActivityService';
import { logger } from '../utils/logger';
import { readLiveAgentKey } from './agentKeyAuthority.service';
import { digestIdentityPayload } from './identityProof.service';

function invalidProof(): ApiError { return new ApiError(401, 'Invalid or expired agent proof', 'INVALID_AGENT_PROOF'); }

async function signer(publicKey: string, db: DatabaseOrTransaction) {
  let key: string;
  try { key = SignatureService.canonicalizePublicKey(publicKey); }
  catch { throw new ApiError(400, 'Invalid public key', 'BAD_REQUEST'); }
  const [row] = await db.select({ id: userAuthMethods.id, userId: userAuthMethods.userId, publicKey: userAuthMethods.methodPublicKey })
    .from(userAuthMethods).innerJoin(users, eq(users.id, userAuthMethods.userId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id)).where(and(
      eq(userAuthMethods.methodPublicKey, key), eq(userAuthMethods.type, 'agent_key'),
      isNull(userAuthMethods.revokedAt), eq(users.kind, 'bot'), eq(users.accountStatus, 'active'), isNull(accountClosureFences.accountId),
    )).limit(1);
  if (!row || !row.publicKey) throw new ApiError(404, 'Agent credential unavailable', 'NOT_FOUND');
  return { ...row, publicKey: row.publicKey };
}

function signInClaims(
  key: { id: string; userId: string; publicKey: string },
  challenge: string,
  expiresAt: Date,
): AgentProofClaims {
  return {
    version: 1, audience: AGENT_PROOF_AUDIENCE, action: 'agent_signin',
    accountId: key.userId, actorId: key.userId, authMethodId: key.id, publicKey: key.publicKey,
    payloadDigest: digestIdentityPayload({ authMethodId: key.id, publicKey: key.publicKey }),
    challenge, expiresAt: expiresAt.getTime(),
  };
}

export async function requestAgentChallenge(publicKey: string): Promise<AgentProofClaims> {
  return getDb().transaction(async (tx) => {
    const key = await signer(publicKey, tx);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, key.userId)).for('share');
    await tx.select({ id: userAuthMethods.id }).from(userAuthMethods).where(eq(userAuthMethods.id, key.id)).for('share');
    if (!(await readLiveAgentKey({ authMethodId: key.id, authMethodOwnerId: key.userId }, tx))) throw invalidProof();
    const challenge = SignatureService.generateChallenge();
    const expiresAt = new Date(Date.now() + AGENT_PROOF_TTL_MS);
    const claims = signInClaims(key, challenge, expiresAt);
    await tx.insert(authChallenges).values({
      challenge, expiresAt, publicKey: key.publicKey, purpose: claims.action,
      accountId: key.userId, actorId: key.userId, bindingDigest: claims.payloadDigest,
    });
    return claims;
  });
}

export async function verifyAgentChallenge(publicKey: string, proof: AgentSignature, req: Request) {
  const session = await getDb().transaction(async (tx) => {
    const key = await signer(publicKey, tx);
    // Account → key → challenge is also the revocation/rotation lock order.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, key.userId)).for('share');
    await tx.select({ id: userAuthMethods.id }).from(userAuthMethods).where(eq(userAuthMethods.id, key.id)).for('update');
    const authMethod = { authMethodId: key.id, authMethodOwnerId: key.userId };
    if (!(await readLiveAgentKey(authMethod, tx))) throw invalidProof();
    const [challenge] = await tx.select({ id: authChallenges.id, expiresAt: authChallenges.expiresAt, bindingDigest: authChallenges.bindingDigest })
      .from(authChallenges).where(and(
        eq(authChallenges.challenge, proof.challenge), eq(authChallenges.publicKey, key.publicKey),
        eq(authChallenges.purpose, 'agent_signin'), eq(authChallenges.accountId, key.userId),
        eq(authChallenges.actorId, key.userId), eq(authChallenges.used, false), gt(authChallenges.expiresAt, new Date()),
      )).for('update').limit(1);
    if (!challenge) throw invalidProof();
    const claims = signInClaims(key, proof.challenge, challenge.expiresAt);
    if (claims.payloadDigest !== challenge.bindingDigest
      || !SignatureService.isTimestampFresh(proof.timestamp, AGENT_PROOF_TTL_MS)
      || !SignatureService.verifySignature(buildAgentProofMessage(claims, proof.timestamp), proof.signature, key.publicKey)) throw invalidProof();
    await tx.update(authChallenges).set({ used: true }).where(eq(authChallenges.id, challenge.id));
    await tx.update(userAuthMethods).set({ lastUsedAt: new Date() }).where(eq(userAuthMethods.id, key.id));
    return sessionService.createSession(key.userId, req, {
      authMethod, executor: tx, stableDeviceKey: `agent-key:${key.id}`, deviceName: 'Agent runtime',
    });
  });
  // Deliberate post-commit audit: logging failure cannot undo the consumed proof
  // or turn a committed sign-in into an error that encourages replay.
  try {
    await securityActivityService.logSignIn(session.userId, req, session.deviceId, {
      deviceName: session.deviceName ?? undefined, deviceType: session.deviceType, platform: session.platform,
    });
  } catch (error) {
    logger.warn('Agent sign-in audit could not be recorded', { sessionId: session.sessionId, error });
  }
  return session;
}
