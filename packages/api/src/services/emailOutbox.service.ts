import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { EmailDeliveryState } from '@oxy.so/contracts';
import { sqlStateOf } from '@oxy.so/db';
import {
  getDb,
  type Database,
  type DatabaseOrTransaction,
  type Transaction,
} from '../config/postgres';
import {
  emailOutbox,
  type EmailDeliveryErrorCode,
  type EmailOutboxPayload,
  type EmailOutboxStatus,
} from '../db/schema/emailOutbox';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../utils/error';

const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Postgres `lock_not_available`: a `lock_timeout` ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * How long taking a send's claim waits for a lock. The one wait that matters
 * is a repeat of the key behind the first request's uncommitted claim, which a
 * healthy request holds for the milliseconds filing takes. Unbounded, a first
 * request whose task stopped answering with its TCP connection still open made
 * every repeat, on every task, hold a pooled connection until keepalive fired.
 */
const CLAIM_LOCK_TIMEOUT = '5s';

/**
 * How long a claim's transaction may sit idle before Postgres ends its
 * session. It never waits on anything but its own statements, so idling means
 * its task stopped answering — and ending the session frees the claim it holds
 * for the repeat that is waiting on it.
 */
const CLAIM_IDLE_TIMEOUT = '15s';

/**
 * `nextAttemptAt` of a scheduled send's claim until the send falls due: never,
 * as far as the outbox worker is concerned. Only `processScheduledMessages`
 * turns it into a delivery ({@link adoptScheduledClaim}); a scheduled message
 * that is deleted or whose claim is cancelled is therefore never sent.
 */
export const SCHEDULED_CLAIM_DUE = new Date('9999-12-31T00:00:00.000Z');

/**
 * A scheduled send's claim that never became a delivery: still waiting for
 * its send to fall due (`pending`), or cancelled with its scheduled message.
 * It is the message's, not the outbox's: the outbox API neither lists,
 * retries nor cancels one ({@link isOutboxDelivery}).
 */
export function isScheduledClaim(row: EmailOutboxRow): boolean {
  return row.nextAttemptAt.getTime() === SCHEDULED_CLAIM_DUE.getTime();
}

/** A scheduled claim still waiting for its send to fall due. */
export function isWaitingScheduledClaim(row: EmailOutboxRow): boolean {
  return row.status === 'pending' && isScheduledClaim(row);
}

/** Rows that are deliveries, as the outbox API sees them — no scheduled claim. */
function isOutboxDelivery() {
  return ne(emailOutbox.nextAttemptAt, SCHEDULED_CLAIM_DUE);
}

/**
 * How many deliveries this user's sends started since `since`: every
 * immediate send claims one row when it is accepted, and a scheduled send
 * becomes one when it falls due. A scheduled claim still waiting, or one
 * cancelled with its message, never went out and is not counted. Whatever
 * becomes of the Sent copy afterwards — moved, deleted — the row stays.
 * Served by `email_outbox_user_created_idx`.
 */
export async function countDeliveriesSince(userId: string, since: Date): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .where(
      and(eq(emailOutbox.userId, userId), gte(emailOutbox.createdAt, since), isOutboxDelivery()),
    );
  return row?.count ?? 0;
}

/**
 * Cancel the claims of these scheduled messages (by RFC Message-ID), in the
 * transaction that unschedules or deletes them: a scheduled message that will
 * not be sent must not leave a claim that answers its key as if it would.
 * `linkTo` attaches each cancelled claim to its message row, so the message
 * itself says it was not sent; it is left out when the row is going away.
 * Returns how many claims it cancelled.
 */
export async function cancelScheduledClaims(
  tx: Transaction,
  userId: string,
  scheduled: { messageId: string; linkTo?: string }[],
): Promise<number> {
  let cancelled = 0;
  for (const { messageId, linkTo } of scheduled) {
    const rows = await tx
      .update(emailOutbox)
      .set({ status: 'cancelled', ...(linkTo ? { messageRowId: linkTo } : {}) })
      .where(
        and(
          eq(emailOutbox.userId, userId),
          eq(emailOutbox.messageId, messageId),
          eq(emailOutbox.status, 'pending'),
          eq(emailOutbox.nextAttemptAt, SCHEDULED_CLAIM_DUE),
        ),
      )
      .returning({ id: emailOutbox.id });
    cancelled += rows.length;
  }
  return cancelled;
}

/**
 * Record that a scheduled message without a claim (scheduled with no key) was
 * not sent, on the message: a cancelled scheduled claim of its own.
 */
export async function recordScheduledCancelled(
  tx: Transaction,
  input: { userId: string; messageId: string; messageRowId: string; payload: EmailOutboxPayload },
): Promise<void> {
  await tx.insert(emailOutbox).values({
    userId: input.userId,
    messageId: input.messageId,
    messageRowId: input.messageRowId,
    payload: input.payload,
    status: 'cancelled',
    attempts: 0,
    nextAttemptAt: SCHEDULED_CLAIM_DUE,
  });
}

/**
 * The transaction a send's claim is taken in — an immediate send's and a
 * scheduled send's alike, so a repeat of the key waits on the claim the same
 * bounded way whichever it races. A wait that runs out is a 503 the client
 * retries with the same key: nothing was claimed or filed.
 */
export async function inClaimTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('lock_timeout', ${CLAIM_LOCK_TIMEOUT}, true),
                   set_config('idle_in_transaction_session_timeout', ${CLAIM_IDLE_TIMEOUT}, true)`,
      );
      return work(tx);
    });
  } catch (error) {
    if (sqlStateOf(error) !== LOCK_NOT_AVAILABLE) throw error;
    throw new ServiceUnavailableError(
      'This message is still being accepted by an earlier request. Retry with the same Idempotency-Key.',
      { retryable: true },
    );
  }
}

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

/**
 * The columns {@link toDto} and {@link toMessageDelivery} read, and the
 * message row a delivery belongs to — the row without `payload`, which is the
 * whole message, bodies and all. Every Sent listing loads the delivery of each
 * row on its page, so the reads that only answer with a status select these.
 * Both functions take a `Pick` of exactly what they read, so tsc proves the
 * projection is enough.
 */
export const OUTBOX_STATUS_COLUMNS = {
  id: emailOutbox.id,
  messageId: emailOutbox.messageId,
  messageRowId: emailOutbox.messageRowId,
  status: emailOutbox.status,
  attempts: emailOutbox.attempts,
  nextAttemptAt: emailOutbox.nextAttemptAt,
  lastError: emailOutbox.lastError,
  errorCode: emailOutbox.errorCode,
  sentAt: emailOutbox.sentAt,
  createdAt: emailOutbox.createdAt,
  updatedAt: emailOutbox.updatedAt,
};

function toDto(
  row: Pick<
    EmailOutboxRow,
    | 'id'
    | 'messageId'
    | 'status'
    | 'attempts'
    | 'nextAttemptAt'
    | 'lastError'
    | 'sentAt'
    | 'createdAt'
    | 'updatedAt'
  >,
): EmailOutboxDto {
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
export function toMessageDelivery(
  row: Pick<
    EmailOutboxRow,
    'status' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'errorCode' | 'updatedAt'
  >,
): MessageDeliveryDto {
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
    .select(OUTBOX_STATUS_COLUMNS)
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

/** The committed claim a send under this Idempotency-Key took, if one did. */
export async function findSendClaim(
  userId: string,
  idempotencyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<EmailOutboxRow | undefined> {
  const [row] = await db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.userId, userId), eq(emailOutbox.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row;
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
 * A SCHEDULED send under a key takes the same claim when it is filed
 * (`scheduleMessage`), so a double press of Schedule, or Schedule racing Send
 * now, files and sends once: the claim waits, unleased and unlinked, until the
 * send falls due ({@link SCHEDULED_CLAIM_DUE}).
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
    /** Hold the key for a scheduled send, to be delivered when it falls due. */
    scheduled?: boolean;
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
      ...(input.scheduled
        ? { status: 'pending' as const, attempts: 0, nextAttemptAt: SCHEDULED_CLAIM_DUE }
        : {
            status: 'processing' as const,
            attempts: 1,
            lockedAt: now,
            lockedBy: input.owner,
            nextAttemptAt: now,
          }),
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

  const existing = await findSendClaim(input.userId, input.idempotencyKey, db);
  if (!existing) {
    // The holder's row went away between our insert and this read. Take the
    // claim ourselves.
    return claimSend(input, db);
  }
  return { claimed: false, existing };
}

/**
 * Turn the claim a scheduled send took under its key into its delivery, now
 * that it is due: leased to `owner` exactly as {@link claimSend} leases a new
 * one, linked to its Sent row, and carrying the payload rebuilt from it.
 *
 * Returns undefined when the send took no claim (no key, or filed before
 * scheduled sends were claimed); the caller claims it then. A claim that is no
 * longer waiting — cancelled, or already the delivery of a Send now that won
 * the key — is returned unclaimed, and nothing is sent.
 */
export async function adoptScheduledClaim(
  tx: Transaction,
  input: {
    userId: string;
    messageId: string;
    messageRowId: string;
    payload: EmailOutboxPayload;
    owner: string;
  },
): Promise<SendClaim | undefined> {
  const [held] = await tx
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.userId, input.userId),
        eq(emailOutbox.messageId, input.messageId),
        isNotNull(emailOutbox.idempotencyKey),
      ),
    )
    .limit(1)
    .for('update');
  if (!held) return undefined;
  if (!isWaitingScheduledClaim(held)) return { claimed: false, existing: held };
  const now = new Date();
  const [row] = await tx
    .update(emailOutbox)
    .set({
      status: 'processing',
      attempts: 1,
      lockedAt: now,
      lockedBy: input.owner,
      nextAttemptAt: now,
      messageRowId: input.messageRowId,
      payload: input.payload,
    })
    .where(eq(emailOutbox.id, held.id))
    .returning();
  return { claimed: true, row };
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

/** A delivery in flight whose holder stopped holding it: its task died, or it never had a lease. */
function abandonedDelivery(now: Date) {
  return and(
    eq(emailOutbox.status, 'processing'),
    or(isNull(emailOutbox.lockedAt), lt(emailOutbox.lockedAt, new Date(now.getTime() - LEASE_MS))),
  );
}

/**
 * Claim the next delivery that is due: a retry whose time has come, or one
 * whose holder died mid-attempt.
 *
 * Both are bounded by the same budget. An abandoned attempt may well have
 * reached the relay — the task can die after the relay accepted and before the
 * row said so — so adopting one is a resend, and adopting one whatever its
 * attempt count turned any bookkeeping fault after an accepted send into the
 * same message going out again every lease. {@link failAbandonedDeliveries}
 * settles what this no longer adopts.
 */
export async function claimEmailOutbox(
  workerId: string,
): Promise<typeof emailOutbox.$inferSelect | undefined> {
  const db = getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(emailOutbox)
      .where(
        and(
          lt(emailOutbox.attempts, MAX_ATTEMPTS),
          or(
            and(
              inArray(emailOutbox.status, ['pending', 'failed']),
              lte(emailOutbox.nextAttemptAt, now),
            ),
            abandonedDelivery(now),
          ),
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

/**
 * Settle every abandoned delivery with no attempts left as `failed`, so the
 * message says it did not go out (as far as anyone knows) instead of reading
 * as being retried forever. A user can still retry it, which is a resend they
 * chose. Returns the rows that changed.
 */
export async function failAbandonedDeliveries(): Promise<
  { userId: string; messageRowId: string | null }[]
> {
  return getDb()
    .update(emailOutbox)
    .set({
      status: 'failed',
      lockedAt: null,
      lockedBy: null,
      lastError:
        'Delivery was interrupted before the relay answered, and its attempts are spent. ' +
        'It may have been delivered; retry it to send it again.',
      errorCode: 'relay_unavailable',
    })
    .where(and(abandonedDelivery(new Date()), gte(emailOutbox.attempts, MAX_ATTEMPTS)))
    .returning({ userId: emailOutbox.userId, messageRowId: emailOutbox.messageRowId });
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
    .select(OUTBOX_STATUS_COLUMNS)
    .from(emailOutbox)
    .where(and(eq(emailOutbox.userId, userId), isOutboxDelivery()))
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
        isOutboxDelivery(),
      ),
    )
    .returning(OUTBOX_STATUS_COLUMNS);
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
        isOutboxDelivery(),
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
        isOutboxDelivery(),
      ),
    )
    .returning(OUTBOX_STATUS_COLUMNS);
  if (updated) return toDto(updated);

  // Nothing cancellable: tell an id this user has no row for apart from one
  // that is past cancelling. A scheduled claim is the user's row too, and is
  // answered as before.
  const [existing] = await getDb()
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.id, id), eq(emailOutbox.userId, userId)))
    .limit(1);
  if (!existing) throw new NotFoundError('Outbound message not found');
  throw new ConflictError('Outbound message is already being delivered or completed');
}

export { MAX_ATTEMPTS as EMAIL_OUTBOX_MAX_ATTEMPTS };
