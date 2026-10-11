/** Real HTTP/JWT/secp256k1/Postgres. Only rate limits, logging and sockets are external stubs. */
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID, generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { OxyServices } from '@oxy.so/core';
import { signInAgentAccount } from '@oxy.so/core/server';
import { buildAgentProofMessage, type AgentProofClaims } from '@oxy.so/contracts';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { accountMembers } from '../../db/schema/accountMembers';
import { applications } from '../../db/schema/applications';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { sessions } from '../../db/schema/sessions';
import { authSessions } from '../../db/schema/authSessions';
import { errorHandler } from '../../middleware/errorHandler';
import SignatureService from '../../services/signature.service';
import sessionService from '../../services/session.service';
import agentAuthRouter from '../agentAuth';
import agentKeysRouter from '../agentKeys';
import accountsRouter from '../accounts';
import authRouter from '../auth';
import internalRouter from '../internal';
import mcpOAuthRouter from '../mcpOAuth';
import { appCapabilityCatalogRegistrations } from '../../db/schema/agency';
import { mcpOauthGrants } from '../../db/schema/mcpOAuth';
import { resolveLiveMcpAccessToken } from '../../services/mcpOAuth.service';

let server: http.Server;
let keyCounter = 1000;
const redirectUri = 'https://fixture.invalid/callback';
// Expected wire fields are checked by each response assertion; this is not an authority seam.
type FixtureResponse = AgentProofClaims & {
  accessToken: string;
  access_token: string;
  deviceSecret: string;
  sessionId: string;
  session_id: string;
  client_id: string;
  code: string;
  refresh_token: string;
  error: string;
  data: { code: string };
  user: { id: string };
};
async function post(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: FixtureResponse }> {
  const form = path.endsWith('/oauth/token');
  const payload = form
    ? new URLSearchParams(body as Record<string, string>).toString()
    : JSON.stringify(body);
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method: 'POST',
        headers: {
          'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
async function fixture() {
  const privateKey = (++keyCounter).toString(16).padStart(64, '0');
  const publicKey = SignatureService.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey));
  const [bot] = await getDb().insert(users).values({ kind: 'bot' }).returning({ id: users.id });
  const [org] = await getDb()
    .insert(users)
    .values({ kind: 'organization' })
    .returning({ id: users.id });
  const [key] = await getDb()
    .insert(userAuthMethods)
    .values({
      userId: bot.id,
      type: 'agent_key',
      methodPublicKey: publicKey,
      label: 'http-fixture',
      enrollmentMethod: 'governor',
    })
    .returning({ id: userAuthMethods.id });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: org.id, memberUserId: bot.id, role: 'admin', status: 'active' });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'External fixture',
      ownerAccountId: org.id,
      type: 'third_party',
      scopes: ['user:read'],
      redirectUris: [redirectUri],
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'fixture',
    type: 'public',
    environment: 'production',
    publicKey: clientId,
  });
  const challenged = await post('/auth/agent/challenge', { publicKey });
  expect(challenged.status).toBe(200);
  const claims = challenged.body as AgentProofClaims;
  const timestamp = Date.now();
  const signed = {
    publicKey,
    challenge: claims.challenge,
    timestamp,
    signature: SignatureService.signMessage(buildAgentProofMessage(claims, timestamp), privateKey),
  };
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
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/internal', internalRouter);
  app.use('/auth/mcp/oauth', mcpOAuthRouter);
  app.use('/auth/agent', agentAuthRouter);
  app.use('/auth', authRouter);
  app.use('/accounts', agentKeysRouter);
  app.use('/accounts', accountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});

it('bot key → organization switch → OAuth code → AppBound session keeps principal key and live revocation', async () => {
  const f = await fixture();
  const switched = await post(`/accounts/${f.org.id}/switch`, {}, f.signedIn.accessToken);
  expect(switched.status).toBe(200);
  const pair = pkce();
  const issued = await post(
    '/auth/oauth/authorize',
    {
      clientId: f.clientId,
      redirectUri,
      scope: 'user:read',
      codeChallenge: pair.challenge,
      codeChallengeMethod: 'S256',
    },
    switched.body.accessToken,
  );
  expect(issued.status).toBe(200);
  const exchanged = await post('/auth/oauth/token', {
    grant_type: 'authorization_code',
    client_id: f.clientId,
    code: issued.body.data.code,
    redirect_uri: redirectUri,
    code_verifier: pair.verifier,
  });
  expect(exchanged.status).toBe(200);
  expect(exchanged.body.deviceSecret).toBeUndefined();
  const [row] = await getDb()
    .select({
      userId: sessions.userId,
      operatedByUserId: sessions.operatedByUserId,
      authMethodId: sessions.authMethodId,
      authMethodOwnerId: sessions.authMethodOwnerId,
      applicationId: sessions.applicationId,
    })
    .from(sessions)
    .where(eq(sessions.sessionId, exchanged.body.session_id));
  expect(row).toEqual({
    userId: f.org.id,
    operatedByUserId: f.bot.id,
    authMethodId: f.key.id,
    authMethodOwnerId: f.bot.id,
    applicationId: f.app.id,
  });
  expect(await sessionService.validateSession(exchanged.body.access_token)).not.toBeNull();
  const governance = await post(
    `/accounts/${f.bot.id}/agent-keys/challenge`,
    { operation: 'revoke', methodId: f.key.id },
    exchanged.body.access_token,
  );
  expect(governance.status).toBe(403);
  await getDb()
    .update(userAuthMethods)
    .set({ revokedAt: new Date() })
    .where(eq(userAuthMethods.id, f.key.id));
  expect(await sessionService.validateSession(exchanged.body.access_token)).toBeNull();
  expect(await sessionService.validateSession(switched.body.accessToken)).toBeNull();
  expect(await sessionService.validateSession(f.signedIn.accessToken)).toBeNull();
});

it('an unexchanged bot authorization code cannot outlive its original key', async () => {
  const f = await fixture();
  const pair = pkce();
  const issued = await post(
    '/auth/oauth/authorize',
    {
      clientId: f.clientId,
      redirectUri,
      scope: 'user:read',
      codeChallenge: pair.challenge,
      codeChallengeMethod: 'S256',
    },
    f.signedIn.accessToken,
  );
  expect(issued.status).toBe(200);
  await getDb()
    .update(userAuthMethods)
    .set({ revokedAt: new Date() })
    .where(eq(userAuthMethods.id, f.key.id));
  const exchanged = await post('/auth/oauth/token', {
    grant_type: 'authorization_code',
    client_id: f.clientId,
    code: issued.body.data.code,
    redirect_uri: redirectUri,
    code_verifier: pair.verifier,
  });
  expect(exchanged.status).toBe(400);
  expect(exchanged.body.error).toBe('invalid_grant');
});

async function pendingApproval(f: Awaited<ReturnType<typeof fixture>>) {
  const pair = pkce();
  const sessionToken = randomUUID();
  const authorizeCode = randomUUID();
  const [row] = await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode,
      applicationId: f.app.id,
      purpose: 'oauth_authorization',
      expiresAt: new Date(Date.now() + 60_000),
      oauthRedirectUri: redirectUri,
      oauthCodeChallenge: pair.challenge,
      oauthCodeChallengeMethod: 'S256',
      oauthScopes: ['user:read'],
      oauthSubjectAccountId: f.org.id,
    })
    .returning({ id: authSessions.id });
  return { pair, sessionToken, authorizeCode, id: row.id };
}

it.each(['authorize', 'authorize-code'])(
  '%s retains the bot approving session through finalization and exchange',
  async (route) => {
    const f = await fixture();
    const pending = await pendingApproval(f);
    const approved = await post(
      `/auth/session/${route}/${route === 'authorize' ? pending.sessionToken : pending.authorizeCode}`,
      {},
      f.signedIn.accessToken,
    );
    expect(approved.status).toBe(200);
    const [binding] = await getDb()
      .select({
        approvedBy: authSessions.approvedBySessionId,
        minted: authSessions.authorizedSessionId,
      })
      .from(authSessions)
      .where(eq(authSessions.id, pending.id));
    expect(binding).toEqual({ approvedBy: f.signedIn.sessionId, minted: null });
    const finalized = await post(`/auth/session/finalize/${pending.sessionToken}`, {});
    expect(finalized.status).toBe(200);
    const exchanged = await post('/auth/oauth/token', {
      grant_type: 'authorization_code',
      client_id: f.clientId,
      code: finalized.body.data.code,
      redirect_uri: redirectUri,
      code_verifier: pending.pair.verifier,
    });
    expect(exchanged.status).toBe(200);
    const [session] = await getDb()
      .select({
        method: sessions.authMethodId,
        owner: sessions.authMethodOwnerId,
        subject: sessions.userId,
        actor: sessions.operatedByUserId,
      })
      .from(sessions)
      .where(eq(sessions.sessionId, exchanged.body.session_id));
    expect(session).toEqual({
      method: f.key.id,
      owner: f.bot.id,
      subject: f.org.id,
      actor: f.bot.id,
    });
  },
);

it.each(['revoke', 'delete', 'missing-reference'])(
  'OAuth bot approval fails closed after %s of its source',
  async (change) => {
    const f = await fixture();
    const pending = await pendingApproval(f);
    expect(
      (await post(`/auth/session/authorize/${pending.sessionToken}`, {}, f.signedIn.accessToken))
        .status,
    ).toBe(200);
    if (change === 'revoke') await sessionService.deactivateSession(f.signedIn.sessionId);
    else if (change === 'delete') {
      await getDb().delete(sessions).where(eq(sessions.sessionId, f.signedIn.sessionId));
      expect(
        await getDb()
          .select({ id: authSessions.id })
          .from(authSessions)
          .where(eq(authSessions.id, pending.id)),
      ).toEqual([]);
    } else
      await getDb()
        .update(authSessions)
        .set({ approvedBySessionId: null })
        .where(eq(authSessions.id, pending.id));
    expect((await post(`/auth/session/finalize/${pending.sessionToken}`, {})).status).toBe(401);
  },
);

it('real bearer MCP approval derives the bot key; reapproval after revocation cannot revive old tokens', async () => {
  const signing = generateKeyPairSync('ed25519');
  const priorId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
  const priorKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'agent-mcp-http';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = signing.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  try {
    const f = await fixture();
    const appSlug = `agent-mcp-${randomUUID()}`;
    const resource = `https://${appSlug}.example.test`;
    const [credential] = await getDb()
      .select({ id: applicationCredentials.id })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, f.app.id));
    await getDb()
      .insert(appCapabilityCatalogRegistrations)
      .values({
        appSlug,
        version: '1',
        audience: appSlug,
        registeredByApplicationId: f.app.id,
        registeredByCredentialId: credential.id,
        digest: '0'.repeat(64),
        signature: 'fixture',
        deployedAt: new Date(),
        active: true,
        catalog: {
          schemaVersion: '1',
          appId: appSlug,
          version: '1',
          audience: appSlug,
          internalBaseUrl: resource,
          accountResourceType: 'account',
          externalMcp: { resource },
          events: [],
          tools: [
            {
              name: 'read',
              version: '1',
              description: 'Read',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              capabilityPackage: 'read',
              requiredCapabilities: ['resource.read'],
              resourceTypes: ['account'],
              effect: 'read',
              idempotency: 'none',
              rollback: 'none',
              exposure: ['mcp'],
              limitKeys: [],
              invocation: { method: 'GET', path: '/read' },
            },
          ],
        },
      });
    const registered = await post('/auth/mcp/oauth/register', {
      client_name: 'agent fixture',
      redirect_uris: [redirectUri],
    });
    expect(registered.status).toBe(201);
    const pair = pkce();
    const approval = {
      responseType: 'code',
      clientId: registered.body.client_id,
      redirectUri,
      resource,
      accountId: f.bot.id,
      scope: 'resource.read',
      codeChallenge: pair.challenge,
      codeChallengeMethod: 'S256',
    };
    const invented = await post(
      '/auth/mcp/oauth/authorize',
      { ...approval, authMethodId: 'invented' },
      f.signedIn.accessToken,
    );
    expect(invented.status).toBe(400);
    const approve = (token: string) => post('/auth/mcp/oauth/authorize', approval, token);
    const exchange = async (code: string) =>
      post('/auth/mcp/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id: registered.body.client_id,
        redirect_uri: redirectUri,
        code_verifier: pair.verifier,
        resource,
      });
    const issuedA = await approve(f.signedIn.accessToken);
    expect(issuedA.status).toBe(200);
    const tokensA = await exchange(issuedA.body.code);
    expect(tokensA.status).toBe(200);
    expect(
      (await resolveLiveMcpAccessToken(tokensA.body.access_token, f.app.id))?.grant.authMethodId,
    ).toBe(f.key.id);
    await getDb()
      .update(userAuthMethods)
      .set({ revokedAt: new Date() })
      .where(eq(userAuthMethods.id, f.key.id));
    expect((await approve(f.signedIn.accessToken)).status).toBe(401);
    const privateKey = (++keyCounter).toString(16).padStart(64, '0');
    const publicKey = SignatureService.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey));
    const [keyB] = await getDb()
      .insert(userAuthMethods)
      .values({
        userId: f.bot.id,
        type: 'agent_key',
        methodPublicKey: publicKey,
        label: 'B',
        enrollmentMethod: 'recovery',
      })
      .returning({ id: userAuthMethods.id });
    const challenged = await post('/auth/agent/challenge', { publicKey });
    const timestamp = Date.now();
    const signedB = await post('/auth/agent/verify', {
      publicKey,
      challenge: challenged.body.challenge,
      timestamp,
      signature: SignatureService.signMessage(
        buildAgentProofMessage(challenged.body as AgentProofClaims, timestamp),
        privateKey,
      ),
    });
    expect(signedB.status).toBe(200);
    const issuedB = await approve(signedB.body.accessToken);
    expect(issuedB.status).toBe(200);
    const tokensB = await exchange(issuedB.body.code);
    expect(tokensB.status).toBe(200);
    expect(
      (await resolveLiveMcpAccessToken(tokensB.body.access_token, f.app.id))?.grant.authMethodId,
    ).toBe(keyB.id);
    // The execution authority reader rejects the old signed bearer even after fresh approval.
    expect(await resolveLiveMcpAccessToken(tokensA.body.access_token, f.app.id)).toBeNull();
    const refreshedA = await post('/auth/mcp/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokensA.body.refresh_token,
      client_id: registered.body.client_id,
      resource,
    });
    expect(refreshedA.status).toBe(400);
    expect(refreshedA.body.error).toBe('invalid_grant');
    expect(
      await getDb()
        .select()
        .from(mcpOauthGrants)
        .where(eq(mcpOauthGrants.principalUserId, f.bot.id)),
    ).toHaveLength(2);
  } finally {
    if (priorId === undefined)
      Reflect.deleteProperty(process.env, 'CAPABILITY_TICKET_SIGNING_KEY_ID');
    else process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = priorId;
    if (priorKey === undefined)
      Reflect.deleteProperty(process.env, 'CAPABILITY_TICKET_SIGNING_PRIVATE_KEY');
    else process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = priorKey;
  }
});

it('P2: an autonomous bearer cannot enter the real internal service router', async () => {
  const f = await fixture();
  const response = await post(
    `/internal/accounts/${f.bot.id}/service-switch`,
    {},
    f.signedIn.accessToken,
  );
  expect([401, 403]).toContain(response.status);
});

// The public SDK helper talks to the real local API; challenge bytes are never mocked.
it.each(['compressed', 'uncompressed', 'uppercase'] as const)(
  'SDK agent signer accepts %s encoding of the same point against HTTP and SQL',
  async (encoding) => {
    const privateKey = (++keyCounter).toString(16).padStart(64, '0');
    const compressed = deriveSecp256k1PublicKey(privateKey, true);
    const canonical = SignatureService.canonicalizePublicKey(compressed);
    const publicKey =
      encoding === 'compressed'
        ? compressed
        : encoding === 'uppercase'
          ? canonical.toUpperCase()
          : canonical;
    const [bot] = await getDb().insert(users).values({ kind: 'bot' }).returning();
    const [method] = await getDb()
      .insert(userAuthMethods)
      .values({
        userId: bot.id,
        type: 'agent_key',
        methodPublicKey: canonical,
        label: 'sdk-real-http',
        enrollmentMethod: 'governor',
      })
      .returning();
    const address = server.address() as AddressInfo;
    const client = new OxyServices({ baseURL: `http://127.0.0.1:${address.port}` });
    const signMessage = jest.fn(async (message: string) =>
      SignatureService.signMessage(message, privateKey),
    );
    const result = await signInAgentAccount({
      client,
      accountId: bot.id,
      signer: { publicKey, signMessage },
    });
    expect(result.user.id).toBe(bot.id);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(signMessage.mock.calls[0][0]).publicKey).toBe(canonical);
    const [row] = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, result.sessionId));
    expect({ user: row.userId, method: row.authMethodId, owner: row.authMethodOwnerId }).toEqual({
      user: bot.id,
      method: method.id,
      owner: bot.id,
    });
    expect(await sessionService.validateSession(result.accessToken)).not.toBeNull();
  },
);

it('SDK signer compressed, uncompressed and mixed-case forms converge on one SQL bot and method', async () => {
  const privateKey = (++keyCounter).toString(16).padStart(64, '0');
  const compressed = deriveSecp256k1PublicKey(privateKey, true);
  const canonical = SignatureService.canonicalizePublicKey(compressed);
  const [bot] = await getDb().insert(users).values({ kind: 'bot' }).returning();
  const [method] = await getDb()
    .insert(userAuthMethods)
    .values({
      userId: bot.id,
      type: 'agent_key',
      methodPublicKey: canonical,
      label: 'sdk-encoding-convergence',
      enrollmentMethod: 'governor',
    })
    .returning();
  const address = server.address() as AddressInfo;
  const client = new OxyServices({ baseURL: `http://127.0.0.1:${address.port}` });
  for (const publicKey of [compressed, canonical, canonical.toUpperCase()]) {
    const signMessage = jest.fn(async (message: string) =>
      SignatureService.signMessage(message, privateKey),
    );
    const result = await signInAgentAccount({
      client,
      accountId: bot.id,
      signer: { publicKey, signMessage },
    });
    expect(result.user.id).toBe(bot.id);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(signMessage.mock.calls[0][0]).publicKey).toBe(canonical);
    const [row] = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, result.sessionId));
    expect({ user: row.userId, method: row.authMethodId, owner: row.authMethodOwnerId }).toEqual({
      user: bot.id,
      method: method.id,
      owner: bot.id,
    });
    expect(await sessionService.validateSession(result.accessToken)).not.toBeNull();
  }
  expect(
    await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.userId, bot.id)),
  ).toHaveLength(1);
});
