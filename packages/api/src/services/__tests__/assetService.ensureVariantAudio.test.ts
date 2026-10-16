/**
 * AssetService.ensureVariant for audio (ADR 0043 stage 4c): audio renditions
 * are made by the queued upload job only. Public media routes reach
 * ensureVariant, so a missing one is refused — never encoded on the request.
 */

import { AssetService } from '../assetService';
import type { S3Service } from '../s3Service';
import type { FileRecord } from '../../types/file.types';

const mockVariantServiceCalls = jest.fn();

jest.mock('../variantService', () => ({
  VariantService: class {
    ensureImageVariant = (...args: unknown[]) => mockVariantServiceCalls('image', ...args);
    ensureVideoPoster = (...args: unknown[]) => mockVariantServiceCalls('poster', ...args);
    ensureVideoImageVariant = (...args: unknown[]) =>
      mockVariantServiceCalls('videoImage', ...args);
    isVideoMp4Rendition = () => false;
  },
}));

const exists = jest.fn(async (_key: string) => true);

function audioFile(
  variants: Array<{ type: string; key: string; readyAt: Date | null }>,
): FileRecord {
  return {
    id: 'file-audio-1',
    sha256: 'b'.repeat(64),
    size: 1000,
    mime: 'audio/mpeg',
    ext: '.mp3',
    visibility: 'public',
    storageKey: 'public/content/sample.mp3',
    status: 'active',
    ownerUserId: 'user-1',
    links: [],
    variants: variants.map((variant, index) => ({
      id: `v${index}`,
      fileId: 'file-audio-1',
      width: null,
      height: null,
      size: null,
      metadata: null,
      ...variant,
    })),
  } as unknown as FileRecord;
}

const service = () => new AssetService({ fileExists: exists } as unknown as S3Service);

beforeEach(() => jest.clearAllMocks());

describe('AssetService.ensureVariant — audio', () => {
  it('serves a ready audio rendition', async () => {
    const file = audioFile([
      { type: 'hls_master', key: 'public/variants/x/hls_master.m3u8', readyAt: new Date() },
    ]);
    await expect(service().ensureVariant(file.id, 'hls_master', file)).resolves.toMatchObject({
      type: 'hls_master',
    });
  });

  it.each(['hls_master', 'preview', 'waveform', 'thumb', 'w320'])(
    'never generates a missing %s on the request path',
    async (type) => {
      const file = audioFile([
        // Started, never finished: not ready.
        { type: 'preview', key: 'public/variants/x/preview.m4a', readyAt: null },
      ]);
      await expect(service().ensureVariant(file.id, type, file)).rejects.toThrow(
        `Audio rendition ${type} is not available`,
      );
      expect(mockVariantServiceCalls).not.toHaveBeenCalled();
    },
  );
});
