/**
 * Asset-variant queue tests.
 *
 * The properties that matter here are the ones a green build cannot tell you:
 *  - the per-file BullMQ job id is colon-free ("Custom Id cannot contain :") and
 *    STABLE, because that identical id is the whole dedup mechanism;
 *  - two enqueues for one file produce one unit of work;
 *  - the no-Redis fallback is a BOUNDED, sequential drain and not a fallback to
 *    the unbounded in-process generation this module exists to remove;
 *  - the worker is constructed with an explicit, small concurrency.
 */

interface AddCall {
  jobId?: string;
  attempts?: number;
}

// MockQueue records every `add` so the test can assert on the job id that BullMQ
// dedupes by. MockWorker records its construction options.
jest.mock('bullmq', () => {
  class MockWorker {
    static lastOptions: { concurrency?: number } | undefined;
    constructor(_name: unknown, _processor: unknown, options: { concurrency?: number }) {
      MockWorker.lastOptions = options;
    }
    on(): this {
      return this;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  class MockQueue {
    static addCalls: AddCall[] = [];
    on(): this {
      return this;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
    add(_name: unknown, _data: unknown, options: AddCall): Promise<void> {
      MockQueue.addCalls.push(options);
      return Promise.resolve();
    }
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

const mockIsQueueEnabled = jest.fn(() => false);
const mockGenerateVariants = jest.fn(() => Promise.resolve());

jest.mock('../connection', () => ({ getQueueConnectionOptions: () => ({}) }));
jest.mock('../queueManager', () => ({ isQueueEnabled: () => mockIsQueueEnabled() }));
jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: {} }));
jest.mock('../../services/variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) {
      /* no-op */
    }
    generateVariants = (...args: unknown[]) => mockGenerateVariants(...args);
  },
}));

import { Queue, Worker } from 'bullmq';
import {
  ASSET_VARIANT_WORKER_CONCURRENCY,
  assetVariantsJobId,
  enqueueAssetVariantGeneration,
  startAssetVariantJobs,
  stopAssetVariantJobs,
} from '../assetVariants.queue';

const MockQueue = Queue as unknown as { addCalls: AddCall[] };
const MockWorker = Worker as unknown as { lastOptions: { concurrency?: number } | undefined };

/** Let the fallback's `setImmediate` drain kick and settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  MockQueue.addCalls = [];
  MockWorker.lastOptions = undefined;
  mockGenerateVariants.mockClear();
  mockGenerateVariants.mockImplementation(() => Promise.resolve());
});

afterEach(async () => {
  await stopAssetVariantJobs();
  mockIsQueueEnabled.mockReturnValue(false);
});

describe('assetVariantsJobId', () => {
  it('never contains a colon (BullMQ custom-id rule) and is stable per file', () => {
    const id = assetVariantsJobId('0f8b2c1e-4d5a-4a8f-9c3b-1e2d3f4a5b6c');
    expect(id).not.toContain(':');
    expect(id.startsWith('av-')).toBe(true);
    expect(assetVariantsJobId('0f8b2c1e-4d5a-4a8f-9c3b-1e2d3f4a5b6c')).toBe(id); // deterministic
    expect(assetVariantsJobId('another-file-id')).not.toBe(id);
  });

  it('stays colon-free even if a file id ever carries one', () => {
    expect(assetVariantsJobId('urn:oxy:file:123')).not.toContain(':');
  });
});

describe('dedup', () => {
  it('enqueues both requests for one file under the SAME job id (BullMQ then keeps one)', async () => {
    mockIsQueueEnabled.mockReturnValue(true);
    await startAssetVariantJobs();

    enqueueAssetVariantGeneration('file-abc');
    enqueueAssetVariantGeneration('file-abc');
    await settle();

    // The dedup lives in BullMQ: an `add` for a jobId already queued/active is
    // ignored. What this code must guarantee is that both adds present the
    // identical id — assert that, rather than re-implementing Redis.
    expect(MockQueue.addCalls).toHaveLength(2);
    expect(MockQueue.addCalls[0].jobId).toBe(assetVariantsJobId('file-abc'));
    expect(MockQueue.addCalls[1].jobId).toBe(MockQueue.addCalls[0].jobId);

    // A different file must NOT collide onto that id.
    enqueueAssetVariantGeneration('file-xyz');
    await settle();
    expect(MockQueue.addCalls[2].jobId).not.toBe(MockQueue.addCalls[0].jobId);
  });

  it('runs generation ONCE for two fallback enqueues of the same file', async () => {
    await startAssetVariantJobs(); // queues disabled -> in-process fallback

    enqueueAssetVariantGeneration('file-abc');
    enqueueAssetVariantGeneration('file-abc');
    await settle();
    await settle();

    expect(mockGenerateVariants).toHaveBeenCalledTimes(1);
    expect(mockGenerateVariants).toHaveBeenCalledWith('file-abc');
  });

  it('carries retry attempts so a failed generation is retried, not lost', async () => {
    mockIsQueueEnabled.mockReturnValue(true);
    await startAssetVariantJobs();

    enqueueAssetVariantGeneration('file-abc');
    await settle();

    expect(MockQueue.addCalls[0].attempts).toBeGreaterThan(1);
  });
});

describe('worker', () => {
  it('is created with an explicit, small concurrency', async () => {
    mockIsQueueEnabled.mockReturnValue(true);
    await startAssetVariantJobs();

    expect(MockWorker.lastOptions?.concurrency).toBe(ASSET_VARIANT_WORKER_CONCURRENCY);
    // The whole point of the queue is that this stays bounded and low. A large
    // value here re-creates the CPU contention on a fractional-vCPU task.
    expect(ASSET_VARIANT_WORKER_CONCURRENCY).toBeLessThanOrEqual(2);
  });
});

describe('no-Redis fallback', () => {
  it('is SEQUENTIAL — never runs two generations at once', async () => {
    await startAssetVariantJobs();

    let concurrent = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    mockGenerateVariants.mockImplementation(() => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      return new Promise<void>((resolve) => {
        release.push(() => {
          concurrent -= 1;
          resolve();
        });
      });
    });

    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      enqueueAssetVariantGeneration(id);
    }
    await settle();

    // Drain them one at a time; each release lets exactly one more start.
    for (let i = 0; i < 5; i += 1) {
      expect(concurrent).toBeLessThanOrEqual(1);
      release[i]?.();
      await settle();
    }

    expect(peak).toBe(1);
    expect(mockGenerateVariants).toHaveBeenCalledTimes(5);
  });

  it('does not enqueue into a dead subsystem after stop', async () => {
    await startAssetVariantJobs();
    await stopAssetVariantJobs();

    enqueueAssetVariantGeneration('file-after-stop');
    await settle();

    expect(mockGenerateVariants).not.toHaveBeenCalled();
  });

  it('keeps draining after one file fails', async () => {
    await startAssetVariantJobs();

    mockGenerateVariants
      .mockImplementationOnce(() => Promise.reject(new Error('ffmpeg exploded')))
      .mockImplementation(() => Promise.resolve());

    enqueueAssetVariantGeneration('bad');
    enqueueAssetVariantGeneration('good');
    await settle();
    await settle();
    await settle();

    expect(mockGenerateVariants).toHaveBeenCalledTimes(2);
  });
});
