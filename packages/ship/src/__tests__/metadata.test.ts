import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  collectPlatformAssets,
  readExportMetadata,
  resolveRuntimeVersion,
  normalizeExpoConfig,
} from '../metadata';

const bundleBytes = Buffer.from('console.log("bundle");');
const assetBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer) => crypto.createHash('md5').update(b).digest('hex');

let distDir: string;

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-fixture-'));
  fs.mkdirSync(path.join(distDir, '_expo/static/js/ios'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, '_expo/static/js/ios/index.hbc'), bundleBytes);
  fs.writeFileSync(path.join(distDir, 'assets/logo'), assetBytes);
  fs.writeFileSync(
    path.join(distDir, 'metadata.json'),
    JSON.stringify({
      version: 0,
      bundler: 'metro',
      fileMetadata: {
        ios: {
          bundle: '_expo/static/js/ios/index.hbc',
          assets: [{ path: 'assets/logo', ext: 'png' }],
        },
      },
    }),
  );
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('collectPlatformAssets', () => {
  test('computes sha256 (content address), md5 key, contentType, fileExtension', () => {
    const metadata = readExportMetadata(distDir);
    const bundle = collectPlatformAssets(distDir, metadata, 'ios');

    expect(bundle.launchAsset.sha256).toBe(sha(bundleBytes));
    expect(bundle.launchAsset.key).toBe(md5(bundleBytes));
    expect(bundle.launchAsset.contentType).toBe('application/javascript');
    expect(bundle.launchAsset.fileExtension).toBeUndefined();
    expect(bundle.launchAsset.size).toBe(bundleBytes.length);

    expect(bundle.assets).toHaveLength(1);
    expect(bundle.assets[0].sha256).toBe(sha(assetBytes));
    expect(bundle.assets[0].key).toBe(md5(assetBytes));
    expect(bundle.assets[0].contentType).toBe('image/png');
    expect(bundle.assets[0].fileExtension).toBe('.png');
  });

  test('throws for a platform absent from metadata', () => {
    const metadata = readExportMetadata(distDir);
    expect(() => collectPlatformAssets(distDir, metadata, 'android')).toThrow(/android/);
  });
});

describe('resolveRuntimeVersion', () => {
  test('override wins', () => {
    expect(resolveRuntimeVersion({ version: '1.0.0' }, '2.0.0')).toBe('2.0.0');
  });
  test('string runtimeVersion is used verbatim', () => {
    expect(resolveRuntimeVersion({ runtimeVersion: '7' })).toBe('7');
  });
  test('appVersion policy resolves to version', () => {
    expect(
      resolveRuntimeVersion({ runtimeVersion: { policy: 'appVersion' }, version: '1.2.3' }),
    ).toBe('1.2.3');
  });
  test('absent runtimeVersion falls back to version', () => {
    expect(resolveRuntimeVersion({ version: '3.0.0' })).toBe('3.0.0');
  });
  test('non-appVersion policy requires an explicit override', () => {
    expect(() => resolveRuntimeVersion({ runtimeVersion: { policy: 'fingerprint' } })).toThrow(
      /fingerprint/,
    );
  });
});

describe('normalizeExpoConfig', () => {
  test('unwraps a { expo } envelope', () => {
    expect(normalizeExpoConfig({ expo: { version: '1', slug: 'x' } })).toEqual({
      version: '1',
      slug: 'x',
    });
  });
  test('returns a bare ExpoConfig unchanged', () => {
    expect(normalizeExpoConfig({ version: '1', slug: 'x' })).toEqual({ version: '1', slug: 'x' });
  });
});
