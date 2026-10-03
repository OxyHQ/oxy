/** Real SQL, normal full migrations; Redis rate limits alone are replaced. */
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { and, eq, sql } from 'drizzle-orm';
jest.mock('../../middleware/rateLimiter', () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applications } from '../../db/schema/applications';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { users } from '../../db/schema/users';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { authCodes } from '../../db/schema/authCodes';
import { serviceActingAsRevocations } from '../../db/schema/serviceActingAsRevocations';
import { serviceActingAsAuthorityEpochs } from '../../db/schema/serviceActingAsAuthorityEpochs';
import { accountClosureFences } from '../../db/schema/accountClosureFences';
import { persistOAuthAuthorization } from '../oauthConsent.service';
import { resolveServiceActingAsGrant, revokeServiceActingAs } from '../serviceActingAs.service';
import { mintServiceToken } from '../serviceTokenMint.service';
import internalRouter from '../../routes/internal';
import { errorHandler } from '../../middleware/errorHandler';

async function seed(kind: 'personal' | 'bot' = 'personal') {
  const db = getDb();
  const [owner] = await db.insert(users).values({}).returning();
  const [subject] = await db.insert(users).values({ kind }).returning();
  const [app] = await db.insert(applications).values({ name: randomUUID(), ownerAccountId: owner.id,
    type: 'internal', scopes: ['acting-as:offline', 'user:read', 'files:write'] }).returning();
  const [credential] = await db.insert(applicationCredentials).values({ applicationId: app.id,
    publicKey: `oxy_dk_${randomUUID()}`, name: 'test', type: 'service', environment: 'production',
    scopes: ['acting-as:offline', 'user:read'] }).returning();
  return { owner, subject, app, credential };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
function consent(f: Fixture, extra: Record<string, unknown> = {}) {
  return persistOAuthAuthorization({ decision: { recordGrant: true, clearsActingAsRevocation: true,
    grantScopes: ['acting-as:offline', 'user:read', 'files:write'], consentedScopes: ['acting-as:offline'] },
    code: { userId: f.subject.id, appId: f.app.id, redirectUri: 'https://test.invalid/callback',
      scopes: ['acting-as:offline', 'user:read', 'files:write'], ...extra } });
}
const context = (f: Fixture) => ({ credentialId: f.credential.id, ownerAccountId: f.owner.id, environment: 'production' as const });
const resolve = (f: Fixture) => resolveServiceActingAsGrant(f.app.id, f.subject.id, context(f));

beforeAll(connectPostgres);
afterAll(closePostgres);

it('grant → revoke → grant increments a durable epoch and retains the live intersection', async () => {
  const f = await seed();
  await consent(f);
  expect(await resolve(f)).toEqual({ authorized: true, epoch: '1', scopes: ['acting-as:offline', 'user:read'] });
  await revokeServiceActingAs(f.subject.id, f.app.id);
  expect(await resolve(f)).toEqual({ authorized: false, epoch: '2', scopes: [] });
  await consent(f);
  expect(await resolve(f)).toMatchObject({ authorized: true, epoch: '3' });
  expect(await getDb().select().from(serviceActingAsRevocations).where(eq(serviceActingAsRevocations.applicationId, f.app.id))).toHaveLength(0);
});

it('failure after epoch and grant writes rolls back epoch, marker clear and grant together', async () => {
  const f = await seed();
  const duplicateId = randomUUID();
  await consent(f, { codeId: duplicateId });
  await revokeServiceActingAs(f.subject.id, f.app.id);
  await expect(consent(f, { codeId: duplicateId })).rejects.toThrow();
  expect(await resolve(f)).toMatchObject({ authorized: false, epoch: '2' });
  expect(await getDb().select().from(appGrants).where(eq(appGrants.applicationId, f.app.id))).toHaveLength(0);
  expect(await getDb().select().from(serviceActingAsRevocations).where(eq(serviceActingAsRevocations.applicationId, f.app.id))).toHaveLength(1);
});

it.each(['credential', 'app', 'owner', 'subject', 'fence'] as const)('denies live %s revocation with an unchanged grant epoch', async (change) => {
  const f = await seed(); await consent(f);
  expect((await resolve(f)).authorized).toBe(true);
  if (change === 'credential') await getDb().update(applicationCredentials).set({ status: 'revoked' }).where(eq(applicationCredentials.id, f.credential.id));
  if (change === 'app') await getDb().update(applications).set({ status: 'suspended' }).where(eq(applications.id, f.app.id));
  if (change === 'owner' || change === 'subject') await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, change === 'owner' ? f.owner.id : f.subject.id));
  if (change === 'fence') await getDb().insert(accountClosureFences).values({ accountId: f.subject.id });
  expect(await resolve(f)).toEqual({ authorized: false, scopes: [], epoch: '1' });
});

it('the live credential and app ceilings narrow existing grant scopes without changing the pair epoch', async () => {
  const f = await seed(); await consent(f);
  await getDb().update(applications).set({ scopes: ['acting-as:offline'] }).where(eq(applications.id, f.app.id));
  expect(await resolve(f)).toEqual({ authorized: true, scopes: ['acting-as:offline'], epoch: '1' });
  expect((await resolveServiceActingAsGrant(f.app.id, f.subject.id, { ...context(f), environment: 'development' })).authorized).toBe(false);
});

it.each(['app', 'credential'] as const)('removing offline delegation from the live %s ceiling denies impersonation even with user:read remaining', async (ceiling) => {
  const f = await seed(); await consent(f);
  if (ceiling === 'app') await getDb().update(applications).set({ scopes: ['user:read'] }).where(eq(applications.id, f.app.id));
  else await getDb().update(applicationCredentials).set({ scopes: ['user:read'] }).where(eq(applicationCredentials.id, f.credential.id));
  expect(await resolve(f)).toEqual({ authorized: false, scopes: [], epoch: '1' });
});

it('revoking the autonomous key after a route precheck but before persistence leaves marker, epoch and grants untouched', async () => {
  const f = await seed('bot');
  const [key] = await getDb().insert(userAuthMethods).values({ userId: f.subject.id, type: 'agent_key',
    methodPublicKey: randomUUID(), label: 'fixture', enrollmentMethod: 'governor' }).returning();
  const binding = { authMethodId: key.id, authMethodOwnerId: f.subject.id };
  await revokeServiceActingAs(f.subject.id, f.app.id);
  // Route already observed this live key. SQL revocation commits before its
  // suspended continuation enters persistOAuthAuthorization's transaction.
  const [checked] = await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.id, key.id));
  expect(checked.revokedAt).toBeNull();
  await getDb().transaction(async (tx) => {
    await tx.select().from(users).where(eq(users.id, f.subject.id)).for('share');
    await tx.update(userAuthMethods).set({ revokedAt: new Date() }).where(eq(userAuthMethods.id, key.id));
  });
  await expect(consent(f, { authMethod: binding })).rejects.toMatchObject({ statusCode: 401 });
  expect(await getDb().select().from(appGrants).where(eq(appGrants.applicationId, f.app.id))).toHaveLength(0);
  expect(await getDb().select().from(authCodes).where(eq(authCodes.applicationId, f.app.id))).toHaveLength(0);
  expect(await getDb().select().from(serviceActingAsRevocations).where(eq(serviceActingAsRevocations.applicationId, f.app.id))).toHaveLength(1);
  expect(await resolve(f)).toMatchObject({ epoch: '1', authorized: false });
});

const workerSource = `
const { OxyServer } = require('@oxy.so/core/server');
let server;
process.on('message', async (message) => {
  try {
    if (message.setup) { server = new OxyServer({baseURL:message.url}); server.serviceToken = async () => message.token; process.send({ready:true}); return; }
    const result = await server.verifyActingAs(message.app, message.user, { cache:message.cache, ...message.context });
    process.send({result});
  } catch (error) { process.send({error:String(error)}); }
});
`;
function message(child: ChildProcess, payload: unknown): Promise<{ ready?: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker response timeout')), 10_000);
    child.once('message', (answer) => { clearTimeout(timer); resolve(answer as { result?: unknown }); });
    child.send(payload, (error) => { if (error) { clearTimeout(timer); reject(error); } });
  });
}

it('two independent SDK processes deny the next fresh effect after the SQL revoke commit, despite cached positive reads', async () => {
  const f = await seed(); await consent(f);
  const app = express(); app.use('/internal', internalRouter); app.use(errorHandler);
  let server: Server | undefined;
  const children: ChildProcess[] = [];
  try {
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const token = mintServiceToken({ appId: f.app.id, appName: f.app.name, credentialId: f.credential.id,
      ownerAccountId: f.owner.id, environment: 'production', tier: 'internal', scopes: f.credential.scopes });
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ['-e', workerSource], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], cwd: process.cwd() });
      children.push(child);
      expect(await message(child, { setup: true, url: `http://127.0.0.1:${address.port}`, token })).toEqual({ ready: true });
    }
    const request = { app: f.app.id, user: f.subject.id, context: context(f) };
    for (const child of children) expect(await message(child, { ...request, cache: true })).toMatchObject({ result: { authorized: true, epoch: '1' } });
    await revokeServiceActingAs(f.subject.id, f.app.id);
    const committedAt = performance.now();
    const denials = await Promise.all(children.map((child) => message(child, { ...request, cache: false })));
    const commitToDenialsMs = performance.now() - committedAt;
    expect(denials).toEqual([{ result: null }, { result: null }]);
    expect(commitToDenialsMs).toBeLessThan(5000);
    process.stdout.write(JSON.stringify({ measurement: 'local_two_process_revoke_commit_to_fresh_denials_ms', value: commitToDenialsMs, productionP99: false }) + "\n");
  } finally {
    await Promise.all(children.map((child) => new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill(); })));
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});


it('a barrier across a concurrent revoke cannot combine a new epoch with the old grant snapshot', async () => {
  const f = await seed(); await consent(f);
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  let release!: () => void;
  const go = new Promise<void>((resolve) => { release = resolve; });
  const writer = getDb().transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE app_grants IN ACCESS EXCLUSIVE MODE`);
    locked(); await go;
    await tx.update(serviceActingAsAuthorityEpochs).set({ epoch: BigInt(2) }).where(and(
      eq(serviceActingAsAuthorityEpochs.userId, f.subject.id), eq(serviceActingAsAuthorityEpochs.applicationId, f.app.id)));
    await tx.delete(appGrants).where(eq(appGrants.applicationId, f.app.id));
  });
  await ready;
  const pending = resolve(f);
  try {
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const rows = await getDb().execute(sql`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE '%from "app_grants"%'
      ) AS waiting`);
      waiting = rows[0]?.waiting === true;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(waiting).toBe(true);
  } finally { release(); }
  await writer;
  expect(await pending).toMatchObject({ authorized: true, epoch: '1' });
  expect(await resolve(f)).toEqual({ authorized: false, scopes: [], epoch: '2' });
});
