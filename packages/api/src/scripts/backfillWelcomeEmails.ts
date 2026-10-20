import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../config/postgres';
import { EMAIL_DOMAIN } from '../config/email.config';
import { messages } from '../db/schema/messages';
import { messageRecipients } from '../db/schema/messageRecipients';
import { renderWelcomeEmail, WELCOME_EMAIL_MARKER } from '../services/welcomeEmail';
// Frozen output of the deployed v1 and v2 renderers.
// Source commits: 20bf0ec64a09f20b65bc4398da818da46762149c,
// then 8f71832c9c7e76ab0628c9cff3405486d70f9251.
import previousWelcome from './fixtures/welcome-v1.json';
import firstBloomWelcome from './fixtures/welcome-v2.json';

const LEGACY_SUBJECT = 'Welcome to Inbox by Oxy';
const LEGACY_INTRO = 'Welcome to Inbox by Oxy — your new email, built for clarity.';
const PREVIOUS_INTRO = previousWelcome.text.split('\n\n')[1];
const FIRST_BLOOM_INTRO = firstBloomWelcome.text.split('\n\n')[1];
const FIRST_BLOOM_MARKER = 'data-oxy-welcome-version="2"';
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Safe to print: carries aggregate counts only, never SQL or message content. */
export class WelcomeBackfillError extends Error {}

/**
 * Rewrites only known Oxy welcome message templates.
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
          html: messages.html,
          subject: messages.subject,
        })
        .from(messages)
        .where(
          and(
            or(
              eq(messages.subject, LEGACY_SUBJECT),
              and(
                eq(messages.subject, previousWelcome.subject),
                or(
                  sql`strpos(coalesce(${messages.html}, ''), ${FIRST_BLOOM_MARKER}) > 0`,
                  sql`strpos(coalesce(${messages.text}, ''), ${PREVIOUS_INTRO}) > 0`,
                ),
              ),
            ),
            sql`strpos(coalesce(${messages.html}, ''), ${WELCOME_EMAIL_MARKER}) = 0`,
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
        const isPrevious = message.subject === previousWelcome.subject;
        const isFirstBloom = message.html?.includes(FIRST_BLOOM_MARKER) ?? false;
        const fixture = isFirstBloom ? firstBloomWelcome : previousWelcome;
        const intro = isPrevious
          ? isFirstBloom
            ? FIRST_BLOOM_INTRO
            : PREVIOUS_INTRO
          : LEGACY_INTRO;
        const greetingEnd = message.text?.indexOf(`,\n\n${intro}\n\n`) ?? -1;
        const greetingName =
          message.text?.startsWith('Hi ') && greetingEnd > 3
            ? message.text.slice(3, greetingEnd)
            : undefined;
        const recipientName = recipient?.name || 'there';
        // Before 6f9e9fa6c, the greeting used name.first while the To header
        // stored first + last. Accept that historical prefix at a word boundary,
        // preserving the original greeting; an unrelated name still fails closed.
        const recognisedGreeting =
          greetingName !== undefined &&
          (greetingName === recipientName || recipientName.startsWith(`${greetingName} `));
        // Compare prior full HTML and text to their frozen renderer output.
        // Only the greeting and recipient address may differ.
        const previousMatches =
          !isPrevious ||
          (greetingName !== undefined &&
            recipient &&
            message.text ===
              fixture.text
                .replaceAll('__OXY_WELCOME_NAME__', () => greetingName)
                .replaceAll('__OXY_WELCOME_ADDRESS__', () => recipient.address) &&
            message.html ===
              fixture.html
                .replaceAll('__OXY_WELCOME_NAME__', () => escapeHtml(greetingName))
                .replaceAll('__OXY_WELCOME_ADDRESS__', () => escapeHtml(recipient.address)));
        const signature = new RegExp(
          `^<welcome-${escapeRegex(message.userId)}-${UUID}@${escapeRegex(EMAIL_DOMAIN)}>$`,
        );
        if (
          !signature.test(message.messageId) ||
          recipients.length !== 1 ||
          recipient.kind !== 'to' ||
          !recognisedGreeting ||
          !previousMatches
        ) {
          result.unrecognised++;
          continue;
        }

        result.eligible++;
        if (apply) {
          const content = renderWelcomeEmail(greetingName, recipient.address);
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
