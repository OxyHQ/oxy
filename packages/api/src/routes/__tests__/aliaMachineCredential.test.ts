import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { OxyServer, OXY_ALIA_RESOURCE_APPLICATION_ID } from '@oxy.so/core/server';

// Actual signing, receiver auth, resolver and SQL; only infrastructure noise is stubbed.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../utils/socket', () => ({ broadcastDeviceState: jest.fn(), broadcastSessionAccountsChanged: jest.fn() }));

import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { applications, applicationCredentials, users } from '../../db/schema';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { errorHandler } from '../../middleware/errorHandler';
import internalRouter from '../internal';

let server: http.Server;
let origin: string;
let receiver: { applicationId: string; credentialId: string; ownerAccountId: string };

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function machine(appScopes: string[] = ['alia:chat', 'inference:invoke'], credentialScopes = appScopes) {
  const ownerAccountId = await owner();
  const [app] = await getDb().insert(applications).values({
    name: `Caller ${randomUUID()}`, ownerAccountId, scopes: appScopes, type: 'third_party',
  }).returning({ id: applications.id });
  const key = generateMachineCredentialToken();
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId: app.id, publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
    name: 'Machine', type: 'machine', environment: 'development', scopes: credentialScopes,
    tokenPrefix: key.tokenPrefix, tokenHash: key.tokenHash,
  }).returning({ id: applicationCredentials.id });
  return { token: key.token, applicationId: app.id, credentialId: credential.id, ownerAccountId };
}

function receiverToken(applicationId = receiver.applicationId): string {
  const now = Math.floor(Date.now() / 1000);
  return signServiceTokenEd25519({
    type: 'service', appId: applicationId, appName: 'Resource',
    credentialId: receiver.credentialId, ownerAccountId: receiver.ownerAccountId,
    environment: 'development', scopes: ['user:read'], iss: 'oxy-auth', aud: 'oxy-api', iat: now, exp: now + 300,
  });
}

beforeAll(async () => {
  await connectPostgres();
  const ownerAccountId = await owner();
  await getDb().insert(applications).values({
    id: OXY_ALIA_RESOURCE_APPLICATION_ID, name: `Alia ${randomUUID()}`, type: 'internal',
    ownerAccountId, scopes: ['user:read'],
  });
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId: OXY_ALIA_RESOURCE_APPLICATION_ID, name: 'Receiver', type: 'service',
    publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`, environment: 'development', scopes: ['user:read'],
  }).returning({ id: applicationCredentials.id });
  receiver = { applicationId: OXY_ALIA_RESOURCE_APPLICATION_ID, credentialId: credential.id, ownerAccountId };
  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closePostgres();
});

function resourceClient() {
  const oxy = new OxyServer({ baseURL: origin });
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue(receiverToken());
  return oxy;
}

describe('Alia machine introspection over real HTTP and SQL', () => {
  it('resolves the real caller, payer and credential through the canonical SDK and endpoint', async () => {
    const key = await machine();
    const result = await resourceClient().apps.introspectAliaMachineCredential(key.token);
    expect(result).toEqual({ active: true, principal: {
      kind: 'machine', audience: receiver.applicationId, applicationId: key.applicationId,
      credentialId: key.credentialId, ownerAccountId: key.ownerAccountId,
      environment: 'development', scopes: ['alia:chat', 'inference:invoke'],
    } });
    expect(JSON.stringify(result)).not.toContain(key.token);
    expect(JSON.stringify(result)).not.toContain(receiver.ownerAccountId);
  });
  it.each([{ scopes: ['inference:invoke'] }, { scopes: ['alia:chat'] }])('requires explicit app capability %j', async ({ scopes }) => {
    const key = await machine(scopes);
    expect(await resourceClient().apps.introspectAliaMachineCredential(key.token)).toEqual({ active: false });
  });
  it('intersects credential scopes with application scopes', async () => {
    const key = await machine(['alia:chat', 'inference:invoke'], ['inference:invoke']);
    expect(await resourceClient().apps.introspectAliaMachineCredential(key.token)).toEqual({ active: false });
  });
  it('immediately refuses a revoked caller credential on the same receiver client', async () => {
    const key = await machine();
    const oxy = resourceClient();
    expect((await oxy.apps.introspectAliaMachineCredential(key.token)).active).toBe(true);
    await getDb().update(applicationCredentials).set({ status: 'revoked' }).where(eq(applicationCredentials.id, key.credentialId));
    expect(await oxy.apps.introspectAliaMachineCredential(key.token)).toEqual({ active: false });
  });
  it('refuses another environment without disclosing credential state', async () => {
    const key = await machine();
    await getDb().update(applicationCredentials).set({ environment: 'production' }).where(eq(applicationCredentials.id, key.credentialId));
    expect(await resourceClient().apps.introspectAliaMachineCredential(key.token)).toEqual({ active: false });
  });
  it('does not let the raw caller key authenticate the resource-server endpoint', async () => {
    const key = await machine();
    const response = await fetch(`${origin}/internal/alia/machine-credentials/introspect`, {
      method: 'POST', headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: key.token }),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(key.token);
  });
  it('rejects claimed person attribution at the receiver endpoint', async () => {
    const key = await machine();
    const response = await fetch(`${origin}/internal/alia/machine-credentials/introspect`, {
      method: 'POST', headers: { Authorization: `Bearer ${receiverToken()}`, 'Content-Type': 'application/json', 'X-Oxy-User-Id': 'claimed-person' },
      body: JSON.stringify({ token: key.token }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { active: false } });
  });
});
