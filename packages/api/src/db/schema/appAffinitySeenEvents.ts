/**
 * `app_affinity_seen_events` — bounded idempotency ledger for interaction-affinity
 * ingest.
 *
 * Ported from `models/AppAffinityEventSeen.ts`. A row records that
 * `(application_id, event_id)` was already folded, so a retried or duplicated
 * delivery is applied at most once.
 *
 * Mongo kept this bounded with a TTL index on `createdAt`
 * (`AFFINITY_EVENT_SEEN_TTL_SECONDS`); here the same retention is declared in
 * `db/expiry.ts` and applied by the sweep. Losing a marker is not a correctness
 * failure — it reopens the dedup window for an event nobody is still retrying,
 * which is exactly what the TTL was for.
 *
 * The Mongo collection was `appaffinityeventseens` (Mongoose's pluralizer, not a
 * word). Nothing reads a collection name, so this table is named for what it
 * holds.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId } from '@oxyhq/db';

export const appAffinitySeenEvents = pgTable(
  'app_affinity_seen_events',
  {
    id: generatedId(),
    /**
     * The application whose ingest this ledger dedupes. `CASCADE`, exactly as
     * the deferred-FK ledger decided before `applications` landed: the ledger
     * only dedupes ingest for an application that still exists.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The app-supplied event id, unique per application within the retention window. */
    eventId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // A duplicate insert loses this race and is treated as "already seen".
    unique('app_affinity_seen_events_application_id_event_id_key').on(
      t.applicationId,
      t.eventId
    ),
    // Supports the expiry sweep in `db/expiry.ts` — the replacement for Mongo's
    // TTL index on this column.
    index('app_affinity_seen_events_created_at_idx').on(t.createdAt),
  ]
);
