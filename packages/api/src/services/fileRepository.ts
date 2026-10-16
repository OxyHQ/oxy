/**
 * Persistence for the stored-asset aggregate: `files` + `file_references` +
 * `file_variants`.
 *
 * They are three tables, so loading a file with its links and variants takes
 * an assembly step, and that has to happen somewhere. It happens HERE, once — not in `assetService` and again in
 * `variantService`, which is how the two would drift on ordering, on which
 * child rows count, and on whether a write is atomic.
 *
 * Two rules this module exists to hold:
 *
 * 1. **A file is never returned without its children.** Every read returns a
 *    {@link FileRecord}. `links.length` IS the usage count — what the owner is
 *    shown as *in use* and what a delete without `force` refuses on — so a file
 *    loaded without its links would read as unused.
 * 3. **A reference write maintains `unreferenced_since` in its own
 *    transaction**, under a lock on the file row (`addFileReferences`,
 *    `deleteFileReference`): it is what the lifecycle sweep collects an
 *    application's unused file by (ADR 0041 D5).
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

import { isServedPublicly } from '../config/cdn';
import { ConflictError, ForbiddenError } from '../utils/error';
import { storageAccountForOwner, withStorageQuota } from './storageQuota.service';
import { recordFileEvents } from './fileEvents.service';
import { assertContentNotBlocked, heldAsEvidence } from './contentClaims/contentBlocklist';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { qualified } from '@oxy.so/db';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../config/postgres';
import { applications, fileReferences, fileVariants, files, users } from '../db/schema';
import { appListingScreenshots } from '../db/schema/appListingScreenshots';
import { messageAttachments } from '../db/schema/messageAttachments';
import type {
  FileReferenceRecord,
  FileOwner,
  FileOwnerColumns,
  FileRecord,
  FileVariantRecord,
  NewFileVariant,
} from '../types/file.types';

/** The metered owner columns of a row: the two that decide whose quota it counts against. */
type MeteredOwner = Pick<FileOwnerColumns, 'ownerUserId' | 'ownerApplicationId'>;

/** The metered owner of one row, read without a lock, or `undefined` when it is gone. */
async function readMeteredOwner(
  tx: DatabaseOrTransaction,
  fileId: string,
): Promise<MeteredOwner | undefined> {
  const [row] = await tx
    .select({ ownerUserId: files.ownerUserId, ownerApplicationId: files.ownerApplicationId })
    .from(files)
    .where(eq(files.id, fileId));
  return row;
}

/**
 * The accounts a quota-checked write to this row must lock and re-measure: the
 * account the row's bytes count against now, and the one a patch moves them to.
 */
async function quotaAccountsFor(
  tx: DatabaseOrTransaction,
  current: MeteredOwner | undefined,
  patch?: FilePatch,
): Promise<(string | null)[]> {
  const accounts = [current ? await storageAccountForOwner(tx, current) : null];
  if (patch && (patch.ownerUserId || patch.ownerApplicationId)) {
    accounts.push(await storageAccountForOwner(tx, patch));
  }
  return accounts;
}

/** Account locks precede this row lock on every quota-checked update. */
async function assertStableFileOwner(
  tx: DatabaseOrTransaction,
  fileId: string,
  expected: MeteredOwner | undefined,
): Promise<void> {
  const [current] = await tx
    .select({ ownerUserId: files.ownerUserId, ownerApplicationId: files.ownerApplicationId })
    .from(files)
    .where(eq(files.id, fileId))
    .for('update');
  if (
    current?.ownerUserId !== expected?.ownerUserId ||
    current?.ownerApplicationId !== expected?.ownerApplicationId
  )
    throw new ConflictError('File ownership changed during admission; retry');
}

/** Columns a caller may set when creating a file row. */
export type NewFile = typeof files.$inferInsert;

/** Columns a caller may change on an existing file row. */
export type FilePatch = Partial<Omit<NewFile, 'id' | 'createdAt' | 'updatedAt'>>;

/** Columns a caller may set when creating a reference row. */
export type NewFileReference = Omit<
  typeof fileReferences.$inferInsert,
  'fileId' | 'id' | 'createdAt'
>;

/** What identifies one reference on a file: the unique key less `file_id`. */
export interface FileReferenceKey {
  applicationId: string;
  entityType: string;
  entityId: string;
}

/**
 * Postgres `unique_violation`.
 *
 * The ones that matter here are the per-owner partial uniques
 * (`files_sha256_owner_user_live_key`, `files_sha256_system_owner_live_key`)
 * that make per-owner dedup a database invariant rather than a hope: two
 * concurrent uploads of identical bytes BY ONE OWNER race, one inserts, the
 * other lands here and re-reads the winner.
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
  for (
    let current: unknown = error;
    current instanceof Error;
    current = Reflect.get(current, 'cause')
  ) {
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
      .from(fileReferences)
      .where(inArray(fileReferences.fileId, ids))
      .orderBy(asc(fileReferences.createdAt), asc(fileReferences.id)),
    db
      .select()
      .from(fileVariants)
      .where(inArray(fileVariants.fileId, ids))
      .orderBy(asc(fileVariants.type), asc(fileVariants.id)),
  ]);

  const linksByFile = new Map<string, FileReferenceRecord[]>();
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

/**
 * `owner_user_id = $1`, `system_owner = $1` or `owner_application_id = $1` —
 * exactly one is set (`files_owner_exclusive_check`).
 */
function ownerPredicate(owner: FileOwner) {
  if (owner.ownerUserId !== null) return eq(files.ownerUserId, owner.ownerUserId);
  if (owner.systemOwner !== null) return eq(files.systemOwner, owner.systemOwner);
  return eq(files.ownerApplicationId, owner.ownerApplicationId);
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
    .where(
      and(
        eq(files.sha256, sha256),
        ne(files.status, 'deleted'),
        ne(files.id, excludeFileId),
        eq(files.storageKey, storageKey),
      ),
    )
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
    .where(
      and(
        inArray(files.sha256, sha256s),
        ne(files.status, 'deleted'),
        options.ownerUserId === undefined ? undefined : eq(files.ownerUserId, options.ownerUserId),
      ),
    )
    .orderBy(asc(files.createdAt), asc(files.id));

  const oldestBySha = new Map<string, typeof files.$inferSelect>();
  for (const row of rows) {
    if (!oldestBySha.has(row.sha256)) {
      oldestBySha.set(row.sha256, row);
    }
  }

  return withChildren([...oldestBySha.values()]);
}

/**
 * One page of an account's own files, newest first, plus the total.
 *
 * `inUse` narrows it to the files some application references (`true`) or to
 * those none does — *not in use* (`false`, ADR 0041 D5). Read from the
 * reference set itself, not from `unreferenced_since`, so the filter and the
 * `inUse` each file reports can never disagree. A file blocked under a claim
 * that is still open is not offered as *not in use* — it is not the owner's
 * clutter to clear while the claim is decided (D10); it is listed again once
 * the claim closes.
 */
export async function listFilesByOwner(
  ownerUserId: string,
  limit: number,
  offset: number,
  options: { inUse?: boolean } = {},
): Promise<{ files: FileRecord[]; total: number }> {
  const db = getDb();
  const referenced = exists(
    db.select({ one: sql`1` }).from(fileReferences).where(eq(fileReferences.fileId, files.id)),
  );
  const where = and(
    eq(files.ownerUserId, ownerUserId),
    ne(files.status, 'deleted'),
    options.inUse === undefined
      ? undefined
      : options.inUse
        ? referenced
        : and(
            not(referenced),
            sql`not (${files.status} = 'blocked' and ${heldAsEvidence(qualified(files.sha256))})`,
          ),
  );

  const [rows, [totals]] = await Promise.all([
    db.select().from(files).where(where).orderBy(desc(files.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(files).where(where),
  ]);

  return { files: await withChildren(rows), total: totals?.total ?? 0 };
}

/** Where one page of an application's files resumes: the last row of the page before. */
export interface ApplicationFileCursor {
  createdAt: Date;
  id: string;
}

/**
 * One page of an APPLICATION's own live files (ADR 0041), newest first, with
 * `(created_at, id)` as the total order so a cursor never skips or repeats a
 * row that shares a timestamp. Served by `files_owner_application_id_created_at_idx`.
 */
export async function listFilesByApplication(
  applicationId: string,
  limit: number,
  after?: ApplicationFileCursor,
): Promise<FileRecord[]> {
  const rows = await getDb()
    .select()
    .from(files)
    .where(
      and(
        eq(files.ownerApplicationId, applicationId),
        ne(files.status, 'deleted'),
        after === undefined
          ? undefined
          : or(
              lt(files.createdAt, after.createdAt),
              and(eq(files.createdAt, after.createdAt), lt(files.id, after.id)),
            ),
      ),
    )
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(limit);
  return withChildren(rows);
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
  return (
    candidates.find(
      (candidate) =>
        candidate.variants.length > 0 &&
        candidate.variants.every((variant) => isPublicSpelling(variant.key) === wantPublic),
    ) ?? null
  );
}

/** Twins examined per lookup: one per spelling is the realistic need; a few spare for mixed sets. */
const TWIN_CANDIDATES = 5;

/**
 * Live rows for this content, other than `excludeFileId`, with the same
 * visibility spelling — the rows a finished generation can hand its set to.
 *
 * `variantless` (the upload path) narrows them to rows with NO renditions yet,
 * so concurrent owners of one upload do not each encode it. A re-encode passes
 * `false`: twins name the same content-addressed objects, so when those are
 * lost every twin is broken with them and every twin gets the new set.
 */
export async function findSameSpellingTwins(
  sha256: string,
  excludeFileId: string,
  visibility: FileRecord['visibility'],
  { variantless }: { variantless: boolean },
): Promise<FileRecord[]> {
  const rows = await getDb()
    .select()
    .from(files)
    .where(
      and(
        eq(files.sha256, sha256),
        ne(files.id, excludeFileId),
        ne(files.status, 'deleted'),
        variantless
          ? notExists(
              getDb()
                .select({ one: sql`1` })
                .from(fileVariants)
                .where(eq(fileVariants.fileId, files.id)),
            )
          : undefined,
      ),
    );
  const wantPublic = visibility === 'public';
  // By the spelling a row is SERVED in, not its visibility alone: a public row
  // in trash keeps its renditions off the CDN (`isServedPublicly`), so it is a
  // twin of the non-public spelling.
  return (await withChildren(rows)).filter((row) => isServedPublicly(row) === wantPublic);
}

/**
 * Insert a file row.
 *
 * Every new row comes through here, so this is where blocked bytes are
 * refused for every owner (ADR 0041 D10): `ContentBlockedError` (451) when the
 * hash is on `blocked_content_hashes`. Callers hold the content-hash lock,
 * which the block takes too, so the check and the insert cannot straddle one.
 *
 * @throws when the content hash is already claimed by a live row — see
 *   {@link isUniqueViolation}, which the caller uses to fall back to a re-read.
 */
export async function insertFile(
  values: NewFile,
  db: DatabaseOrTransaction = getDb(),
): Promise<FileRecord> {
  if (db === getDb()) return getDb().transaction((tx) => insertFile(values, tx));
  await assertContentNotBlocked(values.sha256, db);
  if (values.ownerApplicationId) {
    await assertApplicationNotDeleted(db, [values.ownerApplicationId]);
  }
  return withStorageQuota(db, [await storageAccountForOwner(db, values)], async () => {
    // A new row is used by nothing yet (ADR 0041 D5): the clock that collects
    // an unused application file — and marks an account's "not in use" —
    // starts now, and the first reference stops it.
    const [row] = await db
      .insert(files)
      .values({ unreferencedSince: sql`now()`, ...values })
      .returning();
    return { ...row, links: [], variants: [] };
  });
}

/**
 * The applications among `applicationIds` that are not deleted, read under
 * `FOR KEY SHARE` — the lock an application's deletion (`FOR UPDATE`, ADR 0041
 * D8) conflicts with. A write racing that deletion therefore waits for it and
 * then sees `deleted`, so no file or reference can be added for an
 * application after its content was removed.
 */
async function liveApplicationIds(
  db: DatabaseOrTransaction,
  applicationIds: readonly string[],
): Promise<Set<string>> {
  if (applicationIds.length === 0) return new Set();
  const rows = await db
    .select({ id: applications.id, status: applications.status })
    .from(applications)
    .where(inArray(applications.id, [...new Set(applicationIds)].sort()))
    .orderBy(asc(applications.id))
    .for('key share');
  return new Set(rows.filter((row) => row.status !== 'deleted').map((row) => row.id));
}

async function assertApplicationNotDeleted(
  db: DatabaseOrTransaction,
  applicationIds: readonly string[],
): Promise<void> {
  const live = await liveApplicationIds(db, applicationIds);
  if (applicationIds.some((id) => !live.has(id))) {
    throw new ForbiddenError('This application was deleted');
  }
}

/**
 * Apply a column patch and return the file as it now stands, or `null` if it is gone.
 *
 * `afterUpdate` runs in the same transaction with the updated row — how a
 * visibility change queues its `file.visibility_changed` events (ADR 0041 D9)
 * so the change and its events commit together.
 */
export async function updateFile(
  fileId: string,
  patch: FilePatch,
  options: { afterUpdate?: (tx: Transaction, record: FileRecord) => Promise<void> } = {},
): Promise<FileRecord | null> {
  return getDb().transaction(async (tx) => {
    const old = await readMeteredOwner(tx, fileId);
    return withStorageQuota(tx, await quotaAccountsFor(tx, old, patch), async () => {
      await assertStableFileOwner(tx, fileId, old);
      const rows = await tx.update(files).set(patch).where(eq(files.id, fileId)).returning();
      const [record] = await withChildren(rows, tx);
      if (record && options.afterUpdate) await options.afterUpdate(tx, record);
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
  const federatedOwners = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.type, 'federated'));
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
 *  - a `file_references` row that is not the owner's own use (below);
 *  - a `message_attachments` row (an attachment in somebody's mailbox);
 *  - an `app_listing_screenshots` row (a store listing picture).
 *
 * A reference is the owner's OWN use when the owner made it: for an account's
 * file, a reference its person created (from any application); for an
 * APPLICATION's file (ADR 0041), a reference that application holds. Anything
 * else — another person's reference, an application's service-made reference
 * to a person's file, another application's reference to an application's
 * file, any reference to a system namespace's file — is held by others.
 *
 * Defence in depth since uploads became per-owner: a second owner's upload of
 * the same bytes now gets its OWN row, so a foreign reference is no longer how
 * an upload ends up referenced. Rows created before per-owner rows keep their
 * foreign references until they are split
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
        .from(fileReferences)
        .where(
          and(
            eq(fileReferences.fileId, files.id),
            sql`not coalesce(
              (${files.ownerUserId} is not null and ${fileReferences.createdByUserId} = ${files.ownerUserId})
              or (${files.ownerApplicationId} is not null and ${fileReferences.applicationId} = ${files.ownerApplicationId}),
              false)`,
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(messageAttachments)
        .where(eq(messageAttachments.fileId, files.id)),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(appListingScreenshots)
        .where(eq(appListingScreenshots.fileId, files.id)),
    ),
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
 * Tombstone one of THIS application's own files (ADR 0041) — the whole
 * authorization decision in the one statement that writes, exactly as
 * {@link tombstoneFederatedFileForApp} does: the row must be live, owned by
 * `appId`, and not {@link heldByOthers}. `null` when nothing qualified;
 * {@link classifyApplicationFileDeleteRefusal} says why.
 */
export async function tombstoneApplicationFile(
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
        eq(files.ownerApplicationId, appId),
        ne(files.status, 'deleted'),
        sql`not (${heldByOthers(tx)})`,
      ),
    )
    .returning();
  const [record] = await withChildren(rows, tx);
  return record ?? null;
}

/**
 * Why {@link tombstoneApplicationFile} tombstoned nothing. Another
 * application's file, or no file, is `not_found` — the caller cannot tell the
 * two apart, so no file id becomes an oracle for whose it is.
 */
export async function classifyApplicationFileDeleteRefusal(
  fileId: string,
  appId: string,
): Promise<'not_found' | 'in_use'> {
  const db = getDb();
  const [row] = await db
    .select({
      held: sql<boolean>`coalesce(${heldByOthers(db)}, false)`,
    })
    .from(files)
    .where(
      and(eq(files.id, fileId), eq(files.ownerApplicationId, appId), ne(files.status, 'deleted')),
    )
    .limit(1);
  return row?.held ? 'in_use' : 'not_found';
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
 * Lock one file row for a change to its reference set. `FOR NO KEY UPDATE`:
 * it serialises every reference write on the file — so two removals of its
 * last two references cannot each read the other's as still there and both
 * leave `unreferenced_since` unset — while the reference insert's own foreign
 * key check (`FOR KEY SHARE`) is still compatible with it.
 */
async function lockFilesForReferences(
  tx: Transaction,
  fileIds: readonly string[],
): Promise<Map<string, { status: FileRecord['status'] }>> {
  if (fileIds.length === 0) return new Map();
  // Sorted, so two batches over overlapping files lock in one order.
  const rows = await tx
    .select({ id: files.id, status: files.status })
    .from(files)
    .where(inArray(files.id, [...new Set(fileIds)].sort()))
    .orderBy(asc(files.id))
    .for('no key update');
  return new Map(rows.map((row) => [row.id, { status: row.status }]));
}

/**
 * The reference set of these files changed: stamp `unreferenced_since` on each
 * that no reference names any more (keeping an earlier stamp), and clear it on
 * each that one does. Runs under {@link lockFilesForReferences}, in the
 * transaction that changed the set.
 */
async function refreshUnreferencedSince(
  tx: DatabaseOrTransaction,
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const ids = [...new Set(fileIds)];
  const referenced = exists(
    tx.select({ one: sql`1` }).from(fileReferences).where(eq(fileReferences.fileId, files.id)),
  );
  await tx
    .update(files)
    .set({ unreferencedSince: sql`now()` })
    .where(and(inArray(files.id, ids), isNull(files.unreferencedSince), not(referenced)));
  await tx
    .update(files)
    .set({ unreferencedSince: null })
    .where(and(inArray(files.id, ids), isNotNull(files.unreferencedSince), referenced));
}

/** What adding references did. */
export interface AddedFileReferences {
  /** Reference rows created (a pair that already existed is not one). */
  created: number;
  /** Files that gained a reference. */
  createdFileIds: string[];
  /** Files a new reference brought back from `trash` to `active`. */
  restoredFileIds: string[];
}

/**
 * Record that applications use these assets (ADR 0041 D4), in ONE
 * transaction, maintaining `unreferenced_since` with them.
 *
 * `(file_id, application_id, entity_type, entity_id)` is UNIQUE, so a duplicate
 * is refused by the database rather than by a read-then-write that two
 * concurrent requests can both pass. A file that gains a reference while in
 * `trash` comes back to `active` — a use is a reason to keep it — and a
 * `deleted` file gains nothing. AUTHORIZATION IS THE CALLER'S
 * (`fileReference.service.ts`).
 */
export async function addFileReferences(
  references: readonly (NewFileReference & { fileId: string })[],
  db: DatabaseOrTransaction = getDb(),
): Promise<AddedFileReferences> {
  if (references.length === 0) return { created: 0, createdFileIds: [], restoredFileIds: [] };
  if (db === getDb()) return getDb().transaction((tx) => addFileReferences(references, tx));
  const tx = db as Transaction;

  // Applications first, then files: the order an application's deletion
  // locks them in (D8), so the two can never deadlock.
  const liveApplications = await liveApplicationIds(
    tx,
    references.map((reference) => reference.applicationId),
  );
  const locked = await lockFilesForReferences(
    tx,
    references.map((reference) => reference.fileId),
  );
  const writable = references.filter((reference) => {
    const status = locked.get(reference.fileId)?.status;
    return (
      status !== undefined && status !== 'deleted' && liveApplications.has(reference.applicationId)
    );
  });
  if (writable.length === 0) return { created: 0, createdFileIds: [], restoredFileIds: [] };

  const inserted = await tx
    .insert(fileReferences)
    .values(writable.map((reference) => ({ ...reference })))
    .onConflictDoNothing({
      target: [
        fileReferences.fileId,
        fileReferences.applicationId,
        fileReferences.entityType,
        fileReferences.entityId,
      ],
    })
    .returning({ fileId: fileReferences.fileId });
  const createdFileIds = [...new Set(inserted.map((row) => row.fileId))];
  if (createdFileIds.length === 0) return { created: 0, createdFileIds, restoredFileIds: [] };

  const restored = await tx
    .update(files)
    .set({ status: 'active', trashedAt: null })
    .where(and(inArray(files.id, createdFileIds), eq(files.status, 'trash')))
    .returning({ id: files.id });
  await refreshUnreferencedSince(tx, createdFileIds);
  await recordFileEvents(
    tx,
    'file.restored',
    restored.map((row) => row.id),
  );
  return {
    created: inserted.length,
    createdFileIds,
    restoredFileIds: restored.map((row) => row.id),
  };
}

/**
 * Record that an application uses this asset — {@link addFileReferences} for
 * one. Returns whether a row was actually created, and whether that brought the
 * file back from `trash`.
 */
export async function insertFileReference(
  fileId: string,
  values: NewFileReference,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ created: boolean; restored: boolean }> {
  const result = await addFileReferences([{ ...values, fileId }], db);
  return {
    created: result.createdFileIds.length > 0,
    restored: result.restoredFileIds.length > 0,
  };
}

/**
 * Drop one use of this asset. Returns whether a row was removed.
 *
 * `createdByUserIds`, when given, narrows the delete to a reference one of
 * those people created — how a session that does not own the file removes
 * only what it made itself.
 *
 * NEVER changes the file's status, on any path (ADR 0041 D5): the last
 * reference going only stamps `unreferenced_since`. An account's file is then
 * shown "not in use" to its person; an application's is collected later by
 * `fileLifecycle.worker.ts`.
 */
export async function deleteFileReference(
  fileId: string,
  key: FileReferenceKey,
  createdByUserIds?: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  if (db === getDb()) {
    return getDb().transaction((tx) => deleteFileReference(fileId, key, createdByUserIds, tx));
  }
  const tx = db as Transaction;
  await lockFilesForReferences(tx, [fileId]);
  const removed = await tx
    .delete(fileReferences)
    .where(
      and(
        eq(fileReferences.fileId, fileId),
        eq(fileReferences.applicationId, key.applicationId),
        eq(fileReferences.entityType, key.entityType),
        eq(fileReferences.entityId, key.entityId),
        createdByUserIds === undefined
          ? undefined
          : inArray(fileReferences.createdByUserId, [...createdByUserIds]),
      ),
    )
    .returning({ id: fileReferences.id });
  if (removed.length > 0) await refreshUnreferencedSince(tx, [fileId]);
  return removed.length > 0;
}

/**
 * Drop references by id, in ONE transaction, stamping `unreferenced_since` on
 * every file left with none — reconciliation's removal of stale references
 * (ADR 0041 D6). Never changes a file's status. Returns the ids removed.
 */
export async function deleteFileReferencesByIds(
  referenceIds: readonly string[],
): Promise<string[]> {
  if (referenceIds.length === 0) return [];
  return getDb().transaction(async (tx) => {
    const targets = await tx
      .select({ id: fileReferences.id, fileId: fileReferences.fileId })
      .from(fileReferences)
      .where(inArray(fileReferences.id, [...referenceIds]));
    const fileIds = targets.map((row) => row.fileId);
    await lockFilesForReferences(tx, fileIds);
    const removed = await tx
      .delete(fileReferences)
      .where(
        inArray(
          fileReferences.id,
          targets.map((row) => row.id),
        ),
      )
      .returning({ id: fileReferences.id, fileId: fileReferences.fileId });
    await refreshUnreferencedSince(
      tx,
      removed.map((row) => row.fileId),
    );
    return removed.map((row) => row.id);
  });
}

/**
 * Bring a trashed file back to `active` (the owner's restore, an uploader's
 * re-upload). `restartUnreferencedClock` restarts an UNREFERENCED file's
 * collection clock at now, as a fresh upload would (an application's re-upload
 * of a file the sweep trashed); otherwise `unreferenced_since` is left as it
 * is. `null` when the file is not in trash.
 */
export async function reactivateTrashedFile(
  fileId: string,
  options: { restartUnreferencedClock?: boolean } = {},
): Promise<FileRecord | null> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .update(files)
      .set({
        status: 'active',
        trashedAt: null,
        ...(options.restartUnreferencedClock
          ? {
              unreferencedSince: sql`case when ${files.unreferencedSince} is null then null else now() end`,
            }
          : {}),
      })
      .where(and(eq(files.id, fileId), eq(files.status, 'trash')))
      .returning();
    const [record] = await withChildren(rows, tx);
    if (record) await recordFileEvents(tx, 'file.restored', [record.id]);
    return record ?? null;
  });
}

/**
 * The owner moves an account's ACTIVE file to trash (`POST /assets/:id/trash`,
 * ADR 0041 D5): no longer served, kept until the owner restores or deletes it —
 * an account's trash never expires. One conditional write on the owner and the
 * status, with `file.trashed` queued for every application using the file in
 * the same transaction (D9). `null` when it is not that account's active file.
 */
export async function trashAccountFile(
  fileId: string,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<FileRecord | null> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .update(files)
      .set({ status: 'trash', trashedAt: now })
      .where(
        and(eq(files.id, fileId), eq(files.ownerUserId, ownerUserId), eq(files.status, 'active')),
      )
      .returning();
    const [record] = await withChildren(rows, tx);
    if (record) await recordFileEvents(tx, 'file.trashed', [record.id], { occurredAt: now });
    return record ?? null;
  });
}

// ---------------------------------------------------------------------------
// An application's deletion (ADR 0041 D8)
// ---------------------------------------------------------------------------

/** Rows per statement when an application's whole footprint goes. */
const APPLICATION_DELETION_CHUNK = 500;

/**
 * Remove EVERY reference `applicationId` holds, inside the deletion's
 * transaction, stamping `unreferenced_since` on each file left with none (an
 * account's file becomes *not in use* for its owner; nothing is trashed).
 * Returns how many references went.
 */
export async function deleteApplicationReferences(
  tx: Transaction,
  applicationId: string,
): Promise<number> {
  const used = await tx
    .selectDistinct({ fileId: fileReferences.fileId })
    .from(fileReferences)
    .where(eq(fileReferences.applicationId, applicationId));
  let removed = 0;
  const fileIds = used.map((row) => row.fileId);
  for (let start = 0; start < fileIds.length; start += APPLICATION_DELETION_CHUNK) {
    const part = fileIds.slice(start, start + APPLICATION_DELETION_CHUNK);
    await lockFilesForReferences(tx, part);
    const rows = await tx
      .delete(fileReferences)
      .where(
        and(eq(fileReferences.applicationId, applicationId), inArray(fileReferences.fileId, part)),
      )
      .returning({ id: fileReferences.id });
    removed += rows.length;
    await refreshUnreferencedSince(tx, part);
  }
  return removed;
}

/**
 * Tombstone EVERY live file `applicationId` owns, inside the deletion's
 * transaction — no trash, no 30 days: the developer asked for deletion. Unlike
 * a single delete, a file somebody else still holds is tombstoned too; the
 * holders are told (`file.deleted`, D9). Returns the tombstoned rows with their
 * children, for the storage they are owed.
 */
export async function tombstoneApplicationFiles(
  tx: Transaction,
  applicationId: string,
): Promise<FileRecord[]> {
  const live = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.ownerApplicationId, applicationId), ne(files.status, 'deleted')))
    .orderBy(asc(files.id));
  const tombstoned: FileRecord[] = [];
  for (let start = 0; start < live.length; start += APPLICATION_DELETION_CHUNK) {
    const part = live.slice(start, start + APPLICATION_DELETION_CHUNK).map((row) => row.id);
    const rows = await tx
      .update(files)
      .set({ status: 'deleted' })
      .where(and(inArray(files.id, part), ne(files.status, 'deleted')))
      .returning();
    tombstoned.push(...(await withChildren(rows, tx)));
  }
  return tombstoned;
}

/**
 * Move references between files and keep both files' `unreferenced_since`
 * right — the owner split's repoint (`fileOwnerSplit.service.ts`), inside its
 * transaction, after it moved the rows.
 */
export async function refreshUnreferencedSinceAfterMove(
  tx: Transaction,
  fileIds: readonly string[],
): Promise<void> {
  await lockFilesForReferences(tx, fileIds);
  await refreshUnreferencedSince(tx, fileIds);
}

// ---------------------------------------------------------------------------
// The lifecycle sweep (ADR 0041 D5, `fileLifecycle.worker.ts`)
// ---------------------------------------------------------------------------

/**
 * Nothing on the platform holds this file: no reference at all (the owner's
 * own included — an application's own reference is exactly what keeps its
 * file), no mail attachment, no store listing screenshot. The sweep re-checks
 * it in every conditional write, so `unreferenced_since` is only ever a hint.
 */
function heldByNothing(db: DatabaseOrTransaction) {
  return and(
    notExists(
      db.select({ one: sql`1` }).from(fileReferences).where(eq(fileReferences.fileId, files.id)),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(messageAttachments)
        .where(eq(messageAttachments.fileId, files.id)),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(appListingScreenshots)
        .where(eq(appListingScreenshots.fileId, files.id)),
    ),
  );
}

/** The steps of the sweep, each a predicate over `files` at one instant. */
export type FileLifecycleStep =
  | 'trash'
  | 'purge'
  | 'purgeBlocked'
  | 'staleUploads'
  | 'unpublishTrashed';

/** Collection windows (ADR 0041 D5). */
export const APPLICATION_FILE_UNREFERENCED_GRACE_MS = 24 * 60 * 60 * 1000;
export const APPLICATION_FILE_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const STALE_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The condition of one step at `now`. Platform namespaces (`system_owner`)
 * match no step: their own services keep their rules.
 *
 *  - `trash`: an APPLICATION's active file unreferenced for 24 hours.
 *  - `purge`: an APPLICATION's file in trash for 30 days.
 *  - `purgeBlocked`: an APPLICATION's file BLOCKED by a takedown (ADR 0041
 *    D10) that nothing has used for 30 days and that no open claim holds as
 *    evidence any more (the claim was upheld). It is never trashed — a
 *    restore from trash would serve it — but tombstoned and purged directly.
 *    While a claim is open it is evidence, and an account's blocked file is
 *    its person's to delete, so neither is collected.
 *  - `staleUploads`: an ACCOUNT's upload `POST /assets/init` created and
 *    `/complete` never named (no name, no metadata), 24 hours old. Whether it
 *    holds an object is the store's answer, asked per file.
 *  - `unpublishTrashed`: a public file of any owner in trash or blocked whose
 *    original or a rendition is still at a CDN-reachable `public/` key (it
 *    left `active` before leaving took it off the CDN, or that move failed).
 */
export function fileLifecyclePredicate(
  step: FileLifecycleStep,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
) {
  switch (step) {
    case 'trash':
      return and(
        isNotNull(files.ownerApplicationId),
        eq(files.status, 'active'),
        isNotNull(files.unreferencedSince),
        lte(
          files.unreferencedSince,
          new Date(now.getTime() - APPLICATION_FILE_UNREFERENCED_GRACE_MS),
        ),
        heldByNothing(db),
      );
    case 'purge':
      return and(
        isNotNull(files.ownerApplicationId),
        eq(files.status, 'trash'),
        isNotNull(files.trashedAt),
        lte(files.trashedAt, new Date(now.getTime() - APPLICATION_FILE_TRASH_RETENTION_MS)),
        heldByNothing(db),
      );
    case 'purgeBlocked':
      return and(
        isNotNull(files.ownerApplicationId),
        eq(files.status, 'blocked'),
        isNotNull(files.unreferencedSince),
        lte(files.unreferencedSince, new Date(now.getTime() - APPLICATION_FILE_TRASH_RETENTION_MS)),
        heldByNothing(db),
        sql`not ${heldAsEvidence(qualified(files.sha256))}`,
      );
    case 'staleUploads':
      return and(
        eq(files.status, 'active'),
        isNotNull(files.ownerUserId),
        isNull(files.originalName),
        isNull(files.metadata),
        lte(files.createdAt, new Date(now.getTime() - STALE_UPLOAD_AGE_MS)),
        heldByNothing(db),
      );
    case 'unpublishTrashed':
      return and(
        inArray(files.status, ['trash', 'blocked']),
        eq(files.visibility, 'public'),
        or(
          sql`starts_with(${files.storageKey}, 'public/')`,
          exists(
            db
              .select({ one: sql`1` })
              .from(fileVariants)
              .where(
                and(
                  eq(fileVariants.fileId, files.id),
                  sql`starts_with(${fileVariants.key}, 'public/')`,
                ),
              ),
          ),
        ),
      );
  }
}

/** The column each step's clock reads, for ordering and for reports. */
function lifecycleClock(step: FileLifecycleStep) {
  switch (step) {
    case 'trash':
      return files.unreferencedSince;
    case 'purge':
      return files.trashedAt;
    case 'purgeBlocked':
      return files.unreferencedSince;
    case 'staleUploads':
      return files.createdAt;
    case 'unpublishTrashed':
      return files.updatedAt;
  }
}

/** One file a step is due to act on. */
export interface FileLifecycleCandidate {
  id: string;
  ownerApplicationId: string | null;
  ownerUserId: string | null;
  size: number;
  since: Date | null;
}

/** How many files a step is due to act on at `now`. */
export async function countFileLifecycleCandidates(
  step: FileLifecycleStep,
  now: Date,
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: count() })
    .from(files)
    .where(fileLifecyclePredicate(step, now, db));
  return row?.total ?? 0;
}

/** Up to `limit` of them, longest-waiting first. */
export async function listFileLifecycleCandidates(
  step: FileLifecycleStep,
  now: Date,
  limit: number,
): Promise<FileLifecycleCandidate[]> {
  const db = getDb();
  const clock = lifecycleClock(step);
  return db
    .select({
      id: files.id,
      ownerApplicationId: files.ownerApplicationId,
      ownerUserId: files.ownerUserId,
      size: files.size,
      since: clock,
    })
    .from(files)
    .where(fileLifecyclePredicate(step, now, db))
    .orderBy(asc(clock), asc(files.id))
    .limit(limit);
}

/**
 * Move ONE application file to trash if — at this statement — it still meets
 * the `trash` condition: the authorization and the action are one conditional
 * write, so a reference added after the candidate was listed keeps the file.
 */
export async function trashUnreferencedApplicationFile(
  fileId: string,
  now: Date,
): Promise<FileRecord | null> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .update(files)
      .set({ status: 'trash', trashedAt: now })
      .where(and(eq(files.id, fileId), fileLifecyclePredicate('trash', now, tx)))
      .returning();
    const [record] = await withChildren(rows, tx);
    // Unreferenced by definition: only the owning application is told (D9).
    if (record) await recordFileEvents(tx, 'file.trashed', [record.id], { occurredAt: now });
    return record ?? null;
  });
}

/**
 * Tombstone ONE file if it still meets `step`'s condition at this statement —
 * the conditional half of the purge and the stale-upload sweep, run inside
 * `assetService.tombstoneAndOwePurge`'s transaction.
 */
export async function tombstoneFileIfDue(
  tx: Transaction,
  fileId: string,
  step: 'purge' | 'purgeBlocked' | 'staleUploads',
  now: Date,
): Promise<FileRecord | null> {
  const rows = await tx
    .update(files)
    .set({ status: 'deleted' })
    .where(and(eq(files.id, fileId), fileLifecyclePredicate(step, now, tx)))
    .returning();
  const [record] = await withChildren(rows, tx);
  return record ?? null;
}

/**
 * Write a batch of renditions for a file, optionally alongside its `metadata`,
 * in ONE transaction — replacing any existing row of the SAME `type` and
 * leaving rows of every other type untouched.
 *
 * The transaction keeps variants and metadata indivisible.
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
  patch?: FilePatch,
): Promise<FileVariantRecord[]> {
  return getDb().transaction(async (tx) => {
    const old = await readMeteredOwner(tx, fileId);
    return withStorageQuota(tx, await quotaAccountsFor(tx, old, patch), async () => {
      await assertStableFileOwner(tx, fileId, old);
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
  variant: NewFileVariant,
): Promise<FileVariantRecord> {
  return getDb().transaction(async (tx) => {
    const old = await readMeteredOwner(tx, fileId);
    return withStorageQuota(tx, await quotaAccountsFor(tx, old), async () => {
      await assertStableFileOwner(tx, fileId, old);
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
      and(eq(fileVariants.fileId, fileId), eq(fileVariants.type, type), eq(fileVariants.key, key)),
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
