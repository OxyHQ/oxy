/**
 * Import by URL (ADR 0043 D7) — `POST /assets/service/app/import`, its batch,
 * and `POST /assets/service/user-media/import` — end to end over real
 * `node:http`, the REAL AssetService and a REAL Postgres.
 *
 * Stubbed: the auth middlewares, the rate limiter, S3 (an in-memory map) and
 * the network: `safeFetch` answers from a table of fake sources, and falls
 * through to the REAL `safeFetch` for any URL the table does not know (so the
 * SSRF case below meets the real guard).
 *
 * Invariants:
 *  1. The calling application owns the import; the same URL imported again by
 *     the same owner answers the existing file WITHOUT any request.
 *  2. `revalidate` sends If-None-Match / If-Modified-Since: 304 keeps the file;
 *     new bytes become a new file and the source row moves; the old file is
 *     untouched.
 *  3. `reference` is registered in the same request (and needs its scope).
 *  4. https only on every hop; private addresses, unsupported types and
 *     oversized sources are refused with their codes; nothing is stored.
 *  5. The URL is never stored in clear.
 *  6. The account-owned import has `/service/user-media`'s authority and owner.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();
const mockObjects = new Map<string, Buffer>();
const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mockObjects.set(key, Buffer.concat(chunks));
    return {};
  }),
  fileExists: jest.fn(async (key: string) => mockObjects.has(key)),
  copyFile: jest.fn(async (from: string, to: string) => {
    const bytes = mockObjects.get(from);
    if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockObjects.set(to, bytes);
  }),
  deleteFile: jest.fn(async (key: string) => {
    mockObjects.delete(key);
  }),
  listFiles: jest.fn(async () => []),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
};

interface FakeSource {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer;
}
const mockSources = new Map<
  string,
  FakeSource | ((headers: Record<string, string>) => FakeSource)
>();
const mockFetchLog: Array<{ url: string; headers: Record<string, string> }> = [];

jest.mock('@oxy.so/core/server', () => {
  const actual = jest.requireActual('@oxy.so/core/server');
  return {
    ...actual,
    safeFetch: async (url: string, options: { headers?: Record<string, string> } = {}) => {
      const known = mockSources.get(url);
      if (!known) return actual.safeFetch(url, options);
      mockFetchLog.push({ url, headers: options.headers ?? {} });
      const answer = typeof known === 'function' ? known(options.headers ?? {}) : known;
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
      };
      response.statusCode = answer.status;
      response.headers = Object.fromEntries(
        Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      response.end(answer.body ?? Buffer.alloc(0));
      return { response, status: answer.status, headers: response.headers, finalUrl: url };
    },
  };
});

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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
import {
  applications,
  fileAccessGrants,
  fileIngests,
  fileReferences,
  fileSources,
  files,
  users,
} from '../../db/schema';
import { fileIngestService } from '../../services/fileIngestSingleton';
import { refetchLargeImport } from '../../services/fileImport.service';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

let server: http.Server;

interface Answer {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
  body: { data?: Record<string, any>; error?: string; message?: string };
}

function post(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function actAs(appId: string, scopes: string[]): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId,
        appName: 'importer',
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

async function application(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `importer-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
    })
    .returning({ id: applications.id });
  return row.id;
}

const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(32)]);

/** A fresh source URL serving `body` as a PNG with validators. */
function source(body = png(), headers: Record<string, string> = {}): string {
  const url = `https://supplier.example/${randomBytes(6).toString('hex')}/photo.png`;
  mockSources.set(url, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(body.length),
      etag: '"v1"',
      'last-modified': 'Wed, 14 Oct 2026 10:00:00 GMT',
      ...headers,
    },
    body,
  });
  return url;
}

const APP_SCOPES = ['files:app:write', 'files:references:write'];

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
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
  mockFetchLog.length = 0;
});

describe('POST /assets/service/app/import', () => {
  it('imports once: the application owns the file, a repeat answers it without fetching', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const url = source();

    const first = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      outcome: 'downloaded',
      deduplicated: false,
      file: {
        ownerApplicationId: appId,
        visibility: 'public',
        mime: 'image/png',
        status: 'active',
      },
      source: { host: 'supplier.example', etag: '"v1"' },
    });
    const fileId = first.body.data?.file.id as string;
    expect(mockFetchLog).toHaveLength(1);
    // No credentials, no conditionals on a first fetch; identity encoding.
    expect(mockFetchLog[0].headers['If-None-Match']).toBeUndefined();
    expect(mockFetchLog[0].headers['Accept-Encoding']).toBe('identity');
    expect(mockFetchLog[0].headers.Authorization).toBeUndefined();

    const again = await post('/assets/service/app/import', {
      sourceUrl: `${url}#fragment-is-not-a-new-source`,
      visibility: 'private',
    });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({
      outcome: 'existing',
      file: { id: fileId, visibility: 'public' },
    });
    expect(mockFetchLog).toHaveLength(1);

    // 5. Provenance is hashed and sealed, never in clear.
    const [row] = await getDb()
      .select()
      .from(fileSources)
      .where(eq(fileSources.ownerApplicationId, appId));
    expect(row.fileId).toBe(fileId);
    expect(row.sourceHost).toBe('supplier.example');
    expect(row.sourceUrlCiphertext).not.toContain('supplier.example');
    expect(row.sourceUrlSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.lastStatus).toBe(200);
  });

  it('keeps one source per owner: another application importing the URL gets its own file', async () => {
    const url = source();
    const a = await application();
    const b = await application();
    actAs(a, APP_SCOPES);
    const first = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
    });
    actAs(b, APP_SCOPES);
    const second = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
    });
    expect(second.body.data?.outcome).toBe('downloaded');
    expect(second.body.data?.file.id).not.toBe(first.body.data?.file.id);
    expect(second.body.data?.file.ownerApplicationId).toBe(b);
  });

  it('revalidates conditionally: 304 keeps the file; new bytes make a new file and move the source', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const url = source();
    const first = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
    });
    const oldId = first.body.data?.file.id as string;

    mockSources.set(url, (headers) =>
      headers['If-None-Match'] === '"v1"' ? { status: 304 } : { status: 500 },
    );
    const unchanged = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
      revalidate: true,
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.data).toMatchObject({ outcome: 'not_modified', file: { id: oldId } });
    expect(mockFetchLog.at(-1)?.headers['If-Modified-Since']).toBe('Wed, 14 Oct 2026 10:00:00 GMT');

    const changed = png();
    mockSources.set(url, {
      status: 200,
      headers: { 'content-type': 'image/png', etag: '"v2"' },
      body: changed,
    });
    const moved = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
      revalidate: true,
    });
    expect(moved.body.data).toMatchObject({ outcome: 'downloaded', deduplicated: false });
    const newId = moved.body.data?.file.id as string;
    expect(newId).not.toBe(oldId);

    const [row] = await getDb()
      .select()
      .from(fileSources)
      .where(eq(fileSources.ownerApplicationId, appId));
    expect(row).toMatchObject({ fileId: newId, etag: '"v2"', lastModified: null });
    // The previous file loses nothing automatically.
    const [old] = await getDb().select().from(files).where(eq(files.id, oldId));
    expect(old.status).toBe('active');
  });

  it('registers the reference in the same request, and only with files:references:write', async () => {
    const appId = await application();
    actAs(appId, ['files:app:write']);
    const url = source();
    const refused = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
      reference: { entityType: 'listing', entityId: 'l-1' },
    });
    expect(refused.status).toBe(403);
    expect(mockFetchLog).toHaveLength(0);

    actAs(appId, APP_SCOPES);
    const res = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
      reference: { entityType: 'listing', entityId: 'l-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data?.reference).toEqual({ result: 'created' });
    const refs = await getDb()
      .select()
      .from(fileReferences)
      .where(eq(fileReferences.fileId, res.body.data?.file.id as string));
    expect(refs).toEqual([
      expect.objectContaining({
        applicationId: appId,
        entityType: 'listing',
        entityId: 'l-1',
        createdByUserId: null,
      }),
    ]);
    const [file] = await getDb()
      .select({ unreferencedSince: files.unreferencedSince })
      .from(files)
      .where(eq(files.id, res.body.data?.file.id as string));
    expect(file.unreferencedSince).toBeNull();
  });

  it('refuses what it must never fetch or store, and stores nothing', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const before = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(eq(files.ownerApplicationId, appId));

    const plain = await post('/assets/service/app/import', {
      sourceUrl: 'http://supplier.example/a.png',
      visibility: 'public',
    });
    expect(plain).toMatchObject({ status: 400, body: { error: 'INVALID_SOURCE_URL' } });

    const creds = await post('/assets/service/app/import', {
      sourceUrl: 'https://user:pass@supplier.example/a.png',
      visibility: 'public',
    });
    expect(creds).toMatchObject({ status: 400, body: { error: 'INVALID_SOURCE_URL' } });

    // The REAL guard: a literal loopback address is refused before any connection.
    const internal = await post('/assets/service/app/import', {
      sourceUrl: 'https://127.0.0.1/a.png',
      visibility: 'public',
    });
    expect(internal).toMatchObject({ status: 422, body: { error: 'SOURCE_URL_REFUSED' } });

    // The plain-http target would serve a perfectly good image: only the
    // per-hop https rule refuses it (safeFetch alone follows to http).
    const plainTarget = `http://supplier.example/${randomBytes(4).toString('hex')}/a.png`;
    mockSources.set(plainTarget, {
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: png(),
    });
    const downgrade = `https://supplier.example/${randomBytes(4).toString('hex')}/redirect`;
    mockSources.set(downgrade, {
      status: 302,
      headers: { location: plainTarget },
    });
    const redirected = await post('/assets/service/app/import', {
      sourceUrl: downgrade,
      visibility: 'public',
    });
    expect(redirected).toMatchObject({ status: 422, body: { error: 'SOURCE_URL_REFUSED' } });

    // An SVG is imported only as its sanitized document (stage 4c): one that
    // is not a real SVG document (no SVG namespace) is refused before storage.
    const svg = source(Buffer.from('<svg/>'), { 'content-type': 'image/svg+xml' });
    expect(
      await post('/assets/service/app/import', { sourceUrl: svg, visibility: 'public' }),
    ).toMatchObject({
      status: 415,
      body: { error: 'INVALID_SVG' },
    });

    // Up to 8 GiB is imported (stage 4c: a large source goes the background
    // way); a source announcing more is refused before a byte is read.
    const huge = source(png(), { 'content-length': String(9 * 1024 ** 3) });
    expect(
      await post('/assets/service/app/import', { sourceUrl: huge, visibility: 'public' }),
    ).toMatchObject({
      status: 413,
      body: { error: 'PAYLOAD_TOO_LARGE' },
    });

    const gone = `https://supplier.example/${randomBytes(4).toString('hex')}/gone.png`;
    mockSources.set(gone, { status: 404 });
    expect(
      await post('/assets/service/app/import', { sourceUrl: gone, visibility: 'public' }),
    ).toMatchObject({
      status: 502,
      body: { error: 'SOURCE_FETCH_FAILED' },
    });

    const after = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(eq(files.ownerApplicationId, appId));
    expect(after).toHaveLength(before.length);
  });

  it('follows an https redirect and names the file after the final URL', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const target = source();
    const hop = `https://short.example/${randomBytes(4).toString('hex')}`;
    mockSources.set(hop, { status: 301, headers: { location: target } });
    const res = await post('/assets/service/app/import', {
      sourceUrl: hop,
      visibility: 'unlisted',
    });
    expect(res.status).toBe(200);
    expect(res.body.data?.file).toMatchObject({
      originalName: 'photo.png',
      visibility: 'unlisted',
    });
    expect(res.body.data?.source.host).toBe('short.example');
  });

  it('needs files:app:write on an active application', async () => {
    const appId = await application();
    actAs(appId, ['files:references:write']);
    expect(
      (await post('/assets/service/app/import', { sourceUrl: source(), visibility: 'public' }))
        .status,
    ).toBe(403);
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, appId));
    actAs(appId, APP_SCOPES);
    expect(
      (await post('/assets/service/app/import', { sourceUrl: source(), visibility: 'public' }))
        .status,
    ).toBe(403);
  });
});

describe('POST /assets/service/app/import/batch', () => {
  it('answers each item on its own, in order', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const good = source();
    const gone = `https://supplier.example/${randomBytes(4).toString('hex')}/gone.png`;
    mockSources.set(gone, { status: 404 });

    const res = await post('/assets/service/app/import/batch', {
      items: [
        {
          sourceUrl: good,
          visibility: 'public',
          reference: { entityType: 'brand', entityId: 'b' },
        },
        { sourceUrl: gone, visibility: 'public' },
        { sourceUrl: 'http://plain.example/x.png', visibility: 'public' },
        { sourceUrl: good, visibility: 'public' },
      ],
    });
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
    const results = res.body.data?.results as Array<Record<string, any>>;
    expect(results.map((item) => [item.index, item.ok])).toEqual([
      [0, true],
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(results[0].reference).toEqual({ result: 'created' });
    expect(results[1].error).toMatchObject({ status: 502, code: 'SOURCE_FETCH_FAILED' });
    expect(results[2].error).toMatchObject({ status: 400, code: 'INVALID_SOURCE_URL' });
    expect(results[3].file.id).toBe(results[0].file.id);
  });

  it('refuses more than 50 items', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const items = Array.from({ length: 51 }, () => ({
      sourceUrl: 'https://a.example/x.png',
      visibility: 'public',
    }));
    expect((await post('/assets/service/app/import/batch', { items })).status).toBe(400);
  });
});

describe('POST /assets/service/user-media/import', () => {
  it("imports into the named account's files, once per (account, URL)", async () => {
    const appId = await application();
    const owner = await account();
    actAs(appId, ['files:user-media:write']);
    const url = source();

    const res = await post(
      '/assets/service/user-media/import',
      { sourceUrl: url },
      { 'x-owner-user-id': owner },
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ outcome: 'downloaded', file: { visibility: 'public' } });
    const [stored] = await getDb()
      .select()
      .from(files)
      .where(eq(files.id, res.body.data?.file.id as string));
    expect(stored).toMatchObject({ ownerUserId: owner, ownerApplicationId: null });

    const again = await post(
      '/assets/service/user-media/import',
      { sourceUrl: url },
      { 'x-owner-user-id': owner },
    );
    expect(again.body.data).toMatchObject({ outcome: 'existing', file: { id: stored.id } });
    const sources = await getDb()
      .select()
      .from(fileSources)
      .where(and(eq(fileSources.ownerUserId, owner), eq(fileSources.fileId, stored.id)));
    expect(sources).toHaveLength(1);
  });

  it("has /service/user-media's authority: files:app:write is not enough, nor an unknown owner", async () => {
    const appId = await application();
    actAs(appId, ['files:app:write', 'files:write']);
    const owner = await account();
    expect(
      (
        await post(
          '/assets/service/user-media/import',
          { sourceUrl: source() },
          { 'x-owner-user-id': owner },
        )
      ).status,
    ).toBe(403);
    actAs(appId, ['files:user-media:write']);
    expect((await post('/assets/service/user-media/import', { sourceUrl: source() })).status).toBe(
      400,
    );
    expect(
      (
        await post(
          '/assets/service/user-media/import',
          { sourceUrl: source() },
          { 'x-owner-user-id': 'no-such-user' },
        )
      ).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Large sources (ADR 0043 stage 4c): > 40 MiB, or audio/video without a
// declared size, are fetched in the background and stored the same way.
// ---------------------------------------------------------------------------

function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Poll an import until it is no longer importing (the background fetch is in this process). */
async function settle(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const answer = await get(path, headers);
    if (answer.body.data?.status !== 'importing' && answer.body.data?.status !== 'verifying') {
      return answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`import at ${path} did not settle`);
}

/** A fresh source URL serving `body` as audio. */
function audioSource(body: Buffer, headers: Record<string, string> = {}): string {
  const url = `https://podcasts.example/${randomBytes(6).toString('hex')}/episode.mp3`;
  mockSources.set(url, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', etag: '"ep1"', ...headers },
    body,
  });
  return url;
}

describe('large imports by URL', () => {
  it('imports a 41 MiB enclosure in the background, once, with its provenance', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const bytes = randomBytes(41 * 1024 * 1024);
    const url = audioSource(bytes, { 'content-length': String(bytes.length) });

    const started = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'private',
      reference: { entityType: 'episode', entityId: 'ep-1' },
      audio: { normalizeLoudness: true },
    });
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({
      status: 'importing',
      source: { host: 'podcasts.example' },
    });
    const importId = started.body.data?.importId as string;

    const done = await settle(`/assets/service/app/imports/${importId}`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      importId,
      status: 'completed',
      outcome: 'downloaded',
      deduplicated: false,
      reference: { result: 'created' },
      source: { host: 'podcasts.example', etag: '"ep1"' },
      file: {
        ownerApplicationId: appId,
        mime: 'audio/mpeg',
        visibility: 'private',
        size: bytes.length,
      },
    });
    const [stored] = await getDb()
      .select()
      .from(files)
      .where(eq(files.id, done.body.data?.file.id as string));
    expect(stored.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(stored.storageKey.startsWith('public/')).toBe(false);
    expect(stored.metadata).toMatchObject({
      audioOptions: { normalizeLoudness: true },
      source: 'import',
    });
    const [provenance] = await getDb()
      .select()
      .from(fileSources)
      .where(eq(fileSources.fileId, stored.id));
    expect(provenance).toMatchObject({ sourceHost: 'podcasts.example', etag: '"ep1"' });
    expect(provenance.sourceUrlCiphertext).not.toContain('podcasts.example/');

    // Once per URL: a repeat answers the file without fetching.
    mockFetchLog.length = 0;
    const again = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'private',
    });
    expect(again).toMatchObject({ status: 200, body: { data: { outcome: 'existing' } } });
    expect(mockFetchLog).toHaveLength(0);

    // Another application cannot read the job.
    actAs(await application(), APP_SCOPES);
    expect((await get(`/assets/service/app/imports/${importId}`)).status).toBe(404);
  });

  it('streams audio that declares no size, into a person’s files, granting the importer', async () => {
    const appId = await application();
    const owner = await account();
    actAs(appId, ['files:user-media:write']);
    const bytes = randomBytes(300_000);
    const url = audioSource(bytes);
    const started = await post(
      '/assets/service/user-media/import',
      { sourceUrl: url, visibility: 'private' },
      { 'x-owner-user-id': owner },
    );
    expect(started.status).toBe(202);
    const done = await settle(`/assets/service/user-media/imports/${started.body.data?.importId}`, {
      'x-owner-user-id': owner,
    });
    expect(done.body.data).toMatchObject({
      status: 'completed',
      file: { visibility: 'private', mime: 'audio/mpeg', size: bytes.length },
    });
    const [grant] = await getDb()
      .select()
      .from(fileAccessGrants)
      .where(eq(fileAccessGrants.fileId, done.body.data?.file.id as string));
    expect(grant).toMatchObject({ applicationId: appId, state: 'granted', source: 'upload' });
  });

  it('leases an import on the database clock, so a task whose clock is behind never loses it early', async () => {
    // The sweep reads `lease_expires_at` against the database's `now()`. Two
    // hours behind: a lease computed from this task's clock (65 minutes ahead
    // of IT) would already be over there, and another task would take the
    // import over while this one is still receiving it.
    const appId = await application();
    const url = `https://podcasts.example/${randomBytes(6).toString('hex')}/slow.mp3`;
    const response = new PassThrough();
    const controller = new AbortController();
    const realNow = Date.now.bind(Date);
    const behind = jest.spyOn(Date, 'now').mockImplementation(() => realNow() - 2 * 60 * 60_000);
    let id: string;
    try {
      ({ id } = await fileIngestService.startLargeImport(
        {
          owner: { kind: 'application', applicationId: appId },
          creatorApplicationId: appId,
          source: { url, host: 'podcasts.example', sha256: randomBytes(32).toString('hex') },
          visibility: 'private',
          metadata: {},
          originalName: 'slow.mp3',
          mime: 'audio/mpeg',
          etag: null,
          lastModified: null,
          declaredLength: null,
        },
        response as unknown as Parameters<typeof fileIngestService.startLargeImport>[1],
        controller,
      ));
    } finally {
      behind.mockRestore();
    }
    try {
      const [row] = await getDb()
        .select({
          leaseLive: sql<boolean>`${fileIngests.leaseExpiresAt} > now() + interval '1 hour'`,
          live: sql<boolean>`${fileIngests.expiresAt} > now() + interval '23 hours'`,
        })
        .from(fileIngests)
        .where(eq(fileIngests.id, id));
      expect(row).toEqual({ leaseLive: true, live: true });
    } finally {
      controller.abort();
      response.destroy();
    }
  });

  it('never stores a body cut short, and the worker fetches it again', async () => {
    const appId = await application();
    actAs(appId, APP_SCOPES);
    const bytes = randomBytes(1024 * 1024);
    const url = `https://podcasts.example/${randomBytes(6).toString('hex')}/cut.mp3`;
    // Announces 41 MiB, sends 1 MiB.
    mockSources.set(url, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(41 * 1024 * 1024) },
      body: bytes,
    });
    const started = await post('/assets/service/app/import', {
      sourceUrl: url,
      visibility: 'public',
    });
    expect(started.status).toBe(202);
    const importId = started.body.data?.importId as string;
    let row = (await getDb().select().from(fileIngests).where(eq(fileIngests.id, importId)))[0];
    for (let attempt = 0; attempt < 200 && row.errorCode === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = (await getDb().select().from(fileIngests).where(eq(fileIngests.id, importId)))[0];
    }
    expect(row).toMatchObject({
      status: 'receiving',
      errorCode: 'SOURCE_FETCH_FAILED',
      fileId: null,
    });

    // The source is whole again; the lease ran out; the worker's sweep resumes it.
    const whole = randomBytes(41 * 1024 * 1024);
    mockSources.set(url, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(whole.length) },
      body: whole,
    });
    await getDb()
      .update(fileIngests)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(fileIngests.id, importId));
    const swept = await fileIngestService.sweep(refetchLargeImport);
    expect(swept.resumed).toBeGreaterThanOrEqual(1);
    const done = await settle(`/assets/service/app/imports/${importId}`);
    expect(done.body.data).toMatchObject({ status: 'completed', file: { size: whole.length } });
  });
});
