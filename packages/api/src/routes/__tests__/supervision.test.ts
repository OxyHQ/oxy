import * as directory from '../../services/organization-directory.service';
import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ServiceTokenPayload } from '../../middleware/serviceToken';
let mockServiceToken: ServiceTokenPayload | undefined;
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn() },
}));
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    serviceAuthMiddleware: (
      req: { serviceApp?: ServiceTokenPayload },
      res: unknown,
      next: () => void,
    ) => {
      if (!mockServiceToken) return actual.serviceAuthMiddleware(req, res, next);
      req.serviceApp = mockServiceToken;
      next();
    },
  };
});
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import router from '../supervision';
import assetsRouter from '../assets';
import { assetService } from '../../services/assetServiceSingleton';
import { errorHandler } from '../../middleware/errorHandler';
import { accountService } from '../../services/account.service';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  users,
  applications,
  applicationCredentials,
  sessions,
  files,
  organizationProfiles,
  blocks,
} from '../../db/schema';
import sessionService from '../../services/session.service';
import { inviteGuardian, acceptInvitation } from '../../services/supervision.service';
let server: http.Server;
beforeAll(async () => {
  await connectPostgres();
  process.env.DEVICE_ID_SALT = 's'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/safety', router);
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await closePostgres();
});
afterEach(() => {
  mockServiceToken = undefined;
});
async function person() {
  const [row] = await getDb()
    .insert(users)
    .values({ kind: 'personal', privacyProfileVisibility: true })
    .returning({ id: users.id });
  return row.id;
}
async function consumer() {
  const owner = await person();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Safety reviewer',
      ownerAccountId: owner,
      type: 'first_party',
      scopes: ['safety:decide'],
      capabilities: ['safety:profile:v1', 'safety:content:v1'],
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'Safety service',
      type: 'service',
      environment: 'production',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'testhash',
    })
    .returning({ id: applicationCredentials.id });
  mockServiceToken = {
    type: 'service',
    appId: app.id,
    appName: 'Safety reviewer',
    credentialId: credential.id,
    ownerAccountId: owner,
    environment: 'production',
    tier: 'internal',
    scopes: ['safety:decide'],
  };
  return { app: app.id, credential: credential.id };
}
async function session(account: string) {
  return sessionService.createSession(
    account,
    { headers: { 'user-agent': 'Safety test' }, ip: '127.0.0.1', get: () => undefined } as never,
    { deviceId: randomUUID() },
  );
}
async function post(path: string, body: unknown) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/safety${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: response.status, body: await response.json() };
}
it('requires actual bearer proof, exact session and consumer binding, then live action authority', async () => {
  const c = await consumer(),
    child = await person(),
    guardian = await person();
  await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
  const current = await session(child),
    input = { sessionId: current.sessionId, accessToken: current.accessToken, action: 'content' };
  expect((await post('/service/session', { ...input, accessToken: 'forged' })).status).toBe(401);
  expect((await post('/service/session', { ...input, sessionId: randomUUID() })).status).toBe(401);
  const good = await post('/service/session', input);
  expect(good.status).toBe(200);
  expect(good.body.user.id).toBe(child);
  const [otherApp] = await getDb()
    .insert(applications)
    .values({ name: 'Other consumer', ownerAccountId: guardian })
    .returning({ id: applications.id });
  await getDb()
    .update(sessions)
    .set({ applicationId: otherApp.id })
    .where(eq(sessions.sessionId, current.sessionId));
  expect((await post('/service/session', input)).status).toBe(403);
  await getDb()
    .update(sessions)
    .set({ applicationId: c.app })
    .where(eq(sessions.sessionId, current.sessionId));
  await getDb().update(applications).set({ capabilities: [] }).where(eq(applications.id, c.app));
  expect((await post('/service/session', input)).status).toBe(403);
  await getDb()
    .update(applicationCredentials)
    .set({ status: 'revoked' })
    .where(eq(applicationCredentials.id, c.credential));
  expect(
    (
      await post('/service/profile-access-batch', {
        input: { subjectAccountIds: [child] },
        requester: { accessToken: null },
      })
    ).status,
  ).toBe(403);
});
it('keeps ordinary adults and explicit anonymous public policy reads valid without granting impersonation', async () => {
  await consumer();
  const adult = await person(),
    current = await session(adult);
  expect(
    (
      await post('/service/session', {
        sessionId: current.sessionId,
        accessToken: current.accessToken,
        action: 'content',
      })
    ).status,
  ).toBe(200);
  const input = { subjectAccountIds: [adult] };
  const anonymous = await post('/service/profile-access-batch', {
    input,
    requester: { accessToken: null },
  });
  expect(anonymous.status).toBe(200);
  expect(anonymous.body.items[0].decision.allowed).toBe(true);
  expect(
    (
      await post('/service/profile-access-batch', {
        input,
        requester: { accessToken: null, viewerId: adult },
      })
    ).status,
  ).toBe(422);
});

it('preserves a live authorized ordinary organization actor and revokes it when its human principal enrolls', async () => {
  await consumer();
  const operator = await person(),
    guardian = await person();
  const { account } = await accountService.createChildAccount(operator, operator, {
    kind: 'organization',
    username: `org${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  });
  const current = await sessionService.createSession(
    account.id,
    { headers: { 'user-agent': 'Safety test' }, ip: '127.0.0.1', get: () => undefined } as never,
    { deviceId: randomUUID(), operatedByUserId: operator },
  );
  const input = {
    sessionId: current.sessionId,
    accessToken: current.accessToken,
    action: 'profile',
  };
  const result = await post('/service/session', input);
  expect(result.status).toBe(200);
  expect(result.body.actor).toMatchObject({
    effectiveAccountId: account.id,
    actorAccountId: operator,
  });
  await acceptInvitation((await inviteGuardian(operator, guardian)).id, guardian);
  expect((await post('/service/session', input)).status).toBe(401);
});

it('lets supervised people list and upload only their own private files without exposing another owner', async () => {
  const child = await person(),
    guardian = await person();
  const insert = async (ownerUserId: string, visibility: 'public' | 'private' = 'private') => {
    const [file] = await getDb()
      .insert(files)
      .values({
        ownerUserId,
        visibility,
        sha256: randomUUID().replaceAll('-', '').repeat(2),
        size: 4,
        mime: 'text/plain',
        ext: '.txt',
        storageKey: `test/${randomUUID()}`,
        originalName: 'draft.txt',
      })
      .returning();
    return file;
  };
  const own = await insert(child, 'public'),
    other = await insert(guardian);
  await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
  const current = await session(child);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${current.accessToken}` };
  const listed = await fetch(`${origin}/assets?ownerUserId=${guardian}`, { headers });
  expect(listed.status).toBe(200);
  const listedBody = await listed.json();
  expect(listedBody.data.files.map((file: { id: string }) => file.id)).toEqual([own.id]);
  expect((await fetch(`${origin}/assets/${own.id}`, { headers })).status).toBe(200);
  expect((await fetch(`${origin}/assets/${other.id}`, { headers })).status).toBe(403);
  const setVisibility = async (id: string, visibility: string) =>
    fetch(`${origin}/assets/${id}/visibility`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility }),
    });
  // Relocation performs external object-store I/O; verify the authenticated route calls only the safe mutation.
  const relocate = jest
    .spyOn(assetService, 'updateFileVisibility')
    .mockResolvedValue({ ...own, visibility: 'private', links: [], variants: [] });
  try {
    expect((await setVisibility(own.id, 'private')).status).toBe(200);
    expect(relocate).toHaveBeenCalledWith(own.id, 'private');
  } finally {
    relocate.mockRestore();
  }
  expect((await setVisibility(own.id, 'public')).status).toBe(403);
  expect((await setVisibility(own.id, 'unlisted')).status).toBe(403);
  expect((await setVisibility(other.id, 'private')).status).toBe(403);
  const upload = jest
    .spyOn(assetService, 'uploadFileDirect')
    .mockResolvedValue({ ...own, links: [], variants: [] });
  try {
    const data = new FormData();
    data.append('file', new Blob(['text'], { type: 'text/plain' }), 'draft.txt');
    expect(
      (await fetch(`${origin}/assets/upload`, { method: 'POST', headers, body: data })).status,
    ).toBe(200);
    expect(upload).toHaveBeenCalledWith(
      child,
      expect.any(Buffer),
      'text/plain',
      'draft.txt',
      'private',
      undefined,
    );
    upload.mockClear();
    data.append('visibility', 'public');
    expect(
      (await fetch(`${origin}/assets/upload`, { method: 'POST', headers, body: data })).status,
    ).toBe(403);
    expect(upload).not.toHaveBeenCalled();
  } finally {
    upload.mockRestore();
  }
  const complete = jest.spyOn(assetService, 'completeUpload');
  try {
    const response = await fetch(`${origin}/assets/complete`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        fileId: own.id,
        originalName: 'draft.txt',
        size: 4,
        mime: 'text/plain',
        visibility: 'public',
      }),
    });
    expect(response.status).toBe(403);
    expect(complete).not.toHaveBeenCalled();
  } finally {
    complete.mockRestore();
  }
  await getDb().update(users).set({ reputationTier: 'restricted' }).where(eq(users.id, child));
  expect((await fetch(`${origin}/assets/${own.id}`, { headers })).status).toBe(401);
});

it('authenticates batches once and distinguishes user decisions from reviewed background delivery', async () => {
  const { app } = await consumer();
  const child = await person(),
    guardian = await person();
  await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
  const current = await session(child);
  await getDb()
    .update(applications)
    .set({ capabilities: ['safety:messaging:v1'] })
    .where(eq(applications.id, app));
  const items = [
    { resourceId: 'self', participantAccountIds: [child] },
    { resourceId: 'guardian', participantAccountIds: [child, guardian] },
  ];
  const response = await post('/service/message-access-batch', {
    input: { items },
    requester: { accessToken: current.accessToken },
  });
  expect(response.status).toBe(200);
  expect(
    response.body.items.map((item: { decision: { allowed: boolean } }) => item.decision.allowed),
  ).toEqual([true, true]);
  const delivery = { items: items.map((item) => ({ ...item, senderAccountId: child })) };
  expect((await post('/service/delivery-access-batch', delivery)).status).toBe(403);
  await getDb()
    .update(applications)
    .set({ capabilities: ['safety:messaging:v1', 'safety:messaging-delivery:v1'] })
    .where(eq(applications.id, app));
  expect((await post('/service/delivery-access-batch', delivery)).status).toBe(200);
  await getDb().update(applications).set({ capabilities: [] }).where(eq(applications.id, app));
  expect((await post('/service/delivery-access-batch', delivery)).status).toBe(403);
  expect(
    (
      await post('/service/message-access-batch', {
        input: { items },
        requester: { accessToken: null },
      })
    ).status,
  ).toBe(401);
});

it('returns only current socket identities and refuses wrong-app proofs and revoked consumer capabilities', async () => {
  const { app } = await consumer();
  const adult = await person(),
    child = await person(),
    guardian = await person();
  await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
  const a = await session(adult),
    c = await session(child);
  const [other] = await getDb()
    .insert(applications)
    .values({ name: 'Other receiver', ownerAccountId: adult })
    .returning();
  const wrong = await sessionService.createSession(
    adult,
    { headers: {}, get: () => undefined } as never,
    {
      deviceId: randomUUID(),
      application: { applicationId: other.id, clientId: 'wrong-client', scopes: [] },
    },
  );
  const input = {
    items: [
      { requestId: 'adult-socket', accessToken: a.accessToken },
      { requestId: 'child-socket', accessToken: c.accessToken },
      { requestId: 'wrong-app', accessToken: wrong.accessToken },
      { requestId: 'bad', accessToken: 'malformed' },
    ],
  };
  expect((await post('/service/messaging-sessions', input)).status).toBe(403);
  await getDb()
    .update(applications)
    .set({ capabilities: ['safety:messaging-delivery:v1', 'safety:messaging:v1'] })
    .where(eq(applications.id, app));
  const result = await post('/service/messaging-sessions', input);
  expect(result.status).toBe(200);
  expect(result.body.items).toEqual([
    { requestId: 'adult-socket', allowed: true, accountId: adult },
    { requestId: 'child-socket', allowed: true, accountId: child },
    { requestId: 'wrong-app', allowed: false },
    { requestId: 'bad', allowed: false },
  ]);
  await getDb()
    .update(applications)
    .set({ capabilities: ['safety:messaging-delivery:v1'] })
    .where(eq(applications.id, app));
  expect((await post('/service/messaging-sessions', input)).body.items[1]).toEqual({
    requestId: 'child-socket',
    allowed: false,
  });
  await getDb().update(applications).set({ capabilities: [] }).where(eq(applications.id, app));
  expect((await post('/service/messaging-sessions', input)).status).toBe(403);
});

it('returns only minimal active employer identities to children and adults, resolving redirects and failing closed', async () => {
  const child = await person(),
    guardian = await person();
  await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
  const childSession = await session(child),
    adultSession = await session(guardian);
  const prefix = `Safety${randomUUID().slice(0, 8)}`;
  const create = (suffix: string) =>
    directory.createNeutralOrganization({
      name: `${prefix}${suffix}`,
      organizationType: 'business',
      legalName: 'Private legal detail',
      websiteUrl: 'https://example.com',
    });
  const active = await create('Active'),
    old = await create('Old'),
    inactive = await create('Inactive'),
    hidden = await create('Hidden'),
    privateOrg = await create('Private'),
    blocked = await create('Blocked'),
    restricted = await create('Restricted');
  await directory.mergeOrganizations(old.accountId, active.accountId, guardian, 'review-evidence');
  await getDb()
    .update(organizationProfiles)
    .set({ status: 'inactive' })
    .where(eq(organizationProfiles.accountId, inactive.accountId));
  await getDb()
    .update(users)
    .set({ privacyProfileVisibility: false })
    .where(eq(users.id, hidden.accountId));
  await getDb()
    .update(users)
    .set({ privacyIsPrivateAccount: true })
    .where(eq(users.id, privateOrg.accountId));
  await getDb()
    .update(users)
    .set({ reputationTier: 'restricted' })
    .where(eq(users.id, restricted.accountId));
  await getDb().insert(blocks).values({ userId: blocked.accountId, blockedId: child });
  const request = async (body: unknown, bearer?: string) => {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/safety/supervision/organizations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const identity = {
    accountId: active.accountId,
    username: active.username,
    name: active.name,
    organizationType: 'business',
  };
  for (const bearer of [childSession.accessToken, adultSession.accessToken]) {
    expect(await request({ ids: [old.accountId] }, bearer)).toEqual({
      status: 200,
      body: {
        items: [{ requestedAccountId: old.accountId, organization: identity }],
        missingIds: [],
      },
    });
    expect(await request({ query: `${prefix}Old` }, bearer)).toEqual({
      status: 200,
      body: {
        items: [{ requestedAccountId: active.accountId, organization: identity }],
        missingIds: [],
      },
    });
  }
  await getDb()
    .update(users)
    .set({ privacyProfileVisibility: false })
    .where(eq(users.id, old.accountId));
  expect((await request({ query: `${prefix}Old` }, childSession.accessToken)).body).toEqual({
    items: [],
    missingIds: [],
  });
  const missingIds = [
    inactive.accountId,
    hidden.accountId,
    privateOrg.accountId,
    blocked.accountId,
    restricted.accountId,
    child,
    randomUUID(),
  ];
  expect(await request({ ids: missingIds }, childSession.accessToken)).toEqual({
    status: 200,
    body: { items: [], missingIds },
  });
  expect(
    (await request({ query: prefix, limit: 1 }, childSession.accessToken)).body.items,
  ).toHaveLength(1);
  for (const input of [
    { ids: Array.from({ length: 101 }, () => randomUUID()) },
    { query: prefix, limit: 21 },
    { query: prefix, viewerId: guardian },
    { ids: [active.accountId, active.accountId] },
  ])
    expect((await request(input, childSession.accessToken)).status).toBe(422);
  expect((await request({ ids: [active.accountId] })).status).toBe(401);
  expect((await request({ ids: [active.accountId] }, 'invalid')).status).toBe(401);
  const outage = jest
    .spyOn(sessionService, 'validateSession')
    .mockRejectedValueOnce(new Error('Authority unavailable'));
  expect((await request({ ids: [active.accountId] }, childSession.accessToken)).status).toBe(503);
  outage.mockRestore();
  const queryOutage = jest
    .spyOn(directory, 'safetyOrganizationIdentities')
    .mockRejectedValueOnce(new Error('Directory unavailable'));
  expect((await request({ ids: [active.accountId] }, childSession.accessToken)).status).toBe(503);
  queryOutage.mockRestore();
  await getDb()
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.sessionId, childSession.sessionId));
  expect((await request({ ids: [active.accountId] }, childSession.accessToken)).status).toBe(401);
});
