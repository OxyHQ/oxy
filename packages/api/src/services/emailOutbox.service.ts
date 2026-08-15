import { and, asc, desc, eq, inArray, isNull, lte, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { emailOutbox, type EmailOutboxPayload, type EmailOutboxStatus } from '../db/schema/emailOutbox';
import { ConflictError, NotFoundError } from '../utils/error';

const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface EmailOutboxDto {
  id: string;
  messageId: string;
  status: EmailOutboxStatus;
  attempts: number;
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
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function enqueueEmailOutbox(input: EnqueueEmailOutboxInput): Promise<EmailOutboxDto> {
  const db = getDb();
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, input.userId), eq(emailOutbox.idempotencyKey, input.idempotencyKey)))
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
        .where(and(eq(emailOutbox.userId, input.userId), eq(emailOutbox.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing) return toDto(existing);
    }
    throw error;
  }
}

export async function claimEmailOutbox(workerId: string): Promise<typeof emailOutbox.$inferSelect | undefined> {
  const db = getDb();
  const now = new Date();
  const leaseExpiredAt = new Date(now.getTime() - LEASE_MS);
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(emailOutbox)
      .where(or(
        and(
          inArray(emailOutbox.status, ['pending', 'failed']),
          lte(emailOutbox.nextAttemptAt, now),
          lt(emailOutbox.attempts, MAX_ATTEMPTS),
        ),
        and(eq(emailOutbox.status, 'processing'), isNull(emailOutbox.lockedAt)),
        and(eq(emailOutbox.status, 'processing'), lt(emailOutbox.lockedAt, leaseExpiredAt)),
      ))
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
      })
      .where(eq(emailOutbox.id, candidate.id))
      .returning();
    return claimed;
  });
}

export async function markEmailOutboxSent(id: string): Promise<void> {
  await getDb()
    .update(emailOutbox)
    .set({ status: 'sent', sentAt: new Date(), lockedAt: null, lockedBy: null, lastError: null })
    .where(eq(emailOutbox.id, id));
}

export async function markEmailOutboxFailed(id: string, error: unknown, nextAttemptAt: Date): Promise<void> {
  await getDb()
    .update(emailOutbox)
    .set({
      status: 'failed',
      nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      lastError: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
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
    .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lockedAt: null, lockedBy: null, lastError: null })
    .where(and(eq(emailOutbox.id, id), eq(emailOutbox.userId, userId), inArray(emailOutbox.status, ['failed', 'cancelled'])))
    .returning();
  if (!updated) throw new NotFoundError('Outbound message not found or cannot be retried');
  return toDto(updated);
}

export async function cancelEmailOutbox(userId: string, id: string): Promise<EmailOutboxDto> {
  const [updated] = await getDb()
    .update(emailOutbox)
    .set({ status: 'cancelled', lockedAt: null, lockedBy: null })
    .where(and(eq(emailOutbox.id, id), eq(emailOutbox.userId, userId), inArray(emailOutbox.status, ['pending', 'failed'])))
    .returning();
  if (!updated) throw new ConflictError('Outbound message is already being delivered or completed');
  return toDto(updated);
}

export { MAX_ATTEMPTS as EMAIL_OUTBOX_MAX_ATTEMPTS };
