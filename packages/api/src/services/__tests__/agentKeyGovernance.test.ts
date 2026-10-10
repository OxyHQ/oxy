/** Responsible humans/bots use the same current RBAC, with fresh proof and SQL. */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { buildAgentProofMessage, type AgentKeyOperation } from '@oxy.so/contracts';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { accountMembers } from '../../db/schema/accountMembers';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { securityActivities } from '../../db/schema/securityActivities';
import { authChallenges } from '../../db/schema/authChallenges';
import SignatureService from '../signature.service';
import sessionService from '../session.service';
import accountService from '../account.service';
import { storePassword } from '../password.service';
import { requestAgentChallenge, verifyAgentChallenge } from '../agentKeyAuth.service';
import {
  executeAgentKeyOperation,
  requestAgentKeyOperation,
  listAgentKeys,
} from '../agentKeyGovernance.service';

const request = { headers: { 'user-agent': 'governor-fixture' } } as Request;
let counter = 500;
function keys() {
  const privateKey = (++counter).toString(16).padStart(64, '0');
  return {
    privateKey,
    publicKey: SignatureService.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey)),
  };
}
async function fixture(kind: 'personal' | 'bot' = 'personal') {
  const actorKey = keys();
  const [actor] = await getDb()
    .insert(users)
    .values({ kind, ...(kind === 'personal' ? { publicKey: actorKey.publicKey } : {}) })
    .returning({ id: users.id });
  const [target] = await getDb().insert(users).values({ kind: 'bot' }).returning({ id: users.id });
  let session: Awaited<ReturnType<typeof sessionService.createSession>>;
  if (kind === 'bot') {
    const [key] = await getDb()
      .insert(userAuthMethods)
      .values({
        userId: actor.id,
        type: 'agent_key',
        methodPublicKey: actorKey.publicKey,
        label: 'governor',
        enrollmentMethod: 'governor',
      })
      .returning({ id: userAuthMethods.id });
    session = await sessionService.createSession(actor.id, request, {
      authMethod: { authMethodId: key.id, authMethodOwnerId: actor.id },
      stableDeviceKey: `fixture:${randomUUID()}`,
    });
  } else
    session = await sessionService.createSession(actor.id, request, { deviceId: randomUUID() });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: target.id, memberUserId: actor.id, role: 'owner', status: 'active' });
  return { actor, target, actorKey, session };
}
async function signedOperation(
  sessionId: string,
  targetId: string,
  operation: AgentKeyOperation,
  governorPrivateKey: string,
  newPrivateKey?: string,
) {
  const challenge = await requestAgentKeyOperation(sessionId, targetId, operation);
  const timestamp = Date.now();
  return {
    challenge: challenge.claims.challenge,
    timestamp,
    governorSignature: SignatureService.signMessage(
      buildAgentProofMessage(challenge.claims, timestamp, 'governor'),
      governorPrivateKey,
    ),
    ...(newPrivateKey
      ? {
          keySignature: SignatureService.signMessage(
            buildAgentProofMessage(challenge.claims, timestamp),
            newPrivateKey,
          ),
        }
      : {}),
  };
}
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET ??= `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
  await connectPostgres();
});
afterAll(closePostgres);

it('bot self operations do not turn an explicit admin membership into owner authority', async () => {
  const f = await fixture('bot');
  await getDb()
    .insert(accountMembers)
    .values({ accountId: f.actor.id, memberUserId: f.actor.id, role: 'admin', status: 'active' });
  const [owner] = await getDb()
    .insert(accountMembers)
    .values({ accountId: f.actor.id, memberUserId: f.target.id, role: 'owner', status: 'active' })
    .returning({ id: accountMembers.id });
  const [other] = await getDb()
    .insert(users)
    .values({ kind: 'personal' })
    .returning({ id: users.id });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: f.actor.id, memberUserId: other.id, role: 'owner', status: 'active' });
  const access = await accountService.resolveEffectiveAccess(
    f.actor.id,
    f.actor.id,
    f.session.sessionId,
  );
  expect(access?.permissions).toContain('members:remove');
  // The remove-member route uses this predicate; an admin cannot remove an owner.
  await expect(
    accountService.removeMember(f.actor.id, owner.id, access?.role === 'owner'),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(access?.role).toBe('admin');
  const ownerAccess = await accountService.resolveEffectiveAccess(other.id, f.actor.id);
  await expect(
    accountService.removeMember(f.actor.id, owner.id, ownerAccess?.role === 'owner'),
  ).resolves.toBeUndefined();
});

it('bot self has operational permissions without implicit governance or bare-id authority', async () => {
  const f = await fixture('bot');
  const access = await accountService.resolveEffectiveAccess(
    f.actor.id,
    f.actor.id,
    f.session.sessionId,
  );
  expect(access?.permissions).toEqual(
    expect.arrayContaining(['account:update', 'billing:manage', 'apps:create']),
  );
  for (const permission of [
    'credentials:manage',
    'members:remove',
    'ownership:transfer',
    'account:delete',
  ]) {
    expect(access?.permissions).not.toContain(permission);
  }
  expect(access?.role).not.toBe('owner');
  expect(await accountService.resolveEffectiveAccess(f.actor.id, f.actor.id)).toBeNull();
  const next = keys();
  await expect(
    requestAgentKeyOperation(f.session.sessionId, f.actor.id, {
      operation: 'enroll',
      publicKey: next.publicKey,
      label: 'unauthorized',
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

it('personal governor with a public key may use verified password reauth instead of a root signature', async () => {
  const f = await fixture();
  const next = keys();
  await storePassword(f.actor.id, 'synthetic-governor-password-41');
  const operation = {
    operation: 'enroll',
    publicKey: next.publicKey,
    label: 'password-proof',
  } as const;
  const signed = await signedOperation(
    f.session.sessionId,
    f.target.id,
    operation,
    f.actorKey.privateKey,
    next.privateKey,
  );
  await expect(
    executeAgentKeyOperation(f.session.sessionId, f.target.id, operation, {
      ...signed,
      governorSignature: undefined,
      reauth: { password: 'wrong-password' },
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
  await expect(
    executeAgentKeyOperation(f.session.sessionId, f.target.id, operation, {
      ...signed,
      governorSignature: undefined,
      reauth: { password: 'synthetic-governor-password-41' },
    }),
  ).resolves.toHaveProperty('methodId');
});

it.each(['personal', 'bot'] as const)(
  'P7: current %s governor enrolls with its own fresh signature plus new-key PoP',
  async (kind) => {
    const f = await fixture(kind);
    const next = keys();
    const operation = { operation: 'enroll', publicKey: next.publicKey, label: 'worker' } as const;
    const proof = await signedOperation(
      f.session.sessionId,
      f.target.id,
      operation,
      f.actorKey.privateKey,
      next.privateKey,
    );
    const result = await executeAgentKeyOperation(
      f.session.sessionId,
      f.target.id,
      operation,
      proof,
    );
    expect(result.methodId).toBeTruthy();
    const [audit] = await getDb()
      .select({ metadata: securityActivities.metadata })
      .from(securityActivities)
      .where(eq(securityActivities.userId, f.target.id));
    expect(audit.metadata).toMatchObject({
      actorAccountId: f.actor.id,
      effectiveAccountId: f.target.id,
      action: 'agent_key.enroll',
    });
  },
);

it('P6/P7: missing new-key possession or missing fresh governor proof fails with no method', async () => {
  const f = await fixture();
  const next = keys();
  const operation = { operation: 'enroll', publicKey: next.publicKey, label: 'worker' } as const;
  const proof = await signedOperation(
    f.session.sessionId,
    f.target.id,
    operation,
    f.actorKey.privateKey,
    next.privateKey,
  );
  await expect(
    executeAgentKeyOperation(f.session.sessionId, f.target.id, operation, {
      ...proof,
      keySignature: undefined,
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    executeAgentKeyOperation(f.session.sessionId, f.target.id, operation, {
      ...proof,
      governorSignature: undefined,
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
  expect(
    await getDb()
      .select({ id: userAuthMethods.id })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, f.target.id)),
  ).toEqual([]);
});

it('P9: removing current governance before execution defeats an already signed enrollment', async () => {
  const f = await fixture();
  const next = keys();
  const operation = { operation: 'enroll', publicKey: next.publicKey, label: 'worker' } as const;
  const proof = await signedOperation(
    f.session.sessionId,
    f.target.id,
    operation,
    f.actorKey.privateKey,
    next.privateKey,
  );
  await getDb()
    .delete(accountMembers)
    .where(
      and(eq(accountMembers.accountId, f.target.id), eq(accountMembers.memberUserId, f.actor.id)),
    );
  await expect(
    executeAgentKeyOperation(f.session.sessionId, f.target.id, operation, proof),
  ).rejects.toMatchObject({ statusCode: 403 });
});

it('P10: a bot rotates with old and new keys without owner intervention; new session belongs to new key', async () => {
  const f = await fixture('bot');
  const next = keys();
  const operation = {
    operation: 'rotate',
    publicKey: next.publicKey,
    label: 'replacement',
    retireCurrent: true,
  } as const;
  const proof = await signedOperation(
    f.session.sessionId,
    f.actor.id,
    operation,
    f.actorKey.privateKey,
    next.privateKey,
  );
  const result = await executeAgentKeyOperation(f.session.sessionId, f.actor.id, operation, proof);
  const claims = await requestAgentChallenge(next.publicKey);
  const timestamp = Date.now();
  const session = await verifyAgentChallenge(
    next.publicKey,
    {
      challenge: claims.challenge,
      timestamp,
      signature: SignatureService.signMessage(
        buildAgentProofMessage(claims, timestamp),
        next.privateKey,
      ),
    },
    request,
  );
  expect(session.authMethodId).toBe(result.methodId);
  expect(session.sessionId).not.toBe(f.session.sessionId);
  expect(await sessionService.validateSessionById(f.session.sessionId)).toBeNull();
});

it('recovery revokes old key sessions and outstanding proofs atomically before enrolling the new key', async () => {
  const f = await fixture();
  const oldKey = keys();
  const next = keys();
  const enroll = { operation: 'enroll', publicKey: oldKey.publicKey, label: 'old' } as const;
  await executeAgentKeyOperation(
    f.session.sessionId,
    f.target.id,
    enroll,
    await signedOperation(
      f.session.sessionId,
      f.target.id,
      enroll,
      f.actorKey.privateKey,
      oldKey.privateKey,
    ),
  );
  const claims = await requestAgentChallenge(oldKey.publicKey);
  const timestamp = Date.now();
  const oldSession = await verifyAgentChallenge(
    oldKey.publicKey,
    {
      challenge: claims.challenge,
      timestamp,
      signature: SignatureService.signMessage(
        buildAgentProofMessage(claims, timestamp),
        oldKey.privateKey,
      ),
    },
    request,
  );
  const pending = await requestAgentChallenge(oldKey.publicKey);
  const recover = { operation: 'recover', publicKey: next.publicKey, label: 'recovered' } as const;
  const result = await executeAgentKeyOperation(
    f.session.sessionId,
    f.target.id,
    recover,
    await signedOperation(
      f.session.sessionId,
      f.target.id,
      recover,
      f.actorKey.privateKey,
      next.privateKey,
    ),
  );
  expect(result.revokedMethodIds).toContain(oldSession.authMethodId);
  expect(await sessionService.validateSessionById(oldSession.sessionId)).toBeNull();
  const [row] = await getDb()
    .select({ used: authChallenges.used })
    .from(authChallenges)
    .where(eq(authChallenges.challenge, pending.challenge));
  expect(row.used).toBe(true);
  await expect(requestAgentChallenge(next.publicKey)).resolves.toMatchObject({
    accountId: f.target.id,
  });
});

it('a bot may retire the key that signs its request, but cannot revoke another runtime key without governance', async () => {
  const f = await fixture('bot');
  const next = keys();
  const rotate = { operation: 'rotate', publicKey: next.publicKey, label: 'overlap' } as const;
  const result = await executeAgentKeyOperation(
    f.session.sessionId,
    f.actor.id,
    rotate,
    await signedOperation(
      f.session.sessionId,
      f.actor.id,
      rotate,
      f.actorKey.privateKey,
      next.privateKey,
    ),
  );
  expect(await sessionService.validateSessionById(f.session.sessionId)).not.toBeNull();
  await expect(
    requestAgentKeyOperation(f.session.sessionId, f.actor.id, {
      operation: 'revoke',
      methodId: result.methodId ?? 'missing-created-key',
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  const retire = {
    operation: 'revoke',
    methodId: f.session.authMethodId ?? 'missing-session-key',
  } as const;
  await executeAgentKeyOperation(
    f.session.sessionId,
    f.actor.id,
    retire,
    await signedOperation(f.session.sessionId, f.actor.id, retire, f.actorKey.privateKey),
  );
  expect(await sessionService.validateSessionById(f.session.sessionId)).toBeNull();
  await expect(requestAgentChallenge(next.publicKey)).resolves.toMatchObject({
    accountId: f.actor.id,
  });
});

it.each(['personal', 'organization', 'project', 'channel'] as const)(
  'P8: agent credentials cannot be enrolled on %s',
  async (kind) => {
    const f = await fixture();
    const next = keys();
    await getDb().update(users).set({ kind }).where(eq(users.id, f.target.id));
    await expect(
      requestAgentKeyOperation(f.session.sessionId, f.target.id, {
        operation: 'enroll',
        publicKey: next.publicKey,
        label: 'wrong-kind',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  },
);

it('P14: a key already bound to another bot cannot be enrolled again, and failed recovery rolls back revocation', async () => {
  const f = await fixture();
  const other = await fixture();
  const shared = keys();
  const existing = keys();
  const enroll = { operation: 'enroll', publicKey: shared.publicKey, label: 'shared' } as const;
  await executeAgentKeyOperation(
    f.session.sessionId,
    f.target.id,
    enroll,
    await signedOperation(
      f.session.sessionId,
      f.target.id,
      enroll,
      f.actorKey.privateKey,
      shared.privateKey,
    ),
  );
  const old = { operation: 'enroll', publicKey: existing.publicKey, label: 'old' } as const;
  const original = await executeAgentKeyOperation(
    other.session.sessionId,
    other.target.id,
    old,
    await signedOperation(
      other.session.sessionId,
      other.target.id,
      old,
      other.actorKey.privateKey,
      existing.privateKey,
    ),
  );
  const recovery = {
    operation: 'recover',
    publicKey: shared.publicKey,
    label: 'collision',
  } as const;
  await expect(
    executeAgentKeyOperation(
      other.session.sessionId,
      other.target.id,
      recovery,
      await signedOperation(
        other.session.sessionId,
        other.target.id,
        recovery,
        other.actorKey.privateKey,
        shared.privateKey,
      ),
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
  const [retained] = await getDb()
    .select({ revokedAt: userAuthMethods.revokedAt })
    .from(userAuthMethods)
    .where(eq(userAuthMethods.id, original.methodId ?? 'missing-original-key'));
  expect(retained.revokedAt).toBeNull();
});

it('public key inventory follows current governance and contains no session or proof fields', async () => {
  const f = await fixture();
  const runtime = keys();
  const operation: AgentKeyOperation = {
    operation: 'enroll',
    publicKey: runtime.publicKey,
    label: 'inventory',
  };
  const proof = await signedOperation(
    f.session.sessionId,
    f.target.id,
    operation,
    f.actorKey.privateKey,
    runtime.privateKey,
  );
  await executeAgentKeyOperation(f.session.sessionId, f.target.id, operation, proof);
  const inventory = await listAgentKeys(f.session.sessionId, f.target.id);
  expect(inventory.keys).toHaveLength(1);
  expect(Object.keys(inventory.keys[0]).sort()).toEqual(
    [
      'id',
      'publicKey',
      'label',
      'enrolledByUserId',
      'enrollmentMethod',
      'linkedAt',
      'lastUsedAt',
      'revokedAt',
    ].sort(),
  );
  expect(inventory.keys[0].publicKey).toBe(runtime.publicKey);
  await getDb().delete(accountMembers).where(eq(accountMembers.accountId, f.target.id));
  await expect(listAgentKeys(f.session.sessionId, f.target.id)).rejects.toMatchObject({
    statusCode: 403,
  });
});
