/**
 * Kaana's declared catalogue as Oxy reads it to rate a grant: the signed read,
 * the in-memory cache, the versioning by `priceVersionId`, and the typed
 * refusals (never a price of zero).
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import http from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { deploymentCommercialSchema } from '@kaana.ai/contracts/internal';
import { declaredModel } from '../../routes/__fixtures__/kaanaDeclaredStub';
import {
  KAANA_KEY_ID_HEADER,
  KAANA_SIGNATURE_HEADER,
  KAANA_TIMESTAMP_HEADER,
  createHttpKaanaDeclaredCatalogueReader,
  kaanaDeploymentCommercialSchema,
  kaanaSigningInput,
} from '../httpKaanaClient';
import {
  DECLARED_CATALOGUE_MAX_STALE_MS,
  DECLARED_CATALOGUE_TTL_MS,
  DeclaredPriceError,
  audienceAdmits,
  createDeclaredCatalogueCache,
  isCallable,
  priceSnapshotOf,
  requirePriceSnapshot,
  unpricedUnits,
} from '../kaanaDeclaredCatalogue.service';
import { createDeploymentPublicationCache } from '../kaanaDeploymentPublication.service';

const prices = (priceVersionId: string, input = '3.000000000000') => ({
  priceVersionId,
  unitPrices: [
    { unit: 'requests' as const, amount: '0.000000000000', per: 1 },
    { unit: 'input_tokens' as const, amount: input, per: 1_000_000 },
    { unit: 'output_tokens' as const, amount: '15.000000000000', per: 1_000_000 },
  ],
});

const catalogue = (...models: ReturnType<typeof declaredModel>[]) => ({
  schemaVersion: 1,
  models,
});

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('the declared catalogue cache', () => {
  it('reads once per TTL, single-flight, and serves the same observation meanwhile', async () => {
    const time = clock();
    const read = jest.fn(async () =>
      catalogue(declaredModel({ modelId: 'acme/one', pricing: prices('v1') })),
    );
    const cache = createDeclaredCatalogueCache({ readDeclaredCatalogue: read }, { now: time.now });

    const [first, second] = await Promise.all([cache.current(), cache.current()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.status).toBe('observed');

    time.advance(DECLARED_CATALOGUE_TTL_MS - 1);
    await cache.current();
    expect(read).toHaveBeenCalledTimes(1);
    time.advance(2);
    await cache.current();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good read through an outage, then fails closed past the stale bound', async () => {
    const time = clock();
    let failing = false;
    const cache = createDeclaredCatalogueCache(
      {
        readDeclaredCatalogue: async () => {
          if (failing) throw new Error('Kaana is down');
          return catalogue(declaredModel({ modelId: 'acme/one', pricing: prices('v1') }));
        },
      },
      { now: time.now },
    );
    await cache.current();
    failing = true;
    time.advance(DECLARED_CATALOGUE_TTL_MS + 1);
    expect((await cache.current()).status).toBe('observed');
    time.advance(DECLARED_CATALOGUE_MAX_STALE_MS);
    expect(await cache.current()).toEqual({ status: 'unavailable' });
  });

  it('is unavailable, not empty, when Kaana returns something the contract does not parse', async () => {
    const cache = createDeclaredCatalogueCache({
      readDeclaredCatalogue: async () => ({ schemaVersion: 1, models: [{ modelId: 'acme/one' }] }),
    });
    expect(await cache.current()).toEqual({ status: 'unavailable' });
  });

  it('refuses a catalogue that declares one model twice', async () => {
    const model = declaredModel({ modelId: 'acme/one', pricing: prices('v1') });
    const cache = createDeclaredCatalogueCache({
      readDeclaredCatalogue: async () => catalogue(model, model),
    });
    expect(await cache.current()).toEqual({ status: 'unavailable' });
  });

  it('remembers every priceVersionId it has seen, and flags one republished with other prices', async () => {
    const time = clock();
    let current = declaredModel({ modelId: 'acme/one', pricing: prices('v1') });
    const cache = createDeclaredCatalogueCache(
      { readDeclaredCatalogue: async () => catalogue(current) },
      { ttlMs: 0, now: time.now },
    );
    const first = await cache.current();
    if (first.status !== 'observed') throw new Error('unexpected');
    expect(first.changedPriceVersions.size).toBe(0);

    // A new price is a new id: both remembered, nothing flagged.
    current = declaredModel({ modelId: 'acme/one', pricing: prices('v2', '4.000000000000') });
    const second = await cache.current();
    if (second.status !== 'observed') throw new Error('unexpected');
    expect(second.changedPriceVersions.size).toBe(0);
    expect(cache.priceVersion('v1')?.unitPrices[1]?.amount).toBe('3.000000000000');
    expect(cache.priceVersion('v2')?.unitPrices[1]?.amount).toBe('4.000000000000');

    // The same trailing-zero amount written another way is the same price.
    current = declaredModel({ modelId: 'acme/one', pricing: prices('v2', '4.0') });
    const same = await cache.current();
    if (same.status !== 'observed') throw new Error('unexpected');
    expect(same.changedPriceVersions.size).toBe(0);

    // The same id with another price is not a new version: it prices nothing.
    current = declaredModel({ modelId: 'acme/one', pricing: prices('v2', '5.000000000000') });
    const changed = await cache.current();
    if (changed.status !== 'observed') throw new Error('unexpected');
    expect([...changed.changedPriceVersions]).toEqual(['v2']);
    const model = changed.models.get('acme/one');
    if (model === undefined) throw new Error('unexpected');
    expect(() => requirePriceSnapshot(changed, model)).toThrow(
      expect.objectContaining({ code: 'price_version_changed' }),
    );
  });
});

describe('pricing a declared model', () => {
  const observation = (model: ReturnType<typeof declaredModel>) => ({
    status: 'observed' as const,
    models: new Map([[model.modelId, model]]),
    changedPriceVersions: new Set<string>(),
    observedAt: 0,
  });

  it('returns the declared list verbatim', () => {
    const model = declaredModel({ modelId: 'acme/one', pricing: prices('v1') });
    expect(requirePriceSnapshot(observation(model), model)).toEqual({
      priceVersionId: 'v1',
      currency: 'USD',
      unitPrices: prices('v1').unitPrices,
    });
  });

  it('refuses a model that declares no price, with a typed error and never a zero', () => {
    const model = declaredModel({ modelId: 'acme/byok-only' });
    expect(priceSnapshotOf(model)).toBeUndefined();
    let caught: unknown;
    try {
      requirePriceSnapshot(observation(model), model);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeclaredPriceError);
    expect(caught).toMatchObject({
      code: 'model_not_priced',
      detail: { modelId: 'acme/byok-only' },
    });
  });

  it('names the units a list does not price, ignoring zero quantities', () => {
    const snapshot = priceSnapshotOf(declaredModel({ modelId: 'acme/one', pricing: prices('v1') }));
    if (snapshot === undefined) throw new Error('unexpected');
    expect(unpricedUnits(snapshot, { input_tokens: 10, output_tokens: 5 })).toEqual([]);
    expect(unpricedUnits(snapshot, { input_tokens: 10, audio_input_tokens: 3 })).toEqual([
      'audio_input_tokens',
    ]);
    expect(unpricedUnits(snapshot, { audio_input_tokens: 0 })).toEqual([]);
  });

  it('shows a platform_internal model to official products only, and never a retired one', () => {
    const internal = declaredModel({ modelId: 'acme/one', audience: 'platform_internal' });
    const open = declaredModel({ modelId: 'acme/two', audience: 'public' });
    expect(audienceAdmits(['public_payg', 'oxy_hosted'], internal)).toBe(false);
    expect(audienceAdmits(['public_payg', 'oxy_hosted', 'platform_internal'], internal)).toBe(true);
    expect(audienceAdmits(['public_payg'], open)).toBe(true);
    expect(isCallable(declaredModel({ modelId: 'acme/old', deprecation: 'deprecated' }))).toBe(
      true,
    );
    expect(isCallable(declaredModel({ modelId: 'acme/old', deprecation: 'retired' }))).toBe(false);
  });
});

describe('the signed read of GET /internal/v1/models', () => {
  const edge = generateKeyPairSync('ed25519');
  let server: http.Server;
  let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Buffer }[] =
    [];
  let respond: (res: http.ServerResponse) => void = () => undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    seen = [];
  });

  const reader = () =>
    createHttpKaanaDeclaredCatalogueReader({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      keyId: 'edge-test',
      privateKey: edge.privateKey,
    });

  it('signs an empty GET exactly as every envelope is signed, and returns the declaredCatalogue member', async () => {
    const declared = catalogue(declaredModel({ modelId: 'acme/one', pricing: prices('v1') }));
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ contractVersion: 'x', models: [], declaredCatalogue: declared }));
    };
    const result = await reader().readDeclaredCatalogue(new AbortController().signal);
    expect(result).toEqual(JSON.parse(JSON.stringify(declared)));

    const [request] = seen;
    expect(request).toMatchObject({ method: 'GET', url: '/internal/v1/models' });
    expect(request?.body.length).toBe(0);
    const timestamp = Number(request?.headers[KAANA_TIMESTAMP_HEADER.toLowerCase()]);
    const signature = String(request?.headers[KAANA_SIGNATURE_HEADER.toLowerCase()]);
    expect(request?.headers[KAANA_KEY_ID_HEADER.toLowerCase()]).toBe('edge-test');
    expect(signature.startsWith('v1=')).toBe(true);
    expect(
      verify(
        null,
        kaanaSigningInput('edge-test', timestamp, Buffer.alloc(0)),
        edge.publicKey,
        Buffer.from(signature.slice(3), 'base64'),
      ),
    ).toBe(true);
  });

  it('throws when Kaana refuses, or answers without the declared catalogue', async () => {
    respond = (res) => {
      res.statusCode = 401;
      res.end('{}');
    };
    await expect(reader().readDeclaredCatalogue(new AbortController().signal)).rejects.toThrow(
      /HTTP 401/,
    );
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [] }));
    };
    await expect(reader().readDeclaredCatalogue(new AbortController().signal)).rejects.toThrow(
      /no declaredCatalogue/,
    );
  });
});

describe('the commercial basis Kaana publishes on a deployment descriptor', () => {
  it('is checked against the published contract schema, not a local copy', () => {
    const ok = { availabilityScope: 'public_payg', commercialPermission: 'public_resale_approved' };
    expect(deploymentCommercialSchema.safeParse(ok).success).toBe(true);
    for (const candidate of [
      ok,
      { ...ok, dedicatedCapacity: true },
      { ...ok, availabilityScope: 'free_for_all' },
      { ...ok, price: '1' },
      // customer_byok is the permission of byok_only and of no other scope.
      { availabilityScope: 'public_payg', commercialPermission: 'customer_byok' },
      { availabilityScope: 'byok_only', commercialPermission: 'public_resale_approved' },
    ]) {
      expect(kaanaDeploymentCommercialSchema.safeParse(candidate).success).toBe(
        deploymentCommercialSchema.safeParse(candidate).success,
      );
    }
  });

  it('is carried from Kaana’s published descriptor onto the route Oxy reads', async () => {
    const commercial = {
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    } as const;
    const source = createDeploymentPublicationCache({
      listPublishedDeployments: async () => ({
        snapshotId: 's1',
        deployments: [
          {
            deploymentId: 'dep-1',
            modelReference: 'acme/one@r1',
            provider: 'p',
            regions: ['us'],
            commercial,
          },
          { deploymentId: 'dep-2', modelReference: 'acme/one@r1', provider: 'q', regions: [] },
        ],
      }),
    });
    const observed = await source.current();
    if (observed.status !== 'observed') throw new Error('unexpected');
    expect(observed.routes?.get('dep-1')?.commercial).toEqual(commercial);
    // Kaana did not publish a basis for dep-2: the route carries none.
    expect(observed.routes?.get('dep-2')?.commercial).toBeUndefined();
  });
});
