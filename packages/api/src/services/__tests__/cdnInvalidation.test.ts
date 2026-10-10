/**
 * CloudFront invalidation of deleted public objects.
 *
 * Public media is cached at the edge for a year (`max-age=31536000, immutable`),
 * so a delete that does not invalidate leaves the object served from
 * `cloud.oxy.so`. These tests pin the three halves of the fix:
 *
 *  1. `S3Service.deleteFile` reports every SUCCESSFUL delete (and only those) —
 *     the one call every delete path in the API ends in;
 *  2. the singleton is wired to the process-wide queue;
 *  3. the queue batches, collapses a variant directory to one wildcard, caps
 *     wildcards per request, retries throttles, drops loudly, and is a no-op
 *     with one warning when `CDN_CLOUDFRONT_DISTRIBUTION_ID` is unset.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockCloudFrontConfigs: unknown[] = [];
const mockCloudFrontSend = jest.fn();
jest.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    constructor(config: unknown) {
      mockCloudFrontConfigs.push(config);
    }
    send = (...args: unknown[]) => mockCloudFrontSend(...args);
  },
  CreateInvalidationCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import { S3Service } from '../s3Service';
import {
  CdnInvalidationQueue,
  MAX_ATTEMPTS,
  MAX_PENDING_PATHS,
  MAX_WILDCARDS_PER_REQUEST,
  WILDCARD_COOLDOWN_MS,
  cdnPathForKey,
  flushCdnInvalidations,
  planInvalidationPaths,
  type InvalidationSender,
} from '../cdnInvalidation';
import { logger } from '../../utils/logger';

const SHA = 'ab'.repeat(32);
const VARIANT_DIR = `variants/2026/09/ab/${SHA}`;

function recordingSender(impl?: (paths: string[]) => Promise<void>) {
  const calls: Array<{ distributionId: string; paths: string[]; callerReference: string }> = [];
  const sender: InvalidationSender = {
    send: jest.fn(async (distributionId: string, paths: string[], callerReference: string) => {
      calls.push({ distributionId, paths: [...paths], callerReference });
      if (impl) await impl(paths);
    }),
  };
  return { sender, calls };
}

function namedError(name: string): Error {
  const error = new Error(`${name} happened`);
  error.name = name;
  return error;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('S3Service.deleteFile reports successful deletes to the CDN listener', () => {
  function serviceWith(send: jest.Mock, listener: { enqueueDeletedKey: jest.Mock }) {
    const service = new S3Service(
      { region: 'us-west-2', accessKeyId: 'x', secretAccessKey: 'y', bucketName: 'b' },
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

describe('the S3 singleton is wired to the process-wide invalidation queue', () => {
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

describe('path planning', () => {
  it('maps a public key to its CDN path and ignores non-public keys', () => {
    expect(cdnPathForKey(`public/content/2026/09/${SHA}.png`)).toBe(`/content/2026/09/${SHA}.png`);
    expect(cdnPathForKey(`content/2026/09/${SHA}.png`)).toBeNull();
    expect(cdnPathForKey('federation/incoming/tmp')).toBeNull();
    expect(cdnPathForKey('public/')).toBeNull();
  });

  it('collapses two or more keys of one variant directory into ONE wildcard and keeps singletons exact', () => {
    const plan = planInvalidationPaths([
      `/content/2026/09/${SHA}.mp4`,
      `/${VARIANT_DIR}/poster.jpg`,
      `/${VARIANT_DIR}/hls_720p.m3u8`,
      ...Array.from({ length: 300 }, (_, i) => `/${VARIANT_DIR}/hls_720p_segment_720p_${i}.ts.ts`),
      '/variants/2026/09/cd/other/thumb.webp',
    ]);

    expect(plan.wildcards).toEqual([`/${VARIANT_DIR}/*`]);
    expect(plan.exact).toEqual([
      `/content/2026/09/${SHA}.mp4`,
      '/variants/2026/09/cd/other/thumb.webp',
    ]);
  });
});

describe('CdnInvalidationQueue', () => {
  it('is a no-op with ONE warning when no distribution id is configured', async () => {
    const { sender } = recordingSender();
    const queue = new CdnInvalidationQueue({ distributionId: undefined, sender });

    queue.enqueueDeletedKey('public/content/a.png');
    queue.enqueueDeletedKey('public/content/b.png');
    await queue.flush();

    expect(queue.enabled).toBe(false);
    expect(sender.send).not.toHaveBeenCalled();
    expect(queue.pendingPaths()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toContain('CDN_CLOUDFRONT_DISTRIBUTION_ID');
  });

  it('treats a blank id as unset', () => {
    expect(
      new CdnInvalidationQueue({ distributionId: '  ', sender: recordingSender().sender }).enabled,
    ).toBe(false);
  });

  it('turns a whole video delete — original, variants, playlists, segments — into ONE request', async () => {
    const { sender, calls } = recordingSender();
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST', sender });

    queue.enqueueDeletedKey(`public/content/2026/09/${SHA}.mp4`);
    queue.enqueueDeletedKey(`public/${VARIANT_DIR}/poster.jpg`);
    queue.enqueueDeletedKey(`public/${VARIANT_DIR}/hls_720p.m3u8`);
    for (let i = 0; i < 250; i++) {
      queue.enqueueDeletedKey(`public/${VARIANT_DIR}/hls_720p_segment_720p_${i}.ts.ts`);
    }
    queue.enqueueDeletedKey('cache/incoming/temp-object'); // not CDN-served
    await queue.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].distributionId).toBe('EDIST');
    expect(calls[0].paths.sort()).toEqual(
      [`/${VARIANT_DIR}/*`, `/content/2026/09/${SHA}.mp4`].sort(),
    );
    expect(calls[0].callerReference).toMatch(/^oxy-api-/);
    expect(queue.pendingPaths()).toEqual([]);
  });

  it(`sends at most ${MAX_WILDCARDS_PER_REQUEST} wildcards per request, and the overflow as EXACT paths in the same request`, async () => {
    const { sender, calls } = recordingSender();
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST', sender });
    const dirs = MAX_WILDCARDS_PER_REQUEST + 2;
    for (let d = 0; d < dirs; d++) {
      queue.enqueueDeletedKey(`public/variants/2026/09/aa/sha${d}/a.webp`);
      queue.enqueueDeletedKey(`public/variants/2026/09/aa/sha${d}/b.webp`);
    }
    await queue.flush();

    // One request: nothing waits for the wildcard ceiling.
    expect(calls).toHaveLength(1);
    const wildcards = calls[0].paths.filter((p) => p.endsWith('/*'));
    const exact = calls[0].paths.filter((p) => !p.endsWith('/*'));
    expect(wildcards).toHaveLength(MAX_WILDCARDS_PER_REQUEST);
    expect(exact).toHaveLength(2 * 2);
    expect(queue.pendingPaths()).toEqual([]);
  });

  it('after TooManyInvalidationsInProgress, sends exact paths only for the cooldown', async () => {
    let clock = 1_000_000;
    let first = true;
    const { sender, calls } = recordingSender(async () => {
      if (first) {
        first = false;
        throw namedError('TooManyInvalidationsInProgress');
      }
    });
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST', sender, now: () => clock });
    queue.enqueueDeletedKey(`public/${VARIANT_DIR}/a.webp`);
    queue.enqueueDeletedKey(`public/${VARIANT_DIR}/b.webp`);

    await queue.flush();
    expect(calls[0].paths).toEqual([`/${VARIANT_DIR}/*`]);

    await queue.flush();
    expect(calls[1].paths).toEqual([`/${VARIANT_DIR}/a.webp`, `/${VARIANT_DIR}/b.webp`]);

    clock += WILDCARD_COOLDOWN_MS + 1;
    queue.enqueueDeletedKey(`public/${VARIANT_DIR}/c.webp`);
    queue.enqueueDeletedKey(`public/${VARIANT_DIR}/d.webp`);
    await queue.flush();
    expect(calls[2].paths).toEqual([`/${VARIANT_DIR}/*`]);
  });

  it('a throttle never counts toward dropping a path', async () => {
    const { sender } = recordingSender(async () => {
      throw namedError('Throttling');
    });
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST', sender });
    queue.enqueueDeletedKey('public/content/a.png');

    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      await queue.flush();
    }

    expect(queue.pendingPaths()).toEqual(['/content/a.png']);
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('DROPPED'),
      expect.anything(),
    );
  });

  it(`caps the queue at ${MAX_PENDING_PATHS} paths, dropping — and naming — the OLDEST`, () => {
    const queue = new CdnInvalidationQueue({
      distributionId: 'EDIST',
      sender: recordingSender().sender,
    });
    for (let i = 0; i < MAX_PENDING_PATHS + 3; i++) {
      queue.enqueueDeletedKey(`public/content/${String(i).padStart(6, '0')}.png`);
    }

    const pending = queue.pendingPaths();
    expect(pending).toHaveLength(MAX_PENDING_PATHS);
    expect(pending).not.toContain('/content/000000.png');
    expect(pending).toContain(`/content/${String(MAX_PENDING_PATHS + 2).padStart(6, '0')}.png`);
    const dropped = (logger.error as jest.Mock).mock.calls
      .filter(([message]) => String(message).includes('queue full'))
      .flatMap(([, meta]) => (meta as { paths: string[] }).paths);
    expect(dropped).toEqual(['/content/000000.png', '/content/000001.png', '/content/000002.png']);
  });

  it('the shutdown flush gives up after its timeout, naming what is left', async () => {
    const { sender } = recordingSender(
      () =>
        new Promise<void>(() => {
          /* never settles */
        }),
    );
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST', sender });
    queue.enqueueDeletedKey('public/content/a.png');

    const started = Date.now();
    await flushCdnInvalidations(queue, 50);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      expect.objectContaining({ timeoutMs: 50 }),
    );
  });

  it('the real CloudFront client is built with connection and request timeouts', async () => {
    mockCloudFrontSend.mockResolvedValue({});
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST' });
    queue.enqueueDeletedKey('public/content/a.png');
    await queue.flush();

    expect(mockCloudFrontConfigs).toHaveLength(1);
    expect(mockCloudFrontConfigs[0]).toMatchObject({
      requestHandler: { connectionTimeout: expect.any(Number), requestTimeout: expect.any(Number) },
    });
    const [command] = mockCloudFrontSend.mock.calls[0] as [
      { input: { DistributionId: string; InvalidationBatch: { Paths: { Items: string[] } } } },
    ];
    expect(command.input.DistributionId).toBe('EDIST');
    expect(command.input.InvalidationBatch.Paths.Items).toEqual(['/content/a.png']);
  });

  it('debounces: a scheduled flush fires once after the window', async () => {
    jest.useFakeTimers();
    try {
      const { sender, calls } = recordingSender();
      const queue = new CdnInvalidationQueue({
        distributionId: 'EDIST',
        sender,
        flushDelayMs: 1000,
      });
      queue.enqueueDeletedKey('public/content/a.png');
      queue.enqueueDeletedKey('public/content/b.png');
      expect(sender.send).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);

      expect(calls).toHaveLength(1);
      expect(calls[0].paths).toEqual(['/content/a.png', '/content/b.png']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps throttled paths and retries them, logging each failure at error', async () => {
    let first = true;
    const { sender, calls } = recordingSender(async () => {
      if (first) {
        first = false;
        throw namedError('TooManyInvalidationsInProgress');
      }
    });
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST', sender });
    queue.enqueueDeletedKey('public/content/a.png');

    await queue.flush();
    expect(queue.pendingPaths()).toEqual(['/content/a.png']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('CDN invalidation FAILED'),
      expect.objectContaining({ errorName: 'TooManyInvalidationsInProgress' }),
    );

    await queue.flush();
    expect(calls).toHaveLength(2);
    expect(queue.pendingPaths()).toEqual([]);
  });

  it(`drops a batch — naming every path — after ${MAX_ATTEMPTS} non-throttling failures`, async () => {
    const { sender } = recordingSender(async () => {
      throw namedError('AccessDenied');
    });
    const queue = new CdnInvalidationQueue({ distributionId: 'EDIST', sender });
    queue.enqueueDeletedKey('public/content/a.png');

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await queue.flush();
    }

    expect(sender.send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(queue.pendingPaths()).toEqual([]);
    expect(logger.error).toHaveBeenLastCalledWith(
      expect.stringContaining('DROPPED'),
      expect.objectContaining({ paths: ['/content/a.png'], errorName: 'AccessDenied' }),
    );
  });

  it('never throws from enqueue, even for odd input', () => {
    const queue = new CdnInvalidationQueue({
      distributionId: 'EDIST',
      sender: recordingSender().sender,
    });
    expect(() => queue.enqueueDeletedKey(undefined as unknown as string)).not.toThrow();
  });
});
