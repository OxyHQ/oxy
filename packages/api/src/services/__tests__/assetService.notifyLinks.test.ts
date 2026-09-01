/**
 * AssetService.notifyLinks — webhook delivery must be SSRF-safe.
 */

import { AssetService } from '../assetService';
import type { FileRecord } from '../../types/file.types';
import type { S3Service } from '../s3Service';

const mockSafeFetch = jest.fn();

jest.mock('@oxyhq/core/server', () => {
  class MockSsrfRejection extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SsrfRejection';
    }
  }
  return {
    safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
    SsrfRejection: MockSsrfRejection,
  };
});

import { SsrfRejection } from '@oxyhq/core/server';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) {}
    generateVariants = jest.fn();
  },
}));

jest.mock('../mediaPrivacyService', () => ({ mediaPrivacyService: {} }));
jest.mock('../../utils/fileCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn(), set: jest.fn(), get: jest.fn() },
}));

function buildFile(webhookUrl: string): FileRecord {
  return {
    id: 'file-1',
    links: [
      {
        app: 'mention',
        entityType: 'post',
        entityId: 'post-1',
        createdBy: 'user-1',
        createdAt: new Date(),
        webhookUrl,
      },
    ],
    visibility: 'private',
    status: 'active',
  } as unknown as IFile;
}

describe('AssetService.notifyLinks webhook SSRF guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delivers webhooks through safeFetch with a JSON POST body', async () => {
    mockSafeFetch.mockResolvedValue({
      status: 204,
      response: { resume: jest.fn() },
      headers: {},
      finalUrl: 'https://hooks.example.com/asset',
    });

    const service = new AssetService({} as S3Service);
    await (service as unknown as {
      notifyLinks: (file: IFile, event: string, details: Record<string, unknown>) => Promise<void>;
    }).notifyLinks(buildFile('https://hooks.example.com/asset'), 'deleted', { force: true });

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://hooks.example.com/asset',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        maxRedirects: 0,
      }),
    );
    expect(mockSafeFetch.mock.calls[0][1].body).toContain('"event":"deleted"');
  });

  it('logs and skips blocked SSRF webhook targets without throwing', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('private address'));

    const service = new AssetService({} as S3Service);
    await expect(
      (service as unknown as {
        notifyLinks: (file: IFile, event: string, details: Record<string, unknown>) => Promise<void>;
      }).notifyLinks(buildFile('http://127.0.0.1/hook'), 'deleted', { force: true }),
    ).resolves.toBeUndefined();

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });
});
