/**
 * Oxy's reader of Kaana's provider-cost operator feed (#1526, I09), against a
 * REAL Postgres and a local HTTP server standing in for Kaana.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { USAGE_UNITS } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  inferenceProviderCostAttempts,
  inferenceProviderCostFeedCursors,
} from '../../db/schema/inferenceProviderCostAttempts';
import {
  HttpKaanaProviderCostFeedReader,
  ingestProviderCostAttempts,
  picosToDecimal,
  providerCostAttemptEventSchema,
  providerTelemetrySigningInput,
  syncProviderCostFeed,
  type ProviderCostAttemptEvent,
  type ProviderCostFeedPage,
  type ProviderCostFeedReader,
} from '../kaanaProviderCostFeed.service';
import { logger } from '../../utils/logger';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function attempt(
  requestId: string,
  index: number,
  overrides: Partial<ProviderCostAttemptEvent> = {},
): ProviderCostAttemptEvent {
  return {
    position: `kaf_${requestId}_${index}`,
    requestId,
    attemptIndex: index,
    provider: 'synthetic',
    keyId: 'key-1',
    keyClass: 'platform',
    deploymentId: 'kaana-synthetic',
    modelReference: 'pub/model@2026-01-01',
    cost: { currency: 'USD', amountPicos: '3060000000' },
    costSource: 'rate_card',
    rateCardVersionId: 'rc-1',
    costComplete: true,
    served: true,
    occurredAt: '2026-10-02T10:00:00.000Z',
    units: [{ unit: 'input_tokens', quantity: 1020 }],
    telemetry: {
      startedAt: '2026-10-02T10:00:00.000Z',
      latencyMs: 120,
      timeToFirstOutputMs: 40,
      outcome: 'succeeded',
      failureCode: null,
    },
    ...overrides,
  };
}

async function stored(requestId: string) {
  return getDb()
    .select()
    .from(inferenceProviderCostAttempts)
    .where(eq(inferenceProviderCostAttempts.requestId, requestId))
    .orderBy(inferenceProviderCostAttempts.attemptIndex);
}

describe('picosToDecimal', () => {
  it('moves the decimal point by string, exactly', () => {
    expect(picosToDecimal('0')).toBe('0.000000000000');
    expect(picosToDecimal('3060000000')).toBe('0.003060000000');
    expect(picosToDecimal('1')).toBe('0.000000000001');
    expect(picosToDecimal('12345678901234567890')).toBe('12345678.901234567890');
  });

  it('refuses anything that is not a non-negative integer, or out of range', () => {
    for (const bad of ['-1', '1.5', '1e3', '', '01']) {
      expect(() => picosToDecimal(bad)).toThrow();
    }
    expect(() => picosToDecimal('1'.padEnd(31, '0'))).toThrow();
  });
});

describe('ingestProviderCostAttempts', () => {
  it('stores a repeated feed once', async () => {
    const requestId = randomUUID();
    const page = [attempt(requestId, 0, { served: false, telemetry: null }), attempt(requestId, 1)];
    expect(await ingestProviderCostAttempts(page)).toEqual({
      inserted: 2,
      duplicates: 0,
      mismatches: 0,
    });
    expect(await ingestProviderCostAttempts(page)).toEqual({
      inserted: 0,
      duplicates: 2,
      mismatches: 0,
    });

    const rows = await stored(requestId);
    expect(rows).toHaveLength(2);
    // A failed failover keeps its recorded estimate; this is no invoice proof.
    expect(rows[0]).toMatchObject({ served: false, costAmount: '0.003060000000', outcome: null });
    expect(rows[1]).toMatchObject({
      served: true,
      costAmount: '0.003060000000',
      outcome: 'succeeded',
      latencyMs: 120,
    });
  });

  it('refuses a redelivery with different facts instead of overwriting the cost', async () => {
    const requestId = randomUUID();
    await ingestProviderCostAttempts([attempt(requestId, 0)]);
    const changed = attempt(requestId, 0, { cost: { currency: 'USD', amountPicos: '1' } });
    expect(await ingestProviderCostAttempts([changed])).toEqual({
      inserted: 0,
      duplicates: 0,
      mismatches: 1,
    });
    expect((await stored(requestId))[0].costAmount).toBe('0.003060000000');
    expect(logger.error).toHaveBeenCalledWith(
      'inference.provider_cost.replay_mismatch',
      expect.any(Error),
      expect.objectContaining({ requestId }),
    );
  });

  it('keeps an unknown cost unknown: no amount, no currency', async () => {
    const requestId = randomUUID();
    await ingestProviderCostAttempts([
      attempt(requestId, 0, {
        cost: null,
        costSource: 'unknown',
        rateCardVersionId: null,
        units: null,
      }),
    ]);
    expect((await stored(requestId))[0]).toMatchObject({
      costSource: 'unknown',
      costAmount: null,
      costCurrency: null,
      unitsMeasured: false,
      inputTokens: 0,
    });
  });

  it('stores each unit in its own column, and unmeasured is not a measured zero', async () => {
    const requestId = randomUUID();
    await ingestProviderCostAttempts([
      attempt(requestId, 0, {
        units: [
          { unit: 'output_tokens', quantity: 77 },
          { unit: 'input_tokens', quantity: 1020 },
          { unit: 'audio_input_milliseconds', quantity: 3500 },
        ],
      }),
      attempt(requestId, 1, { units: [] }),
      attempt(requestId, 2, { units: null }),
    ]);
    const [measured, measuredEmpty, unmeasured] = await stored(requestId);
    expect(measured).toMatchObject({
      unitsMeasured: true,
      inputTokens: 1020,
      outputTokens: 77,
      audioInputMilliseconds: 3500,
      cachedInputTokens: 0,
    });
    expect(measuredEmpty).toMatchObject({ unitsMeasured: true, inputTokens: 0 });
    expect(unmeasured).toMatchObject({ unitsMeasured: false, inputTokens: 0, outputTokens: 0 });
  });

  it('the table itself refuses an unmeasured attempt that carries a quantity', async () => {
    const requestId = randomUUID();
    await ingestProviderCostAttempts([attempt(requestId, 0)]);
    const thrown = await getDb()
      .update(inferenceProviderCostAttempts)
      .set({ unitsMeasured: false })
      .where(eq(inferenceProviderCostAttempts.requestId, requestId))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // Drizzle wraps the driver error; the constraint is named on its cause.
    let constraint: unknown;
    for (let current = thrown; current instanceof Error; current = current.cause) {
      constraint ??= Reflect.get(current, 'constraint_name');
    }
    expect(constraint).toBe('inference_provider_cost_attempts_unmeasured_check');
  });
});

describe('providerCostAttemptEventSchema units', () => {
  it('preserves an unsupplied historical key class without assigning authority', async () => {
    const requestId = randomUUID();
    const historical = attempt(requestId, 0, { keyClass: '' });
    expect(providerCostAttemptEventSchema.parse(historical).keyClass).toBe('');
    for (const keyClass of [undefined, null, 0, false, 'x'.repeat(65)]) {
      expect(providerCostAttemptEventSchema.safeParse({ ...historical, keyClass }).success).toBe(
        false,
      );
    }
    await ingestProviderCostAttempts([historical]);
    expect((await stored(requestId))[0].keyClass).toBe('');
  });
  it('accepts every unit Oxy prices', () => {
    for (const unit of USAGE_UNITS) {
      expect(
        providerCostAttemptEventSchema.safeParse(
          attempt('r', 0, { units: [{ unit, quantity: 1 }] }),
        ).success,
      ).toBe(true);
    }
  });

  it('refuses a unit it does not know instead of storing it', () => {
    const event = { ...attempt('r', 0), units: [{ unit: 'prompt_text', quantity: 1 }] };
    expect(providerCostAttemptEventSchema.safeParse(event).success).toBe(false);
  });

  it('refuses a unit reported twice', () => {
    const event = attempt('r', 0, {
      units: [
        { unit: 'input_tokens', quantity: 1 },
        { unit: 'input_tokens', quantity: 2 },
      ],
    });
    expect(providerCostAttemptEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('syncProviderCostFeed', () => {
  class FakeReader implements ProviderCostFeedReader {
    readonly calls: (string | null)[] = [];
    constructor(private readonly pages: Map<string | null, ProviderCostFeedPage>) {}
    async readPage(after: string | null): Promise<ProviderCostFeedPage> {
      this.calls.push(after);
      const page = this.pages.get(after);
      if (page === undefined)
        return { schemaVersion: 1, attempts: [], next: after, caughtUp: true };
      return page;
    }
  }

  it('follows the cursor across pages, resumes from it, and a replay inserts nothing', async () => {
    // Start from whatever cursor sibling cases left behind.
    await getDb().delete(inferenceProviderCostFeedCursors);
    const first = randomUUID();
    const second = randomUUID();
    const pages = new Map<string | null, ProviderCostFeedPage>([
      [null, { schemaVersion: 1, attempts: [attempt(first, 0)], next: 'kaf_1', caughtUp: false }],
      [
        'kaf_1',
        { schemaVersion: 1, attempts: [attempt(second, 0)], next: 'kaf_2', caughtUp: true },
      ],
    ]);
    const reader = new FakeReader(pages);
    expect(await syncProviderCostFeed(reader)).toMatchObject({
      pages: 2,
      caughtUp: true,
      inserted: 2,
    });
    expect(reader.calls).toEqual([null, 'kaf_1']);

    const again = new FakeReader(pages);
    expect(await syncProviderCostFeed(again)).toMatchObject({ pages: 1, inserted: 0 });
    expect(again.calls).toEqual(['kaf_2']);

    // A reader that replays the old pages from the start stores nothing new.
    const replay = await ingestProviderCostAttempts([attempt(first, 0), attempt(second, 0)]);
    expect(replay).toEqual({ inserted: 0, duplicates: 2, mismatches: 0 });
  });
});

describe('HttpKaanaProviderCostFeedReader', () => {
  it('reads and replays the pseudonymized historical live page locally without fabricating cost or class', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__/providerCostFeedLive20261002.json'), 'utf8'),
    );
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let requests = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests += 1;
        const body = Buffer.concat(chunks);
        expect(req.url).toBe('/internal/v1/provider-telemetry/attempts');
        expect(JSON.parse(body.toString('utf8'))).toEqual({ schemaVersion: 1, limit: 25 });
        const signature = Buffer.from(
          String(req.headers['x-oxy-kaana-signature']).replace(/^v1=/, ''),
          'base64',
        );
        expect(
          verify(
            null,
            providerTelemetrySigningInput(
              'fixture-edge',
              Number(req.headers['x-oxy-kaana-timestamp']),
              body,
            ),
            publicKey,
            signature,
          ),
        ).toBe(true);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fixture.response));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const reader = new HttpKaanaProviderCostFeedReader({
        baseUrl: `http://127.0.0.1:${port}`,
        keyId: 'fixture-edge',
        privateKey,
      });
      const page = await reader.readPage(null, 25);
      expect(page.attempts).toHaveLength(25);
      expect(page.attempts.filter((event) => event.keyClass === '')).toHaveLength(21);
      expect(new Set(page.attempts.map((event) => event.requestId)).size).toBe(23);
      expect(await ingestProviderCostAttempts(page.attempts)).toEqual({
        inserted: 25,
        duplicates: 0,
        mismatches: 0,
      });
      expect(await ingestProviderCostAttempts((await reader.readPage(null, 25)).attempts)).toEqual({
        inserted: 0,
        duplicates: 25,
        mismatches: 0,
      });
      expect(requests).toBe(2);
      // A later producer fix cannot rewrite a digest already admitted from the
      // ambiguous old wire shape. This is why the fix precedes live ingestion.
      expect(await ingestProviderCostAttempts([{ ...page.attempts[0], units: null }])).toEqual({
        inserted: 0,
        duplicates: 0,
        mismatches: 1,
      });
      for (const event of page.attempts) {
        const row = (await stored(event.requestId)).find(
          (attempt) => attempt.attemptIndex === event.attemptIndex,
        );
        expect(row).toMatchObject({
          keyClass: event.keyClass,
          costSource: 'unknown',
          costAmount: null,
          costCurrency: null,
        });
        // The old producer encoded unknown historical units as []. This proves
        // preservation of the wire value only, never that those units were measured.
        // Production ingestion must wait for the NULL-preserving producer fix.
        expect(event.units).toEqual([]);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('signs under the provider-telemetry domain only, with the edge key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let seen: { headers: http.IncomingHttpHeaders; body: Buffer } | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen = { headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            attempts: [attempt(randomUUID(), 0)],
            next: 'kaf_9',
            caughtUp: true,
            readAt: new Date().toISOString(),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const reader = new HttpKaanaProviderCostFeedReader({
        baseUrl: `http://127.0.0.1:${port}`,
        keyId: 'oxy-edge-1',
        privateKey,
      } as never);
      const page = await reader.readPage('kaf_8', 500);
      expect(page).toMatchObject({ next: 'kaf_9', caughtUp: true });

      if (seen === undefined) throw new Error('no request reached the fake Kaana');
      expect(JSON.parse(seen.body.toString('utf8'))).toEqual({
        schemaVersion: 1,
        after: 'kaf_8',
        limit: 500,
      });
      const signature = Buffer.from(
        String(seen.headers['x-oxy-kaana-signature']).replace(/^v1=/, ''),
        'base64',
      );
      const timestamp = Number(seen.headers['x-oxy-kaana-timestamp']);
      expect(seen.headers['x-oxy-kaana-key-id']).toBe('oxy-edge-1');
      expect(
        verify(
          null,
          providerTelemetrySigningInput('oxy-edge-1', timestamp, seen.body),
          createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })),
          signature,
        ),
      ).toBe(true);

      // The same bytes under the INFERENCE domain do not verify: this signature
      // cannot be replayed as an envelope, and an envelope cannot read costs.
      const digest = createHash('sha256').update(seen.body).digest('hex');
      const envelopeInput = Buffer.from(
        ['oxy-kaana-envelope:v1', 'oxy-edge-1', String(timestamp), digest].join('\n'),
      );
      expect(verify(null, envelopeInput, publicKey, signature)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses a page whose known/unknown cost shape is inconsistent', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          attempts: [attempt(randomUUID(), 0, { costSource: 'unknown' })],
          next: 'kaf_1',
          caughtUp: true,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const { privateKey } = generateKeyPairSync('ed25519');
      const reader = new HttpKaanaProviderCostFeedReader({
        baseUrl: `http://127.0.0.1:${port}`,
        keyId: 'k',
        privateKey,
      } as never);
      await expect(reader.readPage(null, 10)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
