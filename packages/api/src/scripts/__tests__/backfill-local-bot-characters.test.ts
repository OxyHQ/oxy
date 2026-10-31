let mockRedis: null | { status: string; ping: jest.Mock; del: jest.Mock; publish: jest.Mock } =
  null;
jest.mock('../../config/redis', () => ({
  getRedisClient: () => mockRedis,
  closeRedis: async () => {},
}));
import { randomUUID } from 'node:crypto';
import { avatarCharacterFor } from '@oxy.so/contracts';
import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import userCache from '../../utils/userCache';
import { backfillLocalBotCharacters } from '../backfill-local-bot-characters';

const originalDatabaseUrl = process.env.DATABASE_URL;
let ownDatabaseUrl: string | undefined;
jest.setTimeout(60_000);
beforeAll(async () => {
  // Global inventory needs its own database, not whichever bots a previous suite left behind.
  ownDatabaseUrl = await createTestDatabase();
  await connectPostgres();
});
afterAll(async () => {
  try {
    await closePostgres();
  } finally {
    try {
      if (ownDatabaseUrl) await dropTestDatabase(ownDatabaseUrl);
    } finally {
      if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});

it('dry-runs exact local/automated bot inventory, applies reviewed seeds once, and preserves all exclusions', async () => {
  const suffix = randomUUID().slice(0, 8);
  const existing = avatarCharacterFor('already-chosen');
  const fixtures = [
    { username: `local${suffix}`, kind: 'bot' as const, type: 'local' as const },
    { username: `auto${suffix}`, kind: 'bot' as const, type: 'automated' as const },
    { username: `chosen${suffix}`, kind: 'bot' as const, character: existing },
    { username: `remote${suffix}`, kind: 'bot' as const, type: 'federated' as const },
    {
      username: `uri${suffix}`,
      kind: 'bot' as const,
      federationActorUri: `https://example.test/actor/${suffix}`,
    },
    { username: `archived${suffix}`, kind: 'bot' as const, accountStatus: 'archived' as const },
    { username: `human${suffix}`, kind: 'personal' as const },
  ];
  const rows = await getDb()
    .insert(users)
    .values(fixtures)
    .returning({ id: users.id, username: users.username });
  const invalidation = jest.spyOn(userCache, 'invalidate').mockImplementation(() => {});
  try {
    const plan = await backfillLocalBotCharacters();
    expect(plan.candidates.map((row) => row.username).sort()).toEqual(
      [fixtures[0].username, fixtures[1].username].sort(),
    );
    expect(plan.changed).toEqual([]);
    expect(invalidation).not.toHaveBeenCalled();
    await expect(backfillLocalBotCharacters({ apply: true })).rejects.toThrow('dry-run');
    await expect(
      backfillLocalBotCharacters({ apply: true, expectedHash: '0'.repeat(64) }),
    ).rejects.toThrow('inventory changed');
    const applied = await backfillLocalBotCharacters({ apply: true, expectedHash: plan.hash });
    expect(applied.changed).toHaveLength(2);
    for (const entry of applied.candidates)
      expect(entry.character).toEqual(avatarCharacterFor(entry.username));
    const stored = await getDb()
      .select({ username: users.username, character: users.character })
      .from(users)
      .where(
        inArray(
          users.id,
          rows.map((row) => row.id),
        ),
      );
    expect(stored.find((row) => row.username === fixtures[2].username)?.character).toEqual(
      existing,
    );
    for (const fixture of fixtures.slice(3))
      expect(stored.find((row) => row.username === fixture.username)?.character).toBeNull();
    expect(invalidation).toHaveBeenCalledTimes(2);
    const empty = await backfillLocalBotCharacters();
    expect(empty.candidates).toEqual([]);
    expect(
      (await backfillLocalBotCharacters({ apply: true, expectedHash: empty.hash })).changed,
    ).toEqual([]);
  } finally {
    invalidation.mockRestore();
    await getDb()
      .delete(users)
      .where(
        inArray(
          users.id,
          rows.map((row) => row.id),
        ),
      );
  }
});

it('refuses a stale plan after another writer chooses a character', async () => {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `race${randomUUID().slice(0, 8)}`, kind: 'bot' })
    .returning({ id: users.id });
  try {
    const plan = await backfillLocalBotCharacters();
    const chosen = avatarCharacterFor('concurrent-choice');
    await getDb().update(users).set({ character: chosen }).where(eq(users.id, row.id));
    await expect(
      backfillLocalBotCharacters({ apply: true, expectedHash: plan.hash }),
    ).rejects.toThrow('inventory changed');
    const [stored] = await getDb()
      .select({ character: users.character })
      .from(users)
      .where(eq(users.id, row.id));
    expect(stored.character).toEqual(chosen);
  } finally {
    await getDb().delete(users).where(eq(users.id, row.id));
  }
});

it('waits for lazy Redis readiness before writes and drains actual invalidation commands after commit', async () => {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `drain${randomUUID().slice(0, 8)}`, kind: 'bot' })
    .returning({ id: users.id });
  const commands: string[] = [];
  let ready!: () => void;
  const connecting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  mockRedis = {
    status: 'connecting',
    ping: jest.fn(async () => {
      commands.push('ping');
      await connecting;
      if (mockRedis) mockRedis.status = 'ready';
      return 'PONG';
    }),
    del: jest.fn(async () => {
      commands.push('del');
      return 1;
    }),
    publish: jest.fn(async () => {
      commands.push('publish');
      return 1;
    }),
  };
  try {
    const plan = await backfillLocalBotCharacters();
    expect(commands).toEqual([]);
    const applying = backfillLocalBotCharacters({ apply: true, expectedHash: plan.hash });
    await Promise.resolve();
    const [before] = await getDb()
      .select({ character: users.character })
      .from(users)
      .where(eq(users.id, row.id));
    expect(before.character).toBeNull();
    expect(commands).toEqual(['ping']);
    ready();
    const result = await applying;
    expect(result).toHaveProperty('invalidation', 'redis-drained');
    expect(commands).toEqual(['ping', 'del', 'publish', 'ping']);
    expect(mockRedis.del).toHaveBeenCalledWith(`user:${row.id}`);
    expect(JSON.parse(mockRedis.publish.mock.calls[0][1])).toMatchObject({
      userId: row.id,
      reason: 'profile',
    });
  } finally {
    ready();
    mockRedis = null;
    await getDb().delete(users).where(eq(users.id, row.id));
  }
});

it('does not write when configured Redis cannot become ready', async () => {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `offline${randomUUID().slice(0, 8)}`, kind: 'bot' })
    .returning({ id: users.id });
  try {
    const plan = await backfillLocalBotCharacters();
    mockRedis = {
      status: 'connecting',
      ping: jest.fn().mockRejectedValue(new Error('offline')),
      del: jest.fn(),
      publish: jest.fn(),
    };
    await expect(
      backfillLocalBotCharacters({ apply: true, expectedHash: plan.hash }),
    ).rejects.toThrow('offline');
    const [stored] = await getDb()
      .select({ character: users.character })
      .from(users)
      .where(eq(users.id, row.id));
    expect(stored.character).toBeNull();
    expect(mockRedis.publish).not.toHaveBeenCalled();
  } finally {
    mockRedis = null;
    await getDb().delete(users).where(eq(users.id, row.id));
  }
});
