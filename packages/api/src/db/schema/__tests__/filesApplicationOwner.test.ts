/**
 * `files.owner_application_id` — an APPLICATION as the third owner principal
 * (ADR 0041), against a REAL Postgres.
 *
 * What is pinned here is behaviour, not DDL text:
 *  - the owner CHECK admits exactly one of account, system namespace and
 *    application, and refuses every pair;
 *  - one live row per (application, content hash), tombstones exempt, and an
 *    application's row never collides with an account's or another
 *    application's row for the same bytes;
 *  - the foreign key refuses an unknown application and RESTRICTS the
 *    application's deletion while any row — a tombstone too — still names it,
 *    because a cascade would drop the only record of where the bytes live.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applications } from '../applications';
import { files } from '../files';
import { users } from '../users';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

const unique = () => randomUUID().replace(/-/g, '');

function pgField(error: unknown, field: string): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const value: unknown = Reflect.get(current, field);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `app-${unique()}`, ownerAccountId: await account(), type: 'first_party' })
    .returning({ id: applications.id });
  return row.id;
}

async function insertAppFile(
  ownerApplicationId: string,
  values: Partial<typeof files.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: unique(),
      size: 1024,
      mime: 'image/png',
      ext: 'png',
      storageKey: `content/${unique()}`,
      visibility: 'public',
      ownerApplicationId,
      ...values,
    })
    .returning({ id: files.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('files — an application as the owner', () => {
  it('accepts an application-owned asset with no account and no namespace', async () => {
    const appId = await application();
    const id = await insertAppFile(appId);

    const [row] = await getDb()
      .select({
        ownerUserId: files.ownerUserId,
        systemOwner: files.systemOwner,
        ownerApplicationId: files.ownerApplicationId,
      })
      .from(files)
      .where(eq(files.id, id));

    expect(row).toEqual({ ownerUserId: null, systemOwner: null, ownerApplicationId: appId });
  });

  it('refuses an application beside an account, beside a namespace, and no owner at all', async () => {
    const appId = await application();
    const withAccount = await rejection(insertAppFile(appId, { ownerUserId: await account() }));
    const withNamespace = await rejection(
      insertAppFile(appId, {
        systemOwner: '__stickers__',
        purpose: 'sticker',
      }),
    );
    const none = await rejection(
      getDb().execute(sql`
        insert into files (id, sha256, size, mime, ext, storage_key)
        values (${unique()}, ${unique()}, 1, 'image/png', 'png', ${unique()})
      `),
    );

    for (const error of [withAccount, withNamespace, none]) {
      expect(pgField(error, 'code')).toBe(CHECK_VIOLATION);
      expect(pgField(error, 'constraint_name')).toBe('files_owner_exclusive_check');
    }
  });

  it('refuses an application id that names no application', async () => {
    const error = await rejection(insertAppFile(`ghost-${unique()}`));

    expect(pgField(error, 'code')).toBe(FOREIGN_KEY_VIOLATION);
    expect(pgField(error, 'constraint_name')).toBe('files_owner_application_id_applications_id_fk');
  });
});

describe('files — one live row per application per content hash', () => {
  it('refuses a second LIVE row of the same bytes for the same application', async () => {
    const appId = await application();
    const sha256 = unique();
    await insertAppFile(appId, { sha256 });

    const error = await rejection(insertAppFile(appId, { sha256, status: 'trash' }));

    expect(pgField(error, 'code')).toBe(UNIQUE_VIOLATION);
    expect(pgField(error, 'constraint_name')).toBe('files_owner_application_id_sha256_live_key');
  });

  it('lets a tombstone coexist with the live row, and another application and an account hold the same bytes', async () => {
    const appId = await application();
    const sha256 = unique();
    await insertAppFile(appId, { sha256 });
    await insertAppFile(appId, { sha256, status: 'deleted' });
    await insertAppFile(await application(), { sha256 });
    await getDb()
      .insert(files)
      .values({
        sha256,
        size: 1024,
        mime: 'image/png',
        ext: 'png',
        storageKey: `content/${unique()}`,
        ownerUserId: await account(),
      });

    const rows = await getDb().select({ id: files.id }).from(files).where(eq(files.sha256, sha256));
    expect(rows).toHaveLength(4);
  });
});

describe('files — ON DELETE RESTRICT on owner_application_id', () => {
  it('is declared RESTRICT, never CASCADE', async () => {
    const [constraint] = await getDb().execute<{ confdeltype: string }>(sql`
      select confdeltype from pg_constraint
      where conname = 'files_owner_application_id_applications_id_fk'
    `);
    // 'r' = RESTRICT. 'c' (CASCADE) would drop rows without recording their purge.
    expect(constraint?.confdeltype).toBe('r');
  });

  it('refuses to delete an application while any of its rows — a tombstone included — remains', async () => {
    const appId = await application();
    const liveId = await insertAppFile(appId);
    const tombstoneId = await insertAppFile(appId, { status: 'deleted' });

    const withBoth = await rejection(
      getDb().delete(applications).where(eq(applications.id, appId)),
    );
    expect(pgField(withBoth, 'code')).toBe(FOREIGN_KEY_VIOLATION);

    await getDb().delete(files).where(eq(files.id, liveId));
    const withTombstone = await rejection(
      getDb().delete(applications).where(eq(applications.id, appId)),
    );
    expect(pgField(withTombstone, 'code')).toBe(FOREIGN_KEY_VIOLATION);

    await getDb().delete(files).where(eq(files.id, tombstoneId));
    await getDb().delete(applications).where(eq(applications.id, appId));
    const remaining = await getDb()
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(remaining).toHaveLength(0);
  });
});
