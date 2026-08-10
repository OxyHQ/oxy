import { test, expect, describe, beforeAll, afterAll, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const iosBundle = Buffer.from('ios-bundle');
const androidBundle = Buffer.from('android-bundle');
const sharedAsset = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let distDir: string;

// Record the client interactions the orchestration drives.
const initCalls: Array<Array<{ sha256: string }>> = [];
const uploadCalls: Array<{ url: string; cacheControl: string }> = [];
const completeCalls: string[][] = [];
const createCalls: Array<Record<string, unknown>> = [];

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const fakeClient = {
  initAssets: async (items: Array<{ sha256: string; contentType: string; size: number }>) => {
    initCalls.push(items);
    return {
      missing: items.map((item) => ({
        sha256: item.sha256,
        uploadUrl: `http://s3/${item.sha256}`,
        storageKey: `public/updates/assets/${item.sha256}`,
        contentType: item.contentType,
        cacheControl: CACHE_CONTROL,
        checksumSHA256: Buffer.from(item.sha256, 'hex').toString('base64'),
      })),
      existing: [],
    };
  },
  uploadAsset: async (
    url: string,
    _contentType: string,
    cacheControl: string,
    _checksumSHA256: string
  ) => {
    uploadCalls.push({ url, cacheControl });
  },
  completeAssets: async (sha256s: string[]) => {
    completeCalls.push(sha256s);
    return { assets: sha256s.map((s) => ({ sha256: s, status: 'uploaded' as const, size: 1 })) };
  },
  createUpdate: async (body: Record<string, unknown>) => {
    createCalls.push(body);
    const platform = body.platform as string;
    return {
      id: `uuid-${platform}`,
      platform,
      rolloutPercent: (body.rolloutPercent as number) ?? 100,
    };
  },
};

mock.module('../config', () => ({ createShipClient: () => fakeClient }));
mock.module('../exec', () => ({
  runExpoExport: () => undefined,
  readExpoPublicConfig: () => ({ version: '1.0.0', slug: 'demo', name: 'Demo' }),
}));

// Import AFTER the module mocks are registered.
const { publishCommand } = await import('../commands');

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-publish-'));
  fs.mkdirSync(path.join(distDir, '_expo/static/js/ios'), { recursive: true });
  fs.mkdirSync(path.join(distDir, '_expo/static/js/android'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, '_expo/static/js/ios/index.hbc'), iosBundle);
  fs.writeFileSync(path.join(distDir, '_expo/static/js/android/index.hbc'), androidBundle);
  fs.writeFileSync(path.join(distDir, 'assets/shared'), sharedAsset);
  fs.writeFileSync(
    path.join(distDir, 'metadata.json'),
    JSON.stringify({
      fileMetadata: {
        ios: {
          bundle: '_expo/static/js/ios/index.hbc',
          assets: [{ path: 'assets/shared', ext: 'png' }],
        },
        android: {
          bundle: '_expo/static/js/android/index.hbc',
          assets: [{ path: 'assets/shared', ext: 'png' }],
        },
      },
    })
  );
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('publishCommand orchestration', () => {
  test('exports, dedups assets across platforms, uploads, completes, publishes per platform', async () => {
    await publishCommand({
      channel: 'production',
      'skip-export': true,
      'dist-dir': distDir,
      rollout: '100',
      'client-id': 'x',
      secret: 'y',
    });

    // The shared asset is offered once even though both platforms reference it:
    // 2 distinct bundles + 1 shared asset = 3 unique content addresses.
    expect(initCalls[0]).toHaveLength(3);
    const offered = new Set(initCalls[0].map((i) => i.sha256));
    expect(offered.has(sha(iosBundle))).toBe(true);
    expect(offered.has(sha(androidBundle))).toBe(true);
    expect(offered.has(sha(sharedAsset))).toBe(true);

    // Every missing asset is uploaded exactly once, replaying the signed cache-control.
    expect(uploadCalls).toHaveLength(3);
    expect(uploadCalls.every((c) => c.cacheControl === CACHE_CONTROL)).toBe(true);
    // Complete is called with the full unique set.
    expect(completeCalls[0].length).toBe(3);

    // One update per platform, each carrying extra.expoClient.
    expect(createCalls).toHaveLength(2);
    expect(createCalls.map((c) => c.platform).sort()).toEqual(['android', 'ios']);
    for (const call of createCalls) {
      expect((call.extra as { expoClient: { version: string } }).expoClient.version).toBe('1.0.0');
      expect(call.runtimeVersion).toBe('1.0.0');
      expect(call.channel).toBe('production');
      expect(call.rolloutPercent).toBe(100);
    }

    // The ios update's launch asset is the ios bundle; assets carry the shared png.
    const iosUpdate = createCalls.find((c) => c.platform === 'ios');
    expect((iosUpdate?.launchAsset as { sha256: string }).sha256).toBe(sha(iosBundle));
    const iosAssets = iosUpdate?.assets as Array<{ sha256: string; fileExtension?: string }>;
    expect(iosAssets[0].sha256).toBe(sha(sharedAsset));
    expect(iosAssets[0].fileExtension).toBe('.png');
  });
});
