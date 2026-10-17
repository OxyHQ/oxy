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

import { and, asc, count, eq, exists, gt, lt, lte, not, sql } from 'drizzle-orm';
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

/** A running commit's lease: renewed after every batch, on the database's clock. */
export const COMMIT_LEASE_SECONDS = 120;
/** How long a `background` commit request waits for the commit before answering 202. */
export const COMMIT_HANDOFF_WAIT_MS = 10_000;

const leaseDeadline = () => sql`now() + make_interval(secs => ${COMMIT_LEASE_SECONDS})`;

/** The running commit lost its lease to another task (it was presumed dead); it stops. */
class CommitLeaseLost extends Error {
  constructor(sessionId: string) {
    super(`Reconciliation ${sessionId} lost its commit lease`);
  }
}

/** What a client reads back about its session (`GET …/reconcile/:sessionId`). */
export interface ReconcileSessionState {
  sessionId: string;
  entityType: string;
  status: ReconcileSession['status'];
  itemCount: number;
  expiresAt: Date;
  /** While `committing`: whether the running commit is a dry run. */
  dryRun: boolean | null;
  /** The last commit's counts — a dry run's leaves the session `open`. */
  result: (FileReferenceReconciliationCounts & { dryRun: boolean }) | null;
  /** Why the last commit failed; it can be committed again. */
  error: { code: string; message: string } | null;
}

/**
 * Claim the session for a commit: `open` → `committing`, under a fresh lease,
 * with the last commit's result and error cleared. 404/410/409 as every
 * session route.
 */
async function claimCommit(
  applicationId: string,
  sessionId: string,
  dryRun: boolean,
  now: Date,
): Promise<ReconcileSession> {
  await openSession(applicationId, sessionId, now);
  const [session] = await getDb()
    .update(fileReferenceReconciliations)
    .set({
      status: 'committing',
      expiresAt: new Date(now.getTime() + RECONCILE_SESSION_TTL_MS),
      leaseExpiresAt: leaseDeadline(),
      commitDryRun: dryRun,
      commitError: null,
      result: null,
    })
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
  return session;
}

/** Renew the lease after a batch; a session no longer ours stops the commit. */
async function renewLease(sessionId: string): Promise<void> {
  const [renewed] = await getDb()
    .update(fileReferenceReconciliations)
    .set({
      leaseExpiresAt: leaseDeadline(),
      expiresAt: sql`greatest(${fileReferenceReconciliations.expiresAt}, now() + make_interval(secs => ${RECONCILE_SESSION_TTL_MS / 1000}))`,
    })
    .where(
      and(
        eq(fileReferenceReconciliations.id, sessionId),
        eq(fileReferenceReconciliations.status, 'committing'),
      ),
    )
    .returning({ id: fileReferenceReconciliations.id });
  if (!renewed) throw new CommitLeaseLost(sessionId);
}

/**
 * Diff the claimed session's inventory against the stored references and —
 * unless it is a dry run — apply it, renewing the lease after every batch.
 * On success a dry run leaves the session `open` (the real commit can follow)
 * and a real one `committed`; on failure it is `open` again with
 * `commit_error`, and can be committed again — every step is idempotent: the
 * diff is recomputed, and what a failed attempt added is a reference created
 * after `begin`, which no attempt removes.
 */
async function runCommit(session: ReconcileSession): Promise<ReconcileCommitResult> {
  const { id: sessionId, applicationId } = session;
  const dryRun = session.commitDryRun === true;
  const counts: FileReferenceReconciliationCounts = {
    added: 0,
    removed: 0,
    unchanged: 0,
    refused: 0,
  };
  try {
    counts.unchanged = await countUnchanged(session);
    await renewLease(sessionId);

    // Removals first: they read the inventory against references created
    // before `begin`, which the additions below never are.
    for await (const ids of stalePairs(session)) {
      counts.removed += dryRun ? ids.length : (await deleteFileReferencesByIds(ids)).length;
      await renewLease(sessionId);
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
      } else {
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
      await renewLease(sessionId);
    }
  } catch (error) {
    if (!(error instanceof CommitLeaseLost)) {
      await getDb()
        .update(fileReferenceReconciliations)
        .set({
          status: 'open',
          leaseExpiresAt: null,
          commitDryRun: null,
          commitError: 'The commit failed; commit again',
        })
        .where(
          and(
            eq(fileReferenceReconciliations.id, sessionId),
            eq(fileReferenceReconciliations.status, 'committing'),
          ),
        );
    }
    throw error;
  }

  const [finished] = await getDb()
    .update(fileReferenceReconciliations)
    .set({
      status: dryRun ? 'open' : 'committed',
      ...(dryRun ? {} : { committedAt: new Date() }),
      result: { ...counts, dryRun },
      leaseExpiresAt: null,
      commitDryRun: null,
    })
    .where(
      and(
        eq(fileReferenceReconciliations.id, sessionId),
        eq(fileReferenceReconciliations.status, 'committing'),
      ),
    )
    .returning({ id: fileReferenceReconciliations.id });
  if (!finished) throw new CommitLeaseLost(sessionId);
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

/** {@link runCommit} for a task nobody awaits: a failure is recorded on the row and logged. */
function runCommitDetached(session: ReconcileSession): Promise<ReconcileCommitResult | null> {
  return runCommit(session).catch((error: unknown) => {
    if (error instanceof CommitLeaseLost) {
      logger.warn('Reference reconciliation commit lost its lease', { sessionId: session.id });
    } else {
      logger.error(
        'Reference reconciliation commit failed',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId: session.id, entityType: session.entityType },
      );
    }
    return null;
  });
}

/**
 * Commit and wait for it, however long it takes: the answer of a client that
 * does not ask for a `background` commit (every SDK before core 5.4.0). One
 * commit at a time per session (`open` → `committing`).
 */
export async function commitReconciliation(
  applicationId: string,
  sessionId: string,
  options: { dryRun?: boolean } = {},
  now: Date = new Date(),
): Promise<ReconcileCommitResult> {
  const session = await claimCommit(applicationId, sessionId, options.dryRun === true, now);
  return runCommit(session);
}

/**
 * Start the commit and wait at most `waitMs` for it: its result, or `pending`
 * when it is still running — it goes on in this task under its lease, and the
 * client reads the outcome back with {@link getReconciliation}. A task that
 * dies mid-commit stops renewing the lease, and
 * {@link resumeStalledReconciliationCommits} picks the commit up again.
 */
export async function startReconciliationCommit(
  applicationId: string,
  sessionId: string,
  options: { dryRun?: boolean; waitMs?: number } = {},
  now: Date = new Date(),
): Promise<
  | { pending: false; result: ReconcileCommitResult }
  | { pending: true; sessionId: string; entityType: string; dryRun: boolean }
> {
  const dryRun = options.dryRun === true;
  const session = await claimCommit(applicationId, sessionId, dryRun, now);
  const running = runCommitDetached(session);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handedOff = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), options.waitMs ?? COMMIT_HANDOFF_WAIT_MS);
  });
  try {
    const outcome = await Promise.race([running, handedOff]);
    if (outcome !== 'pending' && outcome !== null) return { pending: false, result: outcome };
    if (outcome === null) {
      // It failed within the wait: answer as the waiting route would.
      throw new ApiError(500, 'The commit failed; commit again', 'RECONCILIATION_COMMIT_FAILED');
    }
    return { pending: true, sessionId, entityType: session.entityType, dryRun };
  } finally {
    clearTimeout(timer);
  }
}

/** The session as its application reads it back; 404 for another's or none. */
export async function getReconciliation(
  applicationId: string,
  sessionId: string,
): Promise<ReconcileSessionState> {
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
  return {
    sessionId: session.id,
    entityType: session.entityType,
    status: session.status,
    itemCount: session.itemCount,
    expiresAt: session.expiresAt,
    dryRun: session.status === 'committing' ? session.commitDryRun === true : null,
    result: session.result ?? null,
    error: session.commitError
      ? { code: 'RECONCILIATION_COMMIT_FAILED', message: session.commitError }
      : null,
  };
}

/**
 * The worker's pass: take over each commit whose lease passed (its task died,
 * e.g. in a deploy) and run it to the end. Bounded; the conditional claim
 * makes it safe on every task at once.
 */
export async function resumeStalledReconciliationCommits(limit = 5): Promise<number> {
  const stalled = await getDb()
    .select({ id: fileReferenceReconciliations.id })
    .from(fileReferenceReconciliations)
    .where(
      and(
        eq(fileReferenceReconciliations.status, 'committing'),
        lt(fileReferenceReconciliations.leaseExpiresAt, sql`now()`),
      ),
    )
    .limit(limit);
  let resumed = 0;
  for (const { id } of stalled) {
    const [session] = await getDb()
      .update(fileReferenceReconciliations)
      .set({ leaseExpiresAt: leaseDeadline() })
      .where(
        and(
          eq(fileReferenceReconciliations.id, id),
          eq(fileReferenceReconciliations.status, 'committing'),
          lt(fileReferenceReconciliations.leaseExpiresAt, sql`now()`),
        ),
      )
      .returning();
    if (!session) continue;
    logger.warn('Resuming a reference reconciliation commit whose task died', {
      sessionId: id,
      entityType: session.entityType,
    });
    await runCommitDetached(session);
    resumed += 1;
  }
  return resumed;
}
