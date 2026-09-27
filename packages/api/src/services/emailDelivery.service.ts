/**
 * Sending a user's message: accept now, deliver afterwards.
 *
 * `POST /email/messages` used to talk SMTP inside the request. A relay slower
 * than the client's timeout (the SDK's is 5 s) made the client report a failure
 * while the server was still sending; the user pressed Send again and the same
 * reply went out twice. Idempotency keys fixed the duplicate, but not the
 * lie — and a synchronous relay also made every send as slow as the slowest
 * provider.
 *
 * So a send is two steps with a durable line between them:
 *
 *   1. {@link acceptOutboundMessage} — in ONE transaction, file the message in
 *      Sent with delivery `sending` and create its `email_outbox` job. Answer.
 *   2. {@link deliverEmail} — claim the job, hand the message to the relay,
 *      and record the verdict on BOTH rows: `sent`, `retrying` (with the next
 *      attempt's time), or `failed` (with the relay's words and a code saying
 *      whether waiting or editing can help). Every transition emits
 *      `email:changed` so every open client converges without polling.
 *
 * The outbox row is the job — lease, attempt budget, schedule, payload. The
 * message row is what the user sees. They are always written together.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { EmailDeliveryErrorCode } from '@oxy.so/contracts';
import { v4 as uuidv4 } from 'uuid';
import { EMAIL_DOMAIN, SMTP_OUTBOUND_CONFIG } from '../config/email.config';
import { getDb } from '../config/postgres';
import { emailOutbox, type EmailOutboxPayload } from '../db/schema/emailOutbox';
import type { MessageAttachment } from '../db/schema/messageAttachments';
import { messages, type EmailAddress } from '../db/schema/messages';
import { registerEmailDeliveryProcessor, scheduleEmailDelivery } from '../queue/emailDelivery.queue';
import { ConflictError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';
import { isUniqueViolation } from '../utils/postgresErrors';
import { emailService, type MessageDto } from './email.service';
import { idempotentMessageId } from './emailIdempotency';
import {
  cancelEmailOutbox,
  claimEmailOutboxById,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  errorText,
  findDeliveryJobForMessage,
  insertDeliveryJob,
  markEmailOutboxFailed,
  markEmailOutboxSent,
  markEmailOutboxTerminal,
  retryEmailOutbox,
  type EmailOutboxDto,
} from './emailOutbox.service';
import { emitEmailChanged } from './inboxRealtime';
import {
  isAuthenticationFailure,
  isOutboundRelayConfigured,
  isRetryableSmtpFailure,
  SmtpConfigurationError,
  smtpOutbound,
} from './smtp.outbound';

/** A message a user is sending, as the send path hands it over. */
export interface OutboundMessage {
  userId: string;
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
  /** When true, add Disposition-Notification-To header requesting a read receipt */
  requestReadReceipt?: boolean;
  /** Stable client key: a retry of the same key returns the first send. */
  idempotencyKey?: string;
}

export interface AcceptedSend {
  /** The Sent row, with its delivery state. */
  message: MessageDto;
  /** False when this call found an earlier send with the same key. */
  created: boolean;
}

type OutboxRow = typeof emailOutbox.$inferSelect;

const workerId = `email-delivery-${uuidv4()}`;

/** What the job keeps to deliver a message. */
function payloadOf(message: OutboundMessage): EmailOutboxPayload {
  return {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments,
    requestReadReceipt: message.requestReadReceipt,
  };
}

/**
 * File a message in Sent and promise its delivery. Returns as soon as both are
 * durable; never waits on a relay.
 *
 * Refuses up front — before anything is filed — only what no retry can fix and
 * the caller can act on now: a server with no relay at all (503). Everything
 * the relay itself decides arrives later, as a delivery state.
 */
export async function acceptOutboundMessage(message: OutboundMessage): Promise<AcceptedSend> {
  if (!isOutboundRelayConfigured()) {
    throw new SmtpConfigurationError(
      'Outbound email is not configured on this server (SMTP_RELAY_HOST is unset), so nothing can be sent. ' +
        'Nothing was filed; an operator must configure a relay.',
    );
  }

  const key = message.idempotencyKey;
  const messageId = key ? idempotentMessageId(message.userId, key) : `<${uuidv4()}@${EMAIL_DOMAIN}>`;

  if (key) {
    const existing = await emailService.findMessageByRfcMessageId(message.userId, messageId);
    if (existing) return { message: existing, created: false };
  }

  let outboxId: string | undefined;
  try {
    const filed = await emailService.fileOutgoingMessage(
      message.userId,
      {
        messageId,
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        text: message.text,
        html: message.html,
        inReplyTo: message.inReplyTo,
        references: message.references,
        attachments: message.attachments,
      },
      async (tx, rowId) => {
        outboxId = await insertDeliveryJob(tx, {
          userId: message.userId,
          messageRowId: rowId,
          messageId,
          idempotencyKey: key,
          payload: payloadOf(message),
        });
      },
    );
    if (outboxId) scheduleEmailDelivery(outboxId);
    return { message: filed, created: true };
  } catch (error) {
    // Another request with this key won the unique index; its transaction has
    // committed (Postgres reports the conflict only then), so its message is
    // readable now. Ours rolled back, message and all.
    if (key && isUniqueViolation(error)) {
      const existing = await emailService.findMessageByRfcMessageId(message.userId, messageId);
      if (existing) return { message: existing, created: false };
      // The key belongs to a send accepted before messages were filed first,
      // still waiting on the sweep. It will be filed when it is delivered.
      throw new ConflictError('A message with this Idempotency-Key is already being sent');
    }
    throw error;
  }
}

/**
 * Promise delivery of a message ALREADY filed in Sent — a scheduled send whose
 * time has come. Creates its job, marks it `sending`, and starts delivery.
 */
export async function deliverFiledMessage(input: {
  userId: string;
  messageRowId: string;
  messageId: string;
  payload: EmailOutboxPayload;
}): Promise<void> {
  const db = getDb();
  const now = new Date();
  const outboxId = await db.transaction(async (tx) => {
    const [taken] = await tx
      .update(messages)
      .set({
        scheduledAt: null,
        deliveryState: 'sending',
        deliveryAttempts: 0,
        deliveryError: null,
        deliveryErrorCode: null,
        deliveryNextAttemptAt: null,
        deliveryUpdatedAt: now,
      })
      // Only the sweep that clears `scheduled_at` hands it over; a second one
      // racing it finds nothing to take and creates no second job.
      .where(and(
        eq(messages.id, input.messageRowId),
        eq(messages.userId, input.userId),
        isNotNull(messages.scheduledAt),
      ))
      .returning({ id: messages.id });
    if (!taken) return null;
    return insertDeliveryJob(tx, input);
  });
  if (!outboxId) return;
  scheduleEmailDelivery(outboxId);
  await announce(input.userId, input.messageRowId);
}

/**
 * Why a delivery attempt failed, in the contract's vocabulary. Mirrors
 * {@link isRetryableSmtpFailure}: everything but the last is permanent.
 */
export function deliveryErrorCode(error: unknown): EmailDeliveryErrorCode {
  if (error instanceof SmtpConfigurationError) return 'relay_unconfigured';
  if (isAuthenticationFailure(error)) return 'relay_auth';
  if (!isRetryableSmtpFailure(error)) return 'rejected';
  return 'relay_unavailable';
}

/** The wait before the attempt after `attempt` (1-based). */
function retryDelayAfter(attempt: number): number {
  const delays = SMTP_OUTBOUND_CONFIG.retryDelays;
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];
}

/** Tell every client showing this message that its delivery moved. */
async function announce(userId: string, messageRowId: string): Promise<void> {
  const [row] = await getDb()
    .select({ mailboxId: messages.mailboxId })
    .from(messages)
    .where(eq(messages.id, messageRowId))
    .limit(1);
  if (!row) return;
  await emitEmailChanged({ userId, id: messageRowId, mailboxIds: [row.mailboxId], reason: 'delivery' });
}

/** Claim one job and deliver it. The queue's processor. */
export async function deliverEmail(outboxId: string): Promise<void> {
  const row = await claimEmailOutboxById(outboxId, workerId);
  if (!row) return;
  await deliverClaimed(row);
}

/**
 * Deliver a job this worker holds the lease on, and record the outcome.
 * Never throws for a relay failure — that is an outcome, not an error.
 */
export async function deliverClaimed(row: OutboxRow): Promise<void> {
  // Filed, but the message is gone: the user deleted it before it left.
  if (row.payload.filed && row.messageRowId === null) {
    await getDb().update(emailOutbox).set({ status: 'cancelled', lockedAt: null, lockedBy: null }).where(eq(emailOutbox.id, row.id));
    return;
  }

  if (row.messageRowId) {
    await getDb()
      .update(messages)
      .set({ deliveryAttempts: row.attempts, deliveryUpdatedAt: new Date() })
      .where(eq(messages.id, row.messageRowId));
  }

  let relayMessageId: string | null;
  try {
    ({ relayMessageId } = await smtpOutbound.sendRaw({
      ...row.payload,
      userId: row.userId,
      messageId: row.messageId,
    }));
  } catch (error) {
    await recordFailure(row, error);
    return;
  }
  await recordDelivered(row, relayMessageId);
}

async function recordDelivered(row: OutboxRow, relayMessageId: string | null): Promise<void> {
  const db = getDb();
  if (row.messageRowId) {
    const messageRowId = row.messageRowId;
    await db.transaction(async (tx) => {
      await markEmailOutboxSent(row.id, tx);
      await tx
        .update(messages)
        .set({
          relayMessageId,
          deliveryState: 'sent',
          deliveryAttempts: row.attempts,
          deliveryError: null,
          deliveryErrorCode: null,
          deliveryNextAttemptAt: null,
          deliveryUpdatedAt: new Date(),
        })
        .where(eq(messages.id, messageRowId));
    });
    await announce(row.userId, messageRowId);
  } else {
    // Accepted before sends were filed first: its Sent row is written now. The
    // stable Message-ID makes a crash between SMTP and this write idempotent.
    const existing = await emailService.findMessageByRfcMessageId(row.userId, row.messageId);
    if (!existing) {
      await emailService.storeSentMessage(row.userId, {
        ...row.payload,
        messageId: row.messageId,
        relayMessageId,
        attempts: row.attempts,
      });
    }
    await markEmailOutboxSent(row.id);
  }
  logger.info('Email delivered', { outboxId: row.id, messageId: row.messageId, attempt: row.attempts });
}

async function recordFailure(row: OutboxRow, error: unknown): Promise<void> {
  const code = deliveryErrorCode(error);
  const retryable = code === 'relay_unavailable';
  const budgetSpent = row.attempts >= EMAIL_OUTBOX_MAX_ATTEMPTS;
  const db = getDb();
  const now = new Date();
  const failure = error instanceof Error ? error : new Error(String(error));

  if (!retryable || budgetSpent) {
    const finalCode: EmailDeliveryErrorCode = retryable ? 'retries_exhausted' : code;
    await db.transaction(async (tx) => {
      await markEmailOutboxTerminal(row.id, error, tx);
      if (row.messageRowId) {
        await tx
          .update(messages)
          .set({
            deliveryState: 'failed',
            deliveryAttempts: row.attempts,
            deliveryError: errorText(error),
            deliveryErrorCode: finalCode,
            deliveryNextAttemptAt: null,
            deliveryUpdatedAt: now,
          })
          .where(eq(messages.id, row.messageRowId));
      }
    });
    logger.error('Outbound email not delivered; no further attempts', failure, {
      outboxId: row.id,
      messageId: row.messageId,
      attempt: row.attempts,
      code: finalCode,
    });
  } else {
    const delay = retryDelayAfter(row.attempts);
    const nextAttemptAt = new Date(now.getTime() + delay);
    await db.transaction(async (tx) => {
      await markEmailOutboxFailed(row.id, error, nextAttemptAt, tx);
      if (row.messageRowId) {
        await tx
          .update(messages)
          .set({
            deliveryState: 'retrying',
            deliveryAttempts: row.attempts,
            deliveryError: errorText(error),
            deliveryErrorCode: code,
            deliveryNextAttemptAt: nextAttemptAt,
            deliveryUpdatedAt: now,
          })
          .where(eq(messages.id, row.messageRowId));
      }
    });
    scheduleEmailDelivery(row.id, delay);
    logger.warn('Outbound email delivery failed; will retry', {
      outboxId: row.id,
      messageId: row.messageId,
      attempt: row.attempts,
      nextAttemptAt: nextAttemptAt.toISOString(),
      error: failure.message,
    });
  }

  if (row.messageRowId) await announce(row.userId, row.messageRowId);
}

/**
 * Try a failed message again, with a fresh budget — after an operator fixed
 * the relay, or after the recipient's server stopped refusing.
 */
export async function retryDelivery(userId: string, messageRowId: string): Promise<MessageDto> {
  const job = await findDeliveryJobForMessage(userId, messageRowId);
  if (!job) throw new NotFoundError('This message has no delivery to retry');
  await retryJob(userId, job.id, messageRowId);
  const dto = await emailService.findMessageByRfcMessageId(userId, job.messageId);
  if (!dto) throw new NotFoundError('Message not found');
  return dto;
}

async function retryJob(userId: string, outboxId: string, messageRowId: string | null): Promise<EmailOutboxDto> {
  const now = new Date();
  const dto = await getDb().transaction(async (tx) => {
    const retried = await retryEmailOutbox(userId, outboxId, tx);
    if (messageRowId) {
      await tx
        .update(messages)
        .set({
          deliveryState: 'sending',
          deliveryAttempts: 0,
          deliveryError: null,
          deliveryErrorCode: null,
          deliveryNextAttemptAt: null,
          deliveryUpdatedAt: now,
        })
        .where(and(eq(messages.id, messageRowId), eq(messages.userId, userId)));
    }
    return retried;
  });
  scheduleEmailDelivery(outboxId);
  if (messageRowId) await announce(userId, messageRowId);
  return dto;
}

/** `POST /email/outbox/:id/retry` — the outbox-shaped view of {@link retryDelivery}. */
export async function retryDeliveryJob(userId: string, outboxId: string): Promise<EmailOutboxDto> {
  const [job] = await getDb()
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.id, outboxId), eq(emailOutbox.userId, userId)))
    .limit(1);
  if (!job) throw new NotFoundError('Outbound message not found or cannot be retried');
  return retryJob(userId, outboxId, job.messageRowId);
}

/**
 * Stop a message that has not left yet. It stays in Sent, `failed`, saying so —
 * a cancelled send that silently vanished would look like one that went out.
 */
export async function cancelDeliveryJob(userId: string, outboxId: string): Promise<EmailOutboxDto> {
  const now = new Date();
  const { dto, messageRowId } = await getDb().transaction(async (tx) => {
    const cancelled = await cancelEmailOutbox(userId, outboxId, tx);
    const [job] = await tx
      .select({ messageRowId: emailOutbox.messageRowId })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, outboxId))
      .limit(1);
    if (job?.messageRowId) {
      await tx
        .update(messages)
        .set({
          deliveryState: 'failed',
          deliveryError: 'Sending was cancelled.',
          deliveryErrorCode: null,
          deliveryNextAttemptAt: null,
          deliveryUpdatedAt: now,
        })
        .where(eq(messages.id, job.messageRowId));
    }
    return { dto: cancelled, messageRowId: job?.messageRowId ?? null };
  });
  if (messageRowId) await announce(userId, messageRowId);
  return dto;
}


registerEmailDeliveryProcessor(deliverEmail);
