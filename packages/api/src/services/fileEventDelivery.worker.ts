/**
 * Pushes file events (`file_event_deliveries`, ADR 0043 D9) to each
 * application's verified file-events endpoint.
 *
 * At least once, the way `accountEventWebhook.worker.ts` delivers account
 * events: a delivery is claimed under a lease (`FOR UPDATE SKIP LOCKED`, so
 * several API tasks share the work), POSTed as the stored JSON payload signed
 * with the application's HMAC secret, and acknowledged only by a 2xx. Anything
 * else is retried with exponential backoff (1 minute doubling, capped at 6
 * hours) and dead-lettered (`failed_at`) after {@link FILE_EVENT_MAX_ATTEMPTS}.
 * The event id travels in the body and in `oxy-event-id`, so a receiver dedupes
 * a replay.
 *
 * The endpoint and secret are read at DELIVERY time: a rotated secret signs
 * what is still queued, and an application that removed its endpoint (or was
 * deleted) has its queued deliveries dead-lettered rather than retried.
 *
 * The URL is developer-supplied, so the POST goes through `safeFetch`:
 * DNS-pinned, public addresses only, no redirects.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { safeFetch, SsrfRejection } from '@oxy.so/core/server';
import { and, asc, inArray, isNull, lt, lte, or, eq, sql } from 'drizzle-orm';
import { getEnvBoolean, getEnvNumber } from '../config/env';
import { getDb, type Database } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { FILE_EVENT_MAX_ATTEMPTS, fileEventDeliveries } from '../db/schema/fileEventDeliveries';
import { logger } from '../utils/logger';
import {
  FILE_EVENT_SIGNATURE_HEADER,
  fileEventSignatureHeader,
  openFileWebhookSecret,
} from './fileEvents.service';

export const FILE_EVENT_LEASE_MS = 60_000;
export const FILE_EVENT_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MAX_RECORDED_ERROR_LENGTH = 500;

/** Delay before attempt `attempts + 1`, after `attempts` failures. */
export function fileEventBackoffMs(attempts: number): number {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(exponent, 20), MAX_BACKOFF_MS);
}

export interface FileEventWebhookRequest {
  url: string;
  eventId: string;
  eventType: string;
  /** The exact bytes sent and signed. */
  body: string;
  /** `t=<unix>,v1=<hex>`. */
  signature: string;
}

/** The outcome of one POST: the receiver's status, or a transport error thrown. */
export type FileEventWebhookDelivery = (request: FileEventWebhookRequest) => Promise<number>;

/** POST one event through the SSRF guard. Resolves to the HTTP status. */
export async function postFileEventWebhook(request: FileEventWebhookRequest): Promise<number> {
  const result = await safeFetch(request.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'oxy-event-id': request.eventId,
      'oxy-event-type': request.eventType,
      [FILE_EVENT_SIGNATURE_HEADER]: request.signature,
    },
    body: request.body,
    maxRedirects: 0,
    headersTimeoutMs: FILE_EVENT_TIMEOUT_MS,
    signal: AbortSignal.timeout(FILE_EVENT_TIMEOUT_MS),
  });
  // Nothing in the body matters; release the socket.
  result.response.resume();
  return result.status;
}

export interface FileEventDeliveryBatchOptions {
  ownerId: string;
  batchSize?: number;
  leaseMs?: number;
  deliver?: FileEventWebhookDelivery;
  now?: () => Date;
}

export interface FileEventDeliveryBatchResult {
  claimed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
  noEndpoint: number;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_RECORDED_ERROR_LENGTH
    ? `${message.slice(0, MAX_RECORDED_ERROR_LENGTH)}…`
    : message;
}

function claimableDeliveries(db: Database, now: Date, claimedBefore: Date, limit: number) {
  return db
    .select({ id: fileEventDeliveries.id })
    .from(fileEventDeliveries)
    .where(
      and(
        isNull(fileEventDeliveries.deliveredAt),
        isNull(fileEventDeliveries.failedAt),
        lte(fileEventDeliveries.nextAttemptAt, now),
        or(isNull(fileEventDeliveries.claimedAt), lt(fileEventDeliveries.claimedAt, claimedBefore)),
      ),
    )
    .orderBy(asc(fileEventDeliveries.nextAttemptAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

export async function runFileEventDeliveryBatch(
  options: FileEventDeliveryBatchOptions,
): Promise<FileEventDeliveryBatchResult> {
  const db = getDb();
  const now = options.now ?? (() => new Date());
  const batchSize =
    options.batchSize ?? getEnvNumber('FILE_EVENT_WEBHOOK_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const leaseMs = options.leaseMs ?? FILE_EVENT_LEASE_MS;
  const deliver = options.deliver ?? postFileEventWebhook;
  const claimTime = now();

  const claimed = await db
    .update(fileEventDeliveries)
    .set({ claimedAt: claimTime, claimedBy: options.ownerId })
    .where(
      inArray(
        fileEventDeliveries.id,
        claimableDeliveries(db, claimTime, new Date(claimTime.getTime() - leaseMs), batchSize),
      ),
    )
    .returning({
      id: fileEventDeliveries.id,
      eventId: fileEventDeliveries.eventId,
      type: fileEventDeliveries.type,
      applicationId: fileEventDeliveries.applicationId,
      payload: fileEventDeliveries.payload,
      attempts: fileEventDeliveries.attempts,
    });

  const result: FileEventDeliveryBatchResult = {
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
    deadLettered: 0,
    noEndpoint: 0,
  };
  if (claimed.length === 0) return result;

  const endpoints = new Map(
    (
      await db
        .select({
          id: applications.id,
          status: applications.status,
          url: applications.filesWebhookUrl,
          secret: applications.filesWebhookSecretCiphertext,
        })
        .from(applications)
        .where(inArray(applications.id, [...new Set(claimed.map((row) => row.applicationId))]))
    ).map((application) => [application.id, application]),
  );

  const ownedBy = (id: string) =>
    and(
      eq(fileEventDeliveries.id, id),
      eq(fileEventDeliveries.claimedBy, options.ownerId),
      isNull(fileEventDeliveries.deliveredAt),
    );

  for (const row of claimed) {
    const endpoint = endpoints.get(row.applicationId);
    if (!endpoint?.url || !endpoint.secret || endpoint.status === 'deleted') {
      await db
        .update(fileEventDeliveries)
        .set({
          failedAt: now(),
          lastError:
            endpoint?.status === 'deleted'
              ? 'The application was deleted'
              : 'The application has no file-events endpoint any more',
        })
        .where(ownedBy(row.id));
      result.noEndpoint += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const body = JSON.stringify(row.payload);
      status = await deliver({
        url: endpoint.url,
        eventId: row.eventId,
        eventType: row.type,
        body,
        signature: fileEventSignatureHeader(
          openFileWebhookSecret(row.applicationId, endpoint.secret),
          body,
          now(),
        ),
      });
      if (status < 200 || status >= 300) error = `Receiver answered HTTP ${status}`;
    } catch (caught) {
      error =
        caught instanceof SsrfRejection
          ? `Endpoint refused by the SSRF guard: ${describeError(caught)}`
          : describeError(caught);
    }

    if (error === null) {
      const acknowledged = await db
        .update(fileEventDeliveries)
        .set({ attempts, deliveredAt: now(), lastStatus: status, lastError: null })
        .where(ownedBy(row.id))
        .returning({ id: fileEventDeliveries.id });
      if (acknowledged.length === 1) result.delivered += 1;
      continue;
    }

    const deadLetter = attempts >= FILE_EVENT_MAX_ATTEMPTS;
    await db
      .update(fileEventDeliveries)
      .set({
        attempts,
        lastStatus: status,
        lastError: error,
        claimedAt: null,
        claimedBy: null,
        nextAttemptAt: new Date(now().getTime() + fileEventBackoffMs(attempts)),
        ...(deadLetter ? { failedAt: now() } : {}),
      })
      .where(ownedBy(row.id));
    result.failed += 1;
    if (deadLetter) result.deadLettered += 1;
    logger.warn('[FileEventDelivery] Delivery failed', {
      eventId: row.eventId,
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
export async function countPendingFileEventDeliveries(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(fileEventDeliveries)
    .where(and(isNull(fileEventDeliveries.deliveredAt), isNull(fileEventDeliveries.failedAt)));
  return row?.count ?? 0;
}

const WORKER_OWNER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runFileEventDeliveryBatch({ ownerId: WORKER_OWNER_ID });
  } catch (error) {
    logger.error(
      '[FileEventDelivery] Batch failed',
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    tickInFlight = false;
  }
}

/**
 * ON by default, like account-event delivery: an application only has rows
 * here once it registered and verified an endpoint, so it asked for them.
 * `FILE_EVENT_WEBHOOK_WORKER_ENABLED=false` switches it off; rows accumulate
 * and are sent when it is switched back on.
 */
export function startFileEventDeliveryWorker(): boolean {
  if (!getEnvBoolean('FILE_EVENT_WEBHOOK_WORKER_ENABLED', true)) {
    logger.info('[FileEventDelivery] Worker disabled; file events are queued, not sent');
    return false;
  }
  if (timer) return true;
  const intervalMs = Math.max(
    getEnvNumber('FILE_EVENT_WEBHOOK_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    100,
  );
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logger.info('[FileEventDelivery] Worker started', { ownerId: WORKER_OWNER_ID, intervalMs });
  return true;
}

export function stopFileEventDeliveryWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
