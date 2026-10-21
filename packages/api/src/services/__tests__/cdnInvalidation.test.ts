/**
 * Every delete of a public object reaches cloud.oxy.so's purge (ADR 0047):
 * `S3Service.deleteFile` reports successful deletes (and only those) to the
 * process-wide queue, and shutdown flushes it within its bound.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { S3Service } from '../s3Service';
import { flushCdnInvalidations } from '../cdnInvalidation';
import { logger } from '../../utils/logger';

const SHA = 'ab'.repeat(32);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('S3Service.deleteFile reports successful deletes to the CDN listener', () => {
  function serviceWith(send: jest.Mock, listener: { enqueueDeletedKey: jest.Mock }) {
    const service = new S3Service(
      { region: 'auto', accessKeyId: 'x', secretAccessKey: 'y', bucketName: 'b' },
      listener,
    );
    (service as unknown as { s3Client: { send: jest.Mock } }).s3Client = { send };
    return service;
  }

  it('enqueues the key after the delete succeeds', async () => {
    const listener = { enqueueDeletedKey: jest.fn() };
    const send = jest.fn().mockResolvedValue({});
    await serviceWith(send, listener).deleteFile(`public/content/${SHA}.png`);
    expect(send).toHaveBeenCalledTimes(1);
    expect(listener.enqueueDeletedKey).toHaveBeenCalledWith(`public/content/${SHA}.png`);
  });

  it('does NOT enqueue when the delete failed — the object is still there', async () => {
    const listener = { enqueueDeletedKey: jest.fn() };
    const send = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    await expect(serviceWith(send, listener).deleteFile('public/content/x.png')).rejects.toThrow();
    expect(listener.enqueueDeletedKey).not.toHaveBeenCalled();
  });
});

describe('the S3 singleton is wired to the process-wide purge queue', () => {
  it('passes getCdnInvalidationQueue() as the delete listener', () => {
    jest.isolateModules(() => {
      const { s3Service } =
        // biome-ignore lint/style/noCommonJs: required inside jest.isolateModules to get a fresh module registry
        require('../s3ServiceSingleton') as typeof import('../s3ServiceSingleton');
      const { getCdnInvalidationQueue } =
        // biome-ignore lint/style/noCommonJs: required inside jest.isolateModules to get a fresh module registry
        require('../cdnInvalidation') as typeof import('../cdnInvalidation');
      const listener = (s3Service as unknown as { deletedObjectListener?: unknown })
        .deletedObjectListener;
      expect(listener).toBeDefined();
      expect(listener).toBe(getCdnInvalidationQueue());
    });
  });
});

describe('flushCdnInvalidations', () => {
  it('names what is left when the flush outlives its bound, and never throws', async () => {
    const queue = {
      enqueueDeletedKey: jest.fn(),
      enqueuePath: jest.fn(),
      flush: () => new Promise<void>(() => undefined),
      pendingPaths: () => ['https://cloud.oxy.so/content/a.png'],
    };
    await flushCdnInvalidations(queue, 10);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      expect.objectContaining({ paths: ['https://cloud.oxy.so/content/a.png'] }),
    );
  });

  it('does nothing without a queue', async () => {
    await expect(flushCdnInvalidations(null)).resolves.toBeUndefined();
  });
});
