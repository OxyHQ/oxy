/**
 * Persistence for the stored-asset aggregate: `files` + `file_links` +
 * `file_variants`.
 *
 * In Mongo those three were ONE document, so "load a file" and "load its links
 * and variants" were the same statement and every caller got the whole thing for
 * free. In Postgres they are three tables, and the assembly has to happen
 * somewhere. It happens HERE, once — not in `assetService` and again in
 * `variantService`, which is how the two would drift on ordering, on which
 * child rows count, and on whether a write is atomic.
 *
 * Two rules this module exists to hold:
 *
 * 1. **A file is never returned without its children.** Every read returns a
 *    {@link FileRecord}. `links.length` IS the usage count and decides whether
 *    an unlinked file falls to `trash`, so a file loaded without its links would
 *    read as unused and be trashed.
 * 2. **A child-set write is one transaction.** `commitVariants` swaps a batch of
 *    variants; done as a bare delete-then-insert a crash or a concurrent read
 *    lands on a file with NO variants, which the callers read as "not generated
 *    yet" and would regenerate from scratch. The delete is scoped to the types
 *    being written (`upsertVariantSet`), so a batch cannot destroy a rendition
 *    the lazy read path materialised and does not itself produce.
 *
 * Ordering is explicit on every read (`created_at, id` for links; `type, id` for
 * variants) because Postgres guarantees none, and a caller that indexes into
 * `variants` — `ensureVideoPoster` rewrites one entry in place — needs the same
 * order twice in a row.
 */

import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { fileLinks, fileVariants, files } from '../db/schema';
import type { FileLinkRecord, FileRecord, FileVariantRecord, NewFileVariant } from '../types/file.types';

/** Columns a caller may set when creating a file row. */
export type NewFile = typeof files.$inferInsert;

/** Columns a caller may change on an existing file row. */
export type FilePatch = Partial<Omit<NewFile, 'id' | 'createdAt' | 'updatedAt'>>;

/** Columns a caller may set when creating a link row. */
export type NewFileLink = Omit<typeof fileLinks.$inferInsert, 'fileId'>;

/**
 * Postgres `unique_violation`.
 *
 * The one that matters here is `files_sha256_live_key`, the partial unique that
 * makes content-addressed dedup a database invariant rather than a hope: two
 * concurrent uploads of identical bytes race, one inserts, the other lands here
 * and re-reads the winner. Mongo's equivalent was `E11000`/`code: 11000`.
 *
 * **The cause chain is not optional.** Drizzle does not surface the driver's
 * error: it throws its own `Failed query: …` `Error` with the postgres.js error
 * as `cause`, so `error.code` on what a `catch` receives is `undefined`. Reading
 * it directly would make every dedup race fall through to a rethrow — a 500 on
 * exactly the concurrent-upload path this branch exists to absorb, and one that
 * only appears under real concurrency. The same walk is what
 * `schema/__tests__/files.test.ts` uses to read a constraint's code.
 */
export function isUniqueViolation(error: unknown): boolean {
  // `Reflect.get` for BOTH hops: this package's `lib` predates `Error.cause`, so
  // reading `.cause` off an `Error` is a type error rather than a value that
  // happens to be there at runtime.
  for (let current: unknown = error; current instanceof Error; current = Reflect.get(current, 'cause')) {
    if (Reflect.get(current, 'code') === '23505') {
      return true;
    }
  }
  return false;
}

/** Attach the child rows to a set of file rows, preserving the caller's order. */
async function withChildren(rows: (typeof files.$inferSelect)[]): Promise<FileRecord[]> {
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const db = getDb();
  const [links, variants] = await Promise.all([
    db
      .select()
      .from(fileLinks)
      .where(inArray(fileLinks.fileId, ids))
      .orderBy(asc(fileLinks.createdAt), asc(fileLinks.id)),
    db
      .select()
      .from(fileVariants)
      .where(inArray(fileVariants.fileId, ids))
      .orderBy(asc(fileVariants.type), asc(fileVariants.id)),
  ]);

  const linksByFile = new Map<string, FileLinkRecord[]>();
  for (const link of links) {
    const bucket = linksByFile.get(link.fileId);
    if (bucket) bucket.push(link);
    else linksByFile.set(link.fileId, [link]);
  }

  const variantsByFile = new Map<string, FileVariantRecord[]>();
  for (const variant of variants) {
    const bucket = variantsByFile.get(variant.fileId);
    if (bucket) bucket.push(variant);
    else variantsByFile.set(variant.fileId, [variant]);
  }

  return rows.map((row) => ({
    ...row,
    links: linksByFile.get(row.id) ?? [],
    variants: variantsByFile.get(row.id) ?? [],
  }));
}

/** One file by id, or `null`. */
export async function findFileById(fileId: string): Promise<FileRecord | null> {
  const rows = await getDb().select().from(files).where(eq(files.id, fileId)).limit(1);
  const [record] = await withChildren(rows);
  return record ?? null;
}

/**
 * Many files by id, in ONE round trip. Unresolvable ids are simply absent, so
 * the result may be shorter than the input and its order is the database's.
 */
export async function findFilesByIds(fileIds: string[]): Promise<FileRecord[]> {
  if (fileIds.length === 0) {
    return [];
  }
  const rows = await getDb().select().from(files).where(inArray(files.id, fileIds));
  return withChildren(rows);
}

/**
 * The live (non-tombstone) record holding this content, if any.
 *
 * `deleted` is excluded deliberately: a tombstone is a deletion intent, not a
 * reusable asset, and reviving one under the next uploader's ownership was a
 * cross-tenant takeover vector. The partial unique index covers exactly the two
 * statuses selected here, so at most one row can match.
 */
export async function findLiveFileBySha256(sha256: string): Promise<FileRecord | null> {
  const rows = await getDb()
    .select()
    .from(files)
    .where(and(eq(files.sha256, sha256), ne(files.status, 'deleted')))
    .limit(1);
  const [record] = await withChildren(rows);
  return record ?? null;
}

/**
 * Batch reverse content-address lookup: many hashes → at most one live record
 * each.
 *
 * Content-addressing dedups BYTES, but a `files` row is per-owner/per-context,
 * so several live rows can share one hash (a tombstone frees the hash for a new
 * row, and the partial unique only covers live rows). The caller maps
 * `sha256 -> id` and that mapping must be stable across calls, so the collapse
 * keeps the OLDEST row — `(created_at, id)`, with `id` as the total-order
 * tiebreak because two rows can share a timestamp. The first-uploaded row is the
 * canonical origin of that content and never changes once written.
 */
export async function findLiveFilesBySha256(sha256s: string[]): Promise<FileRecord[]> {
  if (sha256s.length === 0) {
    return [];
  }

  const rows = await getDb()
    .select()
    .from(files)
    .where(and(inArray(files.sha256, sha256s), ne(files.status, 'deleted')))
    .orderBy(asc(files.createdAt), asc(files.id));

  const oldestBySha = new Map<string, typeof files.$inferSelect>();
  for (const row of rows) {
    if (!oldestBySha.has(row.sha256)) {
      oldestBySha.set(row.sha256, row);
    }
  }

  return withChildren([...oldestBySha.values()]);
}

/** One page of an account's own files, newest first, plus the total. */
export async function listFilesByOwner(
  ownerUserId: string,
  limit: number,
  offset: number
): Promise<{ files: FileRecord[]; total: number }> {
  const db = getDb();
  const where = and(eq(files.ownerUserId, ownerUserId), ne(files.status, 'deleted'));

  const [rows, [totals]] = await Promise.all([
    db.select().from(files).where(where).orderBy(desc(files.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(files).where(where),
  ]);

  return { files: await withChildren(rows), total: totals?.total ?? 0 };
}

/**
 * Another live row holding the same content and already carrying variants — the
 * source `generateVariants` copies a rendition set from instead of re-encoding
 * bytes it has already encoded.
 */
export async function findVariantTwin(
  sha256: string,
  excludeFileId: string
): Promise<FileRecord | null> {
  const rows = await getDb()
    .select({ file: files })
    .from(files)
    .innerJoin(fileVariants, eq(fileVariants.fileId, files.id))
    .where(and(eq(files.sha256, sha256), ne(files.id, excludeFileId)))
    .groupBy(files.id)
    .orderBy(asc(files.createdAt), asc(files.id))
    .limit(1);

  const [record] = await withChildren(rows.map((row) => row.file));
  return record ?? null;
}

/**
 * Insert a file row.
 *
 * @throws when the content hash is already claimed by a live row — see
 *   {@link isUniqueViolation}, which the caller uses to fall back to a re-read.
 */
export async function insertFile(values: NewFile): Promise<FileRecord> {
  const [row] = await getDb().insert(files).values(values).returning();
  return { ...row, links: [], variants: [] };
}

/** Apply a column patch and return the file as it now stands, or `null` if it is gone. */
export async function updateFile(fileId: string, patch: FilePatch): Promise<FileRecord | null> {
  const rows = await getDb().update(files).set(patch).where(eq(files.id, fileId)).returning();
  const [record] = await withChildren(rows);
  return record ?? null;
}

/**
 * Record a use of this asset.
 *
 * `(file_id, app, entity_type, entity_id)` is UNIQUE, so a duplicate link is
 * refused by the database rather than by a read-then-write that two concurrent
 * requests can both pass. Returns whether a row was actually created.
 */
export async function insertFileLink(fileId: string, values: NewFileLink): Promise<boolean> {
  const inserted = await getDb()
    .insert(fileLinks)
    .values({ ...values, fileId })
    .onConflictDoNothing({
      target: [fileLinks.fileId, fileLinks.app, fileLinks.entityType, fileLinks.entityId],
    })
    .returning({ id: fileLinks.id });

  return inserted.length > 0;
}

/** Drop one use of this asset. Returns whether a row was removed. */
export async function deleteFileLink(
  fileId: string,
  app: string,
  entityType: string,
  entityId: string
): Promise<boolean> {
  const removed = await getDb()
    .delete(fileLinks)
    .where(
      and(
        eq(fileLinks.fileId, fileId),
        eq(fileLinks.app, app),
        eq(fileLinks.entityType, entityType),
        eq(fileLinks.entityId, entityId)
      )
    )
    .returning({ id: fileLinks.id });

  return removed.length > 0;
}

/**
 * Write a batch of renditions for a file, optionally alongside its `metadata`,
 * in ONE transaction — replacing any existing row of the SAME `type` and
 * leaving rows of every other type untouched.
 *
 * Mongoose wrote variants and metadata in a single `$set` because they were
 * fields of one document; the transaction is what keeps that indivisible.
 * Intrinsic metadata (dimensions, duration) is derived from the same decode pass
 * that produced the renditions, so a state with one and not the other never
 * existed and must not become reachable.
 *
 * Scoping the delete to the types being written — rather than clearing the
 * file's whole set — is what lets background generation and the lazy read path
 * coexist. `assetService.ensureVariant` materialises ONE variant on demand
 * (`upsertVariant`), and for a video that is a poster-derived image size which
 * background generation does not produce: poster, `360p`/`720p`/`1080p` and HLS.
 * A whole-set clear would delete exactly those, and the next read would pay the
 * ffmpeg pass again to rebuild what it already had — duplicated work that grows
 * with how long a job waits in the queue.
 */
export async function upsertVariantSet(
  fileId: string,
  variants: NewFileVariant[],
  patch?: FilePatch
): Promise<FileVariantRecord[]> {
  return getDb().transaction(async (tx) => {
    const types = variants.map((variant) => variant.type);
    if (types.length > 0) {
      await tx
        .delete(fileVariants)
        .where(and(eq(fileVariants.fileId, fileId), inArray(fileVariants.type, types)));
    }

    const inserted =
      variants.length > 0
        ? await tx
            .insert(fileVariants)
            .values(variants.map((variant) => ({ ...variant, fileId })))
            .returning()
        : [];

    if (patch) {
      await tx.update(files).set(patch).where(eq(files.id, fileId));
    }

    return inserted;
  });
}

/**
 * Write ONE rendition, replacing any existing row of the same `type`.
 *
 * `(file_id, type)` deliberately carries no unique constraint — an unfinished
 * variant and a live one for the same type is a legitimate intermediate state
 * (`schema/fileVariants.ts`) — so the replacement is an explicit delete plus an
 * insert, made indivisible by the transaction.
 */
export async function upsertVariant(
  fileId: string,
  variant: NewFileVariant
): Promise<FileVariantRecord> {
  return getDb().transaction(async (tx) => {
    await tx
      .delete(fileVariants)
      .where(and(eq(fileVariants.fileId, fileId), eq(fileVariants.type, variant.type)));

    const [row] = await tx
      .insert(fileVariants)
      .values({ ...variant, fileId })
      .returning();

    return row;
  });
}

/**
 * Drop a rendition whose stored object has gone missing, so the next read
 * regenerates it instead of handing out a key that 404s.
 */
export async function deleteVariant(fileId: string, type: string, key: string): Promise<void> {
  await getDb()
    .delete(fileVariants)
    .where(
      and(eq(fileVariants.fileId, fileId), eq(fileVariants.type, type), eq(fileVariants.key, key))
    );
}

/** Point one rendition at a new object key (a visibility relocation). */
export async function updateVariantKey(variantId: string, key: string): Promise<void> {
  await getDb().update(fileVariants).set({ key }).where(eq(fileVariants.id, variantId));
}
