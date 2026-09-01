import { randomUUID } from 'node:crypto';
import { SMTP_OUTBOUND_CONFIG } from '../config/email.config';
import { smtpOutbound } from './smtp.outbound';
import { emailService } from './email.service';
import {
  claimEmailOutbox,
  markEmailOutboxFailed,
  markEmailOutboxSent,
} from './emailOutbox.service';
import { logger } from '../utils/logger';

const workerId = `email-outbox-${randomUUID()}`;

/** Process one durable delivery record. At-least-once claiming plus a stable
 * RFC Message-ID makes a retried SMTP submission observable and idempotent. */
export async function processEmailOutbox(): Promise<number> {
  let processed = 0;
  while (processed < 25) {
    const row = await claimEmailOutbox(workerId);
    if (!row) break;
    try {
      await smtpOutbound.sendRaw({ ...row.payload, userId: row.userId, messageId: row.messageId });
      // A worker can crash after SMTP accepts the message but before the row
      // is marked sent. The stable RFC Message-ID makes this recovery
      // idempotent in the Sent mailbox as well.
      const existing = await emailService.findMessageByRfcMessageId(row.userId, row.messageId);
      if (!existing) {
        const size = Buffer.byteLength(`${row.payload.text ?? ''}${row.payload.html ?? ''}`, 'utf8');
        await emailService.storeSentMessage(row.userId, {
          messageId: row.messageId,
          from: row.payload.from,
          to: row.payload.to,
          cc: row.payload.cc,
          bcc: row.payload.bcc,
          subject: row.payload.subject,
          text: row.payload.text,
          html: row.payload.html,
          inReplyTo: row.payload.inReplyTo,
          references: row.payload.references,
          attachments: row.payload.attachments,
          size,
        });
      }
      await markEmailOutboxSent(row.id);
      processed++;
    } catch (error) {
      const delayIndex = Math.min(row.attempts, SMTP_OUTBOUND_CONFIG.retryDelays.length - 1);
      const nextAttemptAt = new Date(Date.now() + SMTP_OUTBOUND_CONFIG.retryDelays[delayIndex]);
      await markEmailOutboxFailed(row.id, error, nextAttemptAt);
      logger.error('Durable outbound email delivery failed', error instanceof Error ? error : new Error(String(error)), {
        outboxId: row.id,
        messageId: row.messageId,
        attempt: row.attempts,
      });
      processed++;
    }
  }
  return processed;
}
