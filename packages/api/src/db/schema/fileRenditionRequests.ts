/**
 * `file_rendition_requests` — a file whose rendition set still has to be built,
 * and the durable half of the asset-variant queue (`queue/assetVariants.queue.ts`).
 *
 * The BullMQ queue used to BE the backlog: every upload added a job, so a bulk
 * import left one job per file in Redis. On 2026-10-20 that was 398,416 jobs
 * (~380 MB) on a 384 MB noeviction node; every write then failed, workers could
 * not even complete a job, and the worker loop logged ~1,600 errors a second.
 *
 * Now the backlog lives here and Redis holds only a bounded window of it: a
 * request is recorded for every file that needs renditions, an upload adds its
 * job directly only while the queue is short, and a leased scheduler tops the
 * queue up from this table in fair lanes, oldest request first within each lane.
 *
 * - `requested_at` — when the newest request was made, at millisecond
 *   precision (it travels in the job and comes back as a JS `Date`). The job
 *   that settles a request deletes the row only if it still holds THIS value,
 *   so a file re-requested while its job ran (its content replaced) keeps its
 *   row and is built again.
 * - `enqueued_until` — the queue holds this file's job until then. NULL or past
 *   means due: a job lost with Redis (or never added) is found again once its
 *   lease runs out, so nothing pending can be dropped by the queue.
 *
 * Rows are deleted when their job settles — built, or failed for good — so the
 * table is exactly the backlog. No `created_at`/`updated_at`: `requested_at` is
 * the only instant a request has, and nothing reads when its lease last moved.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { timestamptz } from '@oxy.so/db';
import { files } from './files';

export const fileRenditionRequests = pgTable(
  'file_rendition_requests',
  {
    /** One request per file: a newer request replaces the older one. */
    fileId: text()
      .primaryKey()
      .references(() => files.id, { onDelete: 'cascade' }),
    requestedAt: timestamptz().notNull(),
    enqueuedUntil: timestamptz(),
    // Existing requests migrate to bulk. Writers explicitly select fresh or
    // repair; neither timestamps nor request identity are changed for priority.
    lane: text({ enum: ['fresh', 'repair', 'bulk'] })
      .notNull()
      .default('bulk'),
  },
  (t) => [
    // The scheduler's read: due requests, oldest first, `file_id` making the
    // order total.
    index('file_rendition_requests_requested_at_idx').on(t.requestedAt, t.fileId),
    index('file_rendition_requests_lane_requested_at_idx').on(t.lane, t.requestedAt, t.fileId),
    check('file_rendition_requests_lane_check', sql`${t.lane} in ('fresh', 'repair', 'bulk')`),
  ],
);
