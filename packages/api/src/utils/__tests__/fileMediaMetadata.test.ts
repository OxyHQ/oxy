import type { FileRecord } from '../../types/file.types';
import {
  applyCanonicalMediaMetadata,
  computeAspectRatio,
  computeOrientation,
  resolveFileMediaMetadata,
} from '../fileMediaMetadata';

function makeFile(partial: Partial<FileRecord>): FileRecord {
  return {
    id: 'file1',
    sha256: 'a'.repeat(64),
    size: 1000,
    mime: 'video/mp4',
    ext: 'mp4',
    ownerUserId: 'u1',
    status: 'active',
    visibility: 'public',
    storageKey: 'k',
    purpose: 'user',
    links: [],
    variants: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as FileRecord;
}

describe('fileMediaMetadata', () => {
  it('computeOrientation classifies portrait, landscape, square', () => {
    expect(computeOrientation(1080, 1920)).toBe('portrait');
    expect(computeOrientation(1920, 1080)).toBe('landscape');
    expect(computeOrientation(1000, 1050)).toBe('square');
  });

  it('computeAspectRatio is width/height', () => {
    expect(computeAspectRatio(1920, 1080)).toBeCloseTo(16 / 9);
    expect(computeAspectRatio(1080, 1920)).toBeCloseTo(9 / 16);
  });

  it('resolveFileMediaMetadata reads video subdoc', () => {
    const file = makeFile({
      metadata: {
        video: { width: 1080, height: 1920, duration: 45.5 },
      },
    });
    const meta = resolveFileMediaMetadata(file);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
    expect(meta.durationSec).toBe(45.5);
    expect(meta.orientation).toBe('portrait');
    expect(meta.aspectRatio).toBeCloseTo(1080 / 1920);
  });

  it('resolveFileMediaMetadata falls back to largest variant', () => {
    const file = makeFile({
      metadata: {},
      variants: [
        { type: 'thumb', key: 'k1', width: 256, height: 256 },
        { type: 'w1280', key: 'k2', width: 1280, height: 720 },
      ],
    });
    const meta = resolveFileMediaMetadata(file);
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    expect(meta.orientation).toBe('landscape');
  });

  it('applyCanonicalMediaMetadata writes metadata.media', () => {
    const file = makeFile({ metadata: {} });
    applyCanonicalMediaMetadata(file, { width: 720, height: 1280, durationSec: 30 });
    expect(file.metadata?.media).toMatchObject({
      width: 720,
      height: 1280,
      durationSec: 30,
      orientation: 'portrait',
    });
  });
});
