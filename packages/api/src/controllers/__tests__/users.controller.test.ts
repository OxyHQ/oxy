/**
 * `POST /users/search` (`UsersController.searchUsers`) against a REAL Postgres.
 *
 * The third people-search surface, alongside `GET /search` and
 * `GET /profiles/search`. It shares their predicate and their public projection
 * but has its own serializer call and its own hard cap of 5 results, which is
 * why it keeps its own suite rather than being folded into theirs.
 *
 * The previous version asserted the SHAPE of the Mongo filter object
 * (`{ accountStatus: { $ne: 'archived' } }`, `PUBLIC_USER_PROFILE_SELECT`, the
 * `$regex` inside `$or`). None of those exist any more — and even when they did,
 * an assertion about a filter object cannot tell a working gate from one that
 * matches nothing: the projection case in particular passed against a stub that
 * returned an empty array. Here the gates are checked by seeding a row that must
 * NOT come back, and the leak guard by seeding a row that really holds the
 * secret.
 *
 * Nothing is mocked but the logger — the controller reaches Postgres directly.
 * Every test scopes itself with a unique token so the shared test database
 * cannot influence a result.
 */

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { USERS_PROTECTED_COLUMNS } from '../../db/schema/protectedColumns';
import { users } from '../../db/schema/users';
import { BadRequestError } from '../../utils/error';
import { UsersController } from '../users.controller';

/** The hard cap the controller applies to a search page. */
const SEARCH_RESULT_CAP = 5;

let controller: UsersController;

interface SearchOutcome {
  data: Array<Record<string, unknown>>;
  raw: string;
}

/**
 * Run the controller against a real `res` double and return what a client
 * receives.
 *
 * `sendSuccess` is the REAL one, so the envelope shape (`{ data }`) is part of
 * what this exercises rather than something a mock decides. The payload is
 * round-tripped through JSON deliberately: express serializes it before it
 * leaves the process, and `JSON.stringify` DROPS a key whose value is
 * `undefined` — so an in-memory `expect(row).not.toHaveProperty('email')` would
 * fail on a field that never reaches the wire at all.
 */
async function search(query: unknown): Promise<SearchOutcome> {
  let payload: unknown;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn((body: unknown) => {
      payload = body;
      return res;
    }),
  };
  await controller.searchUsers(
    { body: { query } } as Request,
    res as unknown as Response,
    jest.fn() as NextFunction,
  );
  const raw = JSON.stringify(payload) ?? '';
  const envelope = (raw.length > 0 ? JSON.parse(raw) : {}) as {
    data?: Array<Record<string, unknown>>;
  };
  return { data: envelope.data ?? [], raw };
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** A search term no row seeded by another test or suite can match. */
function token(): string {
  return `t${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function ids(outcome: SearchOutcome): string[] {
  return outcome.data.map((row) => row.id as string);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  controller = new UsersController();
});

describe('UsersController.searchUsers — input validation', () => {
  it('throws BadRequestError when the query is missing', async () => {
    await expect(search(undefined)).rejects.toThrow(BadRequestError);
  });

  it('throws BadRequestError when the query is not a string', async () => {
    await expect(search(123)).rejects.toThrow(BadRequestError);
  });

  it('throws BadRequestError when the query is only whitespace', async () => {
    await expect(search('   ')).rejects.toThrow(BadRequestError);
  });
});

describe('UsersController.searchUsers — discoverability gate', () => {
  it('excludes an archived account while returning an active one that matches identically', async () => {
    const term = token();
    const visible = await account({ username: `active${term}` });
    await account({ username: `archived${term}`, accountStatus: 'archived' });

    const outcome = await search(term);

    expect(ids(outcome)).toEqual([visible]);
  });

  it('excludes a restricted-tier account while returning trusted and default-tier matches', async () => {
    const term = token();
    const trusted = await account({ username: `trusted${term}`, reputationTier: 'trusted' });
    const untiered = await account({ username: `untiered${term}` });
    await account({ username: `restricted${term}`, reputationTier: 'restricted' });

    const outcome = await search(term);

    expect(ids(outcome).sort()).toEqual([trusted, untiered].sort());
  });

  it('excludes a private account while returning a public one', async () => {
    const term = token();
    const publicUser = await account({ username: `public${term}` });
    await account({ username: `private${term}`, privacyIsPrivateAccount: true });

    const outcome = await search(term);

    expect(ids(outcome)).toEqual([publicUser]);
  });
});

describe('UsersController.searchUsers — account kind', () => {
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

    // Four rows, under this surface's hard cap of five, so the assertion is
    // about the gate and never about the cap.
    const outcome = await search(term);

    expect(ids(outcome).sort()).toEqual([person, bot, org, channel].sort());
  });
});

describe('UsersController.searchUsers — matching', () => {
  it('matches on username, first name, last name and description', async () => {
    const term = token();
    const byUsername = await account({ username: `u${term}` });
    const byFirst = await account({ username: `a${token()}`, nameFirst: `First${term}` });
    const byLast = await account({ username: `b${token()}`, nameLast: `Last${term}` });
    const byDescription = await account({ username: `c${token()}`, description: `about ${term}` });

    const outcome = await search(term);

    expect(ids(outcome).sort()).toEqual([byUsername, byFirst, byLast, byDescription].sort());
  });

  it('strips a single leading @ so a Bluesky handle matches the stored username', async () => {
    const term = token();
    const stored = `${term}.bsky.social@bsky.social`;
    const id = await account({ username: stored });

    const outcome = await search(`@${stored}`);

    expect(ids(outcome)).toEqual([id]);
  });

  it('strips only the leading @ — a mid-string @ is the user@host separator', async () => {
    const term = token();
    const withHost = await account({ username: `${term}@mastodon.social` });
    await account({ username: `${term}nohost` });

    const outcome = await search(`@${term}@mastodon.social`);

    expect(ids(outcome)).toEqual([withHost]);
  });

  it('does NOT strip a mid-string @ when there is no leading @', async () => {
    const term = token();
    const withHost = await account({ username: `${term}@mastodon.social` });
    await account({ username: `${term}nohost` });

    const outcome = await search(`${term}@mastodon.social`);

    expect(ids(outcome)).toEqual([withHost]);
  });

  it('caps the page at five results', async () => {
    const term = token();
    for (let index = 0; index < SEARCH_RESULT_CAP + 3; index += 1) {
      await account({ username: `n${index}${term}` });
    }

    const outcome = await search(term);

    expect(outcome.data).toHaveLength(SEARCH_RESULT_CAP);
  });

  it('returns an empty list when nothing matches', async () => {
    const outcome = await search(token());

    expect(outcome.data).toEqual([]);
  });
});

describe('UsersController.searchUsers — response shape', () => {
  it('emits the user DTO with the canonical composed display name', async () => {
    const term = token();
    const id = await account({
      username: `shape${term}`,
      nameFirst: 'Test',
      nameLast: 'User',
      avatar: 'file_search',
      color: 'blue',
      bio: 'a bio',
    });

    const outcome = await search(term);

    expect(outcome.data).toHaveLength(1);
    const row = outcome.data[0];
    expect(row.id).toBe(id);
    expect(row.username).toBe(`shape${term}`);
    expect(row.name).toEqual({
      displayName: 'Test User',
      first: 'Test',
      last: 'User',
      full: 'Test User',
    });
    expect(row.avatar).toBe('file_search');
    expect(row.bio).toBe('a bio');
  });

  it('never emits a protected column, even when the row carries one', async () => {
    const term = token();
    const username = `secretive${term}`;
    const email = `${username}@oxy.so`;
    const id = await account({
      username,
      email,
      phone: '+34600555444',
      publicKey: `04${randomUUID().replace(/-/g, '')}`,
      refreshToken: `rt_secret_${term}`,
      emailSignature: `signature_secret_${term}`,
      autoForwardTo: `forward_secret_${term}@example.com`,
    });
    const [derived] = await getDb()
      .select({ hashedEmail: users.hashedEmail, hashedPhone: users.hashedPhone })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    const outcome = await search(term);

    const row = outcome.data[0];
    // The vacuity floor: the assertions below pass trivially against an empty
    // page, so the row carrying the secrets has to be the one returned.
    expect(row.id).toBe(id);
    for (const column of USERS_PROTECTED_COLUMNS) {
      expect(row).not.toHaveProperty(column);
    }
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('publicKey');
    for (const secret of [
      email,
      '+34600555444',
      `rt_secret_${term}`,
      `signature_secret_${term}`,
      `forward_secret_${term}@example.com`,
      derived.hashedEmail,
      derived.hashedPhone,
    ]) {
      expect(typeof secret).toBe('string');
      expect(outcome.raw).not.toContain(secret);
    }
  });
});
