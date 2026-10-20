/**
 * `application_invitation_emails` — the invitation emails an application had
 * Oxy send (`POST /apps/invitations/email`, scope `invitations:email`), and the
 * delivery state of each.
 *
 * One fixed template: "{inviter} invited you to {resource} on {application}",
 * with one link. A row is the whole request, so it is three things at once, and
 * each is why it exists:
 *
 *  - **The idempotency claim.** `(application_id, idempotency_key)` is unique: a
 *    repeat of the key (a retry after a timeout, a second task) finds the row
 *    instead of mailing twice. The key is the application's own (Nilo sends the
 *    invite id), so two applications' keys never collide.
 *  - **The rate-limit ledger.** The per-recipient, per-inviter and
 *    per-application windows are counts over these rows, taken under a
 *    per-application advisory lock in the transaction that inserts the next one
 *    (`appInvitationEmail.service.ts`). Durable and exact across tasks, which a
 *    Redis counter keyed on a recipient would be neither of.
 *  - **The outbox.** `status` / `attempts` / `next_attempt_at` / `locked_*` are
 *    the same state machine as `email_outbox`, delivered once by the request
 *    that accepted it and retried by the email maintenance pass. It is NOT a row
 *    of `email_outbox`: that table is a USER's mailbox outbox — `user_id` is the
 *    account whose Sent folder a delivery is filed in, and whose outbox API can
 *    list, retry and cancel it. An invitation is mail from Oxy, filed nowhere,
 *    and must not appear in the inviter's mailbox.
 *
 * The message is RENDERED at delivery from these columns, never stored: the
 * template is code, the application's name and the inviter's display name are
 * read live, and there is no body column for anything else to be put in.
 *
 * ## Retention
 *
 * `recipient` is the address of someone who may have no Oxy account, so the row
 * is kept only as long as it does work: {@link APP_INVITATION_EMAIL_RETENTION_SECONDS}
 * after `created_at` it is swept (`db/expiry.ts`). That bounds the idempotency
 * window too, and comfortably outlasts every rate-limit window and the retry
 * ladder.
 *
 * ## Foreign keys
 *
 * Both `CASCADE`. An application that is gone has nothing left to send for, and
 * an inviter whose account is deleted must not keep inviting people in their
 * name: a queued retry vanishes with them rather than mailing afterwards.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { EMAIL_DELIVERY_ERROR_CODES } from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

/** The languages the template is written in. Anything else is sent in English. */
export const APP_INVITATION_EMAIL_LOCALES = ['en', 'es'] as const;
export type AppInvitationEmailLocale = (typeof APP_INVITATION_EMAIL_LOCALES)[number];

/**
 * `pending` — due for an attempt (`next_attempt_at`); `processing` — leased to a
 * task; `sent` — the relay took it; `failed` — retried later while attempts are
 * left, terminal once they are spent.
 */
export const APP_INVITATION_EMAIL_STATUSES = ['pending', 'processing', 'sent', 'failed'] as const;
export type AppInvitationEmailStatus = (typeof APP_INVITATION_EMAIL_STATUSES)[number];

/** Thirty days: past every rate-limit window and the whole retry ladder. */
export const APP_INVITATION_EMAIL_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const applicationInvitationEmails = pgTable(
  'application_invitation_emails',
  {
    id: generatedId(),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The application's own key for this invitation (Nilo: the invite id). */
    idempotencyKey: text().notNull(),
    /** Whose name the email carries — resolved by Oxy, never supplied as text. */
    inviterUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Trimmed and lower-cased, as the suppression list compares it. */
    recipient: text().notNull(),
    /** What the person is invited to, as plain text (a workspace's name). */
    resourceName: text().notNull(),
    /** The one link, on an origin the application registered. */
    acceptUrl: text().notNull(),
    locale: text({ enum: APP_INVITATION_EMAIL_LOCALES }).notNull(),
    status: text({ enum: APP_INVITATION_EMAIL_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    lockedAt: timestamptz(),
    lockedBy: text(),
    lastError: text(),
    errorCode: text({ enum: EMAIL_DELIVERY_ERROR_CODES }),
    sentAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('application_invitation_emails_application_key').on(
      t.applicationId,
      t.idempotencyKey,
    ),
    // The per-recipient window: this application's mail to this address lately.
    index('application_invitation_emails_recipient_idx').on(
      t.applicationId,
      t.recipient,
      t.createdAt,
    ),
    // The per-inviter window, and the inviter foreign key's cascade.
    index('application_invitation_emails_inviter_idx').on(
      t.inviterUserId,
      t.applicationId,
      t.createdAt,
    ),
    // The per-application window, and the application foreign key's cascade.
    index('application_invitation_emails_application_created_idx').on(t.applicationId, t.createdAt),
    // The maintenance pass's claim: deliveries not finished, in due order.
    index('application_invitation_emails_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('pending', 'processing', 'failed')`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('application_invitation_emails_created_at_idx').on(t.createdAt),
    check(
      'application_invitation_emails_locale_check',
      sql`${t.locale} in (${sql.raw(inList(APP_INVITATION_EMAIL_LOCALES))})`,
    ),
    check(
      'application_invitation_emails_status_check',
      sql`${t.status} in (${sql.raw(inList(APP_INVITATION_EMAIL_STATUSES))})`,
    ),
    check('application_invitation_emails_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'application_invitation_emails_error_code_check',
      sql`${t.errorCode} is null or ${t.errorCode} in (${sql.raw(inList(EMAIL_DELIVERY_ERROR_CODES))})`,
    ),
  ],
);

export type ApplicationInvitationEmailRow = typeof applicationInvitationEmails.$inferSelect;
