/**
 * `GET|POST|DELETE /applications/:appId/trusted-publishers` (ADR 0057), through
 * the shipped `/applications` router against a REAL Postgres.
 *
 * Stubbed seams, the same two `credentialAuditTrail.test.ts` stubs: the session
 * middleware (who the caller is) and `account.service` (which role they hold
 * over the owning account). GitHub's REST API is served through `fetch`.
 */

import express from 'express';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { AccountRole } from '../../utils/accountRoles';
import { permissionsForAccountRole } from '../../utils/accountRoles';

const accessGrants = new Map<string, AccountRole>();
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: {
    resolveEffectiveAccess: jest.fn(async (userId: string, accountId: string) => {
      const role = userId === accountId ? 'owner' : accessGrants.get(`${userId}:${accountId}`);
      if (!role) return null;
      return {
        role,
        permissions: permissionsForAccountRole(role),
        source: userId === accountId ? 'self' : 'direct',
        membership: null,
      };
    }),
    listAccessibleAccounts: jest.fn(async () => []),
  },
}));

let callerId = '';
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: { toString: () => callerId }, isStaff: false };
    next();
  },
}));
jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: async () => {},
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, githubTrustedPublishers, users } from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import applicationsRouter from '../applications';
import { declareFirstPartyTrustedPublishers } from '../../services/githubTrustedPublishing.service';
import { eq } from 'drizzle-orm';

const GITHUB_REPOS: Record<string, { id: number; full_name: string }> = {};
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const prefix = 'https://api.github.com/repos/';
    if (url.startsWith(prefix)) {
      const repo = GITHUB_REPOS[url.slice(prefix.length).toLowerCase()];
      return repo
        ? new Response(JSON.stringify(repo), { status: 200 })
        : new Response('{"message":"Not Found"}', { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const server = express();
server.use(express.json());
server.use('/applications', applicationsRouter);
server.use(errorHandler);

beforeAll(connectPostgres);
afterAll(closePostgres);

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function seedApp(
  ownerAccountId: string,
  type: 'first_party' | 'third_party' = 'third_party',
): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `Publisher App ${randomBytes(4).toString('hex')}`,
      ownerAccountId,
      createdByUserId: ownerAccountId,
      type,
      isOfficial: type === 'first_party',
    })
    .returning({ id: applications.id });
  return row.id;
}

function publicRepo(): { name: string; id: number } {
  const name = `OxyHQ/App-${randomBytes(5).toString('hex')}`;
  const id = Math.floor(Math.random() * 1e9) + 1;
  GITHUB_REPOS[name.toLowerCase()] = { id, full_name: name };
  return { name, id };
}

describe('trusted publisher management', () => {
  it('registers a public repository with the id GitHub reports, lists it, deletes it', async () => {
    const owner = await account();
    callerId = owner;
    const appId = await seedApp(owner);
    const repo = publicRepo();

    const created = await request(server).post(`/applications/${appId}/trusted-publishers`).send({
      repository: repo.name.toLowerCase(),
      workflow: '.github/workflows/publish-update.yml',
    });
    expect(created.status).toBe(201);
    expect(created.body.trustedPublisher).toMatchObject({
      provider: 'github',
      // GitHub's own casing, not the caller's.
      repository: repo.name,
      repositoryId: String(repo.id),
      ref: 'refs/heads/main',
      workflow: '.github/workflows/publish-update.yml',
      lastUsedAt: null,
    });

    const listed = await request(server).get(`/applications/${appId}/trusted-publishers`);
    expect(listed.status).toBe(200);
    expect(listed.body.trustedPublishers).toHaveLength(1);

    const duplicate = await request(server)
      .post(`/applications/${appId}/trusted-publishers`)
      .send({ repository: repo.name, workflow: '.github/workflows/publish-update.yml' });
    expect(duplicate.status).toBe(409);

    const id = created.body.trustedPublisher.id as string;
    expect(
      (await request(server).delete(`/applications/${appId}/trusted-publishers/${id}`)).status,
    ).toBe(200);
    expect(
      (await request(server).delete(`/applications/${appId}/trusted-publishers/${id}`)).status,
    ).toBe(404);
    const after = await request(server).get(`/applications/${appId}/trusted-publishers`);
    expect(after.body.trustedPublishers).toHaveLength(0);
  });

  it('takes an explicit repositoryId for a private repository', async () => {
    const owner = await account();
    callerId = owner;
    const appId = await seedApp(owner);
    const missing = await request(server)
      .post(`/applications/${appId}/trusted-publishers`)
      .send({ repository: 'OxyHQ/private-thing' });
    expect(missing.status).toBe(400);
    const explicit = await request(server).post(`/applications/${appId}/trusted-publishers`).send({
      repository: 'OxyHQ/private-thing',
      repositoryId: '123456',
      ref: 'refs/heads/release',
    });
    expect(explicit.status).toBe(201);
    expect(explicit.body.trustedPublisher).toMatchObject({
      repositoryId: '123456',
      ref: 'refs/heads/release',
    });
  });

  it.each([
    [{ repository: 'not a repo' }],
    [{ repository: 'OxyHQ/x', ref: 'main' }],
    [{ repository: 'OxyHQ/x', workflow: 'publish.yml' }],
    [{ repository: 'OxyHQ/x', repositoryId: '0' }],
    [{ repository: 'OxyHQ/x', scopes: ['files:write'] }],
  ])('refuses a malformed rule %j', async (body) => {
    const owner = await account();
    callerId = owner;
    const appId = await seedApp(owner);
    const response = await request(server)
      .post(`/applications/${appId}/trusted-publishers`)
      .send(body);
    expect(response.status).toBe(400);
  });

  it('refuses writes to an Oxy application, whose publishers are declared in code', async () => {
    const owner = await account();
    callerId = owner;
    const appId = await seedApp(owner, 'first_party');
    const [seeded] = await getDb()
      .insert(githubTrustedPublishers)
      .values({ applicationId: appId, repository: 'OxyHQ/Seeded', repositoryId: '42' })
      .returning({ id: githubTrustedPublishers.id });
    const created = await request(server)
      .post(`/applications/${appId}/trusted-publishers`)
      .send({ repository: publicRepo().name });
    expect(created.status).toBe(409);
    expect(created.body.error).toBe('FIRST_PARTY_TRUSTED_PUBLISHERS_IN_CODE');
    const deleted = await request(server).delete(
      `/applications/${appId}/trusted-publishers/${seeded.id}`,
    );
    expect(deleted.status).toBe(409);
    // Reading them is not refused.
    const listed = await request(server).get(`/applications/${appId}/trusted-publishers`);
    expect(listed.status).toBe(200);
    expect(listed.body.trustedPublishers).toHaveLength(1);
  });

  it('needs the credential permissions over the owning account', async () => {
    const owner = await account();
    const appId = await seedApp(owner);
    const stranger = await account();
    callerId = stranger;
    const repo = publicRepo();
    const post = () =>
      request(server)
        .post(`/applications/${appId}/trusted-publishers`)
        .send({ repository: repo.name });
    expect((await post()).status).toBe(403);
    expect((await request(server).get(`/applications/${appId}/trusted-publishers`)).status).toBe(
      403,
    );

    // A viewer may read but not register.
    accessGrants.set(`${stranger}:${owner}`, 'viewer');
    expect((await post()).status).toBe(403);

    // A developer holds credentials:create, as for any credential.
    accessGrants.set(`${stranger}:${owner}`, 'developer');
    expect((await post()).status).toBe(201);
  });
});

describe('declareFirstPartyTrustedPublishers (the seed, ADR 0057)', () => {
  const rule = (repository: string, repositoryId: string) => ({
    repository,
    repositoryId,
    ref: 'refs/heads/main',
    workflow: '.github/workflows/publish-update.yml',
  });

  async function rows(applicationId: string) {
    return getDb()
      .select({
        repository: githubTrustedPublishers.repository,
        repositoryId: githubTrustedPublishers.repositoryId,
      })
      .from(githubTrustedPublishers)
      .where(eq(githubTrustedPublishers.applicationId, applicationId));
  }

  it('makes the publishers exactly the declaration, idempotently, and a dry run writes nothing', async () => {
    const owner = await account();
    const appId = await seedApp(owner, 'first_party');
    await getDb().insert(githubTrustedPublishers).values({
      applicationId: appId,
      repository: 'OxyHQ/Stray',
      repositoryId: '7',
    });

    const declared = [rule('OxyHQ/App', '100'), rule('OxyHQ/oxy', '200')];
    const dry = await declareFirstPartyTrustedPublishers({
      applicationId: appId,
      declared,
      actorUserId: owner,
      dryRun: true,
    });
    expect(dry.add).toHaveLength(2);
    expect(dry.remove.map((row) => row.repository)).toEqual(['OxyHQ/Stray']);
    expect(await rows(appId)).toEqual([{ repository: 'OxyHQ/Stray', repositoryId: '7' }]);

    await declareFirstPartyTrustedPublishers({
      applicationId: appId,
      declared,
      actorUserId: owner,
      dryRun: false,
    });
    expect((await rows(appId)).map((row) => row.repository).sort()).toEqual([
      'OxyHQ/App',
      'OxyHQ/oxy',
    ]);

    const again = await declareFirstPartyTrustedPublishers({
      applicationId: appId,
      declared,
      actorUserId: owner,
      dryRun: false,
    });
    expect(again).toEqual({ add: [], rename: [], remove: [] });

    // GitHub renamed the repository; the id is unchanged, the rule follows it.
    const renamed = await declareFirstPartyTrustedPublishers({
      applicationId: appId,
      declared: [rule('OxyHQ/App-Renamed', '100')],
      actorUserId: owner,
      dryRun: false,
    });
    expect(renamed.rename).toEqual([
      expect.objectContaining({ from: 'OxyHQ/App', to: 'OxyHQ/App-Renamed' }),
    ]);
    expect(await rows(appId)).toEqual([{ repository: 'OxyHQ/App-Renamed', repositoryId: '100' }]);

    // Absent means none.
    await declareFirstPartyTrustedPublishers({
      applicationId: appId,
      declared: [],
      actorUserId: owner,
      dryRun: false,
    });
    expect(await rows(appId)).toEqual([]);
  });
});
