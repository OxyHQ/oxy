/**
 * `files` and its two child tables, against a REAL Postgres.
 *
 * This file owns the schema's FIRST partial unique indexes (per owner, per
 * content hash). `CONVENTIONS.md`
 * documents the pattern — Mongo `partialFilterExpression` → drizzle
 * `uniqueIndex().where(...)` — and every later table that needs one will copy
 * what is verified here, so the checks are on the BEHAVIOUR rather than on the
 * DDL text: the constraint fires among live rows, does NOT fire among
 * tombstones, and follows a row across a status change in both directions.
 *
 * Also here: the owner split that let `owner_user_id` become a real foreign key
 * at all, and the `ON DELETE` decisions that stop a purge from silently emptying
 * an attachment out of stored mail.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { fileLinks } from '../fileLinks';
import { FILE_LIVE_STATUSES, FILE_STATUSES, files } from '../files';
import { fileVariants } from '../fileVariants';
import { mailboxes } from '../mailboxes';
import { messageAttachments } from '../messageAttachments';
import { messages } from '../messages';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

const unique = () => randomUUID().replace(/-/g, '');

function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The constraint name Postgres reports, so a test can name WHICH one fired. */
function pgConstraint(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const name: unknown = Reflect.get(current, 'constraint_name');
    if (typeof name === 'string') return name;
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

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/** A minimal live asset. Every field the schema requires, nothing more. */
async function insertFile(
  values: Partial<typeof files.$inferInsert> & { sha256: string },
): Promise<string> {
  const [row] = await getDb()
    .insert(files)
    .values({
      size: 1024,
      mime: 'image/png',
      ext: 'png',
      storageKey: `assets/${unique()}`,
      ownerUserId: values.ownerUserId ?? (await owner()),
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

describe('files — the per-owner partial uniques on sha256', () => {
  const OWNER_KEY = 'files_sha256_owner_user_live_key';
  const SYSTEM_KEY = 'files_sha256_system_owner_live_key';

  it('refuses a second LIVE row with the same content hash for the SAME owner', async () => {
    const sha256 = unique();
    const ownerUserId = await owner();
    await insertFile({ sha256, ownerUserId, status: 'active' });

    const error = await rejection(
      getDb()
        .insert(files)
        .values({
          sha256,
          size: 1,
          mime: 'image/png',
          ext: 'png',
          storageKey: `assets/${unique()}`,
          ownerUserId,
          status: 'trash',
        }),
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    // Naming the index is the point: a bare "some unique failed" would pass
    // just as well if the constraint that fired were the primary key.
    expect(pgConstraint(error)).toBe(OWNER_KEY);
  });

  it('lets a DIFFERENT owner hold its own live row for the same content', async () => {
    // The whole change: identical bytes uploaded by two accounts are two rows,
    // one each — never one row handed to both. They may share a storage key.
    const sha256 = unique();
    const storageKey = `assets/${unique()}`;
    const first = await insertFile({ sha256, status: 'active', storageKey });
    const second = await insertFile({ sha256, status: 'active', storageKey });

    expect(second).not.toBe(first);
    const rows = await getDb().select({ id: files.id }).from(files).where(eq(files.sha256, sha256));
    expect(rows).toHaveLength(2);
  });

  it('treats `active` and `trash` as one live namespace per owner', async () => {
    // The predicate covers BOTH live statuses, so a trashed row still holds the
    // owner's claim — a `where status = 'active'` predicate would let this
    // through and give one owner two rows for the same content.
    const sha256 = unique();
    const ownerUserId = await owner();
    await insertFile({ sha256, ownerUserId, status: 'trash' });

    const error = await rejection(insertFile({ sha256, ownerUserId, status: 'active' }));

    expect(pgConstraint(error)).toBe(OWNER_KEY);
  });

  it('gives each SYSTEM namespace one live row per content hash', async () => {
    // A system namespace is an owner too. The cache namespace keeps one row per
    // hash (its dedupe), while another namespace or an account may hold the
    // same bytes alongside it.
    const sha256 = unique();
    const systemRow = (systemOwner: '__federation__' | '__federation_media_cache__') =>
      getDb()
        .insert(files)
        .values({
          sha256,
          size: 1,
          mime: 'image/png',
          ext: 'png',
          storageKey: `assets/${unique()}`,
          ownerUserId: null,
          systemOwner,
          status: 'active',
        });

    await systemRow('__federation_media_cache__');
    await expect(systemRow('__federation__')).resolves.toBeDefined();
    await expect(insertFile({ sha256, status: 'active' })).resolves.toBeDefined();

    const error = await rejection(systemRow('__federation_media_cache__'));
    expect(pgConstraint(error)).toBe(SYSTEM_KEY);
  });

  it('lets a tombstone coexist with a live row of the same content and owner', async () => {
    // The REASON the index is partial. A `deleted` row must not reserve its
    // bytes forever and block a later upload of identical content.
    const sha256 = unique();
    const ownerUserId = await owner();
    await insertFile({ sha256, ownerUserId, status: 'deleted' });

    await expect(insertFile({ sha256, ownerUserId, status: 'active' })).resolves.toBeDefined();
  });

  it('lets any number of tombstones share one content hash and owner', async () => {
    const sha256 = unique();
    const ownerUserId = await owner();
    await insertFile({ sha256, ownerUserId, status: 'deleted' });
    await insertFile({ sha256, ownerUserId, status: 'deleted' });

    const rows = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.sha256, sha256), eq(files.status, 'deleted')));

    expect(rows).toHaveLength(2);
  });

  it("releases the owner's claim when its live row becomes a tombstone", async () => {
    const sha256 = unique();
    const ownerUserId = await owner();
    const id = await insertFile({ sha256, ownerUserId, status: 'active' });

    await getDb().update(files).set({ status: 'deleted' }).where(eq(files.id, id));

    await expect(insertFile({ sha256, ownerUserId, status: 'active' })).resolves.toBeDefined();
  });

  it('refuses to resurrect a tombstone whose owner holds the hash live again', async () => {
    // The other direction, which a plain unique index cannot express at all:
    // the constraint must be re-checked when a row ENTERS the predicate.
    const sha256 = unique();
    const ownerUserId = await owner();
    const tombstone = await insertFile({ sha256, ownerUserId, status: 'deleted' });
    await insertFile({ sha256, ownerUserId, status: 'active' });

    const error = await rejection(
      getDb().update(files).set({ status: 'active' }).where(eq(files.id, tombstone)),
    );

    expect(pgConstraint(error)).toBe(OWNER_KEY);
  });

  it('no longer carries the global one-live-row-per-hash unique', async () => {
    const [row] = await getDb().execute<{ count: number }>(sql`
      select count(*)::int as count from pg_indexes
      where schemaname = 'public' and indexname = 'files_sha256_live_key'
    `);
    expect(row.count).toBe(0);
  });

  it.each([
    [OWNER_KEY, 'owner_user_id'],
    [SYSTEM_KEY, 'system_owner'],
  ])(
    '%s derives its predicate from FILE_LIVE_STATUSES and keys on (sha256, %s)',
    async (indexName, column) => {
      // The index predicate and the constant must be one statement. Reading the
      // catalogue is what proves the derivation happened rather than a matching
      // literal being typed twice and later diverging.
      const [row] = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = ${indexName}
    `);

      expect(row).toBeDefined();
      expect(row.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(row.indexdef).toContain(`(sha256, ${column})`);
      expect(row.indexdef).toContain(`${column} IS NOT NULL`);
      for (const status of FILE_LIVE_STATUSES) {
        expect(row.indexdef).toContain(`'${status}'`);
      }
      // And the tombstone status must NOT be in the predicate.
      const tombstoned = FILE_STATUSES.filter(
        (status) => !(FILE_LIVE_STATUSES as readonly string[]).includes(status),
      );
      expect(tombstoned).toEqual(['deleted']);
      expect(row.indexdef).not.toContain(`'deleted'`);
    },
  );
});

describe('files — one owner, user or system', () => {
  it('accepts a user-owned asset', async () => {
    const userId = await owner();
    const id = await insertFile({ sha256: unique(), ownerUserId: userId });

    const [row] = await getDb()
      .select({ ownerUserId: files.ownerUserId, systemOwner: files.systemOwner })
      .from(files)
      .where(eq(files.id, id));

    expect(row.ownerUserId).toBe(userId);
    expect(row.systemOwner).toBeNull();
  });

  it('accepts a system-owned asset with no user at all', async () => {
    // The whole reason the column split: Mongo put `'__federation__'` in a
    // field that otherwise held user ids, which is why it could never carry a
    // foreign key.
    const [row] = await getDb()
      .insert(files)
      .values({
        sha256: unique(),
        size: 1,
        mime: 'image/webp',
        ext: 'webp',
        storageKey: `cache/${unique()}`,
        systemOwner: '__federation_media_cache__',
        purpose: 'federation-media-cache',
      })
      .returning({ ownerUserId: files.ownerUserId, systemOwner: files.systemOwner });

    expect(row.ownerUserId).toBeNull();
    expect(row.systemOwner).toBe('__federation_media_cache__');
  });

  it('refuses both owners at once, and neither', async () => {
    const both = await rejection(
      getDb().execute(sql`
        insert into files (id, sha256, size, mime, ext, storage_key, owner_user_id, system_owner)
        values (${unique()}, ${unique()}, 1, 'image/png', 'png', ${unique()}, ${await owner()}, '__federation__')
      `),
    );
    const neither = await rejection(
      getDb().execute(sql`
        insert into files (id, sha256, size, mime, ext, storage_key)
        values (${unique()}, ${unique()}, 1, 'image/png', 'png', ${unique()})
      `),
    );

    expect(pgConstraint(both)).toBe('files_owner_exclusive_check');
    expect(pgConstraint(neither)).toBe('files_owner_exclusive_check');
  });

  it('refuses a user id that is not an account — the constraint Mongo could not have', async () => {
    const error = await rejection(
      insertFile({ sha256: unique(), ownerUserId: `ghost-${unique()}` }),
    );

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('refuses a system namespace outside the closed set', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into files (id, sha256, size, mime, ext, storage_key, system_owner)
        values (${unique()}, ${unique()}, 1, 'image/png', 'png', ${unique()}, '__made_up__')
      `),
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('files — usage count is derived, never stored', () => {
  it('has no usage_count column and counts links instead', async () => {
    const columns = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'files'
    `);
    expect(columns.map((row) => row.column_name)).not.toContain('usage_count');

    const userId = await owner();
    const fileId = await insertFile({ sha256: unique(), ownerUserId: userId });
    await getDb()
      .insert(fileLinks)
      .values([
        { fileId, app: 'mention', entityType: 'post', entityId: unique(), createdBy: userId },
        { fileId, app: 'mention', entityType: 'post', entityId: unique(), createdBy: userId },
      ]);

    const [{ count }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(fileLinks)
      .where(eq(fileLinks.fileId, fileId));

    expect(count).toBe(2);
  });
});

describe('file_links', () => {
  it('refuses a duplicate link — the check `linkFile` does in application code', async () => {
    const userId = await owner();
    const fileId = await insertFile({ sha256: unique(), ownerUserId: userId });
    const entityId = unique();

    await getDb()
      .insert(fileLinks)
      .values({ fileId, app: 'mention', entityType: 'post', entityId, createdBy: userId });

    const error = await rejection(
      getDb()
        .insert(fileLinks)
        .values({ fileId, app: 'mention', entityType: 'post', entityId, createdBy: await owner() }),
    );

    // A DIFFERENT creator, deliberately: `linkFile` ignores `createdBy` when it
    // dedupes, so including it in the key would enforce something weaker.
    expect(pgConstraint(error)).toBe('file_links_file_id_app_entity_key');
  });

  it('scopes the link to its creator with a real foreign key', async () => {
    const fileId = await insertFile({ sha256: unique() });
    const error = await rejection(
      getDb()
        .insert(fileLinks)
        .values({
          fileId,
          app: 'mention',
          entityType: 'post',
          entityId: unique(),
          createdBy: `ghost-${unique()}`,
        }),
    );

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('is append-only — no updated_at', async () => {
    const columns = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'file_links'
    `);
    const names = columns.map((row) => row.column_name);

    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });

  it('goes with the file', async () => {
    const userId = await owner();
    const fileId = await insertFile({ sha256: unique(), ownerUserId: userId });
    await getDb().insert(fileLinks).values({
      fileId,
      app: 'mention',
      entityType: 'post',
      entityId: unique(),
      createdBy: userId,
    });

    await getDb().delete(files).where(eq(files.id, fileId));

    const remaining = await getDb()
      .select({ id: fileLinks.id })
      .from(fileLinks)
      .where(eq(fileLinks.fileId, fileId));
    expect(remaining).toEqual([]);
  });
});

describe('file_variants', () => {
  it('round-trips a rendition with its shape-less renderer metadata', async () => {
    const fileId = await insertFile({ sha256: unique(), mime: 'video/mp4', ext: 'mp4' });
    await getDb()
      .insert(fileVariants)
      .values({
        fileId,
        type: '720p',
        key: `variants/${unique()}`,
        width: 1280,
        height: 720,
        size: 4_000_000,
        readyAt: new Date(),
        metadata: { videoCodec: 'libx264', preset: 'fast' },
      });

    const [row] = await getDb()
      .select()
      .from(fileVariants)
      .where(and(eq(fileVariants.fileId, fileId), eq(fileVariants.type, '720p')));

    expect(row.width).toBe(1280);
    expect(row.size).toBe(4_000_000);
    expect(row.metadata).toEqual({ videoCodec: 'libx264', preset: 'fast' });
  });

  it('permits an unfinished variant beside a ready one of the same type', async () => {
    // Deliberately NOT unique on (file_id, type): regeneration removes the
    // stale entry and inserts the replacement, and `getUsableReadyVariant`
    // selects on `ready_at` — so two rows for one type is a legitimate
    // intermediate state rather than a violation.
    const fileId = await insertFile({ sha256: unique(), mime: 'video/mp4', ext: 'mp4' });
    await getDb()
      .insert(fileVariants)
      .values([
        { fileId, type: '720p', key: `variants/${unique()}`, readyAt: new Date() },
        { fileId, type: '720p', key: `variants/${unique()}` },
      ]);

    const ready = await getDb()
      .select({ id: fileVariants.id })
      .from(fileVariants)
      .where(and(eq(fileVariants.fileId, fileId), sql`${fileVariants.readyAt} is not null`));

    expect(ready).toHaveLength(1);
  });
});

describe('message_attachments — ON DELETE no action on file_id', () => {
  async function attachedFile(): Promise<{ fileId: string; messageId: string }> {
    const userId = await owner();
    const [mailbox] = await getDb()
      .insert(mailboxes)
      .values({ userId, name: 'Inbox', path: `INBOX-${unique()}` })
      .returning({ id: mailboxes.id });
    const [message] = await getDb()
      .insert(messages)
      .values({
        userId,
        mailboxId: mailbox.id,
        messageId: `<${unique()}@oxy.so>`,
        fromAddress: 'sender@example.com',
        subject: '',
        size: 2048,
        date: new Date(),
      })
      .returning({ id: messages.id });
    const fileId = await insertFile({ sha256: unique(), ownerUserId: userId });

    await getDb().insert(messageAttachments).values({
      messageId: message.id,
      ord: 0,
      fileId,
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      size: 1024,
    });

    return { fileId, messageId: message.id };
  }

  it('refuses to purge a file that stored mail still carries', async () => {
    const { fileId } = await attachedFile();

    const error = await rejection(getDb().delete(files).where(eq(files.id, fileId)));

    // CASCADE here would have emptied an attachment out of a message that still
    // claims to carry it — silently, with the name and size left behind.
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('permits the purge once the message is gone', async () => {
    const { fileId, messageId } = await attachedFile();

    await getDb().delete(messages).where(eq(messages.id, messageId));
    await expect(getDb().delete(files).where(eq(files.id, fileId))).resolves.toBeDefined();
  });

  it('lets one statement delete both sides — why `no action`, not `restrict`', async () => {
    // `RESTRICT` is checked immediately; `NO ACTION` at end of statement. A
    // single statement that removes the referencing row too must succeed, or an
    // account deletion could fail purely on the order Postgres visited the
    // cascades.
    const { fileId, messageId } = await attachedFile();

    await expect(
      getDb().execute(sql`
        with gone as (delete from messages where id = ${messageId} returning id)
        delete from files where id = ${fileId} and (select count(*) from gone) = 1
      `),
    ).resolves.toBeDefined();

    const remaining = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(eq(files.id, fileId));
    expect(remaining).toEqual([]);
  });
});
