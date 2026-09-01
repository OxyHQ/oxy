/**
 * Constraint behaviour, against a REAL Postgres.
 *
 * Every assertion here goes through the application's own pool against the
 * throwaway database `jest.globalSetup.ts` migrated — there is no mock and no
 * second migrator, so what passes is what the shipped DDL actually does. One
 * `describe` per non-obvious decision recorded in `CONVENTIONS.md`; if a
 * decision is reversed, the matching block goes red and names it.
 *
 * The whole run shares one database, so every row here carries a per-test random
 * owner id — no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { blocks } from '../blocks';
import { labels } from '../labels';
import { linkPreviews } from '../linkPreviews';
import { pushTokens } from '../pushTokens';
import { users } from '../users';
import { webauthnCredentials } from '../webauthnCredentials';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/**
 * A real `users` row, since every `user_id` in this file now carries a foreign
 * key. A fabricated id used to be enough; it is not any more, and that is the
 * point of the constraint. Each call mints its own account, so no assertion
 * depends on another test's rows.
 */
async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/**
 * The SQLSTATE a driver error carries.
 *
 * Drizzle wraps a driver failure in its own `DrizzleQueryError`, so the code
 * lives on the `cause` — walk the chain rather than reading only the surface,
 * which would silently return `undefined` and turn every assertion below into
 * "some error happened" instead of "the constraint fired".
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Await a query, expecting it to reject, and return the error.
 *
 * Awaiting a drizzle query builder twice RUNS it twice, so `expect(q).rejects`
 * followed by `q.catch(...)` would issue two statements — this runs exactly one.
 */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('id column', () => {
  it('stores a 24-hex ObjectId verbatim — the whole reason ids are `text`', async () => {
    const legacyId = 'a1b2c3d4e5f60718293a4b5c';
    const userId = await owner();

    await getDb().insert(blocks).values({ id: legacyId, userId, blockedId: await owner() });
    const [row] = await getDb().select().from(blocks).where(eq(blocks.id, legacyId));

    expect(row.id).toBe(legacyId);
  });

  it('generates a time-sortable uuid v7 when none is supplied', async () => {
    const userId = await owner();
    const [first] = await getDb()
      .insert(blocks)
      .values({ userId, blockedId: await owner() })
      .returning({ id: blocks.id });
    const [second] = await getDb()
      .insert(blocks)
      .values({ userId, blockedId: await owner() })
      .returning({ id: blocks.id });

    // Version nibble 7, and lexicographically increasing — v4 would satisfy the
    // format check and fail the ordering one, which is exactly why v7 was chosen.
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.id > first.id).toBe(true);
  });

  it('requires a caller-supplied id where the id IS the content hash', async () => {
    const sha = randomUUID().replace(/-/g, '').repeat(2).slice(0, 64);
    await getDb().insert(linkPreviews).values({
      id: sha,
      requestedUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
    });

    const [row] = await getDb().select().from(linkPreviews).where(eq(linkPreviews.id, sha));
    expect(row.id).toBe(sha);
    expect(row.status).toBe('pending');
  });
});

describe('labels — case-insensitive unique (Mongo collation strength 2)', () => {
  it('rejects a second label differing only by case', async () => {
    const userId = await owner();
    await getDb().insert(labels).values({ userId, name: 'Work' });

    const error = await rejection(getDb().insert(labels).values({ userId, name: 'wOrK' }));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('scopes the uniqueness to one user', async () => {
    const name = `Shared-${randomUUID()}`;
    await getDb().insert(labels).values({ userId: await owner(), name });
    await expect(
      getDb().insert(labels).values({ userId: await owner(), name })
    ).resolves.toBeDefined();
  });

  it('stores the name exactly as typed — only the comparison ignores case', async () => {
    const userId = await owner();
    await getDb().insert(labels).values({ userId, name: 'PayPal' });

    const [row] = await getDb().select().from(labels).where(eq(labels.userId, userId));
    expect(row.name).toBe('PayPal');
    expect(row.color).toBe('#4285f4');
    expect(row.order).toBe(0);
  });

  it('is the index a lookup must use — `lower(name)`, not `name`', async () => {
    const userId = await owner();
    await getDb().insert(labels).values({ userId, name: 'Receipts' });

    const found = await getDb()
      .select()
      .from(labels)
      .where(sql`${labels.userId} = ${userId} and lower(${labels.name}) = lower(${'RECEIPTS'})`);

    expect(found).toHaveLength(1);
  });
});

describe('blocks — compound unique', () => {
  it('rejects the same (user, blocked) pair twice', async () => {
    const userId = await owner();
    const blockedId = await owner();
    await getDb().insert(blocks).values({ userId, blockedId });

    const error = await rejection(getDb().insert(blocks).values({ userId, blockedId }));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('treats the reverse direction as a different block', async () => {
    const a = await owner();
    const b = await owner();
    await getDb().insert(blocks).values({ userId: a, blockedId: b });
    await expect(
      getDb().insert(blocks).values({ userId: b, blockedId: a })
    ).resolves.toBeDefined();
  });
});

describe('closed value sets — text + CHECK, not a pg enum', () => {
  it('accepts every declared platform', async () => {
    const userId = await owner();
    await expect(
      getDb()
        .insert(pushTokens)
        .values([
          { userId, token: `t-ios-${randomUUID()}`, platform: 'ios' },
          { userId, token: `t-android-${randomUUID()}`, platform: 'android' },
          { userId, token: `t-web-${randomUUID()}`, platform: 'web' },
        ])
    ).resolves.toBeDefined();
  });

  it('rejects an undeclared platform from a raw write', async () => {
    // Raw SQL on purpose: the typed column already refuses this at compile
    // time, so only a hand-written statement (backfill, psql) can reach the
    // constraint — which is precisely who it has to stop.
    const error = await rejection(
      getDb().execute(sql`
        insert into push_tokens (id, user_id, token, platform)
        values (${randomUUID()}, ${await owner()}, ${randomUUID()}, 'desktop')
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('rejects an unrecognised auth-challenge purpose', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into auth_challenges (id, public_key, challenge, purpose, expires_at)
        values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'mint_admin_token', now() + interval '5 minutes')
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('webauthn_credentials — Buffer becomes bytea', () => {
  it('round-trips raw bytes, including 0x00 and the high half', async () => {
    const key = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x00]);
    const credentialID = `cred-${randomUUID()}`;

    await getDb().insert(webauthnCredentials).values({
      userId: await owner(),
      credentialID,
      credentialPublicKey: key,
      deviceType: 'multiDevice',
      name: 'Test key',
    });

    const [row] = await getDb()
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialID, credentialID));

    expect(Buffer.isBuffer(row.credentialPublicKey)).toBe(true);
    expect(row.credentialPublicKey.equals(key)).toBe(true);
  });

  it('keeps transports as a native array and distinguishes absent from empty', async () => {
    const withHints = `cred-${randomUUID()}`;
    const withoutHints = `cred-${randomUUID()}`;
    const userId = await owner();

    await getDb().insert(webauthnCredentials).values([
      {
        userId,
        credentialID: withHints,
        credentialPublicKey: Buffer.from([1]),
        deviceType: 'singleDevice',
        name: 'Security key',
        transports: ['usb', 'nfc'],
      },
      {
        userId,
        credentialID: withoutHints,
        credentialPublicKey: Buffer.from([2]),
        deviceType: 'singleDevice',
        name: 'Silent key',
      },
    ]);

    const rows = await getDb()
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    const hinted = rows.find((row) => row.credentialID === withHints);
    const silent = rows.find((row) => row.credentialID === withoutHints);

    expect(hinted?.transports).toEqual(['usb', 'nfc']);
    expect(silent?.transports).toBeNull();
  });

  it('has no updated_at — the absence IS the append-only contract', async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'webauthn_credentials'
    `);
    const names = rows.map((row) => row.column_name);

    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });
});

describe('updated_at is maintained by the application', () => {
  it('advances on update and leaves created_at alone', async () => {
    const userId = await owner();
    const [inserted] = await getDb()
      .insert(labels)
      .values({ userId, name: 'Before' })
      .returning();

    // `$onUpdate` stamps `updatedAt` with `new Date()` (ms resolution); a fast
    // runner can insert and update in the same tick without this pause.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await getDb()
      .update(labels)
      .set({ name: 'After' })
      .where(eq(labels.id, inserted.id));

    const [updated] = await getDb().select().from(labels).where(eq(labels.id, inserted.id));

    expect(updated.name).toBe('After');
    expect(updated.createdAt.getTime()).toBe(inserted.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThan(inserted.updatedAt.getTime());
  });
});
