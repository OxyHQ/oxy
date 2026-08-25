/**
 * `GET /search` against a REAL Postgres.
 *
 * The legacy people-search surface. It shares `peopleSearchPredicate` /
 * `peopleSearchMatch` / `peopleSearchOrder` with `GET /profiles/search` but
 * differs in three ways that are wire contract and are pinned here:
 *
 *  - it ALSO matches the user's saved locations (`includeLocations: true`),
 *  - it serializes through `utils/userTransform.formatUserResponse`, so a row
 *    carries `privacySettings` — deliberately containing ONLY the public
 *    `fediverseSharing` leaf,
 *  - it answers `{ users, pagination: { page, limit, hasMore } }`, page-based
 *    rather than offset-based, with `hasMore` derived from a full page.
 *
 * The old suite fed a mocked `User.aggregate` an in-memory pool and asserted the
 * `$match` object; the route builds SQL now, so the filter is exercised by
 * seeding rows that must and must not come back.
 *
 * Every test scopes itself with a unique token so the shared test database
 * cannot influence a result.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { userResponseSchema, safeParseContract } from '@oxyhq/contracts';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userLocations } from '../../db/schema/userLocations';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import searchRouter from '../search';

interface SearchResponse {
  status: number;
  raw: string;
  body: {
    users?: Array<Record<string, unknown>>;
    pagination?: { page: number; limit: number; hasMore: boolean };
  };
}

let server: http.Server;

function search(params: Record<string, string>): Promise<SearchResponse> {
  const address = server.address() as AddressInfo;
  const queryString = new URLSearchParams(params);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path: `/search?${queryString}` },
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

function token(): string {
  return `t${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function ids(res: SearchResponse): string[] {
  return (res.body.users ?? []).map((row) => row.id as string);
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/search', searchRouter);
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

describe('GET /search — discoverability gate', () => {
  it('excludes an archived account while returning an active one', async () => {
    const term = token();
    const visible = await account({ username: `active${term}` });
    await account({ username: `archived${term}`, accountStatus: 'archived' });

    const res = await search({ query: term });

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([visible]);
  });

  it('excludes a restricted-tier account while returning trusted and default-tier matches', async () => {
    const term = token();
    const trusted = await account({ username: `trusted${term}`, reputationTier: 'trusted' });
    const untiered = await account({ username: `untiered${term}` });
    await account({ username: `restricted${term}`, reputationTier: 'restricted' });

    const res = await search({ query: term });

    expect(ids(res).sort()).toEqual([trusted, untiered].sort());
  });

  it('excludes a private account while returning a public one', async () => {
    const term = token();
    const publicUser = await account({ username: `public${term}` });
    await account({ username: `private${term}`, privacyIsPrivateAccount: true });

    const res = await search({ query: term });

    expect(ids(res)).toEqual([publicUser]);
  });
});

describe('GET /search — account kind', () => {
  /**
   * PINS THE ECOSYSTEM-WIDE PRODUCT DECISION, ON THIS SURFACE.
   *
   * People search is BLIND to `users.kind` — `peopleSearchPredicate` has no kind
   * clause, so a bot and an organization are returned beside people here. Until
   * this case existed, every people-search test in the API seeded only
   * `personal` rows, which meant adding a kind clause (removing every bot,
   * organization and channel from every search surface at once) was a change CI
   * could not see. The mechanism is pinned in
   * `utils/__tests__/profileQuery.test.ts`; this pins that THIS ROUTE still runs
   * it, so a per-surface divergence fails too.
   *
   * The private bot is the control: without it, "the bot came back" is also what
   * a route that had stopped applying the gate would produce.
   */
  it('returns bots, organizations and channels beside people', async () => {
    const term = token();
    const person = await account({ username: `person${term}`, kind: 'personal' });
    const bot = await account({ username: `bot${term}`, kind: 'bot' });
    const org = await account({ username: `org${term}`, kind: 'organization' });
    const channel = await account({ username: `channel${term}`, kind: 'channel' });
    await account({ username: `privbot${term}`, kind: 'bot', privacyIsPrivateAccount: true });

    const res = await search({ query: term });

    expect(res.status).toBe(200);
    expect(ids(res).sort()).toEqual([person, bot, org, channel].sort());
  });
});

describe('GET /search — match surface', () => {
  it('matches a saved location by name, city and country', async () => {
    const term = token();
    const byName = await account({ username: `a${token()}` });
    const byCity = await account({ username: `b${token()}` });
    const byCountry = await account({ username: `c${token()}` });
    const unrelated = await account({ username: `d${token()}` });
    await getDb()
      .insert(userLocations)
      .values([
        { userId: byName, locationKey: 'home', name: `Studio ${term}` },
        { userId: byCity, locationKey: 'home', name: 'Home', city: `City${term}` },
        { userId: byCountry, locationKey: 'home', name: 'Home', country: `Country${term}` },
        { userId: unrelated, locationKey: 'home', name: 'Home', state: `State${term}` },
      ]);

    const res = await search({ query: term });

    // `state` is deliberately NOT a searched location field.
    expect(ids(res).sort()).toEqual([byName, byCity, byCountry].sort());
  });

  it('matches on username, first name, last name and description', async () => {
    const term = token();
    const byUsername = await account({ username: `u${term}` });
    const byFirst = await account({ username: `a${token()}`, nameFirst: `First${term}` });
    const byLast = await account({ username: `b${token()}`, nameLast: `Last${term}` });
    const byDescription = await account({
      username: `c${token()}`,
      description: `about ${term}`,
    });

    const res = await search({ query: term });

    expect(ids(res).sort()).toEqual([byUsername, byFirst, byLast, byDescription].sort());
  });

  it('strips a single leading @ so a handle-style query matches the stored username', async () => {
    const term = token();
    const stored = `${term}.bsky.social@bsky.social`;
    const id = await account({ username: stored });

    const res = await search({ query: `@${stored}` });

    expect(ids(res)).toEqual([id]);
  });

  it('finds a bridged account when the query is a pasted x.com profile URL', async () => {
    const marker = token();
    const bridged = await account({ username: `${marker}@x.com`, type: 'federated' });
    await account({ username: `other${token()}`, description: `see https://x.com/${marker} for more` });

    const res = await search({ query: `https://x.com/${marker}?s=20&t=abc` });

    expect(ids(res)).toEqual([bridged]);
  });

  it('treats twitter.com and mobile.x.com as the same network when pasted', async () => {
    const marker = token();
    const bridged = await account({ username: `${marker}@x.com`, type: 'federated' });
    await account({ username: `other${token()}`, description: `see https://x.com/${marker} for more` });

    expect(ids(await search({ query: `https://twitter.com/${marker}` }))).toEqual([bridged]);
    expect(ids(await search({ query: `https://mobile.x.com/${marker}?s=20` }))).toEqual([bridged]);
  });

  it('returns nothing for type=users when the query matches nobody', async () => {
    const res = await search({ query: token(), type: 'users' });

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it('400s an out-of-range limit', async () => {
    const res = await search({ query: token(), limit: '500' });

    expect(res.status).toBe(400);
  });
});

describe('GET /search — ordering and pagination', () => {
  it('orders NATIVE accounts before FEDERATED ones with the same query', async () => {
    const term = token();
    const federated = await account({
      username: `fed${term}`,
      type: 'federated',
      reputationRankWeight: 3,
    });
    const native = await account({ username: `nat${term}`, reputationRankWeight: 0.1 });

    const res = await search({ query: term });

    expect(ids(res)).toEqual([native, federated]);
  });

  it('pages without duplicating or skipping a row, and reports hasMore off a full page', async () => {
    const term = token();
    const seeded: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      seeded.push(await account({ username: `p${index}${term}`, reputationRankWeight: 1 }));
    }

    const page1 = await search({ query: term, page: '1', limit: '2' });
    const page2 = await search({ query: term, page: '2', limit: '2' });
    const page3 = await search({ query: term, page: '3', limit: '2' });

    expect([...ids(page1), ...ids(page2), ...ids(page3)]).toEqual(seeded);
    expect(page1.body.pagination).toEqual({ page: 1, limit: 2, hasMore: true });
    expect(page2.body.pagination).toEqual({ page: 2, limit: 2, hasMore: true });
    // The last page is short, so there is nothing after it.
    expect(page3.body.pagination).toEqual({ page: 3, limit: 2, hasMore: false });
  });
});

describe('GET /search — wire shape', () => {
  it('emits the full user DTO, with privacySettings carrying only the public leaf', async () => {
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
      email: `shape${term}@oxy.so`,
      phone: '+34600111222',
      refreshToken: `rt_secret_${term}`,
      privacyIsPrivateAccount: false,
      privacyDiscoverableByEmail: true,
    });
    const [stored] = await getDb()
      .select({ createdAt: users.createdAt, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    const res = await search({ query: term });

    expect(res.body.users).toEqual([
      {
        id,
        username: `shape${term}`,
        avatar: 'file_row',
        color: 'purple',
        kind: 'personal',
        name: { displayName: 'Shape Row', first: 'Shape', last: 'Row', full: 'Shape Row' },
        // ONLY the public consent leaf. `isPrivateAccount`,
        // `discoverableByEmail` and the rest of the privacy block must not ride
        // this surface — the Mongo `$project` named this one path and nothing
        // else, and the port keeps it that way.
        privacySettings: { fediverseSharing: true },
        verified: true,
        // `publicUserColumns` does not select `languages`, so the normalizer
        // sees nothing and emits an empty list rather than inventing a locale.
        languages: [],
        bio: 'row bio',
        description: 'row description',
        links: ['https://oxy.so/row'],
        linksMetadata: [],
        createdAt: stored.createdAt.toISOString(),
        updatedAt: stored.updatedAt.toISOString(),
      },
    ]);
    expect(safeParseContract(userResponseSchema, res.body.users?.[0])).not.toBeNull();
  });
});
