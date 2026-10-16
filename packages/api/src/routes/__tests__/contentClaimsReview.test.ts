/**
 * The content-claim review and the takedown it decides (ADR 0042 D10) — the
 * staff routes of `/content-claims`, `/assets` and `/cdn` over real
 * `node:http`, the REAL AssetService, file events, lifecycle, storage purge
 * and a REAL Postgres. Stubbed: the session (a switchable user; the staff
 * capability is read from the real row), the rate limiters, S3 (an in-memory
 * map) and the network of an import (`safeFetch` answers a table).
 *
 *  1. Only staff holding `content:claims` read or act; `/access` answers anyone.
 *  2. Blocking acts on BYTES: every live row of them — any owner, active or
 *     trash — is `blocked`, off `public/`, not served by the stream route or
 *     `/cdn/:id`; `file.blocked` goes to the owning and referencing
 *     applications; the claimant and every owning account get an email.
 *  3. The bytes cannot come back: an upload by anyone (the owner included),
 *     an init, an application's import — 451 `CONTENT_BLOCKED`, nothing stored.
 *  4. A reviewer previews the blocked bytes on a short-lived token.
 *  5. A counter-notice and a reinstatement serve the bytes again (a trashed
 *     row back to trash), `file.unblocked`, the blocklist entry gone.
 *  6. The state machine refuses what it does not allow (409), and the audit
 *     trail is append-only.
 *  7. Evidence: bytes an open claim names are not purged when their row is
 *     deleted, and are once it closes; a blocked file is not "not in use" nor
 *     collected while a claim holds it, and an application's is once it is
 *     upheld.
 *  8. The queue filters by state, kind and deadline.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { and, asc, eq, inArray } from 'drizzle-orm';

let mockUser: { _id: string; isStaff: boolean } = { _id: 'nobody', isStaff: false };
const mockObjects = new Map<string, Buffer>();
const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mockObjects.set(key, Buffer.concat(chunks));
    return {};
  }),
  uploadBuffer: jest.fn(async (key: string, body: Buffer) => {
    mockObjects.set(key, body);
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
  getPresignedUploadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
  getObjectStreamRange: jest.fn(async (key: string) => {
    const bytes = mockObjects.get(key);
    if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return { body: Readable.from([bytes]), contentLength: bytes.length, statusCode: 200 };
  }),
};

const mockSources = new Map<string, Buffer>();
jest.mock('@oxy.so/core/server', () => {
  const actual = jest.requireActual('@oxy.so/core/server');
  return {
    ...actual,
    safeFetch: async (url: string, options: Record<string, unknown> = {}) => {
      const body = mockSources.get(url);
      if (!body) return actual.safeFetch(url, options);
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
      };
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png', 'content-length': String(body.length) };
      response.end(body);
      return { response, status: 200, headers: response.headers, finalUrl: url };
    },
  };
});

const mockServiceApp: { current: Record<string, unknown> | null } = { current: null };
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { ...mockUser, id: mockUser._id };
    next();
  },
  serviceAuthMiddleware: (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
    req.serviceApp = mockServiceApp.current ?? undefined;
    next();
  },
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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
import {
  applications,
  blockedContentHashes,
  contentClaimClaimants,
  contentClaimEvents,
  contentClaimNotifications,
  contentClaims,
  fileEventDeliveries,
  files,
  storageObjectDeletions,
  users,
} from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import { runStorageDeletionBatch } from '../../services/accountStorageDeletion.worker';
import { assetService } from '../../services/assetServiceSingleton';
import { submitContentClaim } from '../../services/contentClaims/contentClaim.service';
import { sealFileWebhookSecret } from '../../services/fileEvents.service';
import {
  addFileReferences,
  countFileLifecycleCandidates,
  insertFile,
  listFileLifecycleCandidates,
  listFilesByOwner,
} from '../../services/fileRepository';
import fileCache from '../../utils/fileCache';
import assetsRouter from '../assets';
import cdnRouter from '../cdn';
import contentClaimsRouter from '../contentClaims';

jest.setTimeout(120_000);

let server: http.Server;

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
  body: any;
  raw: Buffer;
}

function send(method: string, path: string, payload?: unknown): Promise<Answer> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: body
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let parsed: unknown = raw.toString('utf8');
          try {
            parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            // bytes, or a redirect
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function account(options: { staffCapabilities?: string[]; isStaff?: boolean } = {}) {
  const [row] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      username: `u${randomBytes(5).toString('hex')}`,
      email: `${randomBytes(5).toString('hex')}@example.com`,
      isStaff: options.isStaff ?? false,
      staffCapabilities: (options.staffCapabilities ?? []) as never,
    })
    .returning({ id: users.id });
  return row.id;
}

async function reviewer(): Promise<string> {
  const id = await account({ isStaff: true, staffCapabilities: ['content:claims'] });
  mockUser = { _id: id, isStaff: true };
  return id;
}

async function application(subscribed: boolean): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `app-${id.slice(0, 6)}`,
      ownerAccountId: await account(),
      type: 'first_party',
      ...(subscribed
        ? {
            filesWebhookUrl: 'https://receiver.example/files',
            filesWebhookSecretCiphertext: sealFileWebhookSecret(id, 'whsec_x'),
            filesWebhookVerifiedAt: new Date(),
          }
        : {}),
    });
  return id;
}

const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(48)]);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A stored row of `bytes` with its object in the store. */
async function storedRow(
  bytes: Buffer,
  owner: { ownerUserId?: string; ownerApplicationId?: string },
  options: {
    visibility?: 'public' | 'private';
    status?: 'active' | 'trash';
    createdAt?: Date;
  } = {},
) {
  const sha = sha256(bytes);
  const visibility = options.visibility ?? 'private';
  const base = `content/2026/10/${sha.slice(0, 2)}/${sha}.png`;
  const storageKey = visibility === 'public' ? `public/${base}` : base;
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: bytes.length,
      mime: 'image/png',
      ext: 'png',
      ownerUserId: owner.ownerUserId ?? null,
      ownerApplicationId: owner.ownerApplicationId ?? null,
      visibility,
      status: options.status ?? 'active',
      trashedAt: options.status === 'trash' ? new Date() : null,
      storageKey,
      originalName: 'photo.png',
      metadata: {},
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning();
  mockObjects.set(storageKey, bytes);
  return row;
}

async function claimFor(
  urls: string[],
  overrides: Partial<Parameters<typeof submitContentClaim>[0]> = {},
) {
  return submitContentClaim(
    {
      kind: 'copyright',
      contentUrls: urls,
      description: 'This photo is mine and was posted without my permission.',
      claimant: {
        name: 'Ada',
        email: `ada-${randomBytes(4).toString('hex')}@example.com`,
        relationship: 'rights_holder',
      },
      statements: { goodFaith: true, accurate: true },
      signature: 'Ada',
      ...overrides,
    },
    { submittedByUserId: null, apiHosts: ['api.oxy.so'], cdnHost: 'cloud.oxy.so' },
  );
}

async function fileRow(id: string) {
  const [row] = await getDb().select().from(files).where(eq(files.id, id));
  return row;
}

async function notifications(claimId: string) {
  return getDb()
    .select({
      kind: contentClaimNotifications.kind,
      recipient: contentClaimNotifications.recipient,
      recipientUserId: contentClaimNotifications.recipientUserId,
    })
    .from(contentClaimNotifications)
    .where(eq(contentClaimNotifications.claimId, claimId))
    .orderBy(asc(contentClaimNotifications.createdAt), asc(contentClaimNotifications.id));
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  process.env.ASSET_CDN_URL = 'https://cloud.oxy.so';
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/assets', assetsRouter);
  app.use('/cdn', cdnRouter);
  app.use('/content-claims', contentClaimsRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  await assetService.settleStoragePurges();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => fileCache.clear());

describe('who may review', () => {
  it('is staff holding content:claims; /access answers anyone signed in', async () => {
    const { id } = await claimFor(['https://mention.earth/p/1']);

    mockUser = { _id: await account(), isStaff: false };
    expect((await send('GET', '/content-claims/access')).body).toEqual({ canReview: false });
    for (const [method, path] of [
      ['GET', '/content-claims'],
      ['GET', `/content-claims/${id}`],
      ['POST', `/content-claims/${id}/review`],
      ['POST', `/content-claims/${id}/block`],
    ] as const) {
      expect((await send(method, path, method === 'POST' ? {} : undefined)).status).toBe(403);
    }

    // Staff, without the capability.
    mockUser = { _id: await account({ isStaff: true }), isStaff: true };
    expect((await send('GET', '/content-claims/access')).body).toEqual({ canReview: false });
    const refused = await send('GET', `/content-claims/${id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('content:claims');

    await reviewer();
    expect((await send('GET', '/content-claims/access')).body).toEqual({ canReview: true });
    const detail = await send('GET', `/content-claims/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id,
      state: 'received',
      claimant: { name: 'Ada', email: expect.stringContaining('@example.com') },
      targets: [{ resolution: 'unresolved', url: 'https://mention.earth/p/1' }],
      events: [{ action: 'submitted' }],
    });
  });
});

describe('the takedown', () => {
  it('blocks the bytes everywhere, keeps them out, previews them, and reinstates them', async () => {
    const bytes = png();
    const sha = sha256(bytes);
    const ownerA = await account();
    const ownerB = await account();
    const appC = await application(true);
    const appD = await application(true);
    const fileA = await storedRow(bytes, { ownerUserId: ownerA }, { visibility: 'public' });
    const fileB = await storedRow(bytes, { ownerUserId: ownerB }, { status: 'trash' });
    const fileC = await storedRow(bytes, { ownerApplicationId: appC });
    await addFileReferences([
      { fileId: fileA.id, applicationId: appD, entityType: 'post', entityId: 'p1' },
      { fileId: fileC.id, applicationId: appC, entityType: 'tile', entityId: 't1' },
    ]);
    const publicKey = fileA.storageKey;
    expect((await send('GET', `/cdn/${fileA.id}`)).status).toBe(302);

    const { id } = await claimFor([`https://cloud.oxy.so/${fileA.id}`]);
    const staff = await reviewer();

    // Not before a review has started.
    const early = await send('POST', `/content-claims/${id}/block`, {});
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      error: 'CONTENT_CLAIM_STATE_CONFLICT',
      details: { state: 'received' },
    });

    expect((await send('POST', `/content-claims/${id}/review`)).body.state).toBe('reviewing');
    const blocked = await send('POST', `/content-claims/${id}/block`, { note: 'Clear match.' });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({
      targetsBlocked: 1,
      hashesBlocked: 1,
      filesBlocked: 3,
      ownersNotified: 2,
      claim: { state: 'actioned', targetCount: 1, blockedTargetCount: 1 },
    });

    // Every live row of the bytes, whoever owns it.
    const [a, b, c] = await Promise.all([fileRow(fileA.id), fileRow(fileB.id), fileRow(fileC.id)]);
    expect([a.status, b.status, c.status]).toEqual(['blocked', 'blocked', 'blocked']);
    expect(b.trashedAt).toBeInstanceOf(Date);
    expect(
      await getDb().select().from(blockedContentHashes).where(eq(blockedContentHashes.sha256, sha)),
    ).toEqual([expect.objectContaining({ claimId: id })]);

    // Off the CDN and not served.
    expect(a.storageKey).toBe(publicKey.replace(/^public\//, ''));
    expect(mockObjects.has(publicKey)).toBe(false);
    expect(mockObjects.get(a.storageKey)).toEqual(bytes);
    expect((await send('GET', `/assets/${fileA.id}/stream`)).status).toBe(404);
    expect((await send('GET', `/cdn/${fileA.id}`)).status).toBe(404);

    // file.blocked to the referencing application (A's) and the owning one (C's).
    const events = await getDb()
      .select({
        applicationId: fileEventDeliveries.applicationId,
        fileId: fileEventDeliveries.fileId,
        payload: fileEventDeliveries.payload,
      })
      .from(fileEventDeliveries)
      .where(
        and(
          eq(fileEventDeliveries.type, 'file.blocked'),
          inArray(fileEventDeliveries.fileId, [fileA.id, fileB.id, fileC.id]),
        ),
      );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          applicationId: appD,
          fileId: fileA.id,
          payload: expect.objectContaining({
            type: 'file.blocked',
            file: expect.objectContaining({ status: 'blocked', ownerKind: 'account' }),
            references: [{ entityType: 'post', entityId: 'p1' }],
          }),
        }),
        expect.objectContaining({ applicationId: appC, fileId: fileC.id }),
      ]),
    );

    // The claimant, and each owning ACCOUNT (an application is told by its event).
    const byKey = (row: { kind: string; recipientUserId: string | null }) =>
      `${row.kind}:${row.recipientUserId ?? ''}`;
    expect((await notifications(id)).map(byKey).sort()).toEqual(
      [
        'claim_received:',
        'claim_actioned:',
        `content_blocked:${ownerA}`,
        `content_blocked:${ownerB}`,
      ].sort(),
    );

    // ---- the bytes cannot come back ----------------------------------------
    const stranger = await account();
    await expect(
      assetService.uploadFileDirect(stranger, bytes, 'image/png', 'again.png', 'public'),
    ).rejects.toMatchObject({ statusCode: 451, code: 'CONTENT_BLOCKED' });
    await expect(
      assetService.uploadFileDirect(ownerA, bytes, 'image/png', 'mine.png', 'public'),
    ).rejects.toMatchObject({ statusCode: 451, code: 'CONTENT_BLOCKED' });
    await expect(
      assetService.initUpload(stranger, sha, bytes.length, 'image/png'),
    ).rejects.toMatchObject({
      statusCode: 451,
      code: 'CONTENT_BLOCKED',
    });
    // The root: no row of the bytes can be inserted by any path, for any owner.
    await expect(
      insertFile({
        sha256: sha,
        size: bytes.length,
        mime: 'image/png',
        ext: 'png',
        ownerUserId: stranger,
        storageKey: `content/2026/10/${sha.slice(0, 2)}/${sha}-copy.png`,
      }),
    ).rejects.toMatchObject({ statusCode: 451, code: 'CONTENT_BLOCKED' });
    const importer = await application(false);
    mockServiceApp.current = {
      type: 'service',
      appId: importer,
      appName: 'importer',
      credentialId: 'cred-1',
      ownerAccountId: 'acct-1',
      environment: 'production',
      tier: 'internal',
      scopes: ['files:app:write'],
    };
    const sourceUrl = `https://supplier.example/${randomBytes(4).toString('hex')}.png`;
    mockSources.set(sourceUrl, bytes);
    const imported = await send('POST', '/assets/service/app/import', {
      sourceUrl,
      visibility: 'public',
    });
    expect(imported.status).toBe(451);
    expect(imported.body.error).toBe('CONTENT_BLOCKED');
    const rows = await getDb().select({ id: files.id }).from(files).where(eq(files.sha256, sha));
    expect(rows).toHaveLength(3);
    // No object of the blocked bytes was written for the refused uploads.
    expect(
      [...mockObjects.entries()].filter(([, value]) => value.equals(bytes)).map(([key]) => key),
    ).toEqual(expect.arrayContaining([a.storageKey]));
    expect(
      [...mockObjects.keys()].filter((key) => key.includes(sha) && key.startsWith('public/')),
    ).toEqual([]);

    // ---- a reviewer previews them -------------------------------------------
    const detail = (await send('GET', `/content-claims/${id}`)).body;
    const target = detail.targets[0];
    const minted = await send('POST', `/content-claims/${id}/targets/${target.id}/preview`);
    expect(minted.status).toBe(200);
    const previewPath = new URL(minted.body.url).pathname + new URL(minted.body.url).search;
    const preview = await send('GET', previewPath);
    expect(preview.status).toBe(200);
    expect(preview.raw.equals(bytes)).toBe(true);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.headers['content-security-policy']).toContain('sandbox');
    // A tampered token, and a token used for another target, are refused.
    expect((await send('GET', `${previewPath}x`)).status).toBe(403);
    expect((await send('GET', previewPath.replace(target.id, 'another-target'))).status).toBe(403);

    // ---- counter-notice, reinstatement --------------------------------------
    expect((await send('POST', `/content-claims/${id}/reinstate`, {})).status).toBe(409);
    expect((await send('POST', `/content-claims/${id}/counter-notice`, {})).status).toBe(400);
    const noticed = await send('POST', `/content-claims/${id}/counter-notice`, {
      note: 'The owner says they licensed the photo.',
    });
    expect(noticed.body.state).toBe('counter_noticed');
    const reinstated = await send('POST', `/content-claims/${id}/reinstate`, {
      note: 'Licence verified.',
    });
    expect(reinstated.status).toBe(200);
    expect(reinstated.body).toMatchObject({ filesRestored: 3, claim: { state: 'reinstated' } });

    const [a2, b2, c2] = await Promise.all([
      fileRow(fileA.id),
      fileRow(fileB.id),
      fileRow(fileC.id),
    ]);
    expect([a2.status, b2.status, c2.status]).toEqual(['active', 'trash', 'active']);
    expect(a2.storageKey).toBe(publicKey);
    expect(mockObjects.get(publicKey)).toEqual(bytes);
    expect((await send('GET', `/cdn/${fileA.id}`)).status).toBe(302);
    expect(
      await getDb().select().from(blockedContentHashes).where(eq(blockedContentHashes.sha256, sha)),
    ).toEqual([]);
    const unblocked = await getDb()
      .select({ fileId: fileEventDeliveries.fileId })
      .from(fileEventDeliveries)
      .where(
        and(
          eq(fileEventDeliveries.type, 'file.unblocked'),
          inArray(fileEventDeliveries.fileId, [fileA.id, fileB.id, fileC.id]),
        ),
      );
    expect(unblocked.map((row) => row.fileId).sort()).toEqual([fileA.id, fileC.id].sort());
    const reinstateMail = (await notifications(id)).filter(
      (row) => row.kind === 'content_reinstated',
    );
    expect(reinstateMail.map((row) => row.recipientUserId).sort()).toEqual([ownerA, ownerB].sort());

    // The bytes may be stored again.
    const again = await assetService.uploadFileDirect(
      stranger,
      bytes,
      'image/png',
      'ok.png',
      'private',
    );
    expect(again.status).toBe('active');

    // The trail, in order, with its actors.
    const trail = await getDb()
      .select({ action: contentClaimEvents.action, actorUserId: contentClaimEvents.actorUserId })
      .from(contentClaimEvents)
      .where(eq(contentClaimEvents.claimId, id))
      .orderBy(asc(contentClaimEvents.createdAt), asc(contentClaimEvents.id));
    expect(trail).toEqual([
      { action: 'submitted', actorUserId: null },
      { action: 'review_started', actorUserId: staff },
      { action: 'targets_blocked', actorUserId: staff },
      { action: 'counter_notice_recorded', actorUserId: staff },
      { action: 'reinstated', actorUserId: staff },
    ]);
    // Append-only.
    await expect(
      getDb()
        .update(contentClaimEvents)
        .set({ note: 'edited' })
        .where(eq(contentClaimEvents.claimId, id)),
    ).rejects.toThrow();

    // Closed: the claimant's statement is on its retention clock.
    const [claimant] = await getDb()
      .select({ expiresAt: contentClaimClaimants.expiresAt })
      .from(contentClaimClaimants)
      .where(eq(contentClaimClaimants.claimId, id));
    expect(claimant.expiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 2 * 365 * 24 * 60 * 60 * 1000,
    );
  });

  it('leaves bytes another claim still blocks blocked when one is reinstated', async () => {
    const bytes = png();
    const owner = await account();
    const file = await storedRow(bytes, { ownerUserId: owner });
    const first = await claimFor([`https://cloud.oxy.so/${file.id}`]);
    const second = await claimFor([`https://api.oxy.so/assets/${file.id}`]);
    await reviewer();
    for (const { id } of [first, second]) {
      await send('POST', `/content-claims/${id}/review`);
      expect((await send('POST', `/content-claims/${id}/block`, {})).status).toBe(200);
    }
    await send('POST', `/content-claims/${first.id}/counter-notice`, { note: 'Disputed.' });
    const reinstated = await send('POST', `/content-claims/${first.id}/reinstate`, {});
    expect(reinstated.body.filesRestored).toBe(0);
    expect((await fileRow(file.id)).status).toBe('blocked');
    await expect(
      assetService.uploadFileDirect(await account(), bytes, 'image/png', 'x.png'),
    ).rejects.toMatchObject({ code: 'CONTENT_BLOCKED' });
  });
});

describe('the state machine', () => {
  it('rejects with a reason, from received or reviewing only', async () => {
    const { id } = await claimFor(['https://mention.earth/p/2']);
    await reviewer();
    expect((await send('POST', `/content-claims/${id}/reject`, {})).status).toBe(400);
    const rejected = await send('POST', `/content-claims/${id}/reject`, {
      reason: 'Not Oxy content.',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ state: 'rejected', closedAt: expect.any(String) });
    expect((await send('POST', `/content-claims/${id}/review`)).status).toBe(409);
    expect((await send('POST', `/content-claims/${id}/reject`, { reason: 'Again.' })).status).toBe(
      409,
    );
    expect((await send('POST', `/content-claims/${id}/uphold`, {})).status).toBe(409);
    expect((await notifications(id)).map((row) => row.kind)).toEqual([
      'claim_received',
      'claim_rejected',
    ]);
  });

  it('refuses to block a claim with nothing to block, and unknown targets', async () => {
    const { id } = await claimFor(['https://mention.earth/p/3']);
    await reviewer();
    await send('POST', `/content-claims/${id}/review`);
    const nothing = await send('POST', `/content-claims/${id}/block`, {});
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toBe('CONTENT_CLAIM_NOTHING_TO_BLOCK');
    const unknown = await send('POST', `/content-claims/${id}/block`, { targetIds: ['nope'] });
    expect(unknown.body).toMatchObject({
      error: 'CONTENT_CLAIM_TARGETS_NOT_BLOCKABLE',
      details: { targetIds: ['nope'] },
    });
  });

  it('attaches files to a page target by id, once each', async () => {
    const owner = await account();
    const file = await storedRow(png(), { ownerUserId: owner });
    const { id } = await claimFor(['https://mercaria.co/products/42']);
    await reviewer();
    const missing = await send('POST', `/content-claims/${id}/targets`, {
      fileIds: ['no-such-file'],
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      error: 'FILE_NOT_FOUND',
      details: { fileIds: ['no-such-file'] },
    });
    const attached = await send('POST', `/content-claims/${id}/targets`, {
      fileIds: [file.id],
      url: 'https://mercaria.co/products/42',
    });
    expect(attached.body).toMatchObject({ attached: [file.id], alreadyAttached: [] });
    expect(attached.body.claim.targets).toEqual([
      expect.objectContaining({ source: 'claimant', resolution: 'unresolved' }),
      expect.objectContaining({
        source: 'staff',
        resolution: 'file',
        fileId: file.id,
        sha256: file.sha256,
        url: 'https://mercaria.co/products/42',
        file: expect.objectContaining({ status: 'active', ownerKind: 'account' }),
      }),
    ]);
    const twice = await send('POST', `/content-claims/${id}/targets`, { fileIds: [file.id] });
    expect(twice.body).toMatchObject({ attached: [], alreadyAttached: [file.id] });
    await send('POST', `/content-claims/${id}/review`);
    expect((await send('POST', `/content-claims/${id}/block`, {})).body.filesBlocked).toBe(1);
  });
});

describe('evidence', () => {
  it('keeps the bytes of a deleted row while an open claim names them, and purges once it closes', async () => {
    const bytes = png();
    const owner = await account();
    const file = await storedRow(bytes, { ownerUserId: owner });
    const { id } = await claimFor([`https://cloud.oxy.so/${file.id}`]);

    await assetService.deleteFile(file.id, true, owner);
    expect((await fileRow(file.id)).status).toBe('deleted');
    expect(mockObjects.get(file.storageKey)).toEqual(bytes);
    const [owed] = await getDb()
      .select()
      .from(storageObjectDeletions)
      .where(
        and(
          eq(storageObjectDeletions.sha256, file.sha256),
          eq(storageObjectDeletions.kind, 'object'),
        ),
      );
    expect(owed.completedAt).toBeNull();
    expect(owed.lastError).toContain('evidence');
    expect(owed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);

    // The reviewer can still see them.
    await reviewer();
    const detail = (await send('GET', `/content-claims/${id}`)).body;
    expect(detail.targets[0].file.status).toBe('deleted');
    const minted = await send(
      'POST',
      `/content-claims/${id}/targets/${detail.targets[0].id}/preview`,
    );
    const url = new URL(minted.body.url);
    expect((await send('GET', url.pathname + url.search)).raw.equals(bytes)).toBe(true);

    await send('POST', `/content-claims/${id}/reject`, { reason: 'Withdrawn.' });
    const result = await runStorageDeletionBatch({ ownerId: 'test', ids: [owed.id] });
    expect(result.deleted + result.retainedShared).toBe(1);
    expect(mockObjects.has(file.storageKey)).toBe(false);
  });

  it('keeps a blocked file out of "not in use" and the sweep while a claim holds it', async () => {
    const accountBytes = png();
    const appBytes = png();
    const owner = await account();
    const app = await application(false);
    const long = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const accountFile = await storedRow(accountBytes, { ownerUserId: owner });
    const appFile = await storedRow(appBytes, { ownerApplicationId: app });
    await getDb()
      .update(files)
      .set({ unreferencedSince: long })
      .where(inArray(files.id, [accountFile.id, appFile.id]));

    const { id } = await claimFor([
      `https://cloud.oxy.so/${accountFile.id}`,
      `https://cloud.oxy.so/${appFile.id}`,
    ]);
    await reviewer();
    await send('POST', `/content-claims/${id}/review`);
    await send('POST', `/content-claims/${id}/block`, {});
    await send('POST', `/content-claims/${id}/counter-notice`, { note: 'Disputed.' });

    const notInUse = async () =>
      (await listFilesByOwner(owner, 50, 0, { inUse: false })).files.map((row) => row.id);
    expect(await notInUse()).not.toContain(accountFile.id);
    const now = new Date();
    const due = async () =>
      (await listFileLifecycleCandidates('purgeBlocked', now, 1000)).map((row) => row.id);
    expect(await due()).not.toContain(appFile.id);
    expect(await assetService.purgeBlockedApplicationFile(appFile.id, now)).toBe(false);

    // Upheld: closed. The account's file is its person's to delete; the
    // application's unused one is collected.
    expect((await send('POST', `/content-claims/${id}/uphold`, {})).body.state).toBe('upheld');
    expect(await notInUse()).toContain(accountFile.id);
    expect(await due()).toContain(appFile.id);
    expect(await due()).not.toContain(accountFile.id);
    expect(await countFileLifecycleCandidates('purgeBlocked', now)).toBeGreaterThanOrEqual(1);
    expect(await assetService.purgeBlockedApplicationFile(appFile.id, now)).toBe(true);
    expect((await fileRow(appFile.id)).status).toBe('deleted');
    expect((await fileRow(accountFile.id)).status).toBe('blocked');
    // Upheld: the owner is told the content stays down.
    expect((await notifications(id)).filter((row) => row.kind === 'content_upheld')).toEqual([
      { kind: 'content_upheld', recipient: 'account', recipientUserId: owner },
    ]);
  });
});

describe('the queue', () => {
  it('filters by state, kind and deadline, and pages', async () => {
    const kind = 'trademark';
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1)
      made.push((await claimFor(['https://mention.earth/q'], { kind })).id);
    const overdue = await submitContentClaim(
      {
        kind: 'privacy',
        contentUrls: ['https://mention.earth/me'],
        description: 'This post shows my home address, please remove it.',
        claimant: { name: 'Cy', email: 'cy@example.com', relationship: 'affected_person' },
        statements: { goodFaith: true, accurate: true },
        signature: 'Cy',
      },
      {
        submittedByUserId: null,
        apiHosts: [],
        cdnHost: 'cloud.oxy.so',
        now: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
    );
    await reviewer();

    const trademarks = await send('GET', `/content-claims?kind=${kind}&state=received&limit=2`);
    expect(trademarks.status).toBe(200);
    expect(trademarks.body.claims).toHaveLength(2);
    expect(trademarks.body.nextCursor).toEqual(expect.any(String));
    const rest = await send(
      'GET',
      `/content-claims?kind=${kind}&state=received&limit=2&cursor=${trademarks.body.nextCursor}`,
    );
    const seen = [...trademarks.body.claims, ...rest.body.claims].map(
      (row: { id: string }) => row.id,
    );
    for (const claimId of made) expect(seen).toContain(claimId);
    expect(new Set(seen).size).toBe(seen.length);

    const late = await send('GET', '/content-claims?deadline=overdue');
    expect(late.body.claims.map((row: { id: string }) => row.id)).toContain(overdue.id);
    expect(
      late.body.claims.every(
        (row: { deadlineAt: string }) => new Date(row.deadlineAt) < new Date(),
      ),
    ).toBe(true);
    const soon = await send('GET', '/content-claims?deadline=due_soon');
    expect(soon.body.claims.map((row: { id: string }) => row.id)).toContain(overdue.id);

    expect((await send('GET', '/content-claims?state=bogus')).status).toBe(400);
    const [row] = await getDb()
      .select()
      .from(contentClaims)
      .where(eq(contentClaims.id, overdue.id));
    expect(row.deadlineAt).toBeInstanceOf(Date);
    // An erasure request answered is no longer due.
    await send('POST', `/content-claims/${overdue.id}/reject`, { reason: 'Not ours.' });
    const after = await send('GET', '/content-claims?deadline=any');
    expect(after.body.claims.map((r: { id: string }) => r.id)).not.toContain(overdue.id);
  });
});
