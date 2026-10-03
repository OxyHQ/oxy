/** Real HTTP/JWT/secp256k1/Postgres. Only rate limits, logging and sockets are external stubs. */
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { buildAgentProofMessage, type AgentProofClaims } from '@oxy.so/contracts';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../../utils/authSessionSocket', () => ({ emitAuthSessionUpdate: jest.fn(), emitAuthSessionProgress: jest.fn() }));
jest.mock('../../utils/socket', () => ({ broadcastDeviceState: jest.fn(), broadcastSessionAccountsChanged: jest.fn() }));
jest.mock('../../services/securityActivityService', () => ({ __esModule: true, default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() } }));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { accountMembers } from '../../db/schema/accountMembers';
import { applications } from '../../db/schema/applications';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { sessions } from '../../db/schema/sessions';
import { errorHandler } from '../../middleware/errorHandler';
import SignatureService from '../../services/signature.service';
import sessionService from '../../services/session.service';
import agentAuthRouter from '../agentAuth';
import agentKeysRouter from '../agentKeys';
import accountsRouter from '../accounts';
import authRouter from '../auth';

let server: http.Server;
let keyCounter = 1000;
const redirectUri = 'https://fixture.invalid/callback';
async function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, any> }> {
  const form = path === '/auth/oauth/token';
  const payload = form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, path, method: 'POST',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let raw = ''; res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(payload);
  });
}
async function fixture() {
  const privateKey = (++keyCounter).toString(16).padStart(64, '0');
  const publicKey = SignatureService.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey));
  const [bot] = await getDb().insert(users).values({ kind: 'bot' }).returning({ id: users.id });
  const [org] = await getDb().insert(users).values({ kind: 'organization' }).returning({ id: users.id });
  const [key] = await getDb().insert(userAuthMethods).values({ userId: bot.id, type: 'agent_key', methodPublicKey: publicKey,
    label: 'http-fixture', enrollmentMethod: 'governor' }).returning({ id: userAuthMethods.id });
  await getDb().insert(accountMembers).values({ accountId: org.id, memberUserId: bot.id, role: 'admin', status: 'active' });
  const [app] = await getDb().insert(applications).values({ name: 'External fixture', ownerAccountId: org.id,
    type: 'third_party', scopes: ['user:read'], redirectUris: [redirectUri] }).returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({ applicationId: app.id, name: 'fixture', type: 'public',
    environment: 'production', publicKey: clientId });
  const challenged = await post('/auth/agent/challenge', { publicKey });
  expect(challenged.status).toBe(200);
  const claims = challenged.body as AgentProofClaims; const timestamp = Date.now();
  const signed = { publicKey, challenge: claims.challenge, timestamp,
    signature: SignatureService.signMessage(buildAgentProofMessage(claims, timestamp), privateKey) };
  const signedIn = await post('/auth/agent/verify', signed);
  expect(signedIn.status).toBe(200);
  expect(signedIn.body.user.id).toBe(bot.id);
  expect(signedIn.body.deviceSecret).toBeTruthy();
  return { bot, org, key, app, clientId, signedIn: signedIn.body, signed };
}
function pkce() {
  const verifier = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET ??= `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
  await connectPostgres();
  const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  app.use('/auth/agent', agentAuthRouter); app.use('/auth', authRouter);
  app.use('/accounts', agentKeysRouter); app.use('/accounts', accountsRouter); app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await closePostgres();
});

it('bot key → organization switch → OAuth code → AppBound session keeps principal key and live revocation', async () => {
  const f = await fixture();
  const switched = await post(`/accounts/${f.org.id}/switch`, {}, f.signedIn.accessToken);
  expect(switched.status).toBe(200);
  const pair = pkce();
  const issued = await post('/auth/oauth/authorize', { clientId: f.clientId, redirectUri,
    scope: 'user:read', codeChallenge: pair.challenge, codeChallengeMethod: 'S256' }, switched.body.accessToken);
  expect(issued.status).toBe(200);
  const exchanged = await post('/auth/oauth/token', { grant_type: 'authorization_code', client_id: f.clientId,
    code: issued.body.data.code, redirect_uri: redirectUri, code_verifier: pair.verifier });
  expect(exchanged.status).toBe(200);
  expect(exchanged.body.deviceSecret).toBeUndefined();
  const [row] = await getDb().select({ userId: sessions.userId, operatedByUserId: sessions.operatedByUserId,
    authMethodId: sessions.authMethodId, authMethodOwnerId: sessions.authMethodOwnerId, applicationId: sessions.applicationId,
  }).from(sessions).where(eq(sessions.sessionId, exchanged.body.session_id));
  expect(row).toEqual({ userId: f.org.id, operatedByUserId: f.bot.id, authMethodId: f.key.id,
    authMethodOwnerId: f.bot.id, applicationId: f.app.id });
  expect(await sessionService.validateSession(exchanged.body.access_token)).not.toBeNull();
  const governance = await post(`/accounts/${f.bot.id}/agent-keys/challenge`,
    { operation: 'revoke', methodId: f.key.id }, exchanged.body.access_token);
  expect(governance.status).toBe(403);
  await getDb().update(userAuthMethods).set({ revokedAt: new Date() }).where(eq(userAuthMethods.id, f.key.id));
  expect(await sessionService.validateSession(exchanged.body.access_token)).toBeNull();
  expect(await sessionService.validateSession(switched.body.accessToken)).toBeNull();
  expect(await sessionService.validateSession(f.signedIn.accessToken)).toBeNull();
});

it('an unexchanged bot authorization code cannot outlive its original key', async () => {
  const f = await fixture(); const pair = pkce();
  const issued = await post('/auth/oauth/authorize', { clientId: f.clientId, redirectUri,
    scope: 'user:read', codeChallenge: pair.challenge, codeChallengeMethod: 'S256' }, f.signedIn.accessToken);
  expect(issued.status).toBe(200);
  await getDb().update(userAuthMethods).set({ revokedAt: new Date() }).where(eq(userAuthMethods.id, f.key.id));
  const exchanged = await post('/auth/oauth/token', { grant_type: 'authorization_code', client_id: f.clientId,
    code: issued.body.data.code, redirect_uri: redirectUri, code_verifier: pair.verifier });
  expect(exchanged.status).toBe(400);
  expect(exchanged.body.error).toBe('invalid_grant');
});
