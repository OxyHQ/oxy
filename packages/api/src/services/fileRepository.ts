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

import { withStorageQuota } from './storageQuota.service';
import { and, asc, count, desc, eq, exists, inArray, ne, notExists, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../config/postgres';
import { fileLinks, fileVariants, files, users } from '../db/schema';
import { appListingScreenshots } from '../db/schema/appListingScreenshots';
import { messageAttachments } from '../db/schema/messageAttachments';
import type { FileLinkRecord, FileOwner, FileRecord, FileVariantRecord, NewFileVariant } from '../types/file.types';

/** Columns a caller may set when creating a file row. */
export type NewFile = typeof files.$inferInsert;

/** Columns a caller may change on an existing file row. */
export type FilePatch = Partial<Omit<NewFile, 'id' | 'createdAt' | 'updatedAt'>>;

/** Columns a caller may set when creating a link row. */
export type NewFileLink = Omit<typeof fileLinks.$inferInsert, 'fileId'>;

/**
 * Postgres `unique_violation`.
 *
 * The ones that matter here are the per-owner partial uniques
 * (`files_sha256_owner_user_live_key`, `files_sha256_system_owner_live_key`)
 * that make per-owner dedup a database invariant rather than a hope: two
 * concurrent uploads of identical bytes BY ONE OWNER race, one inserts, the
 * other lands here and re-reads the winner. Mongo's equivalent was `E11000`/`code: 11000`.
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
async function withChildren(
  rows: (typeof files.$inferSelect)[],
  db: DatabaseOrTransaction = getDb(),
): Promise<FileRecord[]> {
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
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
 * The live (non-tombstone) row THIS owner holds for this content, if any.
 *
 * Owner-scoped on purpose: another owner's row for the same bytes is never an
 * answer to "does this uploader already have it" — returning it handed that
 * owner's id, links and delete authority to the uploader. Storage is shared
 * through {@link findLiveStorageSourceBySha256} instead, which returns a KEY to
 * reuse, never a row to hand out.
 *
 * `deleted` is excluded deliberately: a tombstone is a deletion intent, not a
 * reusable asset. The per-owner partial uniques cover exactly the two statuses
 * selected here, so at most one row can match.
 */
export async function findLiveFileBySha256ForOwner(
  sha256: string,
  owner: FileOwner,
  db: DatabaseOrTransaction = getDb(),
): Promise<FileRecord | null> {
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.sha256, sha256), ne(files.status, 'deleted'), ownerPredicate(owner)))
    .limit(1);
  const [record] = await withChildren(rows, db);
  return record ?? null;
}

/** `owner_user_id = $1` or `system_owner = $1` — exactly one is set (`files_owner_exclusive_check`). */
function ownerPredicate(owner: FileOwner) {
  return owner.ownerUserId !== null
    ? eq(files.ownerUserId, owner.ownerUserId)
    : eq(files.systemOwner, owner.systemOwner);
}

/** Whether a storage key is the CDN-reachable `public/` spelling. */
function isPublicSpelling(key: string): boolean {
  return key.startsWith('public/');
}

/**
 * A live row, of ANY owner, whose stored object a new row for the same bytes
 * can share — so a second owner's upload never stores the bytes twice.
 *
 * Prefers a row whose key is already the spelling `visibility` needs (`public/`
 * for public, the bare key otherwise), oldest first, so the choice is stable;
 * falls back to the oldest live row of the other spelling, whose key the caller
 * re-spells (and writes, having the bytes). `null` when no live row holds the
 * content.
 *
 * What is returned is a SOURCE OF STORAGE, never an identity: callers read its
 * `storageKey` (and, for variants, its renditions) and create their own row.
 */
export async function findLiveStorageSourceBySha256(
  sha256: string,
  visibility: FileRecord['visibility'],
  db: DatabaseOrTransaction = getDb(),
): Promise<FileRecord | null> {
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.sha256, sha256), ne(files.status, 'deleted')))
    .orderBy(asc(files.createdAt), asc(files.id));
  if (rows.length === 0) return null;
  const wantPublic = visibility === 'public';
  const chosen = rows.find((row) => isPublicSpelling(row.storageKey) === wantPublic) ?? rows[0];
  const [record] = await withChildren([chosen], db);
  return record ?? null;
}

/**
 * Whether any live row OTHER than `excludeFileId` stores its original at this
 * exact key. A key several owners' rows share must never be handed out for a
 * client-side PUT: whoever PUTs would be writing bytes that other owners serve.
 */
export async function isStorageKeyUsedByOtherLiveRow(
  sha256: string,
  storageKey: string,
  excludeFileId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [hit] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(
      eq(files.sha256, sha256),
      ne(files.status, 'deleted'),
      ne(files.id, excludeFileId),
      eq(files.storageKey, storageKey),
    ))
    .limit(1);
  return hit !== undefined;
}

/**
 * Batch reverse content-address lookup: many hashes → at most one live record
 * each.
 *
 * Content-addressing dedups BYTES, but a `files` row is per owner, so several
 * live rows can share one hash. With `ownerUserId` the lookup is that account's
 * own rows only — at most one per hash, by the per-owner unique. Without it
 * (the legacy, unscoped form every current caller uses) the collapse keeps the
 * OLDEST row — `(created_at, id)`, with `id` as the total-order tiebreak
 * because two rows can share a timestamp — so the `sha256 -> id` mapping is
 * stable across calls. An unscoped answer is NOT the caller's row; see the
 * route's documentation.
 */
export async function findLiveFilesBySha256(
  sha256s: string[],
  options: { ownerUserId?: string } = {},
): Promise<FileRecord[]> {
  if (sha256s.length === 0) {
    return [];
  }

  const rows = await getDb()
    .select()
    .from(files)
    .where(and(
      inArray(files.sha256, sha256s),
      ne(files.status, 'deleted'),
      options.ownerUserId === undefined ? undefined : eq(files.ownerUserId, options.ownerUserId),
    ))
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
 * Another LIVE row holding the same content and already carrying variants whose
 * keys are the spelling `visibility` needs — the source `generateVariants`
 * copies a rendition set from instead of re-encoding bytes it has already
 * encoded. Rows share content-addressed storage, so the copy points the new row
 * at the SAME objects.
 *
 * Live only: a tombstone's renditions are owed a purge, and the purge keeps
 * them only while a live row uses them — copying them onto a new row is exactly
 * what makes that row "use" them, but only under the content-hash lock, which a
 * variant copy does not take. Matching spelling only: a private row pointed at
 * `public/` renditions would keep them on the CDN after every public owner had
 * deleted theirs.
 */
export async function findVariantTwin(
  sha256: string,
  excludeFileId: string,
  visibility: FileRecord['visibility'],
): Promise<FileRecord | null> {
  const rows = await getDb()
    .select({ file: files })
    .from(files)
    .innerJoin(fileVariants, eq(fileVariants.fileId, files.id))
    .where(and(eq(files.sha256, sha256), ne(files.id, excludeFileId), ne(files.status, 'deleted')))
    .groupBy(files.id)
    .orderBy(asc(files.createdAt), asc(files.id))
    .limit(TWIN_CANDIDATES);

  const wantPublic = visibility === 'public';
  const candidates = await withChildren(rows.map((row) => row.file));
  return candidates.find((candidate) =>
    candidate.variants.length > 0 &&
    candidate.variants.every((variant) => isPublicSpelling(variant.key) === wantPublic),
  ) ?? null;
}

/** Twins examined per lookup: one per spelling is the realistic need; a few spare for mixed sets. */
const TWIN_CANDIDATES = 5;

/**
 * Live rows for this content, other than `excludeFileId`, with NO renditions
 * yet and the same visibility spelling — the rows a finished generation can
 * hand its set to, so concurrent owners of one upload do not each encode it.
 */
export async function findVariantlessTwins(
  sha256: string,
  excludeFileId: string,
  visibility: FileRecord['visibility'],
): Promise<FileRecord[]> {
  const rows = await getDb()
    .select()
    .from(files)
    .where(and(
      eq(files.sha256, sha256),
      ne(files.id, excludeFileId),
      ne(files.status, 'deleted'),
      notExists(getDb().select({ one: sql`1` }).from(fileVariants).where(eq(fileVariants.fileId, files.id))),
    ));
  const wantPublic = visibility === 'public';
  return (await withChildren(rows)).filter((row) => (row.visibility === 'public') === wantPublic);
}

/**
 * Insert a file row.
 *
 * @throws when the content hash is already claimed by a live row — see
 *   {@link isUniqueViolation}, which the caller uses to fall back to a re-read.
 */
export async function insertFile(values: NewFile, db: DatabaseOrTransaction = getDb()): Promise<FileRecord> {
  if (db === getDb()) return getDb().transaction(tx => insertFile(values, tx));
  return withStorageQuota(db, [values.ownerUserId], async () => {
    const [row] = await db.insert(files).values(values).returning();
    return { ...row, links: [], variants: [] };
  });
}

/** Apply a column patch and return the file as it now stands, or `null` if it is gone. */
export async function updateFile(fileId: string, patch: FilePatch): Promise<FileRecord | null> {
  return getDb().transaction(async tx => {
    const [old] = await tx.select({ owner: files.ownerUserId }).from(files).where(eq(files.id, fileId));
    return withStorageQuota(tx, [old?.owner, patch.ownerUserId], async () => {
      const rows = await tx.update(files).set(patch).where(eq(files.id, fileId)).returning();
      const [record] = await withChildren(rows, tx);
      return record ?? null;
    });
  });
}

/**
 * The scope half of the federated delete: the row is this application's
 * federated media. Built as a predicate so the tombstone and the refusal
 * classifier read the SAME definition.
 *
 *  - owned by an account whose `type` is `'federated'`, read from `users` in the
 *    same statement, so a local user's asset can never qualify. A non-null owner
 *    also means the row is not system-owned: `files_owner_exclusive_check` makes
 *    `owner_user_id` and `system_owner` mutually exclusive, so a separate
 *    `system_owner IS NULL` term would be dead (it survived mutation);
 *  - `purpose = 'user'`, which is what `POST /assets/service/federation` writes —
 *    a cache-purpose row keeps its own eviction route;
 *  - written by the federation upload path (`metadata.source = 'federation'`);
 *  - uploaded by THIS application (`metadata.serviceAppId = appId`). The upload
 *    writes `source` and `serviceAppId` after the caller's metadata, from the
 *    verified token, so neither can be forged.
 */
function federatedScopeFor(db: DatabaseOrTransaction, appId: string) {
  const federatedOwners = db.select({ id: users.id }).from(users).where(eq(users.type, 'federated'));
  return and(
    eq(files.purpose, 'user'),
    inArray(files.ownerUserId, federatedOwners),
    sql`${files.metadata}->>'source' = 'federation'`,
    sql`${files.metadata}->>'serviceAppId' = ${appId}`,
  );
}

/**
 * Somebody OTHER than the owner holds this asset. Every reference the platform
 * records:
 *
 *  - a `file_links` row created by anyone but the owner (a use in some app);
 *  - a `message_attachments` row (an attachment in somebody's mailbox);
 *  - an `app_listing_screenshots` row (a store listing picture).
 *
 * Defence in depth since uploads became per-owner: a second owner's upload of
 * the same bytes now gets its OWN row, so a foreign link is no longer how an
 * upload ends up referenced. It still happens — `POST /assets/:id/links` takes
 * any id, and rows created before per-owner rows (the one live row per hash
 * was handed to every uploader) keep their foreign links until they are split
 * (`scripts/split-cross-owner-file-links.ts`). A reference held OUTSIDE Oxy (a
 * Mention post that stored the id) is invisible here; the caller must
 * reference-check its own.
 *
 * The last two are the same references `recordAccountStorageDeletion` refuses to
 * purge.
 */
function heldByOthers(db: DatabaseOrTransaction) {
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(fileLinks)
        .where(and(
          eq(fileLinks.fileId, files.id),
          sql`${fileLinks.createdBy} is distinct from ${files.ownerUserId}`,
        )),
    ),
    exists(db.select({ one: sql`1` }).from(messageAttachments).where(eq(messageAttachments.fileId, files.id))),
    exists(db.select({ one: sql`1` }).from(appListingScreenshots).where(eq(appListingScreenshots.fileId, files.id))),
  );
}

/**
 * Tombstone a federation-owned file on behalf of the application that uploaded
 * it — the WHOLE authorization decision, taken in the one statement that writes.
 *
 * Every condition is part of the `UPDATE … WHERE`, not a read before it, so there
 * is no window in which the row can change hands, or gain a reference, between
 * being checked and being deleted. The row qualifies only when it is live
 * (`status <> 'deleted'`; `trash` still holds bytes), in {@link federatedScopeFor},
 * and not {@link heldByOthers}.
 *
 * Runs inside the caller's transaction, which also records the storage the row
 * is owed (`recordFileStorageDeletion`), so a tombstone never exists without its
 * purge being owed. Returns the tombstoned row with its children, or `null` when
 * nothing qualified — {@link classifyFederatedDeleteRefusal} says why.
 */
export async function tombstoneFederatedFileForApp(
  tx: Transaction,
  fileId: string,
  appId: string,
): Promise<FileRecord | null> {
  const rows = await tx
    .update(files)
    .set({ status: 'deleted' })
    .where(
      and(
        eq(files.id, fileId),
        ne(files.status, 'deleted'),
        federatedScopeFor(tx, appId),
        sql`not (${heldByOthers(tx)})`,
      ),
    )
    .returning();
  const [record] = await withChildren(rows, tx);
  return record ?? null;
}

/** Why {@link tombstoneFederatedFileForApp} tombstoned nothing. */
export type FederatedDeleteRefusal = 'not_found' | 'in_use' | 'forbidden';

export async function classifyFederatedDeleteRefusal(
  fileId: string,
  appId: string,
): Promise<FederatedDeleteRefusal> {
  const db = getDb();
  const [row] = await db
    .select({
      status: files.status,
      inScope: sql<boolean>`coalesce(${federatedScopeFor(db, appId)}, false)`,
      held: sql<boolean>`coalesce(${heldByOthers(db)}, false)`,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  if (!row || row.status === 'deleted') return 'not_found';
  if (!row.inScope) return 'forbidden';
  return row.held ? 'in_use' : 'forbidden';
}

/**
 * Tombstone any live row — `deleteFile` and cache eviction. Conditional on the
 * row still being live, so a second delete (or a delete racing another) finds
 * nothing and owes nothing: purging a tombstone's keys again could remove the
 * bytes of a NEWER live row that has since taken the same content hash.
 */
export async function tombstoneFile(tx: Transaction, fileId: string): Promise<FileRecord | null> {
  const rows = await tx
    .update(files)
    .set({ status: 'deleted' })
    .where(and(eq(files.id, fileId), ne(files.status, 'deleted')))
    .returning();
  const [record] = await withChildren(rows, tx);
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
    const [old] = await tx.select({ owner: files.ownerUserId }).from(files).where(eq(files.id, fileId));
    return withStorageQuota(tx, [old?.owner, patch?.ownerUserId], async () => {
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
    const [old] = await tx.select({ owner: files.ownerUserId }).from(files).where(eq(files.id, fileId));
    return withStorageQuota(tx, [old?.owner, null], async () => {
      await tx
        .delete(fileVariants)
        .where(and(eq(fileVariants.fileId, fileId), eq(fileVariants.type, variant.type)));

      const [row] = await tx
        .insert(fileVariants)
        .values({ ...variant, fileId })
        .returning();

      return row;
    });
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
export async function updateVariantKey(
  variantId: string,
  key: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(fileVariants).set({ key }).where(eq(fileVariants.id, variantId));
}
