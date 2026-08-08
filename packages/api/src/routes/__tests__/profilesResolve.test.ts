/**
 * `GET /profiles/resolve` against a REAL Postgres.
 *
 * The route is LOCAL-FIRST: a handle that already names an Oxy row is answered
 * from the database with no network hop, and only a genuinely unknown handle
 * falls through to WebFinger/ActivityPub discovery. That ordering is the point
 * of the endpoint — an atproto actor stored as `user@bsky.social` can never be
 * resolved by our WebFinger, so a local miss there would surface as a false
 * "Profile not found".
 *
 * The previous version asserted that a Mongoose `findOne` had been handed a
 * particular object; the route builds no such object any more, and a
 * query-shape assertion could not distinguish a working local-first path from a
 * broken one. This exercises the real query over real rows instead.
 *
 * `resolveAndUpsert` (a network call) and the auth middleware are the only
 * mocks. `isFediverseHandle` and the serializer are REAL.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { userResponseSchema, safeParseContract } from '@oxyhq/contracts';


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
  body: { message?: string; data?: Record<string, unknown> | null };
}

let server: http.Server;

function resolveHandle(handle: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const path = `/profiles/resolve?handle=${encodeURIComponent(handle)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** A federated-looking handle no other suite sharing this database can collide with. */
function remoteHandle(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}@mastodon.social`;
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
  mockResolveAndUpsert.mockResolvedValue(null);
  jest
    .spyOn(federationService, 'resolveAndUpsert')
    .mockImplementation((...args) => mockResolveAndUpsert(...args));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /profiles/resolve — local-first', () => {
  it('answers a known handle from the database without touching remote discovery', async () => {
    const handle = remoteHandle('known');
    const id = await account({
      username: handle,
      nameFirst: 'Known',
      type: 'federated',
      federationActorUri: `https://mastodon.social/users/${handle.split('@')[0]}`,
      federationDomain: 'mastodon.social',
    });

    const res = await resolveHandle(`@${handle}`);

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('answers an atproto-style handle WebFinger could never resolve', async () => {
    // `user@bsky.social` fails the strict fediverse-handle format gate, so the
    // discovery branch would 400 it. The local row is why it resolves at all —
    // this is the regression the local-first ordering exists for.
    const handle = `${randomUUID().replace(/-/g, '').slice(0, 12)}.bsky.social@bsky.social`;
    const id = await account({ username: handle, nameFirst: 'Blue' });

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('strips an acct: prefix and a single leading @ before the local lookup', async () => {
    const handle = remoteHandle('prefixed');
    const id = await account({ username: handle });

    const res = await resolveHandle(`acct:@${handle}`);

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
  });

  it('lower-cases a mixed-case fediverse handle so it still hits the local row', async () => {
    const handle = remoteHandle('mixedcase');
    const id = await account({ username: handle });

    const res = await resolveHandle(handle.toUpperCase());

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('400s an empty handle', async () => {
    const res = await resolveHandle('   ');

    expect(res.status).toBe(400);
  });
});

describe('GET /profiles/resolve — eligibility gate', () => {
  it('returns data:null for an archived local row rather than falling through to discovery', async () => {
    const handle = remoteHandle('archived');
    await account({ username: handle, accountStatus: 'archived' });

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('returns data:null for a restricted-tier local row', async () => {
    const handle = remoteHandle('restricted');
    await account({ username: handle, reputationTier: 'restricted' });

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('resolves a PRIVATE account — resolve is a direct handle lookup, not a discovery surface', async () => {
    const handle = remoteHandle('private');
    const id = await account({ username: handle, privacyIsPrivateAccount: true });

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
  });
});

describe('GET /profiles/resolve — discovery branch', () => {
  it('400s an unknown handle that is not a valid fediverse handle', async () => {
    const res = await resolveHandle('not-a-handle');

    expect(res.status).toBe(400);
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('resolves an unknown fediverse handle through discovery and re-reads the upserted row', async () => {
    const handle = remoteHandle('fresh');
    const id = await account({
      username: null,
      nameFirst: 'Fresh',
      type: 'federated',
      federationActorUri: `https://mastodon.social/users/${handle.split('@')[0]}`,
      federationDomain: 'mastodon.social',
    });
    mockResolveAndUpsert.mockResolvedValue({ _id: id });

    const res = await resolveHandle(`@${handle}`);

    expect(mockResolveAndUpsert).toHaveBeenCalledWith(handle);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
    expect(res.body.data?.isFederated).toBe(true);
    expect(safeParseContract(userResponseSchema, res.body.data)).not.toBeNull();
  });

  it('returns data:null when discovery resolves nothing', async () => {
    const res = await resolveHandle(remoteHandle('ghost'));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns data:null when discovery resolves an archived actor', async () => {
    const handle = remoteHandle('dead');
    const id = await account({ username: null, accountStatus: 'archived' });
    mockResolveAndUpsert.mockResolvedValue({ _id: id });

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns data:null when discovery resolves a restricted actor', async () => {
    const handle = remoteHandle('abusive');
    const id = await account({ username: null, reputationTier: 'restricted' });
    mockResolveAndUpsert.mockResolvedValue({ _id: id });

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('reads the resolved id from either `_id` or `id` on the upsert result', async () => {
    const handle = remoteHandle('shaped');
    const id = await account({ username: null, nameFirst: 'Shaped' });
    mockResolveAndUpsert.mockResolvedValue({ id });

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
  });
});

describe('GET /profiles/resolve — viewer relationship', () => {
  it('reports followsYou on the local branch from a real follow edge', async () => {
    const handle = remoteHandle('bridged');
    const target = await account({ username: handle });
    const viewer = await account({ username: `viewer${randomUUID().replace(/-/g, '').slice(0, 12)}` });
    await getDb().insert(userFollows).values({ followerId: target, followedId: viewer });
    currentViewerId = viewer;

    const res = await resolveHandle(`@${handle}`);

    expect(res.status).toBe(200);
    expect(res.body.data?.relationship).toEqual({ isFollowing: false, followsYou: true });
    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('omits relationship for an anonymous request', async () => {
    const handle = remoteHandle('anon');
    await account({ username: handle });

    const res = await resolveHandle(`@${handle}`);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('relationship');
  });

  it('omits relationship on a self-view', async () => {
    const handle = remoteHandle('self');
    const id = await account({ username: handle });
    currentViewerId = id;

    const res = await resolveHandle(`@${handle}`);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('relationship');
  });

  it('computes relationship on the discovery branch for a freshly-upserted actor', async () => {
    const handle = remoteHandle('newlyseen');
    const id = await account({ username: null, nameFirst: 'Newly' });
    const viewer = await account({ username: `viewer${randomUUID().replace(/-/g, '').slice(0, 12)}` });
    mockResolveAndUpsert.mockResolvedValue({ _id: id });
    currentViewerId = viewer;

    const res = await resolveHandle(handle);

    expect(res.status).toBe(200);
    // A brand-new actor has no edges yet, but the field is PRESENT — that is
    // what lets a consumer tell "known, not following" from "unknown".
    expect(res.body.data?.relationship).toEqual({ isFollowing: false, followsYou: false });
    expect(mockResolveAndUpsert).toHaveBeenCalled();
  });
});

describe('GET /profiles/resolve — wire shape', () => {
  it('emits the complete public profile DTO for a federated actor', async () => {
    const handle = remoteHandle('shapecheck');
    const localPart = handle.split('@')[0];
    const id = await account({
      username: handle,
      nameFirst: 'Shape',
      nameLast: 'Check',
      avatar: 'file_abc',
      color: 'blue',
      bio: 'remote bio',
      description: 'remote description',
      links: ['https://mastodon.social/@shape'],
      verified: false,
      type: 'federated',
      federationActorUri: `https://mastodon.social/users/${localPart}`,
      federationDomain: 'mastodon.social',
    });
    const [stored] = await getDb()
      .select({ createdAt: users.createdAt, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    const res = await resolveHandle(handle);

    expect(res.body.data).toEqual({
      id,
      username: handle,
      name: { displayName: 'Shape Check', first: 'Shape', last: 'Check', full: 'Shape Check' },
      avatar: 'file_abc',
      verified: false,
      bio: 'remote bio',
      description: 'remote description',
      color: 'blue',
      links: ['https://mastodon.social/@shape'],
      linksMetadata: [],
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
      type: 'federated',
      federation: {
        actorUri: `https://mastodon.social/users/${localPart}`,
        domain: 'mastodon.social',
      },
      kind: 'personal',
      isFederated: true,
      fediverseSharing: true,
      _count: { followers: 0, following: 0 },
    });
    expect(safeParseContract(userResponseSchema, res.body.data)).not.toBeNull();
  });
});
