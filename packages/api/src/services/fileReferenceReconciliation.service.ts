/**
 * Reconciliation of an application's references (ADR 0043 D6): the safety net
 * under per-write bookkeeping.
 *
 * An application sends its full inventory of ONE `entity_type` — `begin` →
 * paged `put` of `(file_id, entity_id)` → `commit` — and Oxy diffs it against
 * the `file_references` that application holds for that type:
 *
 * - **added**: a pair in the inventory with no reference, which the
 *   application may reference under exactly the rules of
 *   `POST /assets/service/references` (`mayApplicationReference`). A trashed
 *   file of its own comes back to `active`, as any new reference brings it.
 * - **refused**: such a pair it may NOT reference, or whose file does not
 *   exist — the two answer alike, as everywhere.
 * - **removed**: a reference with no pair in the inventory. Removing never
 *   trashes or deletes anything: an account's file becomes *not in use*, an
 *   application's gets `unreferenced_since` and the lifecycle sweep's 24 hours.
 * - **unchanged**: both.
 *
 * ## The race it must not lose
 *
 * The inventory is a snapshot taken while the application keeps running. A
 * reference it adds through the normal route AFTER `begin` describes an entity
 * the snapshot may not contain; removing it as stale would undo a correct
 * write. So only references created BEFORE the session began are ever removed.
 * (The opposite race — a reference removed after the snapshot listed it — is
 * re-added by the commit; the application's next reconciliation, or its own
 * removal, settles it. Run reconciliation when the inventory is quiet.)
 *
 * `dryRun` computes the same four counts and writes nothing; the session stays
 * open, so the real commit can follow.
 */

import { and, asc, count, eq, exists, gt, lte, not, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import {
  type FileReferenceReconciliationCounts,
  fileReferenceReconciliationItems,
  fileReferenceReconciliations,
} from '../db/schema/fileReferenceReconciliations';
import { fileReferences } from '../db/schema/fileReferences';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
import { assetService } from './assetServiceSingleton';
import { mayApplicationReference } from './fileReference.service';
import {
  addFileReferences,
  deleteFileReferencesByIds,
  findFilesByIds,
  isUniqueViolation,
} from './fileRepository';

/** A session's sliding deadline: each accepted page moves it this far ahead. */
export const RECONCILE_SESSION_TTL_MS = 60 * 60 * 1000;
/** Distinct pairs one session may hold. */
export const MAX_RECONCILE_ITEMS = 500_000;
/** Rows read, checked and written per step of a commit. */
const COMMIT_BATCH = 500;

export type ReconcileSession = typeof fileReferenceReconciliations.$inferSelect;

export interface ReconcileCommitResult extends FileReferenceReconciliationCounts {
  sessionId: string;
  entityType: string;
  dryRun: boolean;
}

function notFound(): ApiError {
  return new ApiError(404, 'Reconciliation session not found', 'RECONCILIATION_NOT_FOUND');
}

/**
 * Begin a session for (application, entity type). 409 while another is open
 * for the same pair; one that expired open is retired first, so an abandoned
 * client blocks nothing past its deadline.
 */
export async function beginReconciliation(
  applicationId: string,
  entityType: string,
  now: Date = new Date(),
): Promise<ReconcileSession> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx
        .update(fileReferenceReconciliations)
        .set({ status: 'abandoned' })
        .where(
          and(
            eq(fileReferenceReconciliations.applicationId, applicationId),
            eq(fileReferenceReconciliations.entityType, entityType),
            eq(fileReferenceReconciliations.status, 'open'),
            lte(fileReferenceReconciliations.expiresAt, now),
          ),
        );
      const [session] = await tx
        .insert(fileReferenceReconciliations)
        .values({
          applicationId,
          entityType,
          status: 'open',
          expiresAt: new Date(now.getTime() + RECONCILE_SESSION_TTL_MS),
        })
        .returning();
      return session;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        `A reconciliation of '${entityType}' is already in progress for this application`,
        'RECONCILIATION_IN_PROGRESS',
      );
    }
    throw error;
  }
}

/**
 * The application's own session, open and unexpired — 404 for another
 * application's or no session (indistinguishable), 410 once it expired, 409
 * once it is no longer open.
 */
async function openSession(
  applicationId: string,
  sessionId: string,
  now: Date,
): Promise<ReconcileSession> {
  const [session] = await getDb()
    .select()
    .from(fileReferenceReconciliations)
    .where(
      and(
        eq(fileReferenceReconciliations.id, sessionId),
        eq(fileReferenceReconciliations.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!session) throw notFound();
  if (session.status === 'open' && session.expiresAt <= now) {
    throw new ApiError(410, 'Reconciliation session expired', 'RECONCILIATION_EXPIRED');
  }
  if (session.status !== 'open') {
    throw new ApiError(
      409,
      `Reconciliation session is ${session.status}`,
      'RECONCILIATION_NOT_OPEN',
    );
  }
  return session;
}

/** Add one page of `(fileId, entityId)` pairs; a pair already received counts once. */
export async function putReconciliationItems(
  applicationId: string,
  sessionId: string,
  items: readonly { fileId: string; entityId: string }[],
  now: Date = new Date(),
): Promise<{ accepted: number; total: number; expiresAt: Date }> {
  const session = await openSession(applicationId, sessionId, now);
  const unique = [
    ...new Map(items.map((item) => [`${item.fileId}\u0000${item.entityId}`, item])).values(),
  ];
  if (session.itemCount + unique.length > MAX_RECONCILE_ITEMS) {
    throw new ApiError(
      413,
      `A reconciliation holds at most ${MAX_RECONCILE_ITEMS} pairs; split the entity type`,
      'RECONCILIATION_TOO_LARGE',
    );
  }
  return getDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(fileReferenceReconciliationItems)
      .values(unique.map((item) => ({ sessionId, fileId: item.fileId, entityId: item.entityId })))
      .onConflictDoNothing()
      .returning({ fileId: fileReferenceReconciliationItems.fileId });
    const expiresAt = new Date(now.getTime() + RECONCILE_SESSION_TTL_MS);
    // Conditional on still being open and unexpired: a page racing a commit or
    // the deadline changes nothing the commit reads.
    const [updated] = await tx
      .update(fileReferenceReconciliations)
      .set({
        itemCount: sql`${fileReferenceReconciliations.itemCount} + ${inserted.length}`,
        expiresAt,
      })
      .where(
        and(
          eq(fileReferenceReconciliations.id, sessionId),
          eq(fileReferenceReconciliations.status, 'open'),
          gt(fileReferenceReconciliations.expiresAt, now),
        ),
      )
      .returning({ itemCount: fileReferenceReconciliations.itemCount });
    if (!updated) {
      throw new ApiError(
        409,
        'Reconciliation session is no longer open',
        'RECONCILIATION_NOT_OPEN',
      );
    }
    return { accepted: inserted.length, total: updated.itemCount, expiresAt };
  });
}

/** Release a session without committing it (the SDK does on a failed inventory). */
export async function abandonReconciliation(
  applicationId: string,
  sessionId: string,
): Promise<boolean> {
  const released = await getDb()
    .update(fileReferenceReconciliations)
    .set({ status: 'abandoned' })
    .where(
      and(
        eq(fileReferenceReconciliations.id, sessionId),
        eq(fileReferenceReconciliations.applicationId, applicationId),
        eq(fileReferenceReconciliations.status, 'open'),
      ),
    )
    .returning({ id: fileReferenceReconciliations.id });
  if (released.length === 0) return false;
  await getDb()
    .delete(fileReferenceReconciliationItems)
    .where(eq(fileReferenceReconciliationItems.sessionId, sessionId));
  return true;
}

/** `r` is one of this session's application's references of its entity type. */
function sessionReference(session: ReconcileSession) {
  return and(
    eq(fileReferences.applicationId, session.applicationId),
    eq(fileReferences.entityType, session.entityType),
  );
}

/** The item `i` has a matching reference. */
function itemIsReferenced(session: ReconcileSession) {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(fileReferences)
      .where(
        and(
          eq(fileReferences.fileId, fileReferenceReconciliationItems.fileId),
          sessionReference(session),
          eq(fileReferences.entityId, fileReferenceReconciliationItems.entityId),
        ),
      ),
  );
}

/** Pairs in the inventory with no reference: what to add (or refuse). */
async function* missingPairs(session: ReconcileSession) {
  let after: { fileId: string; entityId: string } | null = null;
  for (;;) {
    const page: { fileId: string; entityId: string }[] = await getDb()
      .select({
        fileId: fileReferenceReconciliationItems.fileId,
        entityId: fileReferenceReconciliationItems.entityId,
      })
      .from(fileReferenceReconciliationItems)
      .where(
        and(
          eq(fileReferenceReconciliationItems.sessionId, session.id),
          after === null
            ? undefined
            : sql`(${fileReferenceReconciliationItems.fileId}, ${fileReferenceReconciliationItems.entityId}) > (${after.fileId}, ${after.entityId})`,
          not(itemIsReferenced(session)),
        ),
      )
      .orderBy(
        asc(fileReferenceReconciliationItems.fileId),
        asc(fileReferenceReconciliationItems.entityId),
      )
      .limit(COMMIT_BATCH);
    if (page.length === 0) return;
    yield page;
    after = page[page.length - 1];
  }
}

/**
 * References with no pair in the inventory, created before the session began
 * (see "The race it must not lose"): what to remove.
 */
async function* stalePairs(session: ReconcileSession) {
  let after: string | null = null;
  for (;;) {
    const page: { id: string }[] = await getDb()
      .select({ id: fileReferences.id })
      .from(fileReferences)
      .where(
        and(
          sessionReference(session),
          // Against the session's STORED instant, never `session.createdAt`:
          // both columns are the database's microseconds, and the JavaScript
          // Date rounds the bound down to its millisecond, which would keep a
          // reference made in that millisecond before `begin`.
          sql`${fileReferences.createdAt} < (select ${fileReferenceReconciliations.createdAt} from ${fileReferenceReconciliations} where ${fileReferenceReconciliations.id} = ${session.id})`,
          after === null ? undefined : gt(fileReferences.id, after),
          not(
            exists(
              getDb()
                .select({ one: sql`1` })
                .from(fileReferenceReconciliationItems)
                .where(
                  and(
                    eq(fileReferenceReconciliationItems.sessionId, session.id),
                    eq(fileReferenceReconciliationItems.fileId, fileReferences.fileId),
                    eq(fileReferenceReconciliationItems.entityId, fileReferences.entityId),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(asc(fileReferences.id))
      .limit(COMMIT_BATCH);
    if (page.length === 0) return;
    yield page.map((row) => row.id);
    after = page[page.length - 1].id;
  }
}

async function countUnchanged(session: ReconcileSession): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(fileReferenceReconciliationItems)
    .where(
      and(eq(fileReferenceReconciliationItems.sessionId, session.id), itemIsReferenced(session)),
    );
  return row?.total ?? 0;
}

/**
 * Diff the inventory against the stored references and — unless `dryRun` —
 * apply it. One commit at a time per session (`open` → `committing`); a
 * failure puts it back to `open`, so the commit can be retried (every step is
 * idempotent: the diff is recomputed).
 */
export async function commitReconciliation(
  applicationId: string,
  sessionId: string,
  options: { dryRun?: boolean } = {},
  now: Date = new Date(),
): Promise<ReconcileCommitResult> {
  const dryRun = options.dryRun === true;
  await openSession(applicationId, sessionId, now);
  const [session] = await getDb()
    .update(fileReferenceReconciliations)
    .set({ status: 'committing', expiresAt: new Date(now.getTime() + RECONCILE_SESSION_TTL_MS) })
    .where(
      and(
        eq(fileReferenceReconciliations.id, sessionId),
        eq(fileReferenceReconciliations.applicationId, applicationId),
        eq(fileReferenceReconciliations.status, 'open'),
        gt(fileReferenceReconciliations.expiresAt, now),
      ),
    )
    .returning();
  if (!session) {
    throw new ApiError(409, 'Reconciliation session is no longer open', 'RECONCILIATION_NOT_OPEN');
  }

  const counts: FileReferenceReconciliationCounts = {
    added: 0,
    removed: 0,
    unchanged: 0,
    refused: 0,
  };
  try {
    counts.unchanged = await countUnchanged(session);

    // Removals first: they read the inventory against references created
    // before `begin`, which the additions below never are.
    for await (const ids of stalePairs(session)) {
      counts.removed += dryRun ? ids.length : (await deleteFileReferencesByIds(ids)).length;
    }

    for await (const page of missingPairs(session)) {
      const files = new Map(
        (await findFilesByIds([...new Set(page.map((pair) => pair.fileId))])).map((file) => [
          file.id,
          file,
        ]),
      );
      const allowed = page.filter((pair) => {
        const file = files.get(pair.fileId);
        return file !== undefined && mayApplicationReference(file, applicationId);
      });
      counts.refused += page.length - allowed.length;
      if (dryRun) {
        counts.added += allowed.length;
        continue;
      }
      const result = await addFileReferences(
        allowed.map((pair) => ({
          fileId: pair.fileId,
          applicationId,
          entityType: session.entityType,
          entityId: pair.entityId,
          createdByUserId: null,
        })),
      );
      counts.added += result.created;
      // A file of its own that a reference brought back from trash is served again.
      for (const fileId of result.restoredFileIds) {
        const [restored] = await findFilesByIds([fileId]);
        if (restored) await assetService.enterServing(restored);
      }
    }
  } catch (error) {
    await getDb()
      .update(fileReferenceReconciliations)
      .set({ status: 'open' })
      .where(
        and(
          eq(fileReferenceReconciliations.id, sessionId),
          eq(fileReferenceReconciliations.status, 'committing'),
        ),
      );
    throw error;
  }

  await getDb()
    .update(fileReferenceReconciliations)
    .set({
      status: dryRun ? 'open' : 'committed',
      ...(dryRun ? {} : { committedAt: now }),
      result: { ...counts, dryRun },
    })
    .where(eq(fileReferenceReconciliations.id, sessionId));
  if (!dryRun) {
    // The bulk of a session; the row itself stays as the record until expiry.
    await getDb()
      .delete(fileReferenceReconciliationItems)
      .where(eq(fileReferenceReconciliationItems.sessionId, sessionId));
  }

  logger.info('File references reconciled', {
    applicationId,
    entityType: session.entityType,
    sessionId,
    dryRun,
    ...counts,
  });
  return { sessionId, entityType: session.entityType, dryRun, ...counts };
}
