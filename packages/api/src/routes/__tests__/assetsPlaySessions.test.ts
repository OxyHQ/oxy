/**
 * Per-play, revocable streaming access (ADR 0042 stage 4c) — over real
 * `node:http`, the REAL play-session service, the REAL AssetService and a REAL
 * Postgres. Stubbed: the auth middlewares, the rate limiter, S3 (in memory,
 * holding a stored HLS ladder) and the application's key-authorization
 * endpoint (a transport the test answers).
 *
 * Invariants:
 *  1. Only the owning application, or one the person consented to, opens a
 *     session; a ladder must exist (409 `STREAM_NOT_READY`).
 *  2. Every URL of a session serves only what the ladder lists; a wrong
 *     secret, a revoked or expired session, a file that left `active`, or an
 *     application whose access the owner revoked is 404 `PLAY_SESSION_INVALID`.
 *  3. AES-128: renditions declare the session's key, segments decrypt with it
 *     and IV = media sequence number; with key authorization the key is
 *     released only on the application's signed `{ allow: true }`.
 *  4. Revocation reaches every task: a peer's file-cache invalidation drops a
 *     cached session.
 */

process.env.DEVICE_ID_SALT ??= 'play-session-test-salt-0123456789abcdef';

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();
let mockSessionUserId: string | null = null;
const mockObjects = new Map<string, { bytes: Buffer; contentType?: string }>();

const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mockObjects.set(key, { bytes: Buffer.concat(chunks) });
    return {};
  }),
  fileExists: jest.fn(async (key: string) => mockObjects.has(key)),
  copyFile: jest.fn(async (from: string, to: string) => {
    const object = mockObjects.get(from);
    if (object) mockObjects.set(to, { ...object });
  }),
  deleteFile: jest.fn(async (key: string) => {
    mockObjects.delete(key);
  }),
  listFiles: jest.fn(async () => []),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
  downloadBuffer: jest.fn(async (key: string) => {
    const object = mockObjects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return object.bytes;
  }),
  getObjectStreamRange: jest.fn(async (key: string, range?: string) => {
    const object = mockObjects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    if (range) {
      const [start, end] = range.replace('bytes=', '').split('-').map(Number);
      const slice = object.bytes.subarray(start, end + 1);
      return {
        body: Readable.from([slice]),
        contentType: object.contentType,
        contentLength: slice.length,
        contentRange: `bytes ${start}-${start + slice.length - 1}/${object.bytes.length}`,
        statusCode: 206,
      };
    }
    return {
      body: Readable.from([object.bytes]),
      contentType: object.contentType,
      contentLength: object.bytes.length,
      statusCode: 200,
    };
  }),
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    if (mockSessionUserId) req.user = { _id: mockSessionUserId, id: mockSessionUserId };
    next();
  },
  serviceAuthMiddleware: (...args: unknown[]) => mockServiceAuthMiddleware(...args),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: mockS3 }));
jest.mock('../../services/variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));
jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, filePlaySessions, files, users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache, { FILE_CACHE_INVALIDATION_CHANNEL } from '../../utils/fileCache';
import { handleFileCacheInvalidationMessage } from '../../utils/fileCacheInvalidationSubscriber';
import { insertFile, upsertVariantSet } from '../../services/fileRepository';
import { grantUploadAccess } from '../../services/fileAccessGrant.service';
import {
  clearPlaySessionCache,
  setKeyAuthorizationTransport,
} from '../../services/playSession.service';
import { sealFileWebhookSecret } from '../../services/fileEvents.service';
import {
  deleteApplicationContent,
  invalidateDeletedApplicationFiles,
} from '../../services/applicationDeletion.service';

jest.setTimeout(60_000);

let server: http.Server;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the route answered.
  json: any;
}

function request(
  method: string,
  pathOrUrl: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  const path = pathOrUrl.startsWith('http') ? new URL(pathOrUrl).pathname : pathOrUrl;
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          ...(body
            ? { 'content-type': 'application/json', 'content-length': String(body.length) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json: unknown = null;
          try {
            json = JSON.parse(bytes.toString('utf8'));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, json });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function actAs(appId: string, scopes: string[] = ['files:app:write', 'files:linked:read']): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId,
        appName: 'test-app',
        credentialId: 'cred-1',
        ownerAccountId: 'acct-1',
        environment: 'production',
        tier: 'internal',
        scopes,
      };
      next();
    },
  );
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(
  values: Partial<typeof applications.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `app-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
      ...values,
    })
    .returning({ id: applications.id });
  return row.id;
}

const SEGMENTS = [randomBytes(1000), randomBytes(777)];
const PREVIEW = randomBytes(512);
const WAVEFORM = Buffer.from(JSON.stringify({ version: 1, length: 2, data: [0, 1, -1, 2] }));

/**
 * An audio file with a stored ladder: one rendition of two segments, a
 * preview and a waveform, as `variantService` writes them.
 */
async function audioFile(
  owner: { ownerUserId: string } | { ownerApplicationId: string },
  options: { ladder?: boolean } = {},
): Promise<string> {
  const sha = randomBytes(32).toString('hex');
  const dir = `variants/2026/10/${sha.slice(0, 2)}/${sha}`;
  const file = await insertFile({
    sha256: sha,
    size: 4096,
    mime: 'audio/mpeg',
    ext: '.mp3',
    ownerUserId: 'ownerUserId' in owner ? owner.ownerUserId : null,
    systemOwner: null,
    ownerApplicationId: 'ownerApplicationId' in owner ? owner.ownerApplicationId : null,
    purpose: 'user',
    status: 'active',
    storageKey: `content/2026/10/${sha.slice(0, 2)}/${sha}.mp3`,
    visibility: 'private',
  });
  if (options.ladder === false) return file.id;
  const master =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=70000,CODECS="mp4a.40.2"\nhls_a64.m3u8\n';
  const rendition =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nsegment_a64_000.ts\n#EXTINF:3.2,\nsegment_a64_001.ts\n#EXT-X-ENDLIST\n';
  mockObjects.set(`${dir}/hls_master.m3u8`, { bytes: Buffer.from(master) });
  mockObjects.set(`${dir}/hls_a64.m3u8`, { bytes: Buffer.from(rendition) });
  mockObjects.set(`${dir}/segment_a64_000.ts`, { bytes: SEGMENTS[0], contentType: 'video/mp2t' });
  mockObjects.set(`${dir}/segment_a64_001.ts`, { bytes: SEGMENTS[1], contentType: 'video/mp2t' });
  mockObjects.set(`${dir}/preview.m4a`, { bytes: PREVIEW, contentType: 'audio/mp4' });
  mockObjects.set(`${dir}/waveform.json`, { bytes: WAVEFORM, contentType: 'application/json' });
  const readyAt = new Date();
  await upsertVariantSet(file.id, [
    { type: 'hls_master', key: `${dir}/hls_master.m3u8`, readyAt, metadata: { kind: 'audio' } },
    {
      type: 'hls_a64',
      key: `${dir}/hls_a64.m3u8`,
      readyAt,
      metadata: { kind: 'audio', bandwidth: 70000 },
    },
    { type: 'preview', key: `${dir}/preview.m4a`, readyAt },
    { type: 'waveform', key: `${dir}/waveform.json`, readyAt },
  ]);
  return file.id;
}

async function openSession(appId: string, body: Record<string, unknown>): Promise<RawResponse> {
  actAs(appId);
  return request('POST', '/assets/service/streams', body);
}

function decrypt(bytes: Buffer, key: Buffer, sequence: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sequence), 8);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  fileCache.clear();
  clearPlaySessionCache();
  setKeyAuthorizationTransport(null);
  mockSessionUserId = null;
});

describe('POST /assets/service/streams', () => {
  it('opens an encrypted session over the ladder of the application’s own file', async () => {
    const appId = await application();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const res = await openSession(appId, { fileId });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.json.data;
    expect(data).toMatchObject({
      fileId,
      kind: 'audio',
      status: 'active',
      encryption: 'aes-128',
      keyAuthorization: 'none',
      endUserId: null,
      renditions: [{ type: 'hls_a64', bandwidth: 70000 }],
    });
    expect(data.masterUrl).toMatch(
      /\/assets\/streams\/[0-9a-f-]{36}\.[A-Za-z0-9_-]+\/master\.m3u8$/,
    );
    expect(data.renditions[0].url).toBe(data.masterUrl.replace('master.m3u8', 'hls_a64.m3u8'));
    expect(data.previewUrl).toBe(data.masterUrl.replace('master.m3u8', 'preview.m4a'));
    expect(data.waveformUrl).toBe(data.masterUrl.replace('master.m3u8', 'waveform.json'));
    const [row] = await getDb()
      .select()
      .from(filePlaySessions)
      .where(eq(filePlaySessions.id, data.sessionId));
    // Only the secret's hash is stored, never the secret.
    expect(data.masterUrl).not.toContain(row.tokenSha256);
    expect(row.contentKeyCiphertext).not.toBeNull();
  });

  it('serves only what the ladder lists, encrypted under the session’s key', async () => {
    const appId = await application();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const { masterUrl } = (await openSession(appId, { fileId })).json.data;
    const base = masterUrl.replace('master.m3u8', '');

    const master = await request('GET', masterUrl);
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(master.headers['access-control-allow-origin']).toBe('*');
    expect(master.headers['cache-control']).toBe('no-store');
    expect(master.bytes.toString()).toContain('hls_a64.m3u8');

    const rendition = (await request('GET', `${base}hls_a64.m3u8`)).bytes.toString();
    const lines = rendition.split('\n');
    expect(lines.indexOf('#EXT-X-KEY:METHOD=AES-128,URI="key"')).toBe(
      lines.findIndex((line) => line.startsWith('#EXTINF')) - 1,
    );

    const key = await request('GET', `${base}key`);
    expect(key.status).toBe(200);
    expect(key.bytes).toHaveLength(16);
    expect(key.headers['cache-control']).toBe('no-store');

    const first = await request('GET', `${base}segment_a64_000.ts`);
    expect(first.status).toBe(200);
    expect(first.headers['content-length']).toBe(String((Math.floor(1000 / 16) + 1) * 16));
    expect(decrypt(first.bytes, key.bytes, 0).equals(SEGMENTS[0])).toBe(true);
    const second = await request('GET', `${base}segment_a64_001.ts`);
    expect(decrypt(second.bytes, key.bytes, 1).equals(SEGMENTS[1])).toBe(true);

    expect((await request('GET', `${base}preview.m4a`)).bytes.equals(PREVIEW)).toBe(true);
    expect((await request('GET', `${base}waveform.json`)).bytes.equals(WAVEFORM)).toBe(true);

    for (const name of [
      'segment_a64_002.ts',
      'hls_a128.m3u8',
      'source.mp3',
      '..%2Fx',
      'hls_master.m3u8',
    ]) {
      expect((await request('GET', `${base}${name}`)).status).toBe(404);
    }
  });

  it('serves a clear ladder for encryption "none", with byte ranges, and no key', async () => {
    const appId = await application();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const { masterUrl } = (await openSession(appId, { fileId, encryption: 'none' })).json.data;
    const base = masterUrl.replace('master.m3u8', '');
    expect((await request('GET', `${base}hls_a64.m3u8`)).bytes.toString()).not.toContain(
      'EXT-X-KEY',
    );
    expect((await request('GET', `${base}segment_a64_000.ts`)).bytes.equals(SEGMENTS[0])).toBe(
      true,
    );
    const ranged = await request('GET', `${base}segment_a64_000.ts`, undefined, {
      range: 'bytes=0-99',
    });
    expect(ranged.status).toBe(206);
    expect(ranged.bytes.equals(SEGMENTS[0].subarray(0, 100))).toBe(true);
    expect((await request('GET', `${base}key`)).status).toBe(404);
  });

  it('refuses a file it may not read, one without a ladder, and a person’s file without files:linked:read', async () => {
    const appId = await application();
    const stranger = await application();
    const own = await audioFile({ ownerApplicationId: appId });
    const notReady = await audioFile({ ownerApplicationId: appId }, { ladder: false });

    expect((await openSession(stranger, { fileId: own })).status).toBe(404);
    const unready = await openSession(appId, { fileId: notReady });
    expect(unready).toMatchObject({ status: 409, json: { error: 'STREAM_NOT_READY' } });

    const person = await account();
    const theirs = await audioFile({ ownerUserId: person });
    // No consent at all: like no file.
    expect((await openSession(appId, { fileId: theirs })).status).toBe(404);
    await grantUploadAccess(theirs, appId);
    actAs(appId, ['files:app:write']);
    expect((await request('POST', '/assets/service/streams', { fileId: theirs })).status).toBe(403);
    expect((await openSession(appId, { fileId: theirs })).status).toBe(201);
  });
});

describe('revocation', () => {
  it('a wrong secret, a revoked session and an expired one are refused at once', async () => {
    const appId = await application();
    const other = await application();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const opened = (await openSession(appId, { fileId })).json.data;
    const forged = opened.masterUrl.replace(
      /\.([A-Za-z0-9_-]+)\/master/,
      '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/master',
    );
    expect((await request('GET', forged)).json).toMatchObject({ error: 'PLAY_SESSION_INVALID' });

    expect((await request('GET', opened.masterUrl)).status).toBe(200);
    actAs(other);
    expect((await request('DELETE', `/assets/service/streams/${opened.sessionId}`)).status).toBe(
      404,
    );
    actAs(appId);
    const revoked = await request('DELETE', `/assets/service/streams/${opened.sessionId}`);
    expect(revoked.json.data).toEqual({ sessionId: opened.sessionId, revoked: true });
    expect((await request('GET', opened.masterUrl)).status).toBe(404);
    const segment = opened.masterUrl.replace('master.m3u8', 'segment_a64_000.ts');
    expect((await request('GET', segment)).status).toBe(404);
    const described = await request('GET', `/assets/service/streams/${opened.sessionId}`);
    expect(described.json.data).toMatchObject({ status: 'revoked', kind: 'audio' });
    expect(described.json.data).not.toHaveProperty('masterUrl');

    const short = (await openSession(appId, { fileId, ttlSeconds: 60 })).json.data;
    expect((await request('GET', short.masterUrl)).status).toBe(200);
    await getDb()
      .update(filePlaySessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(filePlaySessions.id, short.sessionId));
    clearPlaySessionCache();
    expect((await request('GET', short.masterUrl)).status).toBe(404);
    actAs(appId);
    expect(
      (await request('GET', `/assets/service/streams/${short.sessionId}`)).json.data.status,
    ).toBe('expired');
  });

  it('revokes every session of an end user or a file', async () => {
    const appId = await application();
    const listener = await account();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const a = (await openSession(appId, { fileId, endUserId: listener })).json.data;
    const b = (await openSession(appId, { fileId, endUserId: listener })).json.data;
    const c = (await openSession(appId, { fileId })).json.data;
    expect(a.endUserId).toBe(listener);
    actAs(appId);
    const res = await request('POST', '/assets/service/streams/revoke', { endUserId: listener });
    expect(res.json.data).toEqual({ revoked: 2 });
    expect((await request('GET', a.masterUrl)).status).toBe(404);
    expect((await request('GET', b.masterUrl)).status).toBe(404);
    expect((await request('GET', c.masterUrl)).status).toBe(200);
    expect((await request('POST', '/assets/service/streams/revoke', {})).status).toBe(400);
    expect(
      (await openSession(appId, { fileId, endUserId: '00000000-0000-7000-8000-000000000000' }))
        .status,
    ).toBe(400);
  });

  it('the owner revoking the application’s access ends its sessions mid-play', async () => {
    const appId = await application();
    const person = await account();
    const fileId = await audioFile({ ownerUserId: person });
    await grantUploadAccess(fileId, appId);
    const session = (await openSession(appId, { fileId })).json.data;
    expect((await request('GET', session.masterUrl)).status).toBe(200);

    mockSessionUserId = person;
    const revoked = await request('DELETE', `/assets/${fileId}/access/${appId}`);
    expect(revoked.json.data).toMatchObject({ revoked: true, streamsRevoked: 1 });
    expect((await request('GET', session.masterUrl)).status).toBe(404);
    expect((await openSession(appId, { fileId })).status).toBe(404);
  });

  it('a file that leaves active stops being served', async () => {
    const appId = await application();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const session = (await openSession(appId, { fileId })).json.data;
    expect((await request('GET', session.masterUrl)).status).toBe(200);
    await getDb()
      .update(files)
      .set({ status: 'trash', trashedAt: new Date() })
      .where(eq(files.id, fileId));
    fileCache.invalidate(fileId);
    expect((await request('GET', session.masterUrl)).status).toBe(404);
  });

  it('a suspended application’s sessions stop, and a deleted one’s are revoked', async () => {
    const appId = await application();
    const person = await account();
    const fileId = await audioFile({ ownerUserId: person });
    await grantUploadAccess(fileId, appId);
    const session = (await openSession(appId, { fileId })).json.data;
    expect((await request('GET', session.masterUrl)).status).toBe(200);

    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, appId));
    clearPlaySessionCache();
    expect((await request('GET', session.masterUrl)).status).toBe(404);

    await getDb().update(applications).set({ status: 'active' }).where(eq(applications.id, appId));
    clearPlaySessionCache();
    expect((await request('GET', session.masterUrl)).status).toBe(200);
    const content = await getDb().transaction(async (tx) => {
      await tx.update(applications).set({ status: 'deleted' }).where(eq(applications.id, appId));
      return deleteApplicationContent(tx, appId);
    });
    expect(content.playSessionFileIds).toEqual([fileId]);
    invalidateDeletedApplicationFiles(content);
    const [row] = await getDb()
      .select()
      .from(filePlaySessions)
      .where(eq(filePlaySessions.id, session.sessionId));
    expect(row).toMatchObject({ revokedBy: 'oxy' });
    expect((await request('GET', session.masterUrl)).status).toBe(404);
  });

  it('a peer task’s file-cache invalidation drops this task’s cached session', async () => {
    const appId = await application();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const session = (await openSession(appId, { fileId })).json.data;
    expect((await request('GET', session.masterUrl)).status).toBe(200);

    // Another task revoked it: the row changed, this task still caches it…
    await getDb()
      .update(filePlaySessions)
      .set({ revokedAt: new Date(), revokedBy: 'application' })
      .where(eq(filePlaySessions.id, session.sessionId));
    expect((await request('GET', session.masterUrl)).status).toBe(200);
    // …until that task's invalidation arrives on the channel.
    handleFileCacheInvalidationMessage(
      FILE_CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ v: 1, origin: 'another-task', fileIds: [fileId] }),
    );
    expect((await request('GET', session.masterUrl)).status).toBe(404);
  });
});

describe('key authorization by the application', () => {
  it('needs a verified file-events endpoint, signs the request, and releases the key only on allow', async () => {
    const appId = await application();
    const listener = await account();
    const fileId = await audioFile({ ownerApplicationId: appId });
    const refused = await openSession(appId, { fileId, keyAuthorization: 'webhook' });
    expect(refused).toMatchObject({ status: 409, json: { error: 'FILES_WEBHOOK_REQUIRED' } });
    expect(
      (await openSession(appId, { fileId, keyAuthorization: 'webhook', encryption: 'none' }))
        .status,
    ).toBe(400);

    const secret = `whsec_${randomBytes(16).toString('hex')}`;
    await getDb()
      .update(applications)
      .set({
        filesWebhookUrl: 'https://product.example/oxy/events',
        filesWebhookSecretCiphertext: sealFileWebhookSecret(appId, secret),
        filesWebhookVerifiedAt: new Date(),
      })
      .where(eq(applications.id, appId));

    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    let allow = false;
    setKeyAuthorizationTransport(async (call) => {
      calls.push(call);
      return { status: 200, body: { allow } };
    });

    const session = (
      await openSession(appId, { fileId, keyAuthorization: 'webhook', endUserId: listener })
    ).json.data;
    const keyUrl = session.masterUrl.replace('master.m3u8', 'key');
    expect(await request('GET', keyUrl)).toMatchObject({
      status: 403,
      json: { error: 'KEY_AUTHORIZATION_DENIED' },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://product.example/oxy/events');
    expect(call.headers['oxy-event-type']).toBe('stream.key_authorization');
    const [t, v1] = call.headers['oxy-signature'].split(',').map((part) => part.split('=')[1]);
    expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${call.body}`).digest('hex'));
    expect(JSON.parse(call.body)).toMatchObject({
      type: 'stream.key_authorization',
      session: { id: session.sessionId, fileId, endUserId: listener },
    });

    allow = true;
    const key = await request('GET', keyUrl);
    expect(key.status).toBe(200);
    expect(key.bytes).toHaveLength(16);
    // An allow is reused for a while: a rendition switch does not ask again.
    expect((await request('GET', keyUrl)).status).toBe(200);
    expect(calls).toHaveLength(2);

    // Anything but a 2xx `{ allow: true }` is a refusal.
    setKeyAuthorizationTransport(async () => ({ status: 500, body: { allow: true } }));
    const other = (await openSession(appId, { fileId, keyAuthorization: 'webhook' })).json.data;
    expect((await request('GET', other.masterUrl.replace('master.m3u8', 'key'))).status).toBe(403);
    setKeyAuthorizationTransport(async () => {
      throw new Error('timeout');
    });
    expect((await request('GET', other.masterUrl.replace('master.m3u8', 'key'))).status).toBe(403);
  });
});
