/** Real PostgreSQL/JWT/HTTP capability issuance and Oxy domain receiver.
 * Only AWS attestation and Redis nonce transport are isolated in this fixture.
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { verifyCapabilityTicket } from '@oxy.so/core/server';
import { createInternalCatalogMcpClient } from '../../../../mcp/src/index';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({ __esModule: true, default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() } }));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
// Real bounded in-memory rate limiters replace only the Redis store transport.
jest.mock('../../middleware/rateLimiter', () => ({ rateLimit: (options: { prefix: string; windowMs: number; max: number }) => {
  const limiter = jest.requireActual('express-rate-limit').default;
  return limiter({ windowMs: options.windowMs, limit: options.max, keyGenerator: () => `synthetic-${options.prefix}`, standardHeaders: true, legacyHeaders: false });
} }));
const nonceStore = new Map<string, string>();
jest.mock('../../config/redis', () => ({ getRedisClient: () => ({
  set: async (key: string, value: string) => { nonceStore.set(key, value); return 'OK'; },
  get: async (key: string) => nonceStore.get(key) ?? null,
  getdel: async (key: string) => { const value = nonceStore.get(key) ?? null; nonceStore.delete(key); return value; },
}), closeRedis: async () => {} }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { appUserSignals } from '../../db/schema/appUserSignals';
import { buildRecommendations } from '../../routes/profiles';
import { users } from '../../db/schema/users';
import { sessions } from '../../db/schema/sessions';
import { appGrants } from '../../db/schema/appGrants';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { accountClosureFences } from '../../db/schema/accountClosureFences';
import { accountMembers } from '../../db/schema/accountMembers';
import { appCapabilityCatalogRegistrations, capabilityExecutionAuthorizations } from '../../db/schema/agency';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import capabilitiesRouter from '../../routes/capabilities';
import authRouter from '../../routes/auth';
import foregroundProfilesRouter from '../../routes/foregroundProfiles';
import { oxyProfileCapabilityCatalog } from '../../capabilities/oxy-profile.catalog';
import { handleOxyProfileInternalMcp } from '../../capabilities/oxy-profile.transport';
import sessionService from '../session.service';
import * as runtimeStore from '../capabilityRuntimeStore.service';
import { bindWorkloadIdentity } from '../workloadIdentityBinding.service';
import { issueWorkloadChallenge, exchangeWorkloadAttestation } from '../workloadIdentity.service';
import { registerAttestationVerifier, workloadAttestationHandle } from '../workloadAttestation.service';
import { verifyServiceToken } from '../../middleware/serviceToken';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';

const signing = generateKeyPairSync('ed25519');
const scope = ['user:read', 'capability-tickets:issue', 'capabilities:read', 'catalogs:write'];
const savedEnv = { ...process.env };
let server: Server;
let origin: string;
let registrar: Awaited<ReturnType<typeof presenter>>;
const app = express();
app.use(rateLimit({ windowMs: 60_000, limit: 512, keyGenerator: () => 'synthetic-foreground', standardHeaders: true, legacyHeaders: false }));
app.use('/_oxy/mcp', (req, res) => { void handleOxyProfileInternalMcp(req, res); });
app.use(express.json());
app.use('/capabilities', capabilitiesRouter);
app.use('/auth', authRouter);
app.use('/_oxy/capabilities', foregroundProfilesRouter);

async function presenter() {
  const [owner] = await getDb().insert(users).values({}).returning();
  const [application] = await getDb().insert(applications).values({
    name: `Foreground ${randomUUID()}`, ownerAccountId: owner.id, type: 'first_party',
    status: 'active', isOfficial: true, isInternal: true, scopes: scope,
    capabilities: ['agency:coordinate', 'catalog:oxy'],
  }).returning();
  const [service] = await getDb().insert(applicationCredentials).values({
    name: 'synthetic service', applicationId: application.id, type: 'service', environment: 'production',
    publicKey: `oxy_dk_${randomUUID()}`, secretHash: 'fixture-only', scopes: scope, status: 'active',
  }).returning();
  const [client] = await getDb().insert(applicationCredentials).values({
    name: 'synthetic public client', applicationId: application.id, type: 'public', environment: 'production',
    publicKey: `oxy_client_${randomUUID()}`, scopes: ['user:read', 'follows:read'], status: 'active',
  }).returning();
  const token = signServiceTokenEd25519({ type: 'service', appId: application.id,
    appName: application.name, credentialId: service.id, ownerAccountId: owner.id,
    environment: 'production', tier: 'internal', scopes: scope, iss: 'oxy-auth', aud: 'oxy-api',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 });
  return { owner, application, service, client, token };
}
async function requester(p: Awaited<ReturnType<typeof presenter>>, appBound = false) {
  const [user] = await getDb().insert(users).values({ username: `foreground_${randomUUID().slice(0, 8)}` }).returning();
  const session = await sessionService.createSession(user.id, { headers: {} } as Request, {
    deviceId: randomUUID(), ...(appBound ? { application: { applicationId: p.application.id, clientId: p.client.publicKey, scopes: ['user:read'] } } : {}),
  });
  return { user, session };
}
async function register(token: string) {
  const res = await request(app).post('/capabilities/catalogs/register').auth(token, { type: 'bearer' })
    .send({ catalog: oxyProfileCapabilityCatalog() });
  expect(res.status).toBe(201);
  return { registrationId: res.body.registration.id, version: res.body.registration.version, digest: res.body.registration.digest };
}
async function issue(p: Awaited<ReturnType<typeof presenter>>, bearer: string, tool: 'readViewerGraph' | 'recommendProfiles' = 'readViewerGraph', token = p.token) {
  const pin = await register(registrar.token);
  const input = { tool, expectedCatalog: pin, runId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const created = await request(app).post('/capabilities/foreground-execution-authorizations').auth(token, { type: 'bearer' }).send({ ...input, subjectToken: bearer });
  expect(created.status).toBe(201);
  const issued = await request(app).post('/capabilities/tickets').auth(token, { type: 'bearer' })
    .send({ executionAuthorizationId: created.body.authorization.id, expectedCatalog: pin });
  expect(issued.status).toBe(201);
  const claims = verifyCapabilityTicket(issued.body.ticket, { audience: 'oxy-platform-api', issuer: origin, resolvePublicKey: () => signing.publicKey });
  return { ticket: issued.body.ticket as string, claims, authorization: created.body.authorization, pin, input };
}
function read(ticket: string) { return request(app).get('/_oxy/capabilities/users/me/graph').set('authorization', `Capability ${ticket}`); }

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = 'foreground-owned-access-fixture';
  process.env.REFRESH_TOKEN_SECRET = 'foreground-owned-refresh-fixture';
  process.env.DEVICE_ID_SALT = 'f'.repeat(48);
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'foreground-fixture';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = signing.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  await connectPostgres();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OXY_API_URL = origin;
  registrar = await presenter();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, savedEnv);
});

it('issues a signed read-only requester ticket, preserves subject graph over HTTP/MCP, and retains historical authorization after session deletion', async () => {
  const p = await presenter(); const r = await requester(p);
  const issued = await issue(p, r.session.accessToken);
  expect(issued.claims).toMatchObject({ actor: { type: 'requester', accountId: r.user.id }, requesterAccountId: r.user.id,
    sub: r.user.id, autonomy: 'read_only', executionAuthorization: { kind: 'direct_request' }, coordinator: { applicationId: p.application.id } });
  expect(JSON.stringify(issued.authorization)).not.toContain(r.session.accessToken);
  const first = await read(issued.ticket); expect(first.status).toBe(200);
  expect((await request(app).get('/_oxy/capabilities/users/me/graph?accountId=other').set('authorization', `Capability ${issued.ticket}`)).status).toBe(403);
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
  const mcp = await client.callTool(issued.ticket, 'readViewerGraph', {});
  expect(mcp.structuredContent).toEqual(first.body);
  expect((await read(issued.ticket)).body).toEqual(first.body); // read replay still checks live authority
  await getDb().delete(sessions).where(eq(sessions.sessionId, r.session.sessionId));
  expect(await getDb().select().from(capabilityExecutionAuthorizations).where(eq(capabilityExecutionAuthorizations.id, issued.authorization.id))).toHaveLength(1);
  expect((await read(issued.ticket)).status).toBe(403);
});

it.each(['rotate', 'logout', 'closure', 'credential', 'app-owner', 'catalog'] as const)('withdraws %s before private output without granting offline authority', async (change) => {
  const p = await presenter(); const r = await requester(p); const issued = await issue(p, r.session.accessToken);
  if (change === 'rotate') await sessionService.refreshTokens(r.session.refreshToken);
  if (change === 'logout') await sessionService.deactivateSession(r.session.sessionId);
  if (change === 'closure') await getDb().insert(accountClosureFences).values({ accountId: r.user.id });
  if (change === 'credential') await getDb().update(applicationCredentials).set({ scopes: ['capabilities:read'] }).where(eq(applicationCredentials.id, p.service.id));
  if (change === 'app-owner') await getDb().insert(accountClosureFences).values({ accountId: p.owner.id });
  if (change === 'catalog') await getDb().update(appCapabilityCatalogRegistrations).set({ digest: '0'.repeat(64) }).where(eq(appCapabilityCatalogRegistrations.id, issued.pin.registrationId));
  expect((await read(issued.ticket)).status).toBe(403);
});

it('refuses data when the session is withdrawn while actual audit persistence is awaiting', async () => {
  const p = await presenter(); const r = await requester(p); const issued = await issue(p, r.session.accessToken);
  let reached!: () => void; let resume!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const persist = runtimeStore.persistCapabilityAuditEvent;
  jest.spyOn(runtimeStore, 'persistCapabilityAuditEvent').mockImplementation(async (event) => { reached(); await gate; return persist(event); });
  const pending = read(issued.ticket).then((response) => response);
  await entered;
  await sessionService.deactivateSession(r.session.sessionId);
  resume();
  expect((await pending).status).toBe(403);
});

it('offline grant revoke is separate from foreground signout; canonical session revoke preserves the shared session', async () => {
  const p = await presenter(); const r = await requester(p, true);
  const shared = await sessionService.createSession(r.user.id, { headers: {} } as Request, { deviceId: randomUUID() });
  await getDb().insert(appGrants).values({ userId: r.user.id, applicationId: p.application.id, scopes: ['user:read', 'follows:read'] });
  const issued = await issue(p, r.session.accessToken);
  const revoked = await request(app).delete(`/auth/grants/${p.application.id}`).auth(shared.accessToken, { type: 'bearer' });
  expect(revoked.status).toBe(200);
  expect(await getDb().select().from(appGrants).where(and(eq(appGrants.userId, r.user.id), eq(appGrants.applicationId, p.application.id)))).toHaveLength(0);
  // ADR0025: withdrawing standing offline consent does not withdraw the present requester session.
  expect((await read(issued.ticket)).status).toBe(200);
  await sessionService.deactivateSession(r.session.sessionId);
  expect((await read(issued.ticket)).status).toBe(403);
  expect(await sessionService.validateSessionById(shared.sessionId, false, { useCache: false })).not.toBeNull();
});

it('scope narrowing through the canonical app-bound mint invalidates the old approval binding', async () => {
  const p = await presenter(); const r = await requester(p, true); const issued = await issue(p, r.session.accessToken);
  await sessionService.createSession(r.user.id, { headers: {} } as Request, { deviceId: r.session.deviceId,
    application: { applicationId: p.application.id, clientId: p.client.publicKey, scopes: ['follows:read'] } });
  expect((await read(issued.ticket)).status).toBe(403);
});

it('rejects free ids, standing/automation authority, stale pins and another presenting application', async () => {
  const p = await presenter(); const r = await requester(p, true); const issued = await issue(p, r.session.accessToken);
  const body = { ...issued.input, subjectToken: r.session.accessToken };
  for (const extra of [{ requesterAccountId: registrar.owner.id }, { actor: { type: 'alia' } }, { kind: 'automation' }, { maximumAutonomy: 'autonomous' }, { grantId: randomUUID() }]) {
    expect((await request(app).post('/capabilities/foreground-execution-authorizations').auth(p.token, { type: 'bearer' }).send({ ...body, ...extra })).status).toBe(400);
  }
  expect((await request(app).post('/capabilities/foreground-execution-authorizations').auth(p.token, { type: 'bearer' }).send({ ...body, expectedCatalog: { ...issued.pin, digest: '0'.repeat(64) } })).status).toBe(409);
  expect((await request(app).post('/capabilities/foreground-execution-authorizations').auth(registrar.token, { type: 'bearer' }).send(body)).status).toBe(401);
  const parts = issued.ticket.split('.');
  parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
  const tampered = parts.join('.');
  expect((await read(tampered)).status).toBe(403);
  expect((await request(app).post('/_oxy/capabilities/profiles/recommendations').set('authorization', `Capability ${issued.ticket}`).send({})).status).toBe(403);
});

it('a live bot requester retains its real key provenance and rejects a revoked signer', async () => {
  const p = await presenter();
  const [bot] = await getDb().insert(users).values({ kind: 'bot', username: `fgbot${randomUUID().slice(0, 8)}` }).returning();
  const [key] = await getDb().insert(userAuthMethods).values({ userId: bot.id, type: 'agent_key',
    methodPublicKey: deriveSecp256k1PublicKey('3'.padStart(64, '0')), label: 'fixture', enrollmentMethod: 'governor' }).returning();
  const session = await sessionService.createSession(bot.id, { headers: {} } as Request, { deviceId: randomUUID(), authMethod: { authMethodId: key.id, authMethodOwnerId: bot.id } });
  const issued = await issue(p, session.accessToken);
  expect(issued.authorization.requesterAuthMethodId).toBe(key.id);
  expect(issued.claims.actor).toEqual({ type: 'requester', accountId: bot.id });
  await getDb().update(userAuthMethods).set({ revokedAt: new Date() }).where(eq(userAuthMethods.id, key.id));
  expect((await read(issued.ticket)).status).toBe(403);
});

it('real workload mint uses its canonical inert attribution row for catalog and execution FKs', async () => {
  const p = registrar; const r = await requester(p);
  const subject = `arn:aws:iam::237343248947:role/oxy-fg-${randomUUID()}`;
  const bound = await bindWorkloadIdentity({ applicationId: p.application.id, subject, provider: 'aws-iam', scopes: scope,
    actor: { isPlatformStaff: true, describedAs: 'synthetic foreground fixture' } });
  registerAttestationVerifier({ provider: 'aws-iam', verify: async (_input, _nonce) => ({ provider: 'aws-iam', subject, attestationId: workloadAttestationHandle(subject) }) });
  const { nonce } = await issueWorkloadChallenge();
  const minted = await exchangeWorkloadAttestation({ provider: 'aws-iam', nonce, attestation: { synthetic: true } });
  const verified = verifyServiceToken(minted.token); if (!verified.ok) throw new Error('Expected actual signed workload mint');
  expect(verified.payload.credentialId).toBe(bound.binding.attestationId);
  const [identity] = await getDb().select().from(applicationCredentials).where(eq(applicationCredentials.id, bound.binding.attestationId));
  expect(identity).toMatchObject({ type: 'workload', publicKey: null, secretHash: null, tokenHash: null, scopes: [], workloadIdentityId: bound.binding.id });
  // Use the real registrar route with workload proof in the same trusted namespace.
  const pin = await register(minted.token);
  const [registered] = await getDb().select().from(appCapabilityCatalogRegistrations).where(eq(appCapabilityCatalogRegistrations.id, pin.registrationId));
  expect(registered.registeredByCredentialId).toBe(bound.binding.attestationId);
  const issued = await issue(p, r.session.accessToken, 'readViewerGraph', minted.token);
  expect(issued.authorization.coordinatorCredentialId).toBe(bound.binding.attestationId);
  expect((await read(issued.ticket)).status).toBe(200);
  await getDb().delete(applicationWorkloadIdentities).where(eq(applicationWorkloadIdentities.id, bound.binding.id));
  expect((await read(issued.ticket)).status).toBe(403);
  expect(pin.registrationId).toBeTruthy();
});


it('private application signals and viewer ranking match the existing domain builder over HTTP and MCP', async () => {
  const p = await presenter(); const r = await requester(p);
  process.env.MENTION_APPLICATION_ID = p.application.id;
  const [candidate] = await getDb().insert(users).values({ username: `private_${randomUUID().slice(0, 8)}`, nameFirst: 'Private signal candidate' }).returning();
  await getDb().insert(appUserSignals).values({ applicationId: p.application.id, userId: candidate.id, interestScore: 1, endorsementScore: 20 });
  const issued = await issue(p, r.session.accessToken, 'recommendProfiles');
  const input = { limit: 100, clientId: p.application.id };
  const expected = await buildRecommendations(r.user.id, { limit: 100, offset: 0, excludeTypes: [], excludeIds: [], clientId: p.application.id });
  const general = await buildRecommendations(r.user.id, { limit: 100, offset: 0, excludeTypes: [], excludeIds: [] });
  expect(expected).not.toEqual(general); // proves a private app profile was not silently dropped
  expect(expected.find((row) => row.id === candidate.id)?.matchedSignals).toEqual(expect.arrayContaining(['interest']));
  const response = await request(app).post('/_oxy/capabilities/profiles/recommendations').set('authorization', `Capability ${issued.ticket}`).send(input);
  expect(response.status).toBe(200); expect(response.body.recommendations).toEqual(expected);
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
  const mcp = await client.callTool(issued.ticket, 'recommendProfiles', input);
  expect(mcp.structuredContent).toEqual(response.body);
  expect((await request(app).post('/_oxy/capabilities/profiles/recommendations').set('authorization', `Capability ${issued.ticket}`).send({ ...input, clientId: registrar.application.id })).status).toBe(403);
  expect((await request(app).get('/_oxy/capabilities/users/me/graph').set('authorization', `Bearer ${p.token}`).set('X-Oxy-User-Id', r.user.id)).status).toBe(401);
});

it('principal A operating subject B stays separate and membership withdrawal cannot switch the ticket subject', async () => {
  const p = await presenter(); const r = await requester(p);
  const [subject] = await getDb().insert(users).values({ kind: 'organization', username: `subject_${randomUUID().slice(0, 8)}` }).returning();
  const [membership] = await getDb().insert(accountMembers).values({ accountId: subject.id, memberUserId: r.user.id, role: 'owner', status: 'active' }).returning();
  const session = await sessionService.createSession(subject.id, { headers: {} } as Request, { deviceId: randomUUID(), operatedByUserId: r.user.id });
  const issued = await issue(p, session.accessToken);
  expect(issued.claims.actor).toEqual({ type: 'requester', accountId: r.user.id });
  expect(issued.claims.requesterAccountId).toBe(r.user.id);
  expect(issued.claims.resource.effectiveAccountId).toBe(subject.id);
  expect(issued.claims.ownerAccountId).toBe(subject.id);
  expect((await read(issued.ticket)).status).toBe(200);
  await getDb().update(accountMembers).set({ status: 'removed' }).where(eq(accountMembers.id, membership.id));
  expect((await read(issued.ticket)).status).toBe(403);
  expect(await sessionService.validateSessionById(r.session.sessionId, false, { useCache: false })).not.toBeNull();
});


it('rechecks the signed ticket expiry after the audit wait, independently of a later authorization deadline', async () => {
  const p = await presenter(); const r = await requester(p); const issued = await issue(p, r.session.accessToken);
  let reached!: () => void; let resume!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const persist = runtimeStore.persistCapabilityAuditEvent;
  jest.spyOn(runtimeStore, 'persistCapabilityAuditEvent').mockImplementation(async (event) => { reached(); await gate; return persist(event); });
  const pending = read(issued.ticket).then((response) => response);
  await entered;
  jest.spyOn(Date, 'now').mockReturnValue(issued.claims.exp * 1000);
  resume();
  expect((await pending).status).toBe(403);
});
