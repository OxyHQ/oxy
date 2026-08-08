/**
 * `GET /profiles/username/:username` against a REAL Postgres.
 *
 * The route is the ecosystem's public profile-by-handle lookup, so this suite
 * pins two things that the previous mock-shaped version could not:
 *
 *  1. **The eligibility gate** — archived and `restricted`-tier accounts are
 *     404, and a local hit never reaches federation discovery. Previously the
 *     suite asserted that `User.findOne` had been called with a particular
 *     regex; the route builds no regex any more, and a query-shape assertion
 *     could never have told a working gate from a broken one anyway.
 *  2. **The wire shape** — the FULL emitted body, field for field, parsed
 *     against `@oxyhq/contracts`' `userResponseSchema`. Every ecosystem app
 *     consumes this object; a dropped field is the expensive defect here.
 *
 * Only the two network/identity edges are mocked: the auth middleware (so a
 * viewer can be chosen) and `federationService.resolveAndUpsert` (WebFinger).
 * `isFediverseHandle`, `validate`, the serializer and every query are REAL.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { userResponseSchema, safeParseContract } from '@oxyhq/contracts';


/** Set by a test before the request; read by the mocked optional-auth middleware. */
let currentViewerId: string | undefined;

const mockResolveAndUpsert = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (
    req: { user?: { _id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    if (currentViewerId) req.user = { _id: currentViewerId };
    next();
  },
  resolveViewerId: () => currentViewerId,
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { federationService } from '../../services/federation.service';
import profilesRouter from '../profiles';

interface JsonResponse {
  status: number;
  raw: string;
  body: { message?: string; data?: Record<string, unknown> | null };
}

let server: http.Server;

function get(path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw,
            body: raw.length > 0 ? JSON.parse(raw) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function lookup(username: string): Promise<JsonResponse> {
  return get(`/profiles/username/${encodeURIComponent(username)}`);
}

/** Insert a `users` row, returning its generated id. */
async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** A username no other suite sharing this database can collide with. */
function handle(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/profiles', profilesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  currentViewerId = undefined;
  mockResolveAndUpsert.mockReset();
  jest
    .spyOn(federationService, 'resolveAndUpsert')
    .mockImplementation((...args) => mockResolveAndUpsert(...args));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /profiles/username/:username — eligibility gate', () => {
  it('404s a restricted-tier local account without attempting federation discovery', async () => {
    const username = handle('abuser');
    await account({ username, accountStatus: 'active', reputationTier: 'restricted' });

    const res = await lookup(username);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('404s an archived local account without attempting federation discovery', async () => {
    const username = handle('gone');
    await account({ username, accountStatus: 'archived', reputationTier: 'trusted' });

    const res = await lookup(username);

    expect(res.status).toBe(404);
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('404s a username that matches no row', async () => {
    const res = await lookup(handle('nobody'));

    expect(res.status).toBe(404);
  });

  it('rejects a username shorter than the 3-character minimum', async () => {
    const res = await lookup('ab');

    expect(res.status).toBe(400);
  });
});

describe('GET /profiles/username/:username — wire shape', () => {
  it('emits the complete public profile DTO and parses against the shared contract', async () => {
    const username = handle('nate');
    const id = await account({
      username,
      nameFirst: 'Nate',
      nameLast: 'Isern',
      avatar: 'file_123',
      color: 'orange',
      bio: 'hello',
      description: 'desc',
      links: ['https://oxy.so'],
      verified: true,
      type: 'local',
      accountStatus: 'active',
      reputationTier: 'trusted',
    });
    // Two real follow edges, so `_count` is a MEASUREMENT rather than a default.
    const follower = await account({ username: handle('follower') });
    const followed = await account({ username: handle('followed') });
    await getDb().insert(userFollows).values([
      { followerId: follower, followedId: id },
      { followerId: id, followedId: followed },
    ]);

    const [stored] = await getDb()
      .select({ createdAt: users.createdAt, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    const res = await lookup(username);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id,
      username,
      name: { displayName: 'Nate Isern', first: 'Nate', last: 'Isern', full: 'Nate Isern' },
      avatar: 'file_123',
      verified: true,
      bio: 'hello',
      description: 'desc',
      color: 'orange',
      links: ['https://oxy.so'],
      linksMetadata: [],
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
      type: 'local',
      kind: 'personal',
      isFederated: false,
      fediverseSharing: true,
      _count: { followers: 1, following: 1 },
    });
    expect(safeParseContract(userResponseSchema, res.body.data)).not.toBeNull();
  });

  it('omits name.displayName for an account with no real name', async () => {
    const username = handle('nameless');
    await account({ username });

    const res = await lookup(username);

    expect(res.status).toBe(200);
    expect(res.body.data?.name).toEqual({});
  });

  it('emits the federation subdocument and isFederated for a federated actor', async () => {
    const username = handle('remote');
    await account({
      username,
      type: 'federated',
      federationActorUri: `https://remote.example/users/${username}`,
      federationDomain: 'remote.example',
    });

    const res = await lookup(username);

    expect(res.status).toBe(200);
    expect(res.body.data?.type).toBe('federated');
    expect(res.body.data?.isFederated).toBe(true);
    expect(res.body.data?.federation).toEqual({
      actorUri: `https://remote.example/users/${username}`,
      domain: 'remote.example',
    });
  });

  it('never emits a protected column, even when the row carries one', async () => {
    const username = handle('secretive');
    await account({
      username,
      email: `${username}@oxy.so`,
      phone: '+34600000000',
      refreshToken: 'rt_secret_value',
      publicKey: `04${randomUUID().replace(/-/g, '')}`,
      emailSignature: 'sent from my oxy',
      autoForwardTo: 'elsewhere@example.com',
    });

    const res = await lookup(username);

    expect(res.status).toBe(200);
    for (const field of ['email', 'phone', 'refreshToken', 'publicKey', 'hashedEmail', 'hashedPhone']) {
      expect(res.body.data).not.toHaveProperty(field);
    }
    expect(res.raw).not.toContain(`${username}@oxy.so`);
    expect(res.raw).not.toContain('+34600000000');
    expect(res.raw).not.toContain('rt_secret_value');
    expect(res.raw).not.toContain('elsewhere@example.com');
  });

  it('never emits the discoverability gate columns it reads', async () => {
    const username = handle('gated');
    await account({ username, accountStatus: 'active', reputationTier: 'high_trust' });

    const res = await lookup(username);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('accountStatus');
    expect(res.body.data).not.toHaveProperty('reputationTier');
    expect(res.body.data).not.toHaveProperty('privacySettings');
  });
});

describe('GET /profiles/username/:username — case-insensitive resolution', () => {
  it('resolves a mixed-case stored username from a lower-case request', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const stored = `Alice${suffix}`;
    const id = await account({ username: stored, nameFirst: 'Alice' });

    const res = await lookup(stored.toLowerCase());

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
    // The STORED spelling is returned verbatim — the index is on `lower(...)`,
    // the value is not normalized.
    expect(res.body.data?.username).toBe(stored);
  });
});

describe('GET /profiles/username/:username — viewer relationship', () => {
  it('omits relationship entirely for an anonymous request', async () => {
    const username = handle('watched');
    await account({ username });

    const res = await lookup(username);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('relationship');
  });

  it('reports real follow edges in both directions for an authenticated viewer', async () => {
    const username = handle('mutual');
    const target = await account({ username });
    const viewer = await account({ username: handle('viewer') });
    await getDb().insert(userFollows).values([
      { followerId: viewer, followedId: target },
      { followerId: target, followedId: viewer },
    ]);
    currentViewerId = viewer;

    const res = await lookup(username);

    expect(res.status).toBe(200);
    expect(res.body.data?.relationship).toEqual({ isFollowing: true, followsYou: true });
  });

  it('reports a one-directional edge as isFollowing without followsYou', async () => {
    const username = handle('oneway');
    const target = await account({ username });
    const viewer = await account({ username: handle('viewer') });
    await getDb()
      .insert(userFollows)
      .values({ followerId: viewer, followedId: target });
    currentViewerId = viewer;

    const res = await lookup(username);

    expect(res.body.data?.relationship).toEqual({ isFollowing: true, followsYou: false });
  });

  it('omits relationship on a self-view', async () => {
    const username = handle('self');
    const id = await account({ username });
    currentViewerId = id;

    const res = await lookup(username);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('relationship');
  });
});

describe('GET /profiles/username/:username — federated handle discovery', () => {
  it('resolves an unknown fediverse handle through WebFinger and returns the upserted row', async () => {
    const username = handle('discovered');
    const remoteHandle = `${username}@remote.example`;
    const id = await account({
      username: remoteHandle,
      nameFirst: 'Discovered',
      type: 'federated',
      federationActorUri: `https://remote.example/users/${username}`,
      federationDomain: 'remote.example',
    });
    // The row exists only AFTER discovery runs, which is what the upsert models:
    // the route re-reads by the id the service hands back.
    await getDb().update(users).set({ username: null }).where(eq(users.id, id));
    mockResolveAndUpsert.mockResolvedValue({ _id: id });

    const res = await lookup(remoteHandle);

    expect(mockResolveAndUpsert).toHaveBeenCalledWith(remoteHandle);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
    expect(res.body.data?.isFederated).toBe(true);
  });

  it('404s when discovery resolves an archived actor', async () => {
    const username = handle('deadactor');
    const remoteHandle = `${username}@remote.example`;
    const id = await account({
      username: null,
      type: 'federated',
      accountStatus: 'archived',
      federationActorUri: `https://remote.example/users/${username}`,
      federationDomain: 'remote.example',
    });
    mockResolveAndUpsert.mockResolvedValue({ _id: id });

    const res = await lookup(remoteHandle);

    expect(res.status).toBe(404);
  });

  it('404s when discovery fails outright', async () => {
    mockResolveAndUpsert.mockRejectedValue(new Error('webfinger unreachable'));

    const res = await lookup(`${handle('missing')}@remote.example`);

    expect(res.status).toBe(404);
  });

  it('lowercases a mixed-case fediverse handle before both the local lookup and discovery', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const stored = `Bridged${suffix}@Remote.Example`;
    mockResolveAndUpsert.mockResolvedValue(null);

    const res = await lookup(stored);

    expect(res.status).toBe(404);
    expect(mockResolveAndUpsert).toHaveBeenCalledWith(stored.toLowerCase());
  });
});
