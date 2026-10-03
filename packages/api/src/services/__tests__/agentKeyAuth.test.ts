/** Real secp256k1, PostgreSQL, session mint and validation; no provider/network. */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { buildAgentProofMessage, type AgentProofClaims } from '@oxy.so/contracts';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({ __esModule: true, default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() } }));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { sessions } from '../../db/schema/sessions';
import { accountClosureFences } from '../../db/schema/accountClosureFences';
import { authChallenges } from '../../db/schema/authChallenges';
import SignatureService from '../signature.service';
import sessionService from '../session.service';
import { requestAgentChallenge, verifyAgentChallenge } from '../agentKeyAuth.service';
import { verifyServiceToken } from '../../middleware/serviceToken';

const request = { headers: { 'user-agent': 'agent-fixture' } } as Request;
let counter = 1;
async function fixture() {
  const privateKey = (++counter).toString(16).padStart(64, '0');
  const publicKey = SignatureService.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey));
  const [bot] = await getDb().insert(users).values({ kind: 'bot', username: `agent${randomUUID().slice(0, 8)}bot` }).returning({ id: users.id });
  const [key] = await getDb().insert(userAuthMethods).values({
    userId: bot.id, type: 'agent_key', methodPublicKey: publicKey, label: 'fixture', enrollmentMethod: 'governor',
  }).returning({ id: userAuthMethods.id });
  return { bot, key, publicKey, privateKey };
}
function proof(claims: AgentProofClaims, privateKey: string) {
  const timestamp = Date.now();
  return { challenge: claims.challenge, timestamp, signature: SignatureService.signMessage(buildAgentProofMessage(claims, timestamp), privateKey) };
}
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET ??= `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
  await connectPostgres();
});
afterAll(closePostgres);

it('P1/P2: the bot signs in as itself with a normal session, never as owner or service', async () => {
  const f = await fixture();
  const claims = await requestAgentChallenge(f.publicKey);
  const session = await verifyAgentChallenge(f.publicKey, proof(claims, f.privateKey), request);
  expect(session).toMatchObject({ userId: f.bot.id, operatedByUserId: null, applicationId: null,
    authMethodId: f.key.id, authMethodOwnerId: f.bot.id, scopes: [] });
  expect(await sessionService.validateSessionById(session.sessionId, true, { useCache: false })).not.toBeNull();
  expect(verifyServiceToken(session.accessToken).ok).toBe(false);
});

it('P3: concurrent replay mints once and leaves one consumed challenge', async () => {
  const f = await fixture();
  const claims = await requestAgentChallenge(f.publicKey);
  const signature = proof(claims, f.privateKey);
  const results = await Promise.allSettled([
    verifyAgentChallenge(f.publicKey, signature, request), verifyAgentChallenge(f.publicKey, signature, request),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, f.bot.id))).toHaveLength(1);
  const [row] = await getDb().select({ used: authChallenges.used }).from(authChallenges).where(eq(authChallenges.challenge, claims.challenge));
  expect(row.used).toBe(true);
});

it.each(['action', 'accountId', 'authMethodId', 'audience'] as const)('P4: changing signed %s fails without consuming the challenge', async (field) => {
  const f = await fixture();
  const claims = await requestAgentChallenge(f.publicKey);
  const timestamp = Date.now();
  // Deliberately sign foreign bytes; the server builds its own original claims.
  const original = buildAgentProofMessage(claims, timestamp);
  const value = field === 'action' ? 'agent_enroll' : 'foreign-value';
  const changed = JSON.parse(original);
  changed[field] = value;
  const signature = SignatureService.signMessage(JSON.stringify(changed), f.privateKey);
  await expect(verifyAgentChallenge(f.publicKey, { challenge: claims.challenge, timestamp, signature }, request)).rejects.toMatchObject({ statusCode: 401 });
  const [row] = await getDb().select({ used: authChallenges.used }).from(authChallenges).where(eq(authChallenges.challenge, claims.challenge));
  expect(row.used).toBe(false);
});

it('P5: key revocation rejects an existing challenge and a previously warmed session', async () => {
  const f = await fixture();
  const first = await requestAgentChallenge(f.publicKey);
  const session = await verifyAgentChallenge(f.publicKey, proof(first, f.privateKey), request);
  expect(await sessionService.validateSessionById(session.sessionId)).not.toBeNull();
  const pending = await requestAgentChallenge(f.publicKey);
  await getDb().update(userAuthMethods).set({ revokedAt: new Date() }).where(eq(userAuthMethods.id, f.key.id));
  await expect(requestAgentChallenge(f.publicKey)).rejects.toMatchObject({ statusCode: 404 });
  await expect(verifyAgentChallenge(f.publicKey, proof(pending, f.privateKey), request)).rejects.toThrow();
  expect(await sessionService.validateSessionById(session.sessionId)).toBeNull();
  expect(await sessionService.getAccessToken(session.sessionId)).toBeNull();
});

it('P13: archiving a bot prevents challenges and invalidates its session', async () => {
  const f = await fixture();
  const claims = await requestAgentChallenge(f.publicKey);
  const session = await verifyAgentChallenge(f.publicKey, proof(claims, f.privateKey), request);
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, f.bot.id));
  await expect(requestAgentChallenge(f.publicKey)).rejects.toMatchObject({ statusCode: 404 });
  expect(await sessionService.validateSessionById(session.sessionId)).toBeNull();
});


it('a closure fence blocks challenge, pending verification and warmed validation before archival', async () => {
  const f = await fixture();
  const claims = await requestAgentChallenge(f.publicKey);
  const session = await verifyAgentChallenge(f.publicKey, proof(claims, f.privateKey), request);
  expect(await sessionService.validateSessionById(session.sessionId)).not.toBeNull();
  const pending = await requestAgentChallenge(f.publicKey);
  await getDb().insert(accountClosureFences).values({ accountId: f.bot.id });
  await expect(requestAgentChallenge(f.publicKey)).rejects.toMatchObject({ statusCode: 404 });
  await expect(verifyAgentChallenge(f.publicKey, proof(pending, f.privateKey), request)).rejects.toThrow();
  expect(await sessionService.validateSessionById(session.sessionId)).toBeNull();
});
