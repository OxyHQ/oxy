/**
 * Cloudflare purge of cloud.oxy.so (ADR 0047): a deleted public object's URL,
 * and a file id's resolver answers by the tag the Worker gives them.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  CloudflarePurgeQueue,
  MAX_PURGE_ATTEMPTS,
  MAX_URLS_PER_REQUEST,
  PurgeError,
  resolverCacheTag,
  type PurgeKind,
  type PurgeSender,
} from '../cdnPurge';
import { getCdnInvalidationQueue } from '../cdnInvalidation';
import { logger } from '../../utils/logger';

const SHA = 'cd'.repeat(32);

function recordingSender(impl?: (kind: PurgeKind, items: string[]) => Promise<void>) {
  const calls: Array<{ kind: PurgeKind; items: string[] }> = [];
  const sender: PurgeSender = {
    purge: jest.fn(async (kind: PurgeKind, items: string[]) => {
      calls.push({ kind, items: [...items] });
      if (impl) await impl(kind, items);
    }),
  };
  return { sender, calls };
}

function queueWith(sender: PurgeSender) {
  return new CloudflarePurgeQueue({ zoneId: 'z', token: 't', sender, flushDelayMs: 60_000 });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ASSET_CDN_URL;
});

describe('what is purged', () => {
  it('a deleted public object is purged by its cloud.oxy.so URL', async () => {
    const { sender, calls } = recordingSender();
    const queue = queueWith(sender);
    queue.enqueueDeletedKey(`public/variants/2026/10/cd/${SHA}/thumb.webp`);
    queue.enqueueDeletedKey(`public/content/2026/10/cd/${SHA}.png`);
    await queue.flush();
    expect(calls).toEqual([
      {
        kind: 'files',
        items: [
          `https://cloud.oxy.so/variants/2026/10/cd/${SHA}/thumb.webp`,
          `https://cloud.oxy.so/content/2026/10/cd/${SHA}.png`,
        ],
      },
    ]);
  });

  it('a private key was never at the edge and is not purged', async () => {
    const { sender, calls } = recordingSender();
    const queue = queueWith(sender);
    queue.enqueueDeletedKey(`content/2026/10/cd/${SHA}.png`);
    queue.enqueueDeletedKey('public/');
    await queue.flush();
    expect(calls).toEqual([]);
  });

  it("a file id's resolver answers are purged by the Worker's tag, every variant at once", async () => {
    const { sender, calls } = recordingSender();
    const queue = queueWith(sender);
    queue.enqueuePath('/01a15c7d-5a0a-719f-a2bd-2655fc7b1962');
    await queue.flush();
    expect(calls).toEqual([{ kind: 'tags', items: ['file:01a15c7d-5a0a-719f-a2bd-2655fc7b1962'] }]);
  });

  it('agrees with the Worker on the tag', async () => {
    const worker = await import('../../../../../workers/cloud/src/index');
    expect(resolverCacheTag('/abc')).toBe(worker.resolverCacheTag('/abc'));
  });
});

describe('batching and failure', () => {
  it(`sends at most ${MAX_URLS_PER_REQUEST} URLs per request`, async () => {
    const { sender, calls } = recordingSender();
    const queue = queueWith(sender);
    for (let i = 0; i < MAX_URLS_PER_REQUEST + 5; i += 1) {
      queue.enqueueDeletedKey(`public/variants/x/${SHA}/hls/seg${i}.ts`);
    }
    await queue.flush();
    expect(calls.map((call) => call.items.length)).toEqual([MAX_URLS_PER_REQUEST, 5]);
  });

  it('a throttle is retried without costing an attempt', async () => {
    let throttles = MAX_PURGE_ATTEMPTS + 2;
    const { sender } = recordingSender(async () => {
      if (throttles-- > 0) throw new PurgeError('rate limited', 429);
    });
    const queue = queueWith(sender);
    queue.enqueuePath('/id-1');
    for (let i = 0; i < MAX_PURGE_ATTEMPTS + 2; i += 1) await queue.flush();
    expect(queue.pendingPaths()).toEqual(['file:id-1']);
    await queue.flush();
    expect(queue.pendingPaths()).toEqual([]);
  });

  it(`drops an entry loudly after ${MAX_PURGE_ATTEMPTS} real failures`, async () => {
    const { sender } = recordingSender(async () => {
      throw new PurgeError('forbidden', 403);
    });
    const queue = queueWith(sender);
    queue.enqueueDeletedKey('public/content/a.png');
    for (let i = 0; i < MAX_PURGE_ATTEMPTS; i += 1) await queue.flush();
    expect(queue.pendingPaths()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('DROPPED after repeated failures'),
      expect.objectContaining({ dropped: ['https://cloud.oxy.so/content/a.png'] }),
    );
  });

  it('is a no-op with one warning while unconfigured', async () => {
    const queue = new CloudflarePurgeQueue({ zoneId: undefined, token: undefined });
    expect(queue.enabled).toBe(false);
    queue.enqueueDeletedKey('public/content/a.png');
    queue.enqueuePath('/id');
    expect(queue.pendingPaths()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('the process-wide CDN queue', () => {
  it('is one object, so the S3 singleton and the delete paths share it', () => {
    expect(getCdnInvalidationQueue()).toBe(getCdnInvalidationQueue());
  });
});
