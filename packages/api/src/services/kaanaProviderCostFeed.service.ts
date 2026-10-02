/**
 * Oxy's reader of Kaana's provider-cost operator feed — issue #1526 (I09).
 *
 * Kaana records what every platform-funded upstream attempt cost it and serves
 * those attempts, oldest first, on `POST /internal/v1/provider-telemetry/attempts`
 * (Kaana `docs/cost.md`, "The operator feed Oxy reads"). The read is signed with
 * the SAME Oxy edge key the envelope uses, under its own domain separator
 * `oxy-kaana-provider-telemetry:v1`: an inference signature cannot read costs,
 * and this signature cannot run inference. No new credential exists for it.
 *
 * ## Exactly once, without trusting the cursor
 *
 * Attempts are keyed `(request_id, attempt_index)` in Kaana and here. Ingesting
 * a page twice inserts nothing the second time; a redelivered attempt whose
 * facts DIFFER is refused and logged, never overwritten — Kaana fails closed on
 * that case too. The cursor is advanced compare-and-set, so two API tasks
 * reading at once cannot move it backwards; at worst they read a page twice,
 * which the key makes harmless.
 *
 * ## Amounts are never floats
 *
 * Kaana sends integer 1e-12 units as a decimal string (`amountPicos`).
 * {@link picosToDecimal} moves the decimal point by string manipulation, the
 * same scale as Oxy's `exactAmount` columns, so no amount passes through a JS
 * number. An attempt with an unknown cost stays unknown.
 */

import { createHash, sign } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../config/postgres';
import { resolveKaanaDataPlane, type KaanaDataPlaneConfig } from '../config/kaanaDataPlane';
import {
  inferenceProviderCostAttempts,
  inferenceProviderCostFeedCursors,
} from '../db/schema/inferenceProviderCostAttempts';
import { logger } from '../utils/logger';

const ATTEMPT_FEED_PATH = '/internal/v1/provider-telemetry/attempts';
const SIGNATURE_DOMAIN = 'oxy-kaana-provider-telemetry:v1';
const FEED_NAME = 'kaana-provider-attempts';
const PAGE_SIZE = 500;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const PROVIDER_COST_FEED_INTERVAL_MS = 60_000;
const MAX_PAGES_PER_RUN = 20;

/* -------------------------------------------------------------------------- */
/*  Wire shape (Kaana `internal/credentialstore/feed.go`)                      */
/* -------------------------------------------------------------------------- */

const operatorAmountSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountPicos: z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/),
});

export const providerCostAttemptEventSchema = z.object({
  position: z.string().min(1).max(1024),
  requestId: z.string().min(1).max(256),
  attemptIndex: z.number().int().nonnegative(),
  provider: z.string().min(1).max(128),
  keyId: z.string().min(1).max(256),
  keyClass: z.string().min(1).max(64),
  deploymentId: z.string().min(1).max(256),
  modelReference: z.string().min(1).max(512),
  cost: operatorAmountSchema.nullable(),
  costSource: z.enum(['provider_reported', 'rate_card', 'unknown']),
  rateCardVersionId: z.string().max(256).nullable(),
  costComplete: z.boolean(),
  served: z.boolean(),
  occurredAt: z.string().datetime({ offset: true }),
  // Null for an attempt Kaana recorded before attempts measured their units.
  units: z
    .array(z.object({ unit: z.string().min(1).max(64), quantity: z.number().int().nonnegative() }))
    .nullable(),
  telemetry: z
    .object({
      startedAt: z.string().datetime({ offset: true }),
      latencyMs: z.number().int().nonnegative(),
      timeToFirstOutputMs: z.number().int().nonnegative().nullable(),
      outcome: z.string().min(1).max(32),
      failureCode: z.string().max(64).nullable(),
    })
    .nullable(),
}).refine(
  // An unknown cost carries no amount; a known one always does. Anything else
  // is a feed this reader does not understand, and it refuses the page.
  (event) => (event.costSource === 'unknown') === (event.cost === null),
  { message: 'cost must be present exactly when costSource is known' }
);

export type ProviderCostAttemptEvent = z.infer<typeof providerCostAttemptEventSchema>;

const attemptFeedPageSchema = z.object({
  schemaVersion: z.literal(1),
  attempts: z.array(providerCostAttemptEventSchema),
  next: z.string().min(1).max(1024).nullable().optional(),
  caughtUp: z.boolean(),
});

export type ProviderCostFeedPage = z.infer<typeof attemptFeedPageSchema>;

/* -------------------------------------------------------------------------- */
/*  Amounts                                                                   */
/* -------------------------------------------------------------------------- */

const PICO_SCALE = 12;
const MAX_INTEGER_DIGITS = 18;

/**
 * `"3060000000"` picos → `"0.003060000000"`. String-only, so it is exact.
 * Throws for a value outside the ledger's 18 integer digits.
 */
export function picosToDecimal(amountPicos: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(amountPicos)) {
    throw new Error('amountPicos must be a non-negative integer string');
  }
  const padded = amountPicos.padStart(PICO_SCALE + 1, '0');
  const integer = padded.slice(0, -PICO_SCALE).replace(/^0+(?=\d)/, '');
  if (integer.length > MAX_INTEGER_DIGITS) {
    throw new Error('amountPicos exceeds the ledger amount range');
  }
  return `${integer}.${padded.slice(-PICO_SCALE)}`;
}

/** SHA-256 of the facts this table stores, in a fixed key order. */
export function attemptFactsDigest(event: ProviderCostAttemptEvent): string {
  const facts = [
    event.requestId,
    event.attemptIndex,
    event.provider,
    event.keyId,
    event.keyClass,
    event.deploymentId,
    event.modelReference,
    event.cost === null ? null : [event.cost.currency, event.cost.amountPicos],
    event.costSource,
    event.rateCardVersionId,
    event.costComplete,
    event.served,
    new Date(event.occurredAt).toISOString(),
    event.units === null
      ? null
      : [...event.units].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)),
    event.telemetry === null
      ? null
      : [event.telemetry.outcome, event.telemetry.failureCode, event.telemetry.latencyMs],
  ];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

/* -------------------------------------------------------------------------- */
/*  Ingestion                                                                 */
/* -------------------------------------------------------------------------- */

export interface ProviderCostIngestion {
  readonly inserted: number;
  readonly duplicates: number;
  /** Same key, different facts: refused, logged, never overwritten. */
  readonly mismatches: number;
}

/** Store a page of attempts, idempotently on `(request_id, attempt_index)`. */
export async function ingestProviderCostAttempts(
  events: readonly ProviderCostAttemptEvent[]
): Promise<ProviderCostIngestion> {
  let inserted = 0;
  let duplicates = 0;
  let mismatches = 0;
  const db = getDb();
  for (const event of events) {
    const digest = attemptFactsDigest(event);
    const [row] = await db
      .insert(inferenceProviderCostAttempts)
      .values({
        requestId: event.requestId,
        attemptIndex: event.attemptIndex,
        provider: event.provider,
        keyId: event.keyId,
        keyClass: event.keyClass,
        deploymentId: event.deploymentId,
        modelReference: event.modelReference,
        costSource: event.costSource,
        costAmount: event.cost === null ? null : picosToDecimal(event.cost.amountPicos),
        costCurrency: event.cost?.currency ?? null,
        rateCardVersionId: event.rateCardVersionId,
        costComplete: event.costComplete,
        served: event.served,
        occurredAt: new Date(event.occurredAt),
        units: event.units,
        outcome: event.telemetry?.outcome ?? null,
        failureCode: event.telemetry?.failureCode ?? null,
        latencyMs: event.telemetry?.latencyMs ?? null,
        feedPosition: event.position,
        factsDigest: digest,
      })
      .onConflictDoNothing()
      .returning({ requestId: inferenceProviderCostAttempts.requestId });
    if (row !== undefined) {
      inserted += 1;
      continue;
    }
    const [existing] = await db
      .select({ factsDigest: inferenceProviderCostAttempts.factsDigest })
      .from(inferenceProviderCostAttempts)
      .where(
        sql`${inferenceProviderCostAttempts.requestId} = ${event.requestId}
          and ${inferenceProviderCostAttempts.attemptIndex} = ${event.attemptIndex}`
      )
      .limit(1);
    if (existing?.factsDigest === digest) {
      duplicates += 1;
    } else {
      mismatches += 1;
      logger.error(
        'inference.provider_cost.replay_mismatch',
        new Error('a redelivered provider-cost attempt differs from the stored one'),
        { requestId: event.requestId, attemptIndex: event.attemptIndex }
      );
    }
  }
  return { inserted, duplicates, mismatches };
}

/* -------------------------------------------------------------------------- */
/*  The signed read                                                           */
/* -------------------------------------------------------------------------- */

export interface ProviderCostFeedReader {
  readPage(after: string | null, limit: number): Promise<ProviderCostFeedPage>;
}

export function providerTelemetrySigningInput(keyId: string, timestamp: number, body: Buffer): Buffer {
  const digest = createHash('sha256').update(body).digest('hex');
  return Buffer.from([SIGNATURE_DOMAIN, keyId, String(timestamp), digest].join('\n'), 'utf8');
}

export class HttpKaanaProviderCostFeedReader implements ProviderCostFeedReader {
  constructor(private readonly config: KaanaDataPlaneConfig) {}

  async readPage(after: string | null, limit: number): Promise<ProviderCostFeedPage> {
    const body = Buffer.from(
      JSON.stringify({ schemaVersion: 1, ...(after === null ? {} : { after }), limit }),
      'utf8'
    );
    const timestamp = Date.now();
    const signature = sign(
      null,
      providerTelemetrySigningInput(this.config.keyId, timestamp, body),
      this.config.privateKey
    ).toString('base64');
    const response = await fetch(`${this.config.baseUrl}${ATTEMPT_FEED_PATH}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'cache-control': 'no-store',
        'X-Oxy-Kaana-Key-Id': this.config.keyId,
        'X-Oxy-Kaana-Timestamp': String(timestamp),
        'X-Oxy-Kaana-Signature': `v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new Error('Kaana provider-cost feed response exceeded its bound');
    }
    if (response.status !== 200) {
      throw new Error(`Kaana provider-cost feed answered ${response.status}`);
    }
    return attemptFeedPageSchema.parse(JSON.parse(raw));
  }
}

export function createHttpKaanaProviderCostFeedReader(): ProviderCostFeedReader | undefined {
  const resolution = resolveKaanaDataPlane();
  return resolution.status === 'configured'
    ? new HttpKaanaProviderCostFeedReader(resolution.config)
    : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Sync                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProviderCostFeedSync extends ProviderCostIngestion {
  readonly pages: number;
  readonly caughtUp: boolean;
}

async function readCursor(): Promise<string | null> {
  const [row] = await getDb()
    .select({ cursor: inferenceProviderCostFeedCursors.cursor })
    .from(inferenceProviderCostFeedCursors)
    .where(eq(inferenceProviderCostFeedCursors.feed, FEED_NAME))
    .limit(1);
  return row?.cursor ?? null;
}

/** Advance from `from` to `to`, only if nobody else moved it first. */
async function advanceCursor(from: string | null, to: string): Promise<boolean> {
  const db = getDb();
  if (from === null) {
    const inserted = await db
      .insert(inferenceProviderCostFeedCursors)
      .values({ feed: FEED_NAME, cursor: to })
      .onConflictDoNothing()
      .returning({ feed: inferenceProviderCostFeedCursors.feed });
    if (inserted.length > 0) return true;
  }
  const updated = await db
    .update(inferenceProviderCostFeedCursors)
    .set({ cursor: to, updatedAt: new Date() })
    .where(
      sql`${inferenceProviderCostFeedCursors.feed} = ${FEED_NAME}
        and ${inferenceProviderCostFeedCursors.cursor} is not distinct from ${from}`
    )
    .returning({ feed: inferenceProviderCostFeedCursors.feed });
  return updated.length > 0;
}

/** Read and store pages until the feed is caught up, or the run's page budget is spent. */
export async function syncProviderCostFeed(
  reader: ProviderCostFeedReader,
  maxPages = MAX_PAGES_PER_RUN
): Promise<ProviderCostFeedSync> {
  let cursor = await readCursor();
  let pages = 0;
  let inserted = 0;
  let duplicates = 0;
  let mismatches = 0;
  let caughtUp = false;
  while (pages < maxPages) {
    const page = await reader.readPage(cursor, PAGE_SIZE);
    pages += 1;
    const ingestion = await ingestProviderCostAttempts(page.attempts);
    inserted += ingestion.inserted;
    duplicates += ingestion.duplicates;
    mismatches += ingestion.mismatches;
    caughtUp = page.caughtUp;
    const next = page.next ?? null;
    if (next !== null && next !== cursor) {
      // Another task advanced it: stop, and let the next run resume from there.
      if (!(await advanceCursor(cursor, next))) break;
      cursor = next;
    }
    if (caughtUp || next === null) break;
  }
  return { pages, caughtUp, inserted, duplicates, mismatches };
}

/** Run {@link syncProviderCostFeed} on an interval in this API task. */
export function startProviderCostFeedSchedule(): { stop(): void } | undefined {
  const reader = createHttpKaanaProviderCostFeedReader();
  if (reader === undefined) {
    logger.info('inference.provider_cost_feed.not_configured', { component: 'inference-provider-cost' });
    return undefined;
  }
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    syncProviderCostFeed(reader)
      .then((result) => {
        if (result.inserted > 0 || result.mismatches > 0) {
          logger.info('inference.provider_cost_feed.synced', { ...result });
        }
      })
      .catch((error: unknown) =>
        logger.error(
          'inference.provider_cost_feed.failed',
          error instanceof Error ? error : new Error(String(error))
        )
      )
      .finally(() => {
        running = false;
      });
  };
  const interval = setInterval(tick, PROVIDER_COST_FEED_INTERVAL_MS);
  interval.unref();
  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}
