/**
 * Asset CDN config / key-placement tests.
 *
 * Verifies the single source of truth for the public-vs-private S3 key prefix
 * and the storage-key ↔ CDN-URL mapping (CloudFront `origin_path = /public`).
 * Guards against the regressions that would leak a raw S3 URL or 404 the CDN:
 * double slashes, missing/duplicated `public/` prefix, and private objects
 * sneaking under the CDN prefix.
 */

import {
  DEFAULT_ASSET_CDN_URL,
  PUBLIC_KEY_PREFIX,
  getAssetCdnUrl,
  isPublicKey,
  applyPublicPrefix,
  stripPublicPrefix,
  storageKeyForVisibility,
  buildCdnUrl,
  cdnUrlForStorageKey,
} from '../cdn';

describe('asset CDN config', () => {
  const originalCdnEnv = process.env.ASSET_CDN_URL;

  afterEach(() => {
    if (originalCdnEnv === undefined) {
      delete process.env.ASSET_CDN_URL;
    } else {
      process.env.ASSET_CDN_URL = originalCdnEnv;
    }
  });

  describe('getAssetCdnUrl', () => {
    it('defaults to the documented CDN origin when unset', () => {
      delete process.env.ASSET_CDN_URL;
      expect(getAssetCdnUrl()).toBe(DEFAULT_ASSET_CDN_URL);
    });

    it('honours the env override and strips trailing slashes', () => {
      process.env.ASSET_CDN_URL = 'https://cdn.example.com/';
      expect(getAssetCdnUrl()).toBe('https://cdn.example.com');
    });
  });

  describe('public-prefix helpers', () => {
    it('detects keys under the public prefix', () => {
      expect(isPublicKey(`${PUBLIC_KEY_PREFIX}content/2026/06/ab/abc.jpg`)).toBe(true);
      expect(isPublicKey('content/2026/06/ab/abc.jpg')).toBe(false);
    });

    it('applies the public prefix idempotently', () => {
      const key = 'content/2026/06/ab/abc.jpg';
      const prefixed = applyPublicPrefix(key);
      expect(prefixed).toBe(`${PUBLIC_KEY_PREFIX}${key}`);
      expect(applyPublicPrefix(prefixed)).toBe(prefixed);
    });

    it('strips the public prefix idempotently', () => {
      const key = 'content/2026/06/ab/abc.jpg';
      expect(stripPublicPrefix(`${PUBLIC_KEY_PREFIX}${key}`)).toBe(key);
      expect(stripPublicPrefix(key)).toBe(key);
    });
  });

  describe('storageKeyForVisibility', () => {
    const base = 'content/2026/06/ab/abc.jpg';

    it('places public objects under the CDN prefix', () => {
      expect(storageKeyForVisibility(base, 'public')).toBe(`${PUBLIC_KEY_PREFIX}${base}`);
    });

    it('keeps private and unlisted objects out of the CDN prefix', () => {
      expect(storageKeyForVisibility(base, 'private')).toBe(base);
      expect(storageKeyForVisibility(base, 'unlisted')).toBe(base);
    });
  });

  describe('CDN URL building', () => {
    beforeEach(() => {
      process.env.ASSET_CDN_URL = 'https://cloud.oxy.so';
    });

    it('builds a clean URL from a CDN-relative key (no double slashes)', () => {
      expect(buildCdnUrl('content/2026/06/ab/abc.jpg')).toBe(
        'https://cloud.oxy.so/content/2026/06/ab/abc.jpg',
      );
      expect(buildCdnUrl('/content/2026/06/ab/abc.jpg')).toBe(
        'https://cloud.oxy.so/content/2026/06/ab/abc.jpg',
      );
    });

    it('maps a stored public key to its CDN URL by stripping the prefix', () => {
      // CloudFront origin_path re-adds `/public`, so the URL path omits it.
      expect(cdnUrlForStorageKey(`${PUBLIC_KEY_PREFIX}content/2026/06/ab/abc.jpg`)).toBe(
        'https://cloud.oxy.so/content/2026/06/ab/abc.jpg',
      );
    });

    it('never emits an amazonaws URL', () => {
      const url = cdnUrlForStorageKey(`${PUBLIC_KEY_PREFIX}variants/2026/06/ab/sha/thumb.webp`);
      expect(url.startsWith('https://cloud.oxy.so/')).toBe(true);
      expect(url).not.toContain('amazonaws');
    });
  });
});
