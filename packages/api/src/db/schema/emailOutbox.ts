/**
 * Durable outbound email delivery state.
 *
 * SMTP is an external side effect, so a Redis-only retry record cannot be the
 * source of truth: a process restart can lose the retry or two replicas can
 * deliver it twice. This table is the durable state machine. A worker claims
 * one row with `FOR UPDATE SKIP LOCKED`, performs SMTP with the stable RFC
 * Message-ID, then records the outcome.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';
import { messages } from './messages';
import type { EmailAddress } from './messages';
import type { MessageAttachment } from './messageAttachments';

export const EMAIL_OUTBOX_STATUSES = ['pending', 'processing', 'sent', 'failed', 'cancelled'] as const;
export type EmailOutboxStatus = (typeof EMAIL_OUTBOX_STATUSES)[number];

export interface EmailOutboxPayload {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: MessageAttachment[];
  requestReadReceipt?: boolean;
}

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: generatedId(),
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    messageRowId: text().references(() => messages.id, { onDelete: 'set null' }),
    messageId: text().notNull(),
    idempotencyKey: text(),
    payload: jsonb().$type<EmailOutboxPayload>().notNull(),
    status: text({ enum: EMAIL_OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    lockedAt: timestamptz(),
    lockedBy: text(),
    lastError: text(),
    sentAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('email_outbox_due_idx').on(t.status, t.nextAttemptAt, t.createdAt),
    index('email_outbox_user_created_idx').on(t.userId, t.createdAt.desc()),
    uniqueIndex('email_outbox_user_idempotency_key').on(t.userId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    check('email_outbox_status_check', sql`${t.status} in (${sql.raw(EMAIL_OUTBOX_STATUSES.map((value) => `'${value}'`).join(', '))})`),
    check('email_outbox_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
