import type { NormalizedAppEvent } from '@oxyhq/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';

/**
 * Transactional source of truth for normalized events emitted by Oxy apps.
 *
 * Producers insert the domain row and this row in one transaction. Delivery is
 * at least once: `eventId` is both unique here and sent to the consumer as its
 * idempotency key, so a worker crash after the remote acknowledgement can only
 * cause a recognizable replay, never a missing event.
 */
export const normalizedAppEventOutbox = pgTable(
  'normalized_app_event_outbox',
  {
    id: generatedId(),
    eventId: text().notNull(),
    appId: text().notNull(),
    event: jsonb().$type<NormalizedAppEvent>().notNull(),
    processedAt: timestamptz(),
    claimedAt: timestamptz(),
    claimedBy: text(),
    attempts: integer().notNull().default(0),
    failedAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('normalized_app_event_outbox_event_id_key').on(t.eventId),
    check('normalized_app_event_outbox_attempts_check', sql`${t.attempts} >= 0`),
    index('normalized_app_event_outbox_pending_idx')
      .on(t.appId, t.createdAt)
      .where(sql`${t.processedAt} is null and ${t.failedAt} is null`),
    index('normalized_app_event_outbox_dead_letter_idx')
      .on(t.failedAt)
      .where(sql`${t.failedAt} is not null`),
  ],
);

export type NormalizedAppEventOutboxRow = typeof normalizedAppEventOutbox.$inferSelect;
