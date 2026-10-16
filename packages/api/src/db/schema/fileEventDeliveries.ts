/**
 * `file_event_deliveries` — the outbox of file events to applications
 * (ADR 0043 D9).
 *
 * When a file is deleted, trashed, restored or changes visibility, every
 * application that uses it (a `file_references` row) and the application that
 * owns it are told, so a product can remove or replace what it shows. One row
 * per (event, application), written IN THE TRANSACTION that changed the file —
 * so a change is never committed without its events, and an event is never
 * sent for a change that rolled back.
 *
 * Only an application with a VERIFIED file-events endpoint
 * (`applications.files_webhook_url` / `files_webhook_verified_at`) gets a row;
 * the endpoint itself is read again at delivery time, so a rotated secret or a
 * moved URL applies to what is still queued.
 *
 * `fileEventDelivery.worker.ts` claims due rows under a lease, POSTs the stored
 * `payload` signed with HMAC-SHA256 over `<timestamp>.<body>`, and retries with
 * exponential backoff until a 2xx or {@link FILE_EVENT_MAX_ATTEMPTS}, when the
 * row is dead-lettered (`failed_at`). At least once: the receiver dedupes on
 * the event id.
 *
 * ## The payload is a snapshot
 *
 * `{ id, type, occurredAt, file: { id, ownerKind, visibility, status },
 * references: [{ entityType, entityId }] }`, built at write time and scoped to
 * THAT application's own references — another application's usage is never
 * disclosed. A file row may be gone by delivery time (an account's deletion
 * removes it), which is why `file_id` carries no foreign key and the payload
 * stands alone.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { applications } from './applications';

/**
 * Every file event type. `file.blocked` / `file.unblocked` are emitted by the
 * takedown flow of stage 4 (ADR 0043 D10); they are in the set now so a
 * receiver can be written against the whole vocabulary.
 */
export const FILE_EVENT_TYPES = [
  'file.deleted',
  'file.visibility_changed',
  'file.trashed',
  'file.restored',
  'file.blocked',
  'file.unblocked',
] as const;

export type FileEventType = (typeof FILE_EVENT_TYPES)[number];

/** 16 attempts at 1, 2, 4 … minutes capped at 6 h: about three and a half days. */
export const FILE_EVENT_MAX_ATTEMPTS = 16;

/**
 * How long a delivery row is kept: thirty days, far past the retry window, so
 * a delivered or dead-lettered event stays inspectable for support.
 */
export const FILE_EVENT_DELIVERY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const fileEventDeliveries = pgTable(
  'file_event_deliveries',
  {
    id: generatedId(),
    /** The event id, shared by every application told of the same change: the receiver's dedupe key. */
    eventId: text().notNull(),
    /** `CASCADE`: an application that is gone has nobody left to tell. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    type: text({ enum: FILE_EVENT_TYPES }).notNull(),
    /** The file the event is about. No foreign key: see the header. */
    fileId: text().notNull(),
    /** The exact JSON object POSTed (see the header). */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamptz().notNull(),
    attempts: integer().notNull().default(0),
    /** Earliest time the next attempt may be made; the backoff lives here. */
    nextAttemptAt: timestamptz().notNull().default(sql`now()`),
    claimedAt: timestamptz(),
    claimedBy: text(),
    /** The receiver acknowledged with a 2xx. */
    deliveredAt: timestamptz(),
    /** Dead letter: attempts exhausted, or the application has no verified endpoint any more. */
    failedAt: timestamptz(),
    lastStatus: integer(),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('file_event_deliveries_event_id_application_id_key').on(t.eventId, t.applicationId),
    check(
      'file_event_deliveries_type_check',
      sql`${t.type} in (${sql.raw(inList(FILE_EVENT_TYPES))})`,
    ),
    check('file_event_deliveries_attempts_check', sql`${t.attempts} >= 0`),
    // The worker's claim: due, unfinished deliveries in due order.
    index('file_event_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.deliveredAt} is null and ${t.failedAt} is null`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('file_event_deliveries_created_at_idx').on(t.createdAt),
  ],
);

export type FileEventDeliveryRow = typeof fileEventDeliveries.$inferSelect;
