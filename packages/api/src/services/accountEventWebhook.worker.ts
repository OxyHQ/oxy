/**
 * Pushes account events (`account_event_deliveries`) to each recipient
 * application's registered webhook (OxyHQ/Mention#1169).
 *
 * At least once. A delivery is claimed under a lease, POSTed as a signed
 * Security Event Token, and acknowledged only by a 2xx; anything else is retried
 * with exponential backoff (1 minute doubling, capped at 6 hours) and
 * dead-lettered after {@link ACCOUNT_EVENT_WEBHOOK_MAX_ATTEMPTS}. The event id
 * travels as `jti` and in `oxy-event-id` on every attempt, so a receiver dedupes
 * a replay. A dead-lettered or webhook-less delivery is not lost: the pull feed
 * (`GET /internal/account-events`) keeps serving it until the event is swept.
 *
 * The URL is owner-supplied — a third-party app sets its own — so the POST goes
 * through `safeFetch`: DNS-pinned, public addresses only, no redirects.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { safeFetch, SsrfRejection } from '@oxy.so/core/server';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getEnvBoolean, getEnvNumber } from '../config/env';
import { getDb, type Database } from '../config/postgres';
import { accountEventDeliveries, accountEvents } from '../db/schema/accountEvents';
import { applications } from '../db/schema/applications';
import { logger } from '../utils/logger';
import { signAccountEventToken, type AccountEventForToken } from './accountEvents.service';

/** 16 attempts at 1, 2, 4 … minutes capped at 6 h spans about three and a half days. */
export const ACCOUNT_EVENT_WEBHOOK_MAX_ATTEMPTS = 16;
export const ACCOUNT_EVENT_WEBHOOK_LEASE_MS = 60_000;
export const ACCOUNT_EVENT_WEBHOOK_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MAX_RECORDED_ERROR_LENGTH = 500;

/** Delay before attempt `attempts + 1`, after `attempts` failures. */
export function accountEventBackoffMs(attempts: number): number {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(exponent, 20), MAX_BACKOFF_MS);
}

export interface AccountEventWebhookRequest {
  url: string;
  eventId: string;
  eventType: string;
  token: string;
}

/** The outcome of one POST: the receiver's status, or a transport error thrown. */
export type AccountEventWebhookDelivery = (request: AccountEventWebhookRequest) => Promise<number>;

/** POST the token to the receiver through the SSRF guard. Resolves to the HTTP status. */
export async function postAccountEventWebhook(request: AccountEventWebhookRequest): Promise<number> {
  const result = await safeFetch(request.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/secevent+jwt',
      accept: 'application/json',
      'oxy-event-id': request.eventId,
      'oxy-event-type': request.eventType,
    },
    body: request.token,
    maxRedirects: 0,
    headersTimeoutMs: ACCOUNT_EVENT_WEBHOOK_TIMEOUT_MS,
  });
  // Nothing in the body matters; release the socket.
  result.response.resume();
  return result.status;
}

export interface AccountEventWebhookBatchOptions {
  ownerId: string;
  batchSize?: number;
  leaseMs?: number;
  deliver?: AccountEventWebhookDelivery;
  now?: () => Date;
}

export interface AccountEventWebhookBatchResult {
  claimed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
  noWebhook: number;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_RECORDED_ERROR_LENGTH
    ? `${message.slice(0, MAX_RECORDED_ERROR_LENGTH)}…`
    : message;
}

function claimableDeliveries(db: Database, now: Date, claimedBefore: Date, limit: number) {
  return db
    .select({ id: accountEventDeliveries.id })
    .from(accountEventDeliveries)
    .where(and(
      isNull(accountEventDeliveries.deliveredAt),
      isNull(accountEventDeliveries.failedAt),
      lte(accountEventDeliveries.nextAttemptAt, now),
      or(
        isNull(accountEventDeliveries.claimedAt),
        lt(accountEventDeliveries.claimedAt, claimedBefore),
      ),
    ))
    .orderBy(asc(accountEventDeliveries.nextAttemptAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

export async function runAccountEventWebhookBatch(
  options: AccountEventWebhookBatchOptions,
): Promise<AccountEventWebhookBatchResult> {
  const db = getDb();
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize
    ?? getEnvNumber('ACCOUNT_EVENT_WEBHOOK_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const leaseMs = options.leaseMs ?? ACCOUNT_EVENT_WEBHOOK_LEASE_MS;
  const deliver = options.deliver ?? postAccountEventWebhook;
  const claimTime = now();

  const claimed = await db
    .update(accountEventDeliveries)
    .set({ claimedAt: claimTime, claimedBy: options.ownerId })
    .where(inArray(
      accountEventDeliveries.id,
      claimableDeliveries(db, claimTime, new Date(claimTime.getTime() - leaseMs), batchSize),
    ))
    .returning({
      id: accountEventDeliveries.id,
      eventId: accountEventDeliveries.eventId,
      applicationId: accountEventDeliveries.applicationId,
      attempts: accountEventDeliveries.attempts,
    });

  const result: AccountEventWebhookBatchResult = {
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
    deadLettered: 0,
    noWebhook: 0,
  };
  if (claimed.length === 0) return result;

  const events = new Map<string, AccountEventForToken>(
    (await db
      .select({
        id: accountEvents.id,
        type: accountEvents.type,
        userId: accountEvents.userId,
        username: accountEvents.username,
        retained: accountEvents.retained,
        createdAt: accountEvents.createdAt,
      })
      .from(accountEvents)
      .where(inArray(accountEvents.id, [...new Set(claimed.map((row) => row.eventId))])))
      .map((event) => [event.id, event]),
  );
  const webhooks = new Map<string, string | null>(
    (await db
      .select({ id: applications.id, webhookUrl: applications.webhookUrl })
      .from(applications)
      .where(inArray(applications.id, [...new Set(claimed.map((row) => row.applicationId))])))
      .map((application) => [application.id, application.webhookUrl]),
  );

  const ownedBy = (id: string) => and(
    eq(accountEventDeliveries.id, id),
    eq(accountEventDeliveries.claimedBy, options.ownerId),
    isNull(accountEventDeliveries.deliveredAt),
  );

  for (const row of claimed) {
    const event = events.get(row.eventId);
    const url = webhooks.get(row.applicationId);
    if (!event || !url) {
      // No webhook registered (or the event was swept under us): the push path
      // is done. The pull feed is how this application learns of the event.
      await db.update(accountEventDeliveries).set({
        failedAt: now(),
        lastError: event ? 'No webhook URL registered; available from the pull feed' : 'Event no longer exists',
      }).where(ownedBy(row.id));
      result.noWebhook += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    let status: number | null = null;
    let error: string | null = null;
    try {
      status = await deliver({
        url,
        eventId: event.id,
        eventType: event.type,
        token: signAccountEventToken(event, row.applicationId),
      });
      if (status < 200 || status >= 300) error = `Receiver answered HTTP ${status}`;
    } catch (caught) {
      error = caught instanceof SsrfRejection
        ? `Webhook URL refused by the SSRF guard: ${describeError(caught)}`
        : describeError(caught);
    }

    if (error === null) {
      const acknowledged = await db.update(accountEventDeliveries).set({
        attempts,
        deliveredAt: now(),
        lastStatus: status,
        lastError: null,
      }).where(ownedBy(row.id)).returning({ id: accountEventDeliveries.id });
      if (acknowledged.length === 1) result.delivered += 1;
      continue;
    }

    const deadLetter = attempts >= ACCOUNT_EVENT_WEBHOOK_MAX_ATTEMPTS;
    await db.update(accountEventDeliveries).set({
      attempts,
      lastStatus: status,
      lastError: error,
      claimedAt: null,
      claimedBy: null,
      nextAttemptAt: new Date(now().getTime() + accountEventBackoffMs(attempts)),
      ...(deadLetter ? { failedAt: now() } : {}),
    }).where(ownedBy(row.id));
    result.failed += 1;
    if (deadLetter) result.deadLettered += 1;
    logger.warn('[AccountEventWebhook] Delivery failed', {
      eventId: event.id,
      applicationId: row.applicationId,
      attempts,
      status,
      deadLetter,
      error,
    });
  }

  return result;
}

/** Deliveries still owed a push, for the health surface and tests. */
export async function countPendingAccountEventDeliveries(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(accountEventDeliveries)
    .where(and(isNull(accountEventDeliveries.deliveredAt), isNull(accountEventDeliveries.failedAt)));
  return row?.count ?? 0;
}

const WORKER_OWNER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runAccountEventWebhookBatch({ ownerId: WORKER_OWNER_ID });
  } catch (error) {
    logger.error(
      '[AccountEventWebhook] Batch failed',
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    tickInFlight = false;
  }
}

/**
 * ON by default, unlike the other outbox loops: acknowledging a delivery here
 * claims only that the receiver answered 2xx, which is exactly what it checks,
 * and an erasure nobody is told about is the defect this exists to fix.
 * `ACCOUNT_EVENT_WEBHOOK_WORKER_ENABLED=false` switches it off; events keep
 * accumulating and the pull feed keeps serving them.
 */
export function startAccountEventWebhookWorker(): boolean {
  if (!getEnvBoolean('ACCOUNT_EVENT_WEBHOOK_WORKER_ENABLED', true)) {
    logger.info('[AccountEventWebhook] Worker disabled; events remain available from the pull feed');
    return false;
  }
  if (timer) return true;
  const intervalMs = Math.max(
    getEnvNumber('ACCOUNT_EVENT_WEBHOOK_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    100,
  );
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logger.info('[AccountEventWebhook] Worker started', { ownerId: WORKER_OWNER_ID, intervalMs });
  return true;
}

export function stopAccountEventWebhookWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
