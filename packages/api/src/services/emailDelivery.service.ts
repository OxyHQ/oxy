/**
 * A user's message: filed first, delivered afterwards.
 *
 * `POST /email/messages` used to relay inside the request. A relay slower than
 * the client's timeout made the client report a failure while the server was
 * still sending, and the user pressed Send again; a relay that refused parked
 * the message in the outbox and answered 202 `queued`, which a client could
 * not tell from success.
 *
 * Now the request only ACCEPTS the message — claims its outbox row and files it
 * in Sent linked to that row, in one transaction, and answers — and the relay
 * is spoken to afterwards, on the same task, under the claim's lease. Every
 * outcome lands on the outbox row, which IS the message's `delivery`
 * (`toMessageDelivery`), and each one emits `email:changed` with reason
 * `delivery` so every open view re-reads it.
 *
 * The outbox worker is unchanged in role: it retries what failed transiently,
 * and adopts a claim whose task died before it could deliver.
 */

import { and, eq, like, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { sqlStateOf } from '@oxy.so/db';
import { EMAIL_DOMAIN, SMTP_OUTBOUND_CONFIG } from '../config/email.config';
import { getDb } from '../config/postgres';
import type { emailOutbox, EmailOutboxPayload } from '../db/schema/emailOutbox';
import { messages } from '../db/schema/messages';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../utils/error';
import { logger } from '../utils/logger';
import { emailService, type MessageDto } from './email.service';
import { idempotentMessageId, refuseReusedSendKey } from './emailIdempotency';
import {
  claimDeliveryRetry,
  claimSend,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  failAbandonedDeliveries as failAbandonedOutboxRows,
  findDeliveryForMessage,
  findSendClaim,
  linkOutboxToMessage,
  markDeliveriesBounced,
  markEmailOutboxFailed,
  markEmailOutboxSent,
  markEmailOutboxTerminal,
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

/** Postgres `lock_not_available`: a `lock_timeout` ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * How long accepting a send waits for a lock. The one wait that matters is a
 * repeat of the key behind the first request's uncommitted claim, which a
 * healthy request holds for the milliseconds filing takes. Unbounded, a first
 * request whose task stopped answering with its TCP connection still open made
 * every repeat, on every task, hold a pooled connection until keepalive fired.
 */
const ACCEPT_LOCK_TIMEOUT = '5s';

/**
 * How long the accept transaction may sit idle before Postgres ends its
 * session. It never waits on anything but its own statements, so idling means
 * its task stopped answering — and ending the session frees the claim it holds
 * for the repeat that is waiting on it.
 */
const ACCEPT_IDLE_TIMEOUT = '15s';

/** A claim taken together with its Sent copy, or the claim that beat it. */
type FiledClaim =
  | { claimed: true; row: EmailOutboxRow; messageRowId: string }
  | { claimed: false; existing: EmailOutboxRow };

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
 * filing or sending again. The repeat must be the same message: the key with
 * a different one is refused (422).
 *
 * Refused synchronously, before anything is filed: no relay configured at all
 * (503, which no amount of waiting fixes), a Sent copy that does not fit the
 * quota, and a repeat that waited too long on the first request's claim (503,
 * retryable with the same key). Every other failure is the relay's, and is
 * reported on the message.
 */
export async function acceptOutboundMessage(message: OutboundMessage): Promise<AcceptedSend> {
  if (!isOutboundRelayConfigured()) throw missingRelayError();

  const key = message.idempotencyKey;
  const messageId = key
    ? idempotentMessageId(message.userId, key)
    : `<${randomUUID()}@${EMAIL_DOMAIN}>`;
  const payload = outboxPayload(message);

  if (key) {
    const claimed = await findSendClaim(message.userId, key);
    if (claimed) return answerRepeat(message.userId, claimed, payload);
    // Filed under this key with no claim: a scheduled send not yet due, or one
    // delivered before sends were claimed. The Sent row is what it asked for.
    const filed = await emailService.findMessageByRfcMessageId(message.userId, messageId);
    if (filed) {
      refuseReusedSendKey(
        await emailService.filedOutboundPayload(message.userId, filed.id),
        payload,
      );
      return { messageId, messageRowId: filed.id, delivery: filed.delivery ?? null };
    }
  }

  // The claim and the Sent copy commit together. A repeat of the key racing
  // this one waits on the claim until it commits, so it can only ever answer
  // with the filed row; a refusal (a full mailbox, usually) rolls the claim
  // back with the filing, so no answer can promise a send that never happens
  // and the key is free to try again once the cause is fixed.
  const target = await emailService.sentFilingTarget(message.userId);
  let claim: FiledClaim;
  try {
    claim = await getDb().transaction(async (tx): Promise<FiledClaim> => {
      await tx.execute(
        sql`select set_config('lock_timeout', ${ACCEPT_LOCK_TIMEOUT}, true),
                   set_config('idle_in_transaction_session_timeout', ${ACCEPT_IDLE_TIMEOUT}, true)`,
      );
      const taken = await claimSend(
        {
          userId: message.userId,
          idempotencyKey: key,
          messageId,
          payload,
          owner: `request:${randomUUID()}`,
        },
        tx,
      );
      if (!taken.claimed) return taken;
      const messageRowId = await emailService.fileSentMessage(tx, message.userId, target, {
        ...payload,
        messageId,
        relayMessageId: null,
        size: bodySize(message),
        deliveryId: taken.row.id,
      });
      return { claimed: true, row: { ...taken.row, messageRowId }, messageRowId };
    });
  } catch (error) {
    if (sqlStateOf(error) !== LOCK_NOT_AVAILABLE) throw error;
    // Almost always a repeat of this key waiting behind a first request that
    // is still filing — or whose task stopped answering with its transaction
    // open. Nothing was claimed or filed here; the same key, retried, answers
    // with the first send or makes the attempt itself.
    throw new ServiceUnavailableError(
      'This message is still being accepted by an earlier request. Retry with the same Idempotency-Key.',
      { retryable: true },
    );
  }

  if (!claim.claimed) return answerRepeat(message.userId, claim.existing, payload);

  const { row, messageRowId } = claim;
  // A second device showing the Sent folder sees the message the moment it is
  // filed, and its first read already says whether it has left.
  await emitEmailChanged({
    userId: message.userId,
    id: messageRowId,
    mailboxIds: [target.mailboxId],
    reason: 'sent',
  });
  startDelivery(row);
  return { messageId, messageRowId, delivery: toMessageDelivery(row) };
}

/**
 * Answer a repeat of an Idempotency-Key with the send it already claimed — if
 * it asks for the same message ({@link refuseReusedSendKey}).
 */
async function answerRepeat(
  userId: string,
  existing: EmailOutboxRow,
  requested: EmailOutboxPayload,
): Promise<AcceptedSend> {
  refuseReusedSendKey(existing.payload, requested);
  const messageRowId =
    existing.messageRowId ??
    // Accepted before sends were filed first.
    (await emailService.findMessageByRfcMessageId(userId, existing.messageId))?.id ??
    null;
  return { messageId: existing.messageId, messageRowId, delivery: toMessageDelivery(existing) };
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

  // Nothing between the relay's acceptance and marking the row sent may throw:
  // a row left `processing` after an accepted send is adopted by the worker
  // when its lease runs out, and sent again. Both writes to the Sent copy are
  // therefore best effort — the relay id before the mark, so a reader that
  // sees `sent` also finds it; a missing Sent copy after it.
  let messageRowId = row.messageRowId;
  if (messageRowId && relayMessageId) {
    await emailService
      .recordRelayMessageId(row.userId, messageRowId, relayMessageId)
      .catch((error) =>
        logger.warn('Could not record the relay Message-ID on the Sent row', {
          outboxId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  await markEmailOutboxSent(row.id);
  messageRowId ??= await fileUnfiledSentCopy(row, relayMessageId);
  await emitDeliveryChanged(row.userId, messageRowId);
  return 'sent';
}

/**
 * File the Sent copy of a delivered message that has none: accepted before
 * sends were filed first, or its Sent row was deleted since. Best effort — the
 * message has left, and a mailbox over its quota must not make it look as if
 * it had not. The stable RFC Message-ID makes filing it idempotent.
 */
async function fileUnfiledSentCopy(
  row: EmailOutboxRow,
  relayMessageId: string | null,
): Promise<string | null> {
  try {
    const existing = await emailService.findMessageByRfcMessageId(row.userId, row.messageId);
    if (existing) {
      await linkOutboxToMessage(row.id, existing.id);
      return existing.id;
    }
    const filed = await emailService.storeSentMessage(row.userId, {
      ...row.payload,
      messageId: row.messageId,
      relayMessageId,
      size: bodySize(row.payload),
      deliveryId: row.id,
    });
    return filed.id;
  } catch (error) {
    logger.error(
      'Delivered, but its Sent copy could not be filed',
      error instanceof Error ? error : new Error(String(error)),
      { outboxId: row.id, messageId: row.messageId },
    );
    return null;
  }
}

/**
 * Settle the deliveries whose task died mid-attempt with no attempts left —
 * the worker no longer adopts them — and tell every open view of them.
 */
export async function failAbandonedDeliveries(): Promise<number> {
  const settled = await failAbandonedOutboxRows();
  for (const { userId, messageRowId } of settled) await emitDeliveryChanged(userId, messageRowId);
  return settled.length;
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
