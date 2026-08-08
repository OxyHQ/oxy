/**
 * `GET /profiles/search` against a REAL Postgres.
 *
 * People search is a PUBLIC, unauthenticated surface, so three properties are
 * load-bearing and each is asserted against stored rows rather than against a
 * query object:
 *
 *  - **The gate.** Archived, `restricted`-tier and private accounts must not
 *    appear — including via the federated prepend, which re-reads the resolved
 *    actor and re-applies the same predicate.
 *  - **The order.** Native before federated, most-reputable first, `id` as the
 *    FINAL tiebreaker. The third key is what makes the order STRICT, and a
 *    strict order is what makes offset pagination safe; a page that repeats one
 *    row while skipping another corrupts an infinite scroll with no error.
 *  - **The total.** `count(*) over ()` is evaluated before `LIMIT`, so it
 *    describes the whole match set, not the page.
 *
 * The old suite read `$match` / `$sort` stages back out of a mocked
 * `User.aggregate` — it asserted a pipeline was BUILT a certain way and never
 * that a row was excluded.
 *
 * Every test scopes itself with a unique token so the shared test database
 * (other suites seed users too) cannot influence a result.
 *
 * The `/profiles/resolve` cases this file also carried moved to
 * `profilesResolve.test.ts`, which owns that route end to end.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { userResponseSchema, safeParseContract } from '@oxyhq/contracts';


const mockResolveAndUpsert = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: (): string | undefined => undefined,
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { federationService } from '../../services/federation.service';
import profilesRouter from '../profiles';

interface SearchResponse {
  status: number;
  raw: string;
  body: {
    data?: Array<Record<string, unknown>>;
    pagination?: { total: number; limit: number; offset: number; hasMore: boolean };
  };
}

let server: http.Server;

function search(query: string, params: Record<string, string> = {}): Promise<SearchResponse> {
  const address = server.address() as AddressInfo;
  const queryString = new URLSearchParams({ query, ...params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path: `/profiles/search?${queryString.toString()}`,
      },
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

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** A search term no row seeded by another test or suite can match. */
function token(): string {
  return `t${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function ids(res: SearchResponse): string[] {
  return (res.body.data ?? []).map((row) => row.id as string);
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
  mockResolveAndUpsert.mockReset();
  mockResolveAndUpsert.mockResolvedValue(null);
  jest
    .spyOn(federationService, 'resolveAndUpsert')
    .mockImplementation((...args) => mockResolveAndUpsert(...args));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /profiles/search — discoverability gate', () => {
  it('excludes an archived account while returning an active one that matches identically', async () => {
    const term = token();
    const visible = await account({ username: `active${term}` });
    await account({ username: `archived${term}`, accountStatus: 'archived' });

    const res = await search(term);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([visible]);
    expect(res.body.pagination?.total).toBe(1);
  });

  it('excludes a restricted-tier account while returning trusted and default-tier matches', async () => {
    const term = token();
    const trusted = await account({ username: `trusted${term}`, reputationTier: 'trusted' });
    const untiered = await account({ username: `untiered${term}` });
    await account({ username: `restricted${term}`, reputationTier: 'restricted' });

    const res = await search(term);

    expect(ids(res).sort()).toEqual([trusted, untiered].sort());
    expect(res.body.pagination?.total).toBe(2);
  });

  it('excludes a private account while returning a public one', async () => {
    const term = token();
    const publicUser = await account({ username: `public${term}` });
    await account({ username: `private${term}`, privacyIsPrivateAccount: true });

    const res = await search(term);

    expect(ids(res)).toEqual([publicUser]);
  });

  it('returns an empty page and total 0 when every match is gated out', async () => {
    const term = token();
    await account({ username: `archived${term}`, accountStatus: 'archived' });
    await account({ username: `restricted${term}`, reputationTier: 'restricted' });
    await account({ username: `private${term}`, privacyIsPrivateAccount: true });

    const res = await search(term);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination?.total).toBe(0);
  });
});

describe('GET /profiles/search — match surface', () => {
  it('matches on username, first name, last name and description — but not bio', async () => {
    const term = token();
    const byUsername = await account({ username: `u${term}` });
    const byFirst = await account({ username: `a${token()}`, nameFirst: `First${term}` });
    const byLast = await account({ username: `b${token()}`, nameLast: `Last${term}` });
    const byDescription = await account({
      username: `c${token()}`,
      description: `about ${term} here`,
    });
    const byBioOnly = await account({ username: `d${token()}`, bio: `bio mentions ${term}` });

    const res = await search(term);

    const returned = ids(res);
    expect(returned.sort()).toEqual([byUsername, byFirst, byLast, byDescription].sort());
    expect(returned).not.toContain(byBioOnly);
  });

  it('matches a partial word, as the unanchored regex it replaced did', async () => {
    const term = token();
    const id = await account({ username: `prefix${term}suffix` });

    const res = await search(term.slice(0, 8));

    expect(ids(res)).toContain(id);
  });

  it('is case-insensitive', async () => {
    const term = token();
    const id = await account({ username: `Mixed${term.toUpperCase()}` });

    const res = await search(term.toLowerCase());

    expect(ids(res)).toEqual([id]);
  });

  it('treats a LIKE wildcard in the query as a literal character', async () => {
    const term = token();
    const literal = await account({ username: `a%b${term}` });
    await account({ username: `axxb${term}` });

    const res = await search(`a%b${term}`);

    // If `%` widened the pattern, `axxb…` would match too.
    expect(ids(res)).toEqual([literal]);
  });

  it('400s an empty query', async () => {
    const res = await search('   ');

    expect(res.status).toBe(400);
  });

  it('finds a bridged account when the query is a pasted upstream profile URL', async () => {
    const marker = token();
    const bridged = await account({ username: `${marker}@x.com`, type: 'federated' });
    await account({ username: `other${token()}`, description: `see https://x.com/${marker} for more` });

    expect(ids(await search(`https://x.com/${marker}?s=20&t=abc`))).toEqual([bridged]);
    expect(ids(await search(`https://twitter.com/${marker}`))).toEqual([bridged]);
    expect(ids(await search(`https://mobile.x.com/${marker}`))).toEqual([bridged]);
  });
});

describe('GET /profiles/search — leading @ handling', () => {
  it('strips a single leading @ so a handle-style query matches the stored username', async () => {
    const term = token();
    const stored = `${term}.bsky.social@bsky.social`;
    const id = await account({ username: stored });

    const res = await search(`@${stored}`);

    expect(ids(res)).toContain(id);
  });

  it('preserves a mid-string @ — it is the user@host separator, not a prefix', async () => {
    const term = token();
    const withHost = await account({ username: `${term}@mastodon.social` });
    await account({ username: `${term}nohost` });

    const res = await search(`@${term}@mastodon.social`);

    expect(ids(res)).toEqual([withHost]);
  });
});

describe('GET /profiles/search — ordering and pagination stability', () => {
  it('orders NATIVE accounts before FEDERATED ones regardless of reputation rank', async () => {
    const term = token();
    const federatedHighRank = await account({
      username: `fed${term}`,
      type: 'federated',
      reputationRankWeight: 3,
    });
    const nativeLowRank = await account({ username: `nat${term}`, reputationRankWeight: 0.1 });

    const res = await search(term);

    expect(ids(res)).toEqual([nativeLowRank, federatedHighRank]);
  });

  it('orders by reputation rank descending within a tier', async () => {
    const term = token();
    const low = await account({ username: `low${term}`, reputationRankWeight: 0.2 });
    const high = await account({ username: `high${term}`, reputationRankWeight: 2.5 });
    const middle = await account({ username: `mid${term}`, reputationRankWeight: 1 });

    const res = await search(term);

    expect(ids(res)).toEqual([high, middle, low]);
  });

  it('breaks a full tie on id ascending, so the total order is STRICT', async () => {
    const term = token();
    const first = await account({ username: `a${term}`, reputationRankWeight: 1 });
    const second = await account({ username: `b${term}`, reputationRankWeight: 1 });
    const third = await account({ username: `c${term}`, reputationRankWeight: 1 });

    const res = await search(term);

    // uuid v7 ids are monotonic, so insertion order IS ascending id order.
    expect(ids(res)).toEqual([first, second, third]);
  });

  it('pages without duplicating or skipping a row across two offsets', async () => {
    const term = token();
    const seeded: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      seeded.push(await account({ username: `p${index}${term}`, reputationRankWeight: 1 }));
    }

    const page1 = await search(term, { limit: '3', offset: '0' });
    const page2 = await search(term, { limit: '3', offset: '3' });

    expect(ids(page1)).toHaveLength(3);
    expect(ids(page2)).toHaveLength(3);
    expect([...ids(page1), ...ids(page2)]).toEqual(seeded);
  });

  it('reports the total over the WHOLE match set, not the page', async () => {
    const term = token();
    for (let index = 0; index < 5; index += 1) {
      await account({ username: `n${index}${term}` });
    }

    const res = await search(term, { limit: '2', offset: '0' });

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toEqual({ total: 5, limit: 2, offset: 0, hasMore: true });
  });
});

describe('GET /profiles/search — federated prepend', () => {
  it('prepends a live resolved actor at the FRONT, ahead of the native page', async () => {
    const term = token();
    const handle = `${term}@remote.example`;
    // The native's username CONTAINS the queried handle, so the page query
    // returns it on its own merits and the assertion is about relative order.
    const native = await account({ username: `native${handle}` });
    // The resolved actor is stored under a username the page query cannot
    // match, so the prepend is the only path by which it can appear.
    const remote = await account({ username: `stored${term}remote`, type: 'federated' });
    mockResolveAndUpsert.mockResolvedValue({ _id: remote });

    const res = await search(handle);

    expect(mockResolveAndUpsert).toHaveBeenCalledWith(handle);
    expect(ids(res)[0]).toBe(remote);
    expect(ids(res)).toContain(native);
  });

  it('does NOT prepend an actor that resolves as restricted', async () => {
    const handle = `${token()}@remote.example`;
    const remote = await account({
      username: null,
      type: 'federated',
      reputationTier: 'restricted',
    });
    mockResolveAndUpsert.mockResolvedValue({ _id: remote });

    const res = await search(handle);

    expect(ids(res)).not.toContain(remote);
    expect(res.body.pagination?.total).toBe(0);
  });

  it('does NOT prepend an actor that resolves as archived', async () => {
    const handle = `${token()}@remote.example`;
    const remote = await account({ username: null, type: 'federated', accountStatus: 'archived' });
    mockResolveAndUpsert.mockResolvedValue({ _id: remote });

    const res = await search(handle);

    expect(ids(res)).not.toContain(remote);
  });

  it('does NOT prepend an actor that resolves as a private account', async () => {
    const handle = `${token()}@remote.example`;
    const remote = await account({
      username: null,
      type: 'federated',
      privacyIsPrivateAccount: true,
    });
    mockResolveAndUpsert.mockResolvedValue({ _id: remote });

    const res = await search(handle);

    expect(ids(res)).not.toContain(remote);
  });

  it('never returns more than limit rows once a prepend lands', async () => {
    const term = token();
    const handle = `${term}@remote.example`;
    for (let index = 0; index < 3; index += 1) {
      await account({ username: `n${index}${handle}` });
    }
    const remote = await account({ username: `r${term}stored`, type: 'federated' });
    mockResolveAndUpsert.mockResolvedValue({ _id: remote });

    const res = await search(handle, { limit: '3' });

    expect(res.body.data).toHaveLength(3);
    expect(ids(res)[0]).toBe(remote);
  });

  it('does not duplicate an actor already present in the page', async () => {
    const term = token();
    const handle = `${term}@remote.example`;
    const remote = await account({ username: handle, type: 'federated' });
    mockResolveAndUpsert.mockResolvedValue({ _id: remote });

    const res = await search(handle);

    expect(ids(res)).toEqual([remote]);
    expect(res.body.pagination?.total).toBe(1);
  });

  it('never calls federation discovery for a plain (non-handle) query', async () => {
    const term = token();
    await account({ username: `plain${term}` });

    await search(term);

    expect(mockResolveAndUpsert).not.toHaveBeenCalled();
  });

  it('survives a discovery failure and still returns the local page', async () => {
    const term = token();
    const handle = `${term}@remote.example`;
    const native = await account({ username: `native${handle}` });
    mockResolveAndUpsert.mockRejectedValue(new Error('webfinger unreachable'));

    const res = await search(handle);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([native]);
  });
});

describe('GET /profiles/search — wire shape', () => {
  it('emits the complete public profile DTO for each row', async () => {
    const term = token();
    const id = await account({
      username: `shape${term}`,
      nameFirst: 'Shape',
      nameLast: 'Row',
      avatar: 'file_row',
      color: 'purple',
      bio: 'row bio',
      description: 'row description',
      links: ['https://oxy.so/row'],
      verified: true,
    });
    const [stored] = await getDb()
      .select({ createdAt: users.createdAt, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    const res = await search(term);

    expect(res.body.data).toEqual([
      {
        id,
        username: `shape${term}`,
        name: { displayName: 'Shape Row', first: 'Shape', last: 'Row', full: 'Shape Row' },
        avatar: 'file_row',
        verified: true,
        bio: 'row bio',
        description: 'row description',
        color: 'purple',
        links: ['https://oxy.so/row'],
        linksMetadata: [],
        createdAt: stored.createdAt.toISOString(),
        updatedAt: stored.updatedAt.toISOString(),
        type: 'local',
        kind: 'personal',
        isFederated: false,
        fediverseSharing: true,
        _count: { followers: 0, following: 0 },
      },
    ]);
    expect(safeParseContract(userResponseSchema, res.body.data?.[0])).not.toBeNull();
  });
});
