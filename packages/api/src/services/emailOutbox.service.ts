import { and, asc, desc, eq, inArray, isNull, lte, lt, or, sql } from 'drizzle-orm';
import type { EmailDeliveryState } from '@oxy.so/contracts';
import { getDb, type Database, type DatabaseOrTransaction } from '../config/postgres';
import {
  emailOutbox,
  type EmailDeliveryErrorCode,
  type EmailOutboxPayload,
  type EmailOutboxStatus,
} from '../db/schema/emailOutbox';
import { ConflictError, NotFoundError } from '../utils/error';

const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface EmailOutboxDto {
  id: string;
  messageId: string;
  status: EmailOutboxStatus;
  attempts: number;
  /** The retry budget. `attempts >= maxAttempts` means no worker will claim this row again. */
  maxAttempts: number;
  /**
   * No further delivery attempt will happen on its own — either the retry
   * budget is spent or the failure was permanent (bad configuration, rejected
   * credential, 5xx refusal). A client MUST present this differently from
   * "still trying": the difference is whether waiting helps.
   *
   * A user can still {@link retryEmailOutbox} it, which refills the budget —
   * exactly what you want after an operator fixes the relay.
   */
  terminal: boolean;
  nextAttemptAt: Date;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface EnqueueEmailOutboxInput {
  userId: string;
  messageRowId?: string;
  messageId: string;
  idempotencyKey?: string;
  payload: EmailOutboxPayload;
  nextAttemptAt?: Date;
}

function toDto(row: typeof emailOutbox.$inferSelect): EmailOutboxDto {
  return {
    id: row.id,
    messageId: row.messageId,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: MAX_ATTEMPTS,
    terminal: row.status === 'failed' && row.attempts >= MAX_ATTEMPTS,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type EmailOutboxRow = typeof emailOutbox.$inferSelect;

/**
 * Where a message the user sent stands — the `delivery` on its Sent copy.
 * The wire shape is `emailMessageDeliverySchema` in `@oxy.so/contracts`.
 */
export interface MessageDeliveryDto {
  state: EmailDeliveryState;
  attempts: number;
  maxAttempts: number;
  /** Set only while `retrying`: when the worker will try again. */
  nextAttemptAt: Date | null;
  /** The relay's own words, while there is something to explain. */
  error: string | null;
  errorCode: EmailDeliveryErrorCode | null;
  updatedAt: Date;
}

/**
 * Project one outbox row onto the message it delivers.
 *
 * The outbox is a worker's state machine; a person asks one question of it —
 * did it leave? — and these four states answer it:
 *  - `pending`/`processing` on the first attempt is `sending`; on a later one,
 *    `retrying` (being retried right now, so no `nextAttemptAt`);
 *  - `failed` with budget left is `retrying`; with none, `failed`;
 *  - `cancelled` is `failed` with `errorCode: 'cancelled'`;
 *  - `sent` is `sent`.
 *
 * A transient failure that spent the whole budget is reported as
 * `retries_exhausted`, not as the last attempt's `relay_unavailable`: the
 * difference is whether waiting will help.
 */
export function toMessageDelivery(row: EmailOutboxRow): MessageDeliveryDto {
  const base = { attempts: row.attempts, maxAttempts: MAX_ATTEMPTS, updatedAt: row.updatedAt };
  switch (row.status) {
    case 'sent':
      return { ...base, state: 'sent', nextAttemptAt: null, error: null, errorCode: null };
    case 'cancelled':
      return { ...base, state: 'failed', nextAttemptAt: null, error: null, errorCode: 'cancelled' };
    case 'failed': {
      const terminal = row.attempts >= MAX_ATTEMPTS;
      const errorCode =
        terminal && row.errorCode === 'relay_unavailable' ? 'retries_exhausted' : row.errorCode;
      return {
        ...base,
        state: terminal ? 'failed' : 'retrying',
        nextAttemptAt: terminal ? null : row.nextAttemptAt,
        error: row.lastError,
        errorCode: errorCode ?? null,
      };
    }
    case 'pending':
    case 'processing':
      return {
        ...base,
        state: row.attempts <= 1 ? 'sending' : 'retrying',
        nextAttemptAt: null,
        error: null,
        errorCode: null,
      };
  }
}

/**
 * The delivery of each of these message rows that has one — received mail and
 * mail sent before delivery was tracked have none. When a row somehow has two
 * deliveries, the newest one is the truth.
 */
export async function loadMessageDeliveries(
  db: Database,
  messageRowIds: string[],
): Promise<Map<string, MessageDeliveryDto>> {
  const deliveries = new Map<string, MessageDeliveryDto>();
  if (messageRowIds.length === 0) return deliveries;
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(inArray(emailOutbox.messageRowId, messageRowIds))
    .orderBy(asc(emailOutbox.createdAt));
  for (const row of rows) {
    if (row.messageRowId) deliveries.set(row.messageRowId, toMessageDelivery(row));
  }
  return deliveries;
}

/** The newest delivery row of one of this user's messages. */
export async function findDeliveryForMessage(
  userId: string,
  messageRowId: string,
): Promise<EmailOutboxRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.userId, userId), eq(emailOutbox.messageRowId, messageRowId)))
    .orderBy(desc(emailOutbox.createdAt))
    .limit(1);
  return row;
}

export async function enqueueEmailOutbox(input: EnqueueEmailOutboxInput): Promise<EmailOutboxDto> {
  const db = getDb();
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.userId, input.userId),
          eq(emailOutbox.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) return toDto(existing);
  }

  try {
    const [created] = await db
      .insert(emailOutbox)
      .values({
        userId: input.userId,
        messageRowId: input.messageRowId,
        messageId: input.messageId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        nextAttemptAt: input.nextAttemptAt ?? new Date(),
      })
      .returning();
    return toDto(created);
  } catch (error) {
    if (input.idempotencyKey) {
      const [existing] = await db
        .select()
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.userId, input.userId),
            eq(emailOutbox.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) return toDto(existing);
    }
    throw error;
  }
}

/** The outcome of {@link claimSend}. */
export type SendClaim =
  | { claimed: true; row: EmailOutboxRow }
  | { claimed: false; existing: EmailOutboxRow };

/**
 * Take the durable, cross-process claim on ONE send BEFORE anything is said to
 * a relay — and, with an `Idempotency-Key`, before anything is filed in Sent.
 *
 * The row is created already `processing` and leased to the caller, so the
 * outbox worker leaves it alone while the caller files and delivers it — and
 * adopts it after the lease expires if the caller died mid-flight. A second
 * request with the same key (a client retry after its own timeout, a double
 * press, a retry that landed on another API task) loses the unique-index race
 * and gets the existing row instead of sending again.
 *
 * Claimed inside the transaction that files the Sent copy (`acceptOutboundMessage`),
 * the claim and the filing commit as one: the loser's insert waits on the
 * unique index until the holder commits — and then reads a row already linked
 * to its Sent copy — or rolls back, and then claims the send itself.
 *
 * This replaces a per-process in-flight map plus a Redis result cache written
 * only AFTER the relay answered: two tasks could both miss both, and the same
 * reply went out twice.
 */
export async function claimSend(
  input: {
    userId: string;
    idempotencyKey?: string;
    messageId: string;
    /** The Sent row this delivers, when it is already filed (a scheduled send). */
    messageRowId?: string;
    payload: EmailOutboxPayload;
    owner: string;
  },
  /** A transaction to claim inside, when the claim must commit with another write. */
  db: DatabaseOrTransaction = getDb(),
): Promise<SendClaim> {
  const now = new Date();
  const [created] = await db
    .insert(emailOutbox)
    .values({
      userId: input.userId,
      messageRowId: input.messageRowId,
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      status: 'processing',
      attempts: 1,
      lockedAt: now,
      lockedBy: input.owner,
      nextAttemptAt: now,
    })
    .onConflictDoNothing({
      target: [emailOutbox.userId, emailOutbox.idempotencyKey],
      where: sql`${emailOutbox.idempotencyKey} is not null`,
    })
    .returning();
  if (created) return { claimed: true, row: created };
  if (!input.idempotencyKey) {
    throw new Error('Outbox insert without an idempotency key conflicted');
  }

  const [existing] = await db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.userId, input.userId),
        eq(emailOutbox.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) {
    // The holder's row went away between our insert and this read. Take the
    // claim ourselves.
    return claimSend(input, db);
  }
  return { claimed: false, existing };
}

/**
 * Record which Sent row this delivery is the delivery of — on the transaction
 * that filed the row, when there is one: another connection cannot see a claim
 * that transaction has not committed, and would link nothing.
 */
export async function linkOutboxToMessage(
  outboxId: string,
  messageRowId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(emailOutbox).set({ messageRowId }).where(eq(emailOutbox.id, outboxId));
}

export async function claimEmailOutbox(
  workerId: string,
): Promise<typeof emailOutbox.$inferSelect | undefined> {
  const db = getDb();
  const now = new Date();
  const leaseExpiredAt = new Date(now.getTime() - LEASE_MS);
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(emailOutbox)
      .where(
        or(
          and(
            inArray(emailOutbox.status, ['pending', 'failed']),
            lte(emailOutbox.nextAttemptAt, now),
            lt(emailOutbox.attempts, MAX_ATTEMPTS),
          ),
          and(eq(emailOutbox.status, 'processing'), isNull(emailOutbox.lockedAt)),
          and(eq(emailOutbox.status, 'processing'), lt(emailOutbox.lockedAt, leaseExpiredAt)),
        ),
      )
      .orderBy(asc(emailOutbox.nextAttemptAt), asc(emailOutbox.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) return undefined;

    const [claimed] = await tx
      .update(emailOutbox)
      .set({
        status: 'processing',
        lockedAt: now,
        lockedBy: workerId,
        attempts: sql`${emailOutbox.attempts} + 1`,
        lastError: null,
        errorCode: null,
      })
      .where(eq(emailOutbox.id, candidate.id))
      .returning();
    return claimed;
  });
}

export async function markEmailOutboxSent(id: string): Promise<void> {
  await getDb()
    .update(emailOutbox)
    .set({
      status: 'sent',
      sentAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      errorCode: null,
    })
    .where(eq(emailOutbox.id, id));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
}

/** Record a TRANSIENT failure and schedule the next attempt. */
export async function markEmailOutboxFailed(
  id: string,
  error: unknown,
  nextAttemptAt: Date,
  errorCode: EmailDeliveryErrorCode = 'relay_unavailable',
): Promise<void> {
  await getDb()
    .update(emailOutbox)
    .set({
      status: 'failed',
      nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      lastError: errorText(error),
      errorCode,
    })
    .where(eq(emailOutbox.id, id));
}

/**
 * Record a PERMANENT failure: stop retrying now, instead of burning the whole
 * retry ladder on a condition no amount of waiting can change (an unset relay,
 * a rejected credential, a 5xx refusal).
 *
 * Implemented by spending the retry budget rather than by adding a status,
 * because `attempts < MAX_ATTEMPTS` is already the single gate
 * {@link claimEmailOutbox} gives a worker — this makes the claim query say
 * "never again" without a schema migration, and {@link retryEmailOutbox}
 * refills it when an operator has fixed the cause. `attempts` is a budget, not
 * a history counter; `lastError` carries what actually happened.
 */
export async function markEmailOutboxTerminal(
  id: string,
  error: unknown,
  errorCode: EmailDeliveryErrorCode,
): Promise<void> {
  await getDb()
    .update(emailOutbox)
    .set({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      lockedAt: null,
      lockedBy: null,
      lastError: errorText(error),
      errorCode,
    })
    .where(eq(emailOutbox.id, id));
}

export async function listEmailOutbox(userId: string, limit = 50): Promise<EmailOutboxDto[]> {
  const rows = await getDb()
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.userId, userId))
    .orderBy(desc(emailOutbox.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(toDto);
}

export async function retryEmailOutbox(userId: string, id: string): Promise<EmailOutboxDto> {
  const [updated] = await getDb()
    .update(emailOutbox)
    .set({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      errorCode: null,
    })
    .where(
      and(
        eq(emailOutbox.id, id),
        eq(emailOutbox.userId, userId),
        inArray(emailOutbox.status, ['failed', 'cancelled']),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError('Outbound message not found or cannot be retried');
  return toDto(updated);
}

/**
 * Claim a failed or cancelled delivery for an immediate new attempt, with a
 * fresh budget, leased to `owner` exactly as {@link claimSend} leases a new
 * one. Returns undefined when the row is not in a state a retry applies to —
 * it is being delivered, or it already was.
 */
export async function claimDeliveryRetry(
  userId: string,
  outboxId: string,
  owner: string,
): Promise<EmailOutboxRow | undefined> {
  const now = new Date();
  const [claimed] = await getDb()
    .update(emailOutbox)
    .set({
      status: 'processing',
      attempts: 1,
      nextAttemptAt: now,
      lockedAt: now,
      lockedBy: owner,
      lastError: null,
      errorCode: null,
    })
    .where(
      and(
        eq(emailOutbox.id, outboxId),
        eq(emailOutbox.userId, userId),
        inArray(emailOutbox.status, ['failed', 'cancelled']),
      ),
    )
    .returning();
  return claimed;
}

/**
 * The relay took it, and then a recipient's server refused it for good — an
 * SES permanent bounce. That is the one outcome after `sent` that still means
 * "it did not arrive", so the message says so instead of reading as delivered.
 *
 * Only a `sent` delivery changes: a bounce never resurrects a cancelled one.
 * The budget is spent, so no worker re-offers mail to an address that has just
 * been suppressed for refusing it. Returns the message rows that changed.
 */
export async function markDeliveriesBounced(
  userId: string,
  messageRowIds: string[],
  detail: string,
): Promise<string[]> {
  if (messageRowIds.length === 0) return [];
  const rows = await getDb()
    .update(emailOutbox)
    .set({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      lastError: detail.slice(0, 2000),
      errorCode: 'bounced',
    })
    .where(
      and(
        eq(emailOutbox.userId, userId),
        inArray(emailOutbox.messageRowId, messageRowIds),
        eq(emailOutbox.status, 'sent'),
      ),
    )
    .returning({ messageRowId: emailOutbox.messageRowId });
  return rows.map((r) => r.messageRowId).filter((id): id is string => id !== null);
}

export async function cancelEmailOutbox(userId: string, id: string): Promise<EmailOutboxDto> {
  const [updated] = await getDb()
    .update(emailOutbox)
    .set({ status: 'cancelled', lockedAt: null, lockedBy: null })
    .where(
      and(
        eq(emailOutbox.id, id),
        eq(emailOutbox.userId, userId),
        inArray(emailOutbox.status, ['pending', 'failed']),
      ),
    )
    .returning();
  if (!updated) throw new ConflictError('Outbound message is already being delivered or completed');
  return toDto(updated);
}

export { MAX_ATTEMPTS as EMAIL_OUTBOX_MAX_ATTEMPTS };
