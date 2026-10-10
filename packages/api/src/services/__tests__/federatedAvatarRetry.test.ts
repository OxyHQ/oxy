/**
 * A failed federated avatar mirror is a DEFERRED success, never a lost avatar —
 * real Postgres, every outbound fetch mocked.
 *
 * The production case: the #1449 repair cleared 880 avatars, 842 of them for
 * TRANSIENT reasons — mostly the 15 s per-origin gap refusing consecutive
 * fetches from one CDN — and nothing re-queued them. Also pinned here: the
 * downloader decides by magic bytes, not Content-Type, and re-encodes an
 * oversized picture instead of dropping it.
 */

const mockCacheInvalidate = jest.fn();
const mockAssetUploadFileDirect = jest.fn();
const mockSafeFetch = jest.fn();
const mockAcquire = jest.fn(() => Promise.resolve(0));

process.env.AWS_ACCESS_KEY_ID ||= 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test-secret-key';
process.env.AWS_S3_BUCKET ||= 'test-bucket';

jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: mockCacheInvalidate },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../assetService', () => ({
  __esModule: true,
  AssetService: class {
    fileContentExists() {
      return Promise.resolve(true);
    }
    uploadFileDirect(...args: unknown[]) {
      return mockAssetUploadFileDirect(...args);
    }
    deleteFile() {
      return Promise.resolve();
    }
  },
}));
jest.mock('../s3Service', () => ({ __esModule: true, createS3Service: jest.fn(() => ({})) }));
jest.mock('@oxy.so/core/server', () => ({
  __esModule: true,
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: class extends Error {},
}));
jest.mock('../federation/avatarFetchBackpressure', () => ({
  acquireAvatarOriginLease: (...args: unknown[]) => mockAcquire(...(args as [])),
  clearAvatarOriginFailures: () => Promise.resolve(),
  recordAvatarOriginRateLimit: () => Promise.resolve(30_000),
}));

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { federationService } from '../federation.service';
import { normalizeAvatarImage, sniffImageMime } from '../federation/avatarImage';
import {
  claimDueAvatarRetries,
  queueRecoveryForAvatarlessFederatedUsers,
  retryFederatedAvatar,
  runFederatedAvatarRetrySweep,
} from '../federation/avatarRetry';
import { persistFederatedAvatar } from '../../utils/federatedAvatar';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const HTML = Buffer.from('<!doctype html><html><body>Not Found</body></html>');

type Fetched = {
  status: number;
  headers: Record<string, string>;
  finalUrl: string;
  response: Readable;
};
function reply(
  status: number,
  headers: Record<string, string> = {},
  body: Buffer | string = '',
): Fetched {
  return {
    status,
    headers,
    finalUrl: 'https://final.example/',
    response: Readable.from([typeof body === 'string' ? Buffer.from(body) : body]),
  };
}
function route(routes: Record<string, () => Fetched>) {
  mockSafeFetch.mockReset().mockImplementation(async (url: string) => {
    const handler = routes[url];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return handler();
  });
}

async function seed(avatar: string | null, over: Partial<typeof users.$inferInsert> = {}) {
  const local = `r${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const actorUri = `https://retry.example/users/${local}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      type: 'federated',
      username: `${local}@retry.example`,
      federationActorUri: actorUri,
      federationDomain: 'retry.example',
      avatar,
      ...over,
    })
    .returning({ id: users.id });
  return { id: row.id, actorUri, local };
}
async function stateOf(id: string) {
  const [row] = await getDb()
    .select({
      avatar: users.avatar,
      retryAt: users.federationAvatarRetryAt,
      attempts: users.federationAvatarAttempts,
      failure: users.federationAvatarFailure,
    })
    .from(users)
    .where(eq(users.id, id));
  return row;
}
function sourceProfile(actorUri: string, avatarUrl?: string) {
  return {
    actorUri,
    transportAcct: 'x@retry.example',
    protocol: 'activitypub',
    evidenceLinks: [],
    domain: 'retry.example',
    username: 'x@retry.example',
    displayName: 'X',
    avatarUrl,
    bio: '',
  };
}

beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(() => {
  jest.clearAllMocks();
  mockAcquire.mockImplementation(() => Promise.resolve(0));
  mockAssetUploadFileDirect.mockImplementation(async () => ({ id: `mirror-${randomUUID()}` }));
});
afterEach(() => jest.restoreAllMocks());

describe('the downloader decides by bytes, not by Content-Type', () => {
  it('sniffs the raster formats and refuses documents', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(
      sniffImageMime(
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
      ),
    ).toBe('image/webp');
    expect(sniffImageMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')]))).toBe(
      'image/avif',
    );
    expect(sniffImageMime(HTML)).toBeNull();
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it.each([['text/plain'], ['binary/octet-stream'], ['text/html'], ['']])(
    'stores a real JPEG served as %p',
    async (contentType) => {
      const url = `https://cdn.retry.example/${randomUUID()}.jpg`;
      route({ [url]: () => reply(200, contentType ? { 'content-type': contentType } : {}, JPEG) });
      const result = await federationService.downloadAndStoreAvatar(
        url,
        undefined,
        undefined,
        'owner',
      );
      expect(result.fileId).toMatch(/^mirror-/);
      expect(mockAssetUploadFileDirect).toHaveBeenCalledWith(
        'owner',
        JPEG,
        'image/jpeg',
        expect.stringMatching(/\.jpg$/),
        'public',
        expect.any(Object),
      );
    },
  );

  it('refuses an HTML page served as image/jpeg, permanently', async () => {
    const url = `https://cdn.retry.example/${randomUUID()}.jpg`;
    route({ [url]: () => reply(200, { 'content-type': 'image/jpeg' }, HTML) });
    const result = await federationService.downloadAndStoreAvatar(url);
    expect(result).toMatchObject({ fileId: null, failure: 'permanent', reason: 'not_an_image' });
    expect(mockAssetUploadFileDirect).not.toHaveBeenCalled();
  });

  it('re-encodes an oversized picture instead of dropping it', async () => {
    const width = 1800;
    const noise = Buffer.alloc(width * width * 3);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
    const big = await sharp(noise, { raw: { width, height: width, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);

    const normalized = await normalizeAvatarImage(big, 5 * 1024 * 1024);
    expect(normalized).toMatchObject({ ok: true, mime: 'image/webp', reencoded: true });

    const url = `https://cdn.retry.example/${randomUUID()}.png`;
    route({ [url]: () => reply(200, { 'content-type': 'image/png' }, big) });
    const result = await federationService.downloadAndStoreAvatar(
      url,
      undefined,
      undefined,
      'owner',
    );
    expect(result.fileId).toMatch(/^mirror-/);
    const [, stored, mime] = mockAssetUploadFileDirect.mock.calls[0] as [string, Buffer, string];
    expect(mime).toBe('image/webp');
    expect(stored.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    const meta = await sharp(stored).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1024);
  });
});

describe('a busy origin is waited for, not failed', () => {
  it('waits out the short per-origin gap and mirrors', async () => {
    const url = `https://cdn.retry.example/${randomUUID()}.jpg`;
    mockAcquire.mockResolvedValueOnce(50).mockResolvedValueOnce(0);
    route({ [url]: () => reply(200, {}, JPEG) });
    const result = await federationService.downloadAndStoreAvatar(url);
    expect(result.fileId).toMatch(/^mirror-/);
    expect(mockAcquire).toHaveBeenCalledTimes(2);
  });

  it('defers only on a long cooldown (a recorded 429), as a transient failure', async () => {
    mockAcquire.mockResolvedValue(10 * 60_000);
    const result = await federationService.downloadAndStoreAvatar(
      `https://cdn.retry.example/${randomUUID()}.jpg`,
    );
    expect(result).toMatchObject({ failure: 'transient', reason: 'origin_cooldown' });
  });
});

describe('a failed mirror owes a durable retry', () => {
  it('a transient failure without a stored picture schedules a backed-off retry', async () => {
    const user = await seed(null);
    await persistFederatedAvatar(user.id, { failed: 'http_5xx', permanent: false });
    const first = await stateOf(user.id);
    expect(first.avatar).toBeNull();
    expect(first.attempts).toBe(1);
    expect(first.failure).toBe('http_5xx');
    const firstDelay = first.retryAt!.getTime() - Date.now();
    expect(firstDelay).toBeGreaterThan(4 * 60_000);
    expect(firstDelay).toBeLessThan(6 * 60_000);

    await persistFederatedAvatar(user.id, { failed: 'http_5xx', permanent: false });
    const second = await stateOf(user.id);
    expect(second.attempts).toBe(2);
    expect(second.retryAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it('a permanent failure retries daily; keeping a previous mirror owes nothing; success clears the debt', async () => {
    const dead = await seed(null);
    await persistFederatedAvatar(dead.id, { failed: 'http_4xx', permanent: true });
    expect((await stateOf(dead.id)).retryAt!.getTime() - Date.now()).toBeGreaterThan(
      23 * 60 * 60_000,
    );

    const mirrored = await seed('previous-mirror');
    await persistFederatedAvatar(mirrored.id, { failed: 'http_5xx', permanent: false });
    expect(await stateOf(mirrored.id)).toMatchObject({ avatar: 'previous-mirror', retryAt: null });

    await persistFederatedAvatar(dead.id, { fileId: 'fresh-mirror' });
    expect(await stateOf(dead.id)).toMatchObject({
      avatar: 'fresh-mirror',
      retryAt: null,
      attempts: 0,
      failure: null,
    });
  });

  it('the background worker records the owed retry when its mirror fails', async () => {
    const user = await seed(null);
    const url = `https://cdn.retry.example/${randomUUID()}.jpg`;
    route({ [url]: () => reply(503) });
    const worker = jest.spyOn(
      federationService as unknown as { downloadAvatarForUser(...a: unknown[]): Promise<void> },
      'downloadAvatarForUser',
    );
    federationService.scheduleAvatarRefresh(user.id, url, undefined, { force: false });
    await Promise.all(worker.mock.results.map((r) => r.value));
    expect(await stateOf(user.id)).toMatchObject({
      avatar: null,
      failure: 'http_5xx',
      attempts: 1,
    });
    expect((await stateOf(user.id)).retryAt).toBeInstanceOf(Date);
  });
});

describe('retryFederatedAvatar re-derives the CURRENT source picture', () => {
  it('fetches the source profile and mirrors its current picture, not the stale one', async () => {
    const user = await seed(null, {
      federationAvatarRetryAt: new Date(),
      federationAvatarAttempts: 3,
      federationAvatarFailure: 'origin_cooldown',
    });
    const current = `https://cdn.retry.example/${randomUUID()}-current.jpg`;
    jest
      .spyOn(federationService, 'fetchActorProfile')
      .mockResolvedValue(sourceProfile(user.actorUri, current));
    route({ [current]: () => reply(200, {}, JPEG) });

    expect(await retryFederatedAvatar(user.id)).toMatchObject({ state: 'mirrored' });
    expect(await stateOf(user.id)).toMatchObject({
      avatar: expect.stringMatching(/^mirror-/),
      retryAt: null,
      attempts: 0,
      failure: null,
    });
    expect(mockCacheInvalidate).toHaveBeenCalledWith(user.id);
  });

  it('an unavailable source stays owed with backoff; a source without a picture settles the debt', async () => {
    const gone = await seed(null, { federationAvatarRetryAt: new Date() });
    const bare = await seed(null, { federationAvatarRetryAt: new Date() });
    jest
      .spyOn(federationService, 'fetchActorProfile')
      .mockImplementation(async (actorUri: string) =>
        actorUri === bare.actorUri ? sourceProfile(bare.actorUri, undefined) : null,
      );

    expect(await retryFederatedAvatar(gone.id)).toMatchObject({
      state: 'failed',
      reason: 'source_unavailable',
      permanent: false,
    });
    expect((await stateOf(gone.id)).retryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await retryFederatedAvatar(bare.id)).toEqual({ state: 'no_source_picture' });
    expect((await stateOf(bare.id)).retryAt).toBeNull();
  });

  it('refuses a source document that names another actor', async () => {
    const user = await seed(null, { federationAvatarRetryAt: new Date() });
    jest
      .spyOn(federationService, 'fetchActorProfile')
      .mockResolvedValue(
        sourceProfile('https://elsewhere.example/users/x', 'https://cdn.retry.example/x.jpg'),
      );
    expect(await retryFederatedAvatar(user.id)).toMatchObject({
      state: 'failed',
      reason: 'source_unavailable',
    });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

describe('the retry sweep', () => {
  it('claims only due rows, once, and reports failures by reason', async () => {
    const ok = await seed(null, { federationAvatarRetryAt: new Date(Date.now() - 1000) });
    const flaky = await seed(null, { federationAvatarRetryAt: new Date(Date.now() - 1000) });
    const notDue = await seed(null, {
      federationAvatarRetryAt: new Date(Date.now() + 60 * 60_000),
    });
    const okUrl = `https://cdn.retry.example/${randomUUID()}.jpg`;
    const flakyUrl = `https://cdn.retry.example/${randomUUID()}.jpg`;
    const mine = new Set([ok.id, flaky.id, notDue.id]);
    jest
      .spyOn(federationService, 'fetchActorProfile')
      .mockImplementation(async (actorUri: string) =>
        actorUri === ok.actorUri
          ? sourceProfile(ok.actorUri, okUrl)
          : actorUri === flaky.actorUri
            ? sourceProfile(flaky.actorUri, flakyUrl)
            : null,
      );
    route({ [okUrl]: () => reply(200, {}, JPEG), [flakyUrl]: () => reply(503) });

    const lines: string[] = [];
    const summary = await runFederatedAvatarRetrySweep({
      maxUsers: 1000,
      concurrency: 3,
      log: (l) => lines.push(l),
    });
    const own = lines
      .map((l) => JSON.parse(l) as { userId: string; state: string; reason?: string })
      .filter((l) => mine.has(l.userId));
    expect(own.map((l) => l.userId).sort()).toEqual([ok.id, flaky.id].sort());
    expect(own.find((l) => l.userId === ok.id)?.state).toBe('mirrored');
    expect(own.find((l) => l.userId === flaky.id)).toMatchObject({
      state: 'failed',
      reason: 'http_5xx',
    });
    expect(summary.byReason['http_5xx:503']).toBeGreaterThanOrEqual(1);
    expect((await stateOf(notDue.id)).retryAt!.getTime()).toBeGreaterThan(Date.now());

    // Everything just handled is backed off or settled: nothing of ours is due.
    const again = await claimDueAvatarRetries(1000);
    expect(again.filter((id) => mine.has(id))).toHaveLength(0);
  });

  it('a claim is a lease: a second concurrent claim does not take the same rows', async () => {
    const a = await seed(null, { federationAvatarRetryAt: new Date(Date.now() - 1000) });
    const first = await claimDueAvatarRetries(1000);
    const second = await claimDueAvatarRetries(1000);
    expect(first).toContain(a.id);
    expect(second).not.toContain(a.id);
    expect((await stateOf(a.id)).retryAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
  });
});

describe('recovery of avatars cleared before retries were durable', () => {
  it('queues every federated user left without an avatar by a mirror attempt, and only those', async () => {
    const cleared = await seed(null, {
      federationLastAvatarFetchedAt: new Date(Date.now() - 86_400_000),
    });
    const neverAttempted = await seed(null);
    const mirrored = await seed('a-mirror', { federationLastAvatarFetchedAt: new Date() });
    const archived = await seed(null, {
      federationLastAvatarFetchedAt: new Date(),
      accountStatus: 'archived',
    });

    expect(await queueRecoveryForAvatarlessFederatedUsers(false)).toBeGreaterThanOrEqual(1);
    expect((await stateOf(cleared.id)).retryAt).toBeNull();

    expect(await queueRecoveryForAvatarlessFederatedUsers(true)).toBeGreaterThanOrEqual(1);
    const rows = await getDb()
      .select({ id: users.id, retryAt: users.federationAvatarRetryAt })
      .from(users)
      .where(inArray(users.id, [cleared.id, neverAttempted.id, mirrored.id, archived.id]));
    const due = new Map(rows.map((r) => [r.id, r.retryAt]));
    expect(due.get(cleared.id)).toBeInstanceOf(Date);
    expect(due.get(neverAttempted.id)).toBeNull();
    expect(due.get(mirrored.id)).toBeNull();
    expect(due.get(archived.id)).toBeNull();
  });
});
