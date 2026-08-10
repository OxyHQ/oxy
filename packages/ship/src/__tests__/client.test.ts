import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShipClient, decodeServiceTokenAppId, type FetchFn } from '../client';

function makeToken(appId: string | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ type: 'service', appId })).toString('base64url');
  return `${header}.${payload}.signature`;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  isBytes?: boolean;
}

function mockFetch(calls: RecordedCall[], response: unknown, ok = true, status = 200): FetchFn {
  return async (url, init) => {
    const isBytes = init.body !== undefined && typeof init.body !== 'string';
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      json: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      isBytes,
    });
    return {
      ok,
      status,
      text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
    };
  };
}

const TOKEN = makeToken('app123');
const SHA_A = 'a'.repeat(64);

function client(fetchFn: FetchFn): ShipClient {
  return new ShipClient({ baseURL: 'http://api.test', getToken: async () => TOKEN, fetchFn });
}

describe('decodeServiceTokenAppId', () => {
  test('reads the appId claim', () => {
    expect(decodeServiceTokenAppId(makeToken('app123'))).toBe('app123');
  });
  test('rejects a non-JWT', () => {
    expect(() => decodeServiceTokenAppId('nope')).toThrow();
  });
  test('rejects a token with no appId', () => {
    expect(() => decodeServiceTokenAppId(makeToken(undefined))).toThrow(/appId/);
  });
});

describe('ShipClient', () => {
  test('initAssets posts applicationId + assets and unwraps { data }', async () => {
    const calls: RecordedCall[] = [];
    const res = await client(
      mockFetch(calls, { data: { missing: [], existing: [SHA_A] } })
    ).initAssets([{ sha256: SHA_A, contentType: 'image/png', size: 10 }]);

    expect(res.existing).toEqual([SHA_A]);
    expect(calls[0].url).toBe('http://api.test/updates/v1/assets/init');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].json?.applicationId).toBe('app123');
    expect((calls[0].json?.assets as unknown[]).length).toBe(1);
  });

  test('createUpdate returns the update from { data: { update } }', async () => {
    const calls: RecordedCall[] = [];
    const update = await client(
      mockFetch(calls, { data: { update: { id: 'new-uuid', rolloutPercent: 100 } } })
    ).createUpdate({
      channel: 'production',
      runtimeVersion: '1.0.0',
      platform: 'ios',
      launchAsset: { sha256: SHA_A, key: 'k', contentType: 'application/javascript' },
      assets: [],
      extra: { expoClient: {} },
    });

    expect(update.id).toBe('new-uuid');
    expect(calls[0].url).toBe('http://api.test/updates/v1/updates');
    expect(calls[0].json?.applicationId).toBe('app123');
    expect(calls[0].json?.channel).toBe('production');
  });

  test('non-2xx surfaces the status + body', async () => {
    const calls: RecordedCall[] = [];
    await expect(
      client(mockFetch(calls, '{"error":"forbidden"}', false, 403)).initAssets([
        { sha256: SHA_A, contentType: 'image/png', size: 1 },
      ])
    ).rejects.toThrow(/403/);
  });

  test('uploadAsset PUTs raw bytes with the signed content-type + cache-control (no auth header)', async () => {
    const calls: RecordedCall[] = [];
    const tmp = path.join(os.tmpdir(), `ship-upload-${Date.now()}.bin`);
    fs.writeFileSync(tmp, Buffer.from([1, 2, 3, 4]));
    try {
      await client(mockFetch(calls, '')).uploadAsset(
        'http://s3/put',
        'image/png',
        'public, max-age=31536000, immutable',
        'AQIDBA==',
        tmp
      );
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    expect(calls[0].url).toBe('http://s3/put');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers['content-type']).toBe('image/png');
    expect(calls[0].headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(calls[0].headers['x-amz-checksum-sha256']).toBe('AQIDBA==');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].isBytes).toBe(true);
  });

  test('rollback URL-encodes the channel and returns { rolledBack, head }', async () => {
    const calls: RecordedCall[] = [];
    const res = await client(
      mockFetch(calls, { data: { rolledBack: { id: 'h' }, head: { id: 'p' } } })
    ).rollback('pr-1', '1.0.0', 'ios');
    expect(res.rolledBack.id).toBe('h');
    expect(res.head?.id).toBe('p');
    expect(calls[0].url).toBe('http://api.test/updates/v1/channels/pr-1/rollback');
    expect(calls[0].json).toEqual({ applicationId: 'app123', runtimeVersion: '1.0.0', platform: 'ios' });
  });

  test('promote posts to the target channel and returns the new update', async () => {
    const calls: RecordedCall[] = [];
    const update = await client(
      mockFetch(calls, { data: { update: { id: 'promoted', rolloutPercent: 50 } } })
    ).promote('preview', 'source-uuid', 50);
    expect(update.id).toBe('promoted');
    expect(calls[0].url).toBe('http://api.test/updates/v1/channels/preview/promote');
    expect(calls[0].json).toEqual({ applicationId: 'app123', updateId: 'source-uuid', rolloutPercent: 50 });
  });

  test('listChannels passes applicationId as a query param', async () => {
    const calls: RecordedCall[] = [];
    const channels = await client(
      mockFetch(calls, { data: { channels: [{ name: 'production', rollbacksToEmbedded: [] }] } })
    ).listChannels();
    expect(channels).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/updates/v1/channels?applicationId=app123');
    expect(calls[0].method).toBe('GET');
  });

  test('listUpdates targets the channel-scoped route with filters', async () => {
    const calls: RecordedCall[] = [];
    const updates = await client(mockFetch(calls, { data: { updates: [{ id: 'u1' }] } })).listUpdates({
      channel: 'production',
      runtimeVersion: '1.0.0',
      platform: 'ios',
      limit: 5,
    });
    expect(updates).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/updates/v1/channels/production/updates?');
    expect(calls[0].url).toContain('applicationId=app123');
    expect(calls[0].url).toContain('runtimeVersion=1.0.0');
    expect(calls[0].url).toContain('platform=ios');
    expect(calls[0].url).toContain('limit=5');
  });

  test('listUpdates without a channel uses the flat route', async () => {
    const calls: RecordedCall[] = [];
    await client(mockFetch(calls, { data: { updates: [] } })).listUpdates({});
    expect(calls[0].url).toBe('http://api.test/updates/v1/updates?applicationId=app123');
  });
});
