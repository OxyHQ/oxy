/**
 * AssetService.ensureVariant — safe video mp4 rendition routing.
 *
 * Public media routes reach ensureVariant, so missing MP4 renditions must not
 * start expensive FFmpeg work on the request path.
 */

import { AssetService } from '../assetService';
import type { S3Service } from '../s3Service';
import type { FileRecord, FileVariantRecord } from '../../types/file.types';

const mockEnsureVideoPoster = jest.fn<Promise<FileVariantRecord>, [FileRecord]>();
const mockEnsureVideoMp4Rendition = jest.fn<Promise<FileVariantRecord>, [FileRecord, string]>();
const mockEnsureVideoImageVariant = jest.fn<Promise<FileVariantRecord>, [FileRecord, string]>();
const mockIsVideoMp4Rendition = jest.fn<boolean, [string]>();

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) {
      /* routing-only test */
    }
    ensureVideoPoster = mockEnsureVideoPoster;
    ensureVideoMp4Rendition = mockEnsureVideoMp4Rendition;
    ensureVideoImageVariant = mockEnsureVideoImageVariant;
    isVideoMp4Rendition = mockIsVideoMp4Rendition;
  },
}));

const VIDEO_FILE: FileRecord = {
  id: 'file-video-1',
  sha256: 'a'.repeat(64),
  size: 1_000_000,
  mime: 'video/mp4',
  ext: 'mp4',
  visibility: 'public',
  storageKey: 'public/content/sample.mp4',
  status: 'active',
  ownerUserId: 'user-1',
  variants: [],
};

const RENDITION_ROW: FileVariantRecord = {
  id: 'variant-720p',
  fileId: VIDEO_FILE.id,
  type: '720p',
  key: 'public/variants/sample-720p.mp4',
  width: 1280,
  height: 720,
  readyAt: new Date(),
  size: 500_000,
  metadata: { format: 'mp4' },
};

function buildService(): AssetService {
  return new AssetService({} as S3Service);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsVideoMp4Rendition.mockImplementation((type) => ['360p', '720p', '1080p'].includes(type));
});

describe('AssetService.ensureVariant — video mp4 renditions', () => {
  it('does not lazily generate a missing mp4 rendition', async () => {
    const service = buildService();

    await expect(service.ensureVariant('file-video-1', '720p', VIDEO_FILE))
      .rejects.toThrow('Video rendition 720p is not available');

    expect(mockIsVideoMp4Rendition).toHaveBeenCalledWith('720p');
    expect(mockEnsureVideoMp4Rendition).not.toHaveBeenCalled();
    expect(mockEnsureVideoImageVariant).not.toHaveBeenCalled();
  });

  it('still routes poster to ensureVideoPoster', async () => {
    const posterRow = { ...RENDITION_ROW, type: 'poster' };
    mockEnsureVideoPoster.mockResolvedValue(posterRow);
    const service = buildService();

    await service.ensureVariant('file-video-1', 'poster', VIDEO_FILE);

    expect(mockEnsureVideoPoster).toHaveBeenCalledWith(VIDEO_FILE);
    expect(mockEnsureVideoMp4Rendition).not.toHaveBeenCalled();
  });

  it('routes thumb to ensureVideoImageVariant, not mp4 rendition', async () => {
    const thumbRow = { ...RENDITION_ROW, type: 'thumb' };
    mockEnsureVideoImageVariant.mockResolvedValue(thumbRow);
    const service = buildService();

    await service.ensureVariant('file-video-1', 'thumb', VIDEO_FILE);

    expect(mockIsVideoMp4Rendition).toHaveBeenCalledWith('thumb');
    expect(mockEnsureVideoMp4Rendition).not.toHaveBeenCalled();
    expect(mockEnsureVideoImageVariant).toHaveBeenCalledWith(VIDEO_FILE, 'thumb');
  });
});
