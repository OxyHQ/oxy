/**
 * A user's message: filed first, delivered afterwards.
 *
 * `POST /email/messages` used to relay inside the request. A relay slower than
 * the client's timeout made the client report a failure while the server was
 * still sending, and the user pressed Send again; a relay that refused parked
 * the message in the outbox and answered 202 `queued`, which a client could
 * not tell from success.
 *
 * Now the request only ACCEPTS the message — claims its outbox row, files it in
 * Sent linked to that row, and answers — and the relay is spoken to afterwards,
 * on the same task, under the claim's lease. Every outcome lands on the outbox
 * row, which IS the message's `delivery` (`toMessageDelivery`), and each one
 * emits `email:changed` with reason `delivery` so every open view re-reads it.
 *
 * The outbox worker is unchanged in role: it retries what failed transiently,
 * and adopts a claim whose task died before it could deliver.
 */

import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EMAIL_DOMAIN, SMTP_OUTBOUND_CONFIG } from '../config/email.config';
import { getDb } from '../config/postgres';
import type { emailOutbox } from '../db/schema/emailOutbox';
import { messages } from '../db/schema/messages';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';
import { emailService, type MessageDto } from './email.service';
import { idempotentMessageId } from './emailIdempotency';
import {
  claimDeliveryRetry,
  claimSend,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  findDeliveryForMessage,
  markDeliveriesBounced,
  markEmailOutboxFailed,
  markEmailOutboxSent,
  markEmailOutboxTerminal,
  releaseSendClaim,
  toMessageDelivery,
  type MessageDeliveryDto,
} from './emailOutbox.service';
import { findSuppressed } from './emailSuppression.service';
import { emitEmailChanged } from './inboxRealtime';
import {
  deliveryErrorCode,
  isOutboundRelayConfigured,
  missingRelayError,
  type OutboundMessage,
  outboxPayload,
  smtpOutbound,
} from './smtp.outbound';

type EmailOutboxRow = typeof emailOutbox.$inferSelect;

/** What accepting a send tells the caller. */
export interface AcceptedSend {
  /** The RFC 5322 Message-ID it goes out under. */
  messageId: string;
  /** The Sent row, when it is filed (always, but for a send accepted before filing existed). */
  messageRowId: string | null;
  /** Where it stands now — `sending`, normally. Null for a legacy send with no delivery row. */
  delivery: MessageDeliveryDto | null;
}

/** The size the Sent copy counts toward, as the transport would send it. */
function bodySize(payload: { text?: string; html?: string }): number {
  return Buffer.byteLength(`${payload.text ?? ''}${payload.html ?? ''}`, 'utf8');
}

/**
 * Accept a user's message: claim its delivery, file it in Sent, and start
 * delivering it without waiting for the relay.
 *
 * With an `idempotencyKey`, a repeat of the same key — a client retry, a double
 * press, a retry on another task — returns the first acceptance instead of
 * filing or sending again.
 *
 * Refused synchronously, before anything is filed: no relay configured at all
 * (503, which no amount of waiting fixes), and a Sent copy that does not fit
 * the quota. Every other failure is the relay's, and is reported on the
 * message.
 */
export async function acceptOutboundMessage(message: OutboundMessage): Promise<AcceptedSend> {
  if (!isOutboundRelayConfigured()) throw missingRelayError();

  const key = message.idempotencyKey;
  const messageId = key
    ? idempotentMessageId(message.userId, key)
    : `<${randomUUID()}@${EMAIL_DOMAIN}>`;

  if (key) {
    // Filed by an earlier attempt with this key, or delivered before deliveries
    // were linked to their Sent rows.
    const filed = await emailService.findMessageByRfcMessageId(message.userId, messageId);
    if (filed) return { messageId, messageRowId: filed.id, delivery: filed.delivery ?? null };
  }

  const claim = await claimSend({
    userId: message.userId,
    idempotencyKey: key,
    messageId,
    payload: outboxPayload(message),
    owner: `request:${randomUUID()}`,
  });
  if (!claim.claimed) {
    const existing = claim.existing;
    const messageRowId =
      existing.messageRowId ??
      (await emailService.findMessageByRfcMessageId(message.userId, existing.messageId))?.id ??
      null;
    return {
      messageId: existing.messageId,
      messageRowId,
      delivery: toMessageDelivery(existing),
    };
  }

  let filed: MessageDto;
  try {
    filed = await emailService.storeSentMessage(message.userId, {
      ...outboxPayload(message),
      messageId,
      relayMessageId: null,
      size: bodySize(message),
      deliveryId: claim.row.id,
    });
  } catch (error) {
    // Nothing was sent and nothing is filed: give the key back, so the sender
    // can try again once the cause (a full mailbox, usually) is fixed.
    await releaseSendClaim(claim.row.id);
    throw error;
  }

  const row = { ...claim.row, messageRowId: filed.id };
  startDelivery(row);
  return { messageId, messageRowId: filed.id, delivery: toMessageDelivery(row) };
}

/** Deliver a claimed row in the background; the outcome is on the row. */
export function startDelivery(row: EmailOutboxRow): void {
  void deliverClaimed(row).catch((error) => {
    // Bookkeeping failed after the relay was spoken to. The claim's lease
    // expires and the worker adopts the row — at-least-once, as ever.
    logger.error(
      'Outbound delivery bookkeeping failed',
      error instanceof Error ? error : new Error(String(error)),
      { outboxId: row.id, messageId: row.messageId },
    );
  });
}

/**
 * Tell every open view of a message that its delivery moved. The event
 * carries no state: a client re-reads the message.
 */
async function emitDeliveryChanged(userId: string, messageRowId: string | null): Promise<void> {
  if (!messageRowId) return;
  const mailboxId = await emailService.mailboxOf(userId, messageRowId);
  await emitEmailChanged({ userId, id: messageRowId, mailboxIds: [mailboxId], reason: 'delivery' });
}

/**
 * One delivery attempt of a row the caller holds the claim on, and its
 * outcome: `sent`, `retrying` (a transient failure with budget left) or
 * `failed` (a permanent refusal, or the budget spent).
 *
 * Only the relay call decides the outcome. A failure in the bookkeeping that
 * follows a relay's acceptance must never be recorded as a failed delivery —
 * the worker would send the message again.
 */
export async function deliverClaimed(row: EmailOutboxRow): Promise<'sent' | 'retrying' | 'failed'> {
  let relayMessageId: string | null;
  try {
    ({ relayMessageId } = await smtpOutbound.sendRaw({
      ...row.payload,
      userId: row.userId,
      messageId: row.messageId,
    }));
  } catch (error) {
    const outcome = await recordFailure(row, error);
    await emitDeliveryChanged(row.userId, row.messageRowId);
    return outcome;
  }

  let messageRowId = row.messageRowId;
  if (messageRowId) {
    if (relayMessageId) {
      await emailService
        .recordRelayMessageId(row.userId, messageRowId, relayMessageId)
        .catch((error) =>
          logger.warn('Could not record the relay Message-ID on the Sent row', {
            outboxId: row.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  } else {
    // Accepted before sends were filed first. A worker can also crash after
    // the relay accepted it and before the row was marked: the stable RFC
    // Message-ID makes filing it idempotent.
    const existing = await emailService.findMessageByRfcMessageId(row.userId, row.messageId);
    messageRowId =
      existing?.id ??
      (
        await emailService.storeSentMessage(row.userId, {
          ...row.payload,
          messageId: row.messageId,
          relayMessageId,
          size: bodySize(row.payload),
          deliveryId: row.id,
        })
      ).id;
  }
  await markEmailOutboxSent(row.id);
  await emitDeliveryChanged(row.userId, messageRowId);
  return 'sent';
}

async function recordFailure(row: EmailOutboxRow, error: unknown): Promise<'retrying' | 'failed'> {
  const errorCode = deliveryErrorCode(error);
  const context = { outboxId: row.id, messageId: row.messageId, attempt: row.attempts };
  const asError = error instanceof Error ? error : new Error(String(error));

  // A permanent failure must not walk the retry ladder: an unset relay used to
  // fail identically on all five attempts over five hours, then sit in
  // `failed` indistinguishable from a message waiting for its next try.
  if (errorCode !== 'relay_unavailable') {
    await markEmailOutboxTerminal(row.id, error, errorCode);
    logger.error('Outbound email permanently undeliverable; no further attempts', asError, context);
    return 'failed';
  }

  const delays = SMTP_OUTBOUND_CONFIG.retryDelays;
  const delay = delays[Math.min(Math.max(row.attempts - 1, 0), delays.length - 1)];
  await markEmailOutboxFailed(row.id, error, new Date(Date.now() + delay), errorCode);
  logger.error('Outbound email delivery failed; will retry', asError, context);
  return row.attempts >= EMAIL_OUTBOX_MAX_ATTEMPTS ? 'failed' : 'retrying';
}

/**
 * Try a message whose delivery failed again, now, with a fresh budget.
 *
 * Refused when a recipient has since been suppressed — a bounce or a complaint
 * — exactly as a new send to them would be: re-offering mail to an address that
 * refused it is how a sending domain gets suspended.
 */
export async function retryMessageDelivery(
  userId: string,
  messageRowId: string,
): Promise<MessageDto> {
  const row = await findDeliveryForMessage(userId, messageRowId);
  if (!row) throw new NotFoundError('This message has no delivery to retry');

  const { to, cc = [], bcc = [] } = row.payload;
  const suppressed = await findSuppressed(
    userId,
    [...to, ...cc, ...bcc].map((r) => r.address),
  );
  if (suppressed.length > 0) {
    throw new BadRequestError(
      `Cannot retry: mail to ${suppressed.map((s) => s.address).join(', ')} was refused ` +
        'before. Edit the message and send it as a new one.',
      { suppressed: suppressed.map((s) => ({ address: s.address, reason: s.reason })) },
    );
  }

  const claimed = await claimDeliveryRetry(userId, row.id, `retry:${randomUUID()}`);
  if (!claimed) throw new ConflictError('This message is already being delivered or was delivered');

  await emitDeliveryChanged(userId, messageRowId);
  startDelivery(claimed);
  const message = await emailService.getMessage(userId, messageRowId);
  if (!message) throw new NotFoundError('Message not found');
  return message;
}

/** An SES message id: hex groups joined by dashes, nothing a LIKE treats specially. */
const SES_MESSAGE_ID = /^[0-9a-f]+(?:-[0-9a-f]+)+$/i;

/**
 * A recipient's server refused a message after SES accepted it (a permanent
 * bounce). Marks the sender's Sent copy as not delivered, and tells their
 * devices. SES names the message by its own id, which the Sent row keeps as
 * `<{ses id}@{region}.amazonses.com>` (`relayMessageId.ts`).
 *
 * Returns how many messages changed; a bounce for mail that is not a user's
 * Sent message (a verification code, an unknown id) changes none.
 */
export async function recordBouncedDelivery(input: {
  userId: string;
  sesMessageId: string;
  detail: string;
}): Promise<number> {
  if (!SES_MESSAGE_ID.test(input.sesMessageId)) return 0;
  const rows = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.userId, input.userId),
        like(messages.relayMessageId, `<${input.sesMessageId}@%`),
      ),
    )
    .limit(5);
  const changed = await markDeliveriesBounced(
    input.userId,
    rows.map((r) => r.id),
    input.detail,
  );
  for (const messageRowId of changed) await emitDeliveryChanged(input.userId, messageRowId);
  return changed.length;
}
