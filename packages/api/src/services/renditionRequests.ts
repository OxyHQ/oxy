/**
 * The durable backlog of rendition work (`file_rendition_requests`): which
 * files still need their rendition set built, and which of them the asset-variant
 * queue currently holds (`queue/assetVariants.queue.ts`).
 *
 * Redis is a bounded window over this table, never the backlog itself — see the
 * table's header for the incident that made it so.
 */

import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { type DatabaseOrTransaction, getDb } from '../config/postgres';
import { fileRenditionRequests } from '../db/schema';

export interface RenditionRequest {
  fileId: string;
  /** Millisecond precision, so it survives a round trip through a job's data. */
  requestedAt: Date;
}

/** Now, at millisecond precision — what `requested_at` holds. */
const NOW_MS = sql`date_trunc('milliseconds', now())`;

function leaseUntil(leaseMs: number) {
  return sql`now() + make_interval(secs => ${leaseMs / 1000})`;
}

/**
 * Record that `fileId` needs its renditions (re)built. A newer request replaces
 * an older one, so a job already holding the old `requestedAt` no longer
 * settles it. `leaseMs` when the caller is about to add the job itself; NULL
 * leaves the request due for the scheduler.
 */
export async function recordRenditionRequest(
  fileId: string,
  leaseMs: number | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<RenditionRequest> {
  const enqueuedUntil = leaseMs === null ? null : leaseUntil(leaseMs);
  const [row] = await db
    .insert(fileRenditionRequests)
    .values({ fileId, requestedAt: NOW_MS, enqueuedUntil, lane: 'fresh' })
    .onConflictDoUpdate({
      target: fileRenditionRequests.fileId,
      set: { requestedAt: NOW_MS, enqueuedUntil, lane: 'fresh' },
    })
    .returning({
      fileId: fileRenditionRequests.fileId,
      requestedAt: fileRenditionRequests.requestedAt,
    });
  return row;
}

/** The job for this request was not added after all: due again at once. */
export async function releaseRenditionRequest(
  request: RenditionRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(fileRenditionRequests)
    .set({ enqueuedUntil: null })
    .where(
      and(
        eq(fileRenditionRequests.fileId, request.fileId),
        eq(fileRenditionRequests.requestedAt, request.requestedAt),
      ),
    );
}

export type RenditionLane = 'fresh' | 'repair' | 'bulk';

/** A complete round grants each due background lane a turn when its lease is free. */
export const RENDITION_DISPATCH_ROUND: readonly RenditionLane[] = [
  ...Array<RenditionLane>(30).fill('fresh'),
  'repair',
  'bulk',
];

/**
 * Claim in weighted rounds, oldest within each lane. Empty lanes donate their
 * slots only to lanes with admission headroom. Each background lane owns at
 * most one unexpired lease, including active jobs and delayed retries, so slow
 * maintenance cannot fill the window before a fresh upload arrives. The caller
 * holds the fleet-wide scheduler transaction lock and only refills whole rounds,
 * so a stream of one-slot vacancies cannot reset fairness.
 * Rows selected beyond the final window are locked briefly but never leased.
 */
export async function claimDueRenditionRequests(
  limit: number,
  leaseMs: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RenditionRequest[]> {
  if (limit < 1) return [];
  const lanes: RenditionLane[] = ['fresh', 'repair', 'bulk'];
  const candidates = new Map<RenditionLane, RenditionRequest[]>();
  for (const lane of lanes) {
    // Keep active/delayed ownership until settlement or normal lease expiry.
    // A previous deployment may exceed this cap; let it drain without resetting
    // attempts, cancelling work, or granting another background lease.
    if (lane !== 'fresh') {
      const [leased] = await db
        .select({ fileId: fileRenditionRequests.fileId })
        .from(fileRenditionRequests)
        .where(
          and(
            eq(fileRenditionRequests.lane, lane),
            gte(fileRenditionRequests.enqueuedUntil, sql`now()`),
          ),
        )
        .limit(1);
      if (leased) continue;
    }
    candidates.set(
      lane,
      await db
        .select({
          fileId: fileRenditionRequests.fileId,
          requestedAt: fileRenditionRequests.requestedAt,
        })
        .from(fileRenditionRequests)
        .where(
          and(
            eq(fileRenditionRequests.lane, lane),
            or(
              isNull(fileRenditionRequests.enqueuedUntil),
              lt(fileRenditionRequests.enqueuedUntil, sql`now()`),
            ),
          ),
        )
        .orderBy(asc(fileRenditionRequests.requestedAt), asc(fileRenditionRequests.fileId))
        .limit(lane === 'fresh' ? limit : 1)
        .for('update', { skipLocked: true }),
    );
  }
  const selected: RenditionRequest[] = [];
  for (let slot = 0; selected.length < limit; slot++) {
    const preferred = candidates.get(
      RENDITION_DISPATCH_ROUND[slot % RENDITION_DISPATCH_ROUND.length],
    );
    const next =
      preferred?.shift() ??
      lanes
        .map((lane) => candidates.get(lane))
        .find((rows) => rows?.length)
        ?.shift();
    if (!next) break;
    selected.push(next);
  }
  if (selected.length > 0)
    await db
      .update(fileRenditionRequests)
      .set({ enqueuedUntil: leaseUntil(leaseMs) })
      .where(
        inArray(
          fileRenditionRequests.fileId,
          selected.map((row) => row.fileId),
        ),
      );
  return selected;
}

/**
 * The request a job carried is done — built, or given up on. Deletes the row
 * only if it still holds that request: a newer one (the file's content was
 * replaced while the job ran) stays and is built again.
 */
export async function settleRenditionRequest(
  request: RenditionRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .delete(fileRenditionRequests)
    .where(
      and(
        eq(fileRenditionRequests.fileId, request.fileId),
        eq(fileRenditionRequests.requestedAt, request.requestedAt),
      ),
    );
}

/**
 * Take jobs the queue holds beyond its bound back into the table, due at once:
 * the backlog a pre-bound producer left in Redis. A file that no longer exists
 * is skipped (its job is dropped with it); a file that already has a request
 * keeps its `requested_at` and becomes due.
 */
export async function adoptRenditionRequests(
  requests: readonly RenditionRequest[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (requests.length === 0) return 0;
  // One JSON parameter for the whole batch (raw SQL binds no `Date`, and no
  // array): each instant goes as ISO text, cast once by the recordset.
  const batch = JSON.stringify(
    requests.map((r) => ({ file_id: r.fileId, requested_at: r.requestedAt.toISOString() })),
  );
  const rows = await db.execute<{ file_id: string }>(sql`
    insert into ${fileRenditionRequests} (file_id, requested_at, enqueued_until)
    select f.id, date_trunc('milliseconds', adopted.requested_at), null
      from jsonb_to_recordset(${batch}::jsonb) as adopted(file_id text, requested_at timestamptz)
      join files f on f.id = adopted.file_id
    on conflict (file_id) do update set enqueued_until = null
    returning file_id`);
  return rows.length;
}

/** How many files are waiting for renditions — the real backlog. */
export async function countRenditionRequests(db: DatabaseOrTransaction = getDb()): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(fileRenditionRequests);
  return row?.n ?? 0;
}

/** When the oldest open request was made — how long the backlog's head has waited. */
export async function oldestRenditionRequestAt(
  db: DatabaseOrTransaction = getDb(),
): Promise<Date | null> {
  const [row] = await db
    .select({ requestedAt: fileRenditionRequests.requestedAt })
    .from(fileRenditionRequests)
    .orderBy(asc(fileRenditionRequests.requestedAt), asc(fileRenditionRequests.fileId))
    .limit(1);
  return row?.requestedAt ?? null;
}
