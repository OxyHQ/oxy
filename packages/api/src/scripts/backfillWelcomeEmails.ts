import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../config/postgres';
import { EMAIL_DOMAIN } from '../config/email.config';
import { messages } from '../db/schema/messages';
import { messageRecipients } from '../db/schema/messageRecipients';
import { renderWelcomeEmail } from '../services/welcomeEmail';

const LEGACY_SUBJECT = 'Welcome to Inbox by Oxy';
const LEGACY_INTRO = 'Welcome to Inbox by Oxy — your new email, built for clarity.';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Safe to print: carries aggregate counts only, never SQL or message content. */
export class WelcomeBackfillError extends Error {}

/**
 * Rewrites only the known, locally provisioned legacy welcome message.
 * One transaction is the cutover: any unrecognised candidate aborts all writes.
 * Original recipient identity, row IDs, threading, dates, flags and folders stay
 * intact. There is no insert, SMTP delivery, or recreation of deleted messages.
 */
export async function backfillWelcomeEmails(db: Database, apply = false) {
  return db.transaction(async (tx) => {
    const result = { candidates: 0, eligible: 0, unrecognised: 0, updated: 0 };
    let cursor: string | undefined;

    for (;;) {
      const query = tx
        .select({
          id: messages.id,
          userId: messages.userId,
          messageId: messages.messageId,
          text: messages.text,
        })
        .from(messages)
        .where(
          and(
            eq(messages.subject, LEGACY_SUBJECT),
            eq(messages.fromName, 'Inbox by Oxy'),
            eq(messages.fromAddress, `hello@${EMAIL_DOMAIN}`),
            eq(messages.draft, false),
            eq(messages.encrypted, false),
            isNull(messages.inReplyTo),
            sql`starts_with(${messages.messageId}, '<welcome-' || ${messages.userId} || '-')`,
            cursor ? gt(messages.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(messages.id))
        .limit(100)
        .$dynamic();
      const batch = await (apply ? query.for('update') : query);
      if (!batch.length) break;

      for (const message of batch) {
        result.candidates++;
        const recipients = await tx
          .select({
            name: messageRecipients.name,
            address: messageRecipients.address,
            kind: messageRecipients.kind,
          })
          .from(messageRecipients)
          .where(eq(messageRecipients.messageId, message.id));
        const recipient = recipients[0];
        const signature = new RegExp(
          `^<welcome-${escapeRegex(message.userId)}-${UUID}@${escapeRegex(EMAIL_DOMAIN)}>$`,
        );
        if (
          !signature.test(message.messageId) ||
          recipients.length !== 1 ||
          recipient.kind !== 'to' ||
          !message.text?.startsWith(`Hi ${recipient.name || 'there'},\n\n${LEGACY_INTRO}\n\n`)
        ) {
          result.unrecognised++;
          continue;
        }

        result.eligible++;
        if (apply) {
          const content = renderWelcomeEmail(recipient.name || 'there', recipient.address);
          await tx
            .update(messages)
            .set({
              ...content,
              // Match initial provisioning's plain-text byte accounting.
              size: Buffer.byteLength(content.text, 'utf8'),
              updatedAt: new Date(),
            })
            .where(eq(messages.id, message.id));
          result.updated++;
        }
      }
      cursor = batch[batch.length - 1].id;
    }

    if (apply && result.unrecognised > 0) {
      throw new WelcomeBackfillError(
        `Welcome backfill rolled back: ${result.unrecognised} unrecognised candidates. Run without --apply and investigate before retrying.`,
      );
    }
    return result;
  });
}
