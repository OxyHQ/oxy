import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { normalizedAppEventSchema, type NormalizedAppEvent } from '@oxyhq/contracts';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getEnvBoolean, getEnvNumber } from '../config/env';
import { getDb, type Database } from '../config/postgres';
import { normalizedAppEventOutbox } from '../db/schema/normalizedAppEventOutbox';
import {
  inboxServiceClient,
  requiredInboxServiceClient,
} from '../capabilities/inbox-service-client';
import { logger } from '../utils/logger';

export const NORMALIZED_EVENT_OUTBOX_MAX_ATTEMPTS = 12;
export const NORMALIZED_EVENT_OUTBOX_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_RECORDED_ERROR_LENGTH = 500;

export type NormalizedEventDelivery = (event: NormalizedAppEvent) => Promise<void>;

function aliaApiUrl(): string {
  return (process.env.ALIA_API_URL ?? 'https://api.alia.onl').replace(/\/$/, '');
}

async function postEvent(event: NormalizedAppEvent, token: string): Promise<Response> {
  return fetch(`${aliaApiUrl()}/webhooks/oxy`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': event.eventId,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Deliver with Oxy service identity; no user bearer or shared HMAC is stored. */
export async function deliverNormalizedAppEvent(event: NormalizedAppEvent): Promise<void> {
  const parsed = normalizedAppEventSchema.parse(event);
  const client = requiredInboxServiceClient();
  let response = await postEvent(parsed, await client.getServiceToken());
  if (response.status === 401) {
    client.invalidateServiceToken();
    response = await postEvent(parsed, await client.getServiceToken());
  }
  if (!response.ok) {
    throw new Error(`Alia rejected ${parsed.appId} event (${response.status})`);
  }
}

export interface NormalizedEventOutboxBatchOptions {
  ownerId: string;
  batchSize?: number;
  leaseMs?: number;
  deliver?: NormalizedEventDelivery;
}

export interface NormalizedEventOutboxBatchResult {
  claimed: number;
  processed: number;
  failed: number;
  deadLettered: number;
}

function claimableInboxEvents(db: Database, claimedBefore: Date, limit: number) {
  return db
    .select({ id: normalizedAppEventOutbox.id })
    .from(normalizedAppEventOutbox)
    .where(and(
      eq(normalizedAppEventOutbox.appId, 'inbox'),
      isNull(normalizedAppEventOutbox.processedAt),
      isNull(normalizedAppEventOutbox.failedAt),
      or(
        isNull(normalizedAppEventOutbox.claimedAt),
        lt(normalizedAppEventOutbox.claimedAt, claimedBefore),
      ),
    ))
    .orderBy(asc(normalizedAppEventOutbox.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_RECORDED_ERROR_LENGTH
    ? `${message.slice(0, MAX_RECORDED_ERROR_LENGTH)}…`
    : message;
}

export async function runNormalizedEventOutboxBatch(
  options: NormalizedEventOutboxBatchOptions,
): Promise<NormalizedEventOutboxBatchResult> {
  const db = getDb();
  const batchSize = options.batchSize
    ?? getEnvNumber('INBOX_EVENT_OUTBOX_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const leaseMs = options.leaseMs ?? NORMALIZED_EVENT_OUTBOX_LEASE_MS;
  const claimed = await db
    .update(normalizedAppEventOutbox)
    .set({
      claimedAt: new Date(),
      claimedBy: options.ownerId,
      attempts: sql`${normalizedAppEventOutbox.attempts} + 1`,
    })
    .where(inArray(
      normalizedAppEventOutbox.id,
      claimableInboxEvents(db, new Date(Date.now() - leaseMs), batchSize),
    ))
    .returning({
      id: normalizedAppEventOutbox.id,
      eventId: normalizedAppEventOutbox.eventId,
      event: normalizedAppEventOutbox.event,
      attempts: normalizedAppEventOutbox.attempts,
    });

  const result: NormalizedEventOutboxBatchResult = {
    claimed: claimed.length,
    processed: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (const row of claimed) {
    if (row.attempts > NORMALIZED_EVENT_OUTBOX_MAX_ATTEMPTS) {
      await db.update(normalizedAppEventOutbox).set({
        failedAt: new Date(),
        lastError: sql`coalesce(${normalizedAppEventOutbox.lastError}, 'Attempt limit reached')`,
      }).where(and(
        eq(normalizedAppEventOutbox.id, row.id),
        eq(normalizedAppEventOutbox.claimedBy, options.ownerId),
        isNull(normalizedAppEventOutbox.processedAt),
      ));
      result.deadLettered += 1;
      continue;
    }

    try {
      await (options.deliver ?? deliverNormalizedAppEvent)(normalizedAppEventSchema.parse(row.event));
    } catch (error) {
      const deadLetter = row.attempts >= NORMALIZED_EVENT_OUTBOX_MAX_ATTEMPTS;
      await db.update(normalizedAppEventOutbox).set({
        lastError: describeError(error),
        ...(deadLetter ? { failedAt: new Date() } : {}),
      }).where(and(
        eq(normalizedAppEventOutbox.id, row.id),
        eq(normalizedAppEventOutbox.claimedBy, options.ownerId),
        isNull(normalizedAppEventOutbox.processedAt),
      ));
      result.failed += 1;
      if (deadLetter) result.deadLettered += 1;
      logger.warn('[NormalizedEventOutbox] Inbox delivery failed', {
        eventId: row.eventId,
        attempts: row.attempts,
        deadLetter,
        error: describeError(error),
      });
      continue;
    }

    const acknowledged = await db.update(normalizedAppEventOutbox).set({
      processedAt: new Date(),
      lastError: null,
    }).where(and(
      eq(normalizedAppEventOutbox.id, row.id),
      eq(normalizedAppEventOutbox.claimedBy, options.ownerId),
      isNull(normalizedAppEventOutbox.processedAt),
    )).returning({ id: normalizedAppEventOutbox.id });
    if (acknowledged.length === 1) result.processed += 1;
  }

  return result;
}

const WORKER_OWNER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runNormalizedEventOutboxBatch({ ownerId: WORKER_OWNER_ID });
  } catch (error) {
    logger.error(
      '[NormalizedEventOutbox] Inbox batch failed',
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    tickInFlight = false;
  }
}

export function startNormalizedEventOutboxWorker(): boolean {
  if (!getEnvBoolean('INBOX_EVENT_OUTBOX_WORKER_ENABLED', false)) {
    logger.info('[NormalizedEventOutbox] Inbox worker disabled; events remain durable');
    return false;
  }
  if (!inboxServiceClient()) {
    logger.error('[NormalizedEventOutbox] Inbox worker requires application credentials');
    return false;
  }
  if (timer) return true;
  const intervalMs = Math.max(
    getEnvNumber('INBOX_EVENT_OUTBOX_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    100,
  );
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logger.info('[NormalizedEventOutbox] Inbox worker started', {
    ownerId: WORKER_OWNER_ID,
    intervalMs,
  });
  return true;
}

export function stopNormalizedEventOutboxWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('[NormalizedEventOutbox] Inbox worker stopped', { ownerId: WORKER_OWNER_ID });
}
