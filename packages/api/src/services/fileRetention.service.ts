/**
 * The file retention pass: what the shared database keeps for files that no
 * longer need it, removed in small, resumable, off-peak batches.
 *
 * It slows the growth of `file_variants` (17.2 GiB, 34.4M rows on 2026-11-28),
 * `file_sources` and `files` on the shared production Postgres. It runs only
 * when an operator runs it (`scripts/file-retention.ts`, in production the
 * `file-retention.yml` ECS one-shot); deleting production data is the app
 * owner's decision, so nothing here is scheduled.
 *
 * | Step | Condition (re-checked in the write) | Apply |
 * |---|---|---|
 * | `tombstoneRenditions` | a TOMBSTONED file (`status = 'deleted'`) that still has `file_variants` or `file_sources` rows, and whose bytes no open content claim holds | delete those rows; the variant directories are first made sure to be owed a delete in `storage_object_deletions` |
 * | `unusedRenditions` | an ACTIVE image of an account or an application, unreferenced for `unusedDays` (30) and held by nothing, with more than one ladder rendition in one variant directory | delete every ladder rendition ROW but one per directory (`thumb` first); the objects stay |
 * | `federationCacheExpiry` (opt-in) | a `__federation_media_cache__` entry cached more than `cacheTtlDays` (90) ago that nothing holds | tombstone and purge it, as its eviction route does |
 *
 * ## What it never touches
 *
 * - An account's file, or an application's. ADR 0043 D5: an account's unused
 *   file is its person's to delete; an application's is collected by the
 *   lifecycle sweep (`fileLifecycle.worker.ts`, `FILE_LIFECYCLE_MODE`). The
 *   only thing `unusedRenditions` removes from them is derived: rendition rows
 *   that `assetService.ensureVariant` renders again on the first read. The
 *   original, its name, its references and its storage objects stay.
 * - Anything referenced: `file_references`, a mail attachment, a store
 *   screenshot (`heldByNothing`, the lifecycle's own definition).
 * - Bytes an open content claim holds as evidence (`heldAsEvidence`), whatever
 *   the step.
 * - Videos, audio and documents: their renditions are made by the upload
 *   pipeline only and never on demand, so they are not renditions to drop.
 * - The platform namespaces other than the media cache (federation avatars,
 *   stickers).
 *
 * ## Why `unusedRenditions` keeps one row and every object
 *
 * Storage is content-addressed and shared: a rendition's object
 * (`variants/<y>/<m>/<pp>/<sha256>/<type>.webp`) may be another owner's too,
 * and a public one may be linked directly from the CDN. Deleting only rows
 * breaks no link and no twin. The one row kept per directory is what a later
 * delete of the file records as owed (`storageTargetsForAsset` deletes a
 * variant directory as a prefix), so no object is ever orphaned. The bytes in
 * object storage are not what this pass is for; the rows are.
 *
 * ## Batches, resumability, the database's health
 *
 * The pass walks `files` by primary key in WINDOWS of `scanWindow` ids
 * (`id > after order by id limit n`, the primary key index), so each batch
 * reads a bounded slice of the table whatever a step's selectivity, and
 * evaluates every selected step on that window. `lastFileId` of a summary or
 * progress line resumes it (`after`). Every step is idempotent: a file it has
 * handled no longer matches, so a re-run, a resumed run or two runs at once
 * converge on the same state.
 *
 * It stops by itself when the off-peak window (01:00–07:00 UTC by default)
 * closes, and backs off when the database is slow: a batch slower than
 * `slowBatchMs` halves the window and pauses (longer each time), and
 * `maxSlowBatches` slow batches in a row end the run (`databaseSlow`).
 *
 * ## What a delete gives back
 *
 * A DELETE frees space INSIDE the tables for reuse once vacuumed (autovacuum
 * does it), so the tables stop growing until the freed space is used again; it
 * does not shrink the RDS volume. Only `VACUUM FULL` or `pg_repack` return
 * space to the filesystem, and RDS storage never shrinks anyway.
 */

import { and, asc, eq, exists, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { qualified } from '@oxy.so/db';
import { IMAGE_VARIANTS } from '@oxy.so/utils/image';
import { stripPublicPrefix } from '../config/cdn';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { files, fileSources, fileVariants, storageObjectDeletions } from '../db/schema';
import fileCache from '../utils/fileCache';
import { logger } from '../utils/logger';
import { assetAccountId, storageTargetsForAsset } from './accountStorageDeletion.service';
import { assetService } from './assetServiceSingleton';
import { heldAsEvidence } from './contentClaims/contentBlocklist';
import { federationCacheExpiryPredicate, heldByNothing } from './fileRepository';

import {
  DEFAULT_CACHE_TTL_DAYS,
  DEFAULT_FILE_RETENTION_STEPS,
  DEFAULT_MAX_SLOW_BATCHES,
  DEFAULT_OFF_PEAK_WINDOW,
  DEFAULT_PAUSE_MS,
  DEFAULT_SCAN_WINDOW,
  DEFAULT_SLOW_BATCH_MS,
  DEFAULT_UNUSED_DAYS,
  FILE_RETENTION_CONFIRMATION,
  FILE_RETENTION_STEPS,
  type FileRetentionStep,
  isInOffPeakWindow,
  MIN_CACHE_TTL_DAYS,
  MIN_SCAN_WINDOW,
  MIN_UNUSED_DAYS,
  type OffPeakWindow,
} from './fileRetention.options';

export * from './fileRetention.options';

/** Run order within one window: an expired cache entry's rows go in the same pass. */
const STEP_ORDER: readonly FileRetentionStep[] = FILE_RETENTION_STEPS;
const SLOW_PAUSE_BASE_MS = 15_000;
const SLOW_PAUSE_MAX_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The image ladder: the renditions `ensureImageVariant` renders again on demand. */
export const REGENERABLE_IMAGE_VARIANT_TYPES: readonly string[] = Object.keys(IMAGE_VARIANTS);

/** A variant row's directory (`variants/<y>/<m>/<pp>/<sha256>/`), either spelling; NULL for any other key shape. */
const variantRoot = sql`substring(regexp_replace(${fileVariants.key}, '^public/', '') from '^(variants/[0-9]{4}/[0-9]{2}/[0-9a-f]{2}/[0-9a-f]{64}/)')`;

export interface FileRetentionStepTotals {
  /** Files the step selected (would act on, or acted on). */
  files: number;
  /** `file_variants` rows deleted (would be). */
  variantRows: number;
  /** The rendition bytes those rows describe (their objects stay, except a cache entry's). */
  variantBytes: number;
  /** `file_sources` rows deleted (would be). */
  sourceRows: number;
  /** Original bytes of the files expired (`federationCacheExpiry`): object storage, not the database. */
  originalBytes: number;
  /** Files whose conditional write found them changed. */
  skipped: number;
  /** Batches (or, for the cache expiry, files) whose write threw; the next run retries them. */
  failed: number;
}

export type FileRetentionStopReason =
  | 'complete'
  | 'maxBatches'
  | 'outsideOffPeakWindow'
  | 'databaseSlow';

export interface FileRetentionSummary {
  apply: boolean;
  steps: FileRetentionStep[];
  cutoffs: { unusedRenditions: string; federationCacheExpiry: string };
  batches: number;
  /** `files` rows examined. */
  scanned: number;
  /** Resume after this id (`after`); null when nothing was scanned. */
  lastFileId: string | null;
  stoppedBecause: FileRetentionStopReason;
  totals: Record<FileRetentionStep, FileRetentionStepTotals>;
  /**
   * Database bytes the rows above occupy, estimated from each table's
   * `pg_total_relation_size / reltuples` (heap, indexes and TOAST together),
   * so an approximation: space freed for reuse, not returned to the volume.
   * A cache entry's rows count here only when `tombstoneRenditions` runs with
   * it (that step is what removes a tombstone's rows).
   */
  estimate: {
    variantRowBytes: number | null;
    sourceRowBytes: number | null;
    databaseBytes: number | null;
  };
}

/** One file a step selected, for the per-file log. */
export interface FileRetentionRecord {
  step: FileRetentionStep;
  fileId: string;
  variantRows: number;
  variantBytes: number;
  sourceRows: number;
  originalBytes?: number;
  outcome: 'due' | 'done' | 'skipped' | 'failed';
}

/** What the cache expiry acts through (a seam for tests). */
export interface FileRetentionActions {
  expireFederationCacheEntry(fileId: string, cutoff: Date): Promise<boolean>;
}

export interface FileRetentionOptions {
  apply: boolean;
  /** Required with `apply`: exactly {@link FILE_RETENTION_CONFIRMATION}. */
  confirm?: string;
  steps?: readonly FileRetentionStep[];
  unusedDays?: number;
  cacheTtlDays?: number;
  scanWindow?: number;
  after?: string;
  maxBatches?: number;
  /** `null` runs at any hour. */
  offPeakWindow?: OffPeakWindow | null;
  pauseMs?: number;
  slowBatchMs?: number;
  maxSlowBatches?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  actions?: FileRetentionActions;
  emit?: (record: FileRetentionRecord) => void;
  progress?: (summary: FileRetentionSummary) => void;
}

function emptyTotals(): FileRetentionStepTotals {
  return {
    files: 0,
    variantRows: 0,
    variantBytes: 0,
    sourceRows: 0,
    originalBytes: 0,
    skipped: 0,
    failed: 0,
  };
}

// Correlated subqueries in a select list: every column is written out with its
// table (`qualified`), since a single-table select renders columns bare and a
// bare `"id"` would resolve to the subquery's own table.
const variantCountOf = sql<number>`(select count(*)::int from ${fileVariants} where ${qualified(fileVariants.fileId)} = ${qualified(files.id)})`;
const variantBytesOf = sql<string>`(select coalesce(sum(${qualified(fileVariants.size)}), 0)::bigint from ${fileVariants} where ${qualified(fileVariants.fileId)} = ${qualified(files.id)})`;
const sourceCountOf = sql<number>`(select count(*)::int from ${fileSources} where ${qualified(fileSources.fileId)} = ${qualified(files.id)})`;

/** A tombstone that still carries rows, whose bytes no open claim holds. */
export function tombstoneRenditionsPredicate(db: DatabaseOrTransaction) {
  return and(
    eq(files.status, 'deleted'),
    sql`not ${heldAsEvidence(qualified(files.sha256))}`,
    or(
      exists(
        db.select({ one: sql`1` }).from(fileVariants).where(eq(fileVariants.fileId, files.id)),
      ),
      exists(db.select({ one: sql`1` }).from(fileSources).where(eq(fileSources.fileId, files.id))),
    ),
  );
}

/** An active image of an account or an application nobody has used since `cutoff`. */
export function unusedRenditionsPredicate(cutoff: Date, db: DatabaseOrTransaction) {
  return and(
    eq(files.status, 'active'),
    or(isNotNull(files.ownerUserId), isNotNull(files.ownerApplicationId)),
    sql`starts_with(${files.mime}, 'image/')`,
    isNotNull(files.unreferencedSince),
    lte(files.unreferencedSince, cutoff),
    heldByNothing(db),
    sql`not ${heldAsEvidence(qualified(files.sha256))}`,
    exists(
      db
        .select({ one: sql`1` })
        .from(fileVariants)
        .where(
          and(
            eq(fileVariants.fileId, files.id),
            inArray(fileVariants.type, [...REGENERABLE_IMAGE_VARIANT_TYPES]),
          ),
        ),
    ),
  );
}

/**
 * The ladder rows of `fileIds` beyond the first per (file, directory): `thumb`
 * is the one kept where there is one, otherwise the oldest id. A row whose key
 * has no directory shape is never chosen (it would be the only record of it).
 */
async function redundantLadderRows(
  db: DatabaseOrTransaction,
  fileIds: readonly string[],
): Promise<Array<{ id: string; fileId: string; size: number }>> {
  if (fileIds.length === 0) return [];
  const ranked = db
    .select({
      id: fileVariants.id,
      fileId: fileVariants.fileId,
      size: sql<string>`coalesce(${fileVariants.size}, 0)`.as('size'),
      rank: sql<number>`row_number() over (partition by ${fileVariants.fileId}, ${variantRoot} order by (${fileVariants.type} = 'thumb') desc, ${fileVariants.id})`.as(
        'rank',
      ),
    })
    .from(fileVariants)
    .where(
      and(
        inArray(fileVariants.fileId, [...fileIds]),
        inArray(fileVariants.type, [...REGENERABLE_IMAGE_VARIANT_TYPES]),
        sql`${variantRoot} is not null`,
      ),
    )
    .as('ranked');
  const rows = await db
    .select({ id: ranked.id, fileId: ranked.fileId, size: ranked.size })
    .from(ranked)
    .where(sql`${ranked.rank} > 1`);
  return rows.map((row) => ({ id: row.id, fileId: row.fileId, size: Number(row.size) }));
}

/** Average bytes per row of a table (heap + indexes + TOAST), or null when unknown. */
async function averageRowBytes(table: 'file_variants' | 'file_sources'): Promise<number | null> {
  const [row] = await getDb().execute<{ tuples: number | string; bytes: number | string }>(
    sql`select c.reltuples::float8 as tuples, pg_total_relation_size(c.oid)::float8 as bytes
        from pg_class c where c.oid = to_regclass(${table})`,
  );
  const tuples = Number(row?.tuples ?? 0);
  const bytes = Number(row?.bytes ?? 0);
  return tuples > 0 && bytes > 0 ? bytes / tuples : null;
}

function addRecord(totals: FileRetentionStepTotals, record: FileRetentionRecord): void {
  totals.files += 1;
  totals.variantRows += record.variantRows;
  totals.variantBytes += record.variantBytes;
  totals.sourceRows += record.sourceRows;
  totals.originalBytes += record.originalBytes ?? 0;
}

/** `tombstoneRenditions` on one window. */
async function tombstoneRenditionsBatch(
  ids: readonly string[],
  apply: boolean,
): Promise<FileRetentionRecord[]> {
  const db = getDb();
  const select = (tx: DatabaseOrTransaction) =>
    tx
      .select({
        id: files.id,
        sha256: files.sha256,
        storageKey: files.storageKey,
        metadata: files.metadata,
        ownerUserId: files.ownerUserId,
        systemOwner: files.systemOwner,
        ownerApplicationId: files.ownerApplicationId,
        variantRows: variantCountOf,
        variantBytes: variantBytesOf,
        sourceRows: sourceCountOf,
      })
      .from(files)
      .where(and(inArray(files.id, [...ids]), tombstoneRenditionsPredicate(tx)))
      .orderBy(asc(files.id));
  const toRecord = (
    row: Awaited<ReturnType<typeof select>>[number],
    outcome: FileRetentionRecord['outcome'],
  ): FileRetentionRecord => ({
    step: 'tombstoneRenditions',
    fileId: row.id,
    variantRows: Number(row.variantRows),
    variantBytes: Number(row.variantBytes),
    sourceRows: Number(row.sourceRows),
    outcome,
  });

  if (!apply) return (await select(db)).map((row) => toRecord(row, 'due'));

  return db.transaction(async (tx) => {
    // Re-read under a row lock: what is deleted is what qualifies NOW.
    const due = await select(tx).for('no key update', { of: files });
    if (due.length === 0) return [];
    const dueIds = due.map((row) => row.id);
    const keys = await tx
      .select({ fileId: fileVariants.fileId, key: fileVariants.key })
      .from(fileVariants)
      .where(inArray(fileVariants.fileId, dueIds));
    const keysByFile = new Map<string, string[]>();
    for (const { fileId, key } of keys) {
      const list = keysByFile.get(fileId) ?? [];
      list.push(key);
      keysByFile.set(fileId, list);
    }
    // These rows may be the only record of where the renditions are: make sure
    // each directory is owed a delete before they go. A target already in the
    // ledger (the tombstone's own, normally) is left as it is — never re-armed.
    const owed = due.flatMap((row) => {
      const original = stripPublicPrefix(row.storageKey);
      return storageTargetsForAsset(row, keysByFile.get(row.id) ?? [])
        .filter((target) => !(target.kind === 'object' && target.target === original))
        .map((target) => ({
          reason: 'file.deleted' as const,
          accountId: assetAccountId(row),
          ...target,
        }));
    });
    if (owed.length > 0) {
      await tx
        .insert(storageObjectDeletions)
        .values(owed)
        .onConflictDoNothing({
          target: [
            storageObjectDeletions.accountId,
            storageObjectDeletions.kind,
            storageObjectDeletions.target,
          ],
        });
    }
    await tx.delete(fileVariants).where(inArray(fileVariants.fileId, dueIds));
    await tx.delete(fileSources).where(inArray(fileSources.fileId, dueIds));
    return due.map((row) => toRecord(row, 'done'));
  });
}

/** `unusedRenditions` on one window. */
async function unusedRenditionsBatch(
  ids: readonly string[],
  cutoff: Date,
  apply: boolean,
): Promise<FileRetentionRecord[]> {
  const db = getDb();
  const eligible = (tx: DatabaseOrTransaction) =>
    tx
      .select({ id: files.id })
      .from(files)
      .where(and(inArray(files.id, [...ids]), unusedRenditionsPredicate(cutoff, tx)))
      .orderBy(asc(files.id));
  const toRecords = (
    rows: Array<{ id: string; fileId: string; size: number }>,
    outcome: FileRetentionRecord['outcome'],
  ): FileRetentionRecord[] => {
    const byFile = new Map<string, FileRetentionRecord>();
    for (const row of rows) {
      const record = byFile.get(row.fileId) ?? {
        step: 'unusedRenditions' as const,
        fileId: row.fileId,
        variantRows: 0,
        variantBytes: 0,
        sourceRows: 0,
        outcome,
      };
      record.variantRows += 1;
      record.variantBytes += row.size;
      byFile.set(row.fileId, record);
    }
    return [...byFile.values()].sort((a, b) => (a.fileId < b.fileId ? -1 : 1));
  };

  if (!apply) {
    const fileIds = (await eligible(db)).map((row) => row.id);
    return toRecords(await redundantLadderRows(db, fileIds), 'due');
  }

  const records = await db.transaction(async (tx) => {
    // The file rows are locked as a reference write locks them
    // (`lockFilesForReferences`), so no reference lands in between.
    const fileIds = (await eligible(tx).for('no key update', { of: files })).map((row) => row.id);
    const doomed = await redundantLadderRows(tx, fileIds);
    if (doomed.length === 0) return [];
    await tx.delete(fileVariants).where(
      inArray(
        fileVariants.id,
        doomed.map((row) => row.id),
      ),
    );
    return toRecords(doomed, 'done');
  });
  // Committed: every API task drops its copy (the objects are still there, so
  // a stale copy would only ever serve a rendition that exists).
  if (records.length > 0) fileCache.invalidateMany(records.map((record) => record.fileId));
  return records;
}

/** `federationCacheExpiry` on one window. */
async function federationCacheExpiryBatch(
  ids: readonly string[],
  cutoff: Date,
  apply: boolean,
  actions: FileRetentionActions,
  includeDependentRows: boolean,
): Promise<FileRetentionRecord[]> {
  const db = getDb();
  const due = await db
    .select({
      id: files.id,
      size: files.size,
      variantRows: variantCountOf,
      variantBytes: variantBytesOf,
      sourceRows: sourceCountOf,
    })
    .from(files)
    .where(and(inArray(files.id, [...ids]), federationCacheExpiryPredicate(cutoff, db)))
    .orderBy(asc(files.id));
  const records: FileRetentionRecord[] = [];
  for (const row of due) {
    const record: FileRetentionRecord = {
      step: 'federationCacheExpiry',
      fileId: row.id,
      // Its rows are removed by `tombstoneRenditions` once it is a tombstone;
      // counted here only when that step runs with it.
      variantRows: includeDependentRows ? Number(row.variantRows) : 0,
      variantBytes: Number(row.variantBytes),
      sourceRows: includeDependentRows ? Number(row.sourceRows) : 0,
      originalBytes: Number(row.size),
      outcome: 'due',
    };
    if (apply) {
      try {
        record.outcome = (await actions.expireFederationCacheEntry(row.id, cutoff))
          ? 'done'
          : 'skipped';
      } catch (error) {
        record.outcome = 'failed';
        logger.warn('[FileRetention] Cache entry expiry failed; a later run retries it', {
          fileId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    records.push(record);
  }
  return records;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultActions: FileRetentionActions = {
  expireFederationCacheEntry: (fileId, cutoff) =>
    assetService.expireFederationCacheEntry(fileId, cutoff),
};

/**
 * Run the pass. Without `apply` it writes nothing and reports what an apply
 * would do, with the same selection. With `apply`, `confirm` must be
 * {@link FILE_RETENTION_CONFIRMATION}.
 */
export async function runFileRetention(
  options: FileRetentionOptions,
): Promise<FileRetentionSummary> {
  if (options.apply && options.confirm !== FILE_RETENTION_CONFIRMATION) {
    throw new Error(
      `Applying the file retention pass deletes production rows: confirm it with "${FILE_RETENTION_CONFIRMATION}"`,
    );
  }
  const steps = STEP_ORDER.filter((step) =>
    (options.steps ?? DEFAULT_FILE_RETENTION_STEPS).includes(step),
  );
  if (steps.length === 0) throw new Error('Select at least one retention step');
  const unusedDays = Math.max(options.unusedDays ?? DEFAULT_UNUSED_DAYS, MIN_UNUSED_DAYS);
  const cacheTtlDays = Math.max(options.cacheTtlDays ?? DEFAULT_CACHE_TTL_DAYS, MIN_CACHE_TTL_DAYS);
  // The operator script bounds the window to [MIN_SCAN_WINDOW, 10000]; the
  // service accepts any positive one (tests walk a handful of rows).
  const configuredWindow = Math.max(options.scanWindow ?? DEFAULT_SCAN_WINDOW, 1);
  const smallestWindow = Math.min(MIN_SCAN_WINDOW, configuredWindow);
  const offPeak =
    options.offPeakWindow === undefined ? DEFAULT_OFF_PEAK_WINDOW : options.offPeakWindow;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const slowBatchMs = options.slowBatchMs ?? DEFAULT_SLOW_BATCH_MS;
  const maxSlowBatches = options.maxSlowBatches ?? DEFAULT_MAX_SLOW_BATCHES;
  const clock = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const actions = options.actions ?? defaultActions;

  const start = clock();
  const unusedCutoff = new Date(start.getTime() - unusedDays * DAY_MS);
  const cacheCutoff = new Date(start.getTime() - cacheTtlDays * DAY_MS);
  const [variantRowBytes, sourceRowBytes] = await Promise.all([
    averageRowBytes('file_variants'),
    averageRowBytes('file_sources'),
  ]);

  const summary: FileRetentionSummary = {
    apply: options.apply,
    steps: [...steps],
    cutoffs: {
      unusedRenditions: unusedCutoff.toISOString(),
      federationCacheExpiry: cacheCutoff.toISOString(),
    },
    batches: 0,
    scanned: 0,
    lastFileId: options.after ?? null,
    stoppedBecause: 'complete',
    totals: Object.fromEntries(FILE_RETENTION_STEPS.map((step) => [step, emptyTotals()])) as Record<
      FileRetentionStep,
      FileRetentionStepTotals
    >,
    estimate: { variantRowBytes, sourceRowBytes, databaseBytes: null },
  };
  const refreshEstimate = () => {
    let rows = 0;
    let sources = 0;
    for (const step of steps) {
      rows += summary.totals[step].variantRows;
      sources += summary.totals[step].sourceRows;
    }
    summary.estimate.databaseBytes =
      variantRowBytes === null && sourceRowBytes === null
        ? null
        : Math.round(rows * (variantRowBytes ?? 0) + sources * (sourceRowBytes ?? 0));
  };

  let window = configuredWindow;
  let slowInARow = 0;
  const db = getDb();
  while (true) {
    if (options.maxBatches !== undefined && summary.batches >= options.maxBatches) {
      summary.stoppedBecause = 'maxBatches';
      break;
    }
    if (offPeak && !isInOffPeakWindow(clock(), offPeak)) {
      summary.stoppedBecause = 'outsideOffPeakWindow';
      break;
    }

    const began = Date.now();
    const after = summary.lastFileId;
    const ids = (
      await db
        .select({ id: files.id })
        .from(files)
        .where(after ? gt(files.id, after) : undefined)
        .orderBy(asc(files.id))
        .limit(window)
    ).map((row) => row.id);
    if (ids.length === 0) {
      summary.stoppedBecause = 'complete';
      break;
    }

    for (const step of steps) {
      let records: FileRetentionRecord[];
      try {
        switch (step) {
          case 'federationCacheExpiry':
            records = await federationCacheExpiryBatch(
              ids,
              cacheCutoff,
              options.apply,
              actions,
              steps.includes('tombstoneRenditions') && !options.apply,
            );
            break;
          case 'tombstoneRenditions':
            records = await tombstoneRenditionsBatch(ids, options.apply);
            break;
          case 'unusedRenditions':
            records = await unusedRenditionsBatch(ids, unusedCutoff, options.apply);
            break;
        }
      } catch (error) {
        // A batch transaction that threw changed nothing; the next run (or a
        // resume from an earlier `lastFileId`) retries the window.
        summary.totals[step].failed += 1;
        logger.warn('[FileRetention] Batch failed; a later run retries this window', {
          step,
          after: summary.lastFileId,
          error: error instanceof Error ? error.message : String(error),
        });
        options.emit?.({
          step,
          fileId: ids[0],
          variantRows: 0,
          variantBytes: 0,
          sourceRows: 0,
          outcome: 'failed',
        });
        continue;
      }
      for (const record of records) {
        const totals = summary.totals[step];
        if (record.outcome === 'skipped') totals.skipped += 1;
        else if (record.outcome === 'failed') totals.failed += 1;
        else addRecord(totals, record);
        options.emit?.(record);
      }
    }

    summary.batches += 1;
    summary.scanned += ids.length;
    summary.lastFileId = ids[ids.length - 1];
    refreshEstimate();
    options.progress?.(summary);

    const tookMs = Date.now() - began;
    if (tookMs > slowBatchMs) {
      slowInARow += 1;
      if (slowInARow >= maxSlowBatches) {
        summary.stoppedBecause = 'databaseSlow';
        break;
      }
      window = Math.max(Math.floor(window / 2), smallestWindow);
      await sleep(Math.min(SLOW_PAUSE_BASE_MS * 2 ** (slowInARow - 1), SLOW_PAUSE_MAX_MS));
    } else {
      slowInARow = 0;
      window = Math.min(window * 2, configuredWindow);
      if (pauseMs > 0) await sleep(pauseMs);
    }
  }
  refreshEstimate();
  return summary;
}
