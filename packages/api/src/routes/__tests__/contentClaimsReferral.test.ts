/**
 * A service's referral to the claim review (ADR 0043 D14), over real
 * `node:http`, the REAL AssetService and a REAL Postgres. Stubbed: the session
 * and the service workload (switchable), the rate limiters and S3.
 *
 *  1. Only an Oxy service's workload refers; a customer key is refused.
 *  2. A referral is a claim with a reason and NO claimant: no statement row, no
 *     email to one, and the staff are told.
 *  3. The same referral again is the same claim; once it closes, the content
 *     can be referred anew.
 *  4. For `child_safety`, blocking writes to no owner, and an owner's
 *     counter-notice is answered exactly like no claim.
 *  5. Staff can still record a dispute and reinstate.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { asc, eq } from 'drizzle-orm';

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
  contentClaimTargets,
  contentClaims,
  files,
  users,
} from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import { assetService } from '../../services/assetServiceSingleton';
import { renderContentClaimMail } from '../../services/contentClaims/contentClaim.mail';
import { sealFileWebhookSecret } from '../../services/fileEvents.service';
import fileCache from '../../utils/fileCache';
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

function notice(overrides: Record<string, unknown> = {}) {
  return {
    subscriber: {
      name: 'Grace Owner',
      address: '1 Harbor Way, Arlington, VA 22201, USA',
      phone: '+1 555 010 2030',
      email: 'grace@example.com',
    },
    material: {
      description: 'A photo of my own garden that I took.',
      location: 'https://mention.earth/@grace/posts/1',
    },
    explanation: 'I took this photo myself; it is not what the claim says.',
    statements: { perjury: true, jurisdiction: true, serviceOfProcess: true, disclosure: true },
    signature: 'Grace Owner',
    ...overrides,
  };
}

/** Speak as an Oxy service's workload (or as a customer key, or as nobody). */
function asService(appId: string | null, authority: 'first_party' | 'external' = 'first_party') {
  mockServiceApp.current = appId ? { appId, authority } : null;
}

async function claimRow(id: string) {
  const [row] = await getDb().select().from(contentClaims).where(eq(contentClaims.id, id));
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

async function fileRow(id: string) {
  const [row] = await getDb().select().from(files).where(eq(files.id, id));
  return row;
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  process.env.ASSET_CDN_URL = 'https://cloud.oxy.so';
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/content-claims', contentClaimsRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  await assetService.settleStoragePurges();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  fileCache.clear();
  asService(null);
});

describe('POST /content-claims/referrals', () => {
  it('is an Oxy service’s: a customer key and no workload at all are refused', async () => {
    const file = await storedRow(png(), { ownerUserId: await account() });
    const referral = { reason: 'child_safety', fileIds: [file.id] };

    asService(null);
    expect((await send('POST', '/content-claims/referrals', referral)).status).toBe(403);

    asService(await application(false), 'external');
    expect((await send('POST', '/content-claims/referrals', referral)).status).toBe(403);

    const none = await getDb()
      .select({ id: contentClaimTargets.id })
      .from(contentClaimTargets)
      .where(eq(contentClaimTargets.fileId, file.id));
    expect(none).toEqual([]);
  });

  it('refuses a referral that names nothing, an unknown reason, a stray key or a file Oxy does not hold', async () => {
    asService(await application(false));
    const file = await storedRow(png(), { ownerUserId: await account() });

    expect(
      (await send('POST', '/content-claims/referrals', { reason: 'child_safety' })).status,
    ).toBe(400);
    expect(
      (await send('POST', '/content-claims/referrals', { reason: 'spam', fileIds: [file.id] }))
        .status,
    ).toBe(400);
    expect(
      (
        await send('POST', '/content-claims/referrals', {
          reason: 'child_safety',
          fileIds: [file.id],
          reporter: 'someone',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send('POST', '/content-claims/referrals', {
          reason: 'child_safety',
          pageUrls: ['http://mention.earth/p/1'],
        })
      ).status,
    ).toBe(400);

    const unknown = await send('POST', '/content-claims/referrals', {
      reason: 'child_safety',
      fileIds: [file.id, 'no-such-file'],
    });
    expect(unknown.status).toBe(400);
    // The refusal names the code and exactly the ids Oxy does not hold.
    const refusal = JSON.stringify(unknown.body);
    expect(refusal).toContain('CONTENT_REFERRAL_UNKNOWN_FILES');
    expect(refusal).toContain('no-such-file');
    expect(refusal).not.toContain(file.id);
  });

  it('opens a claim with a reason and no claimant, names its targets and tells the staff', async () => {
    const app = await application(false);
    asService(app);
    const file = await storedRow(png(), { ownerUserId: await account() });

    const answer = await send('POST', '/content-claims/referrals', {
      reason: 'child_safety',
      fileIds: [file.id],
      pageUrls: ['https://mention.earth/p/abc'],
    });
    expect(answer.status).toBe(200);
    expect(answer.body.reference).toMatch(/^OXY-/);

    const claim = await claimRow(answer.body.id);
    expect(claim).toMatchObject({
      kind: 'illegal_content',
      state: 'received',
      relationship: null,
      referralReason: 'child_safety',
      referredByApplicationId: app,
      submittedByUserId: null,
      deadlineAt: null,
    });

    const claimants = await getDb()
      .select({ claimId: contentClaimClaimants.claimId })
      .from(contentClaimClaimants)
      .where(eq(contentClaimClaimants.claimId, claim.id));
    expect(claimants).toEqual([]);

    const targets = await getDb()
      .select({
        source: contentClaimTargets.source,
        resolution: contentClaimTargets.resolution,
        fileId: contentClaimTargets.fileId,
        sha256: contentClaimTargets.sha256,
        url: contentClaimTargets.url,
      })
      .from(contentClaimTargets)
      .where(eq(contentClaimTargets.claimId, claim.id))
      .orderBy(asc(contentClaimTargets.resolution));
    expect(targets).toEqual([
      { source: 'service', resolution: 'file', fileId: file.id, sha256: file.sha256, url: null },
      {
        source: 'service',
        resolution: 'unresolved',
        fileId: null,
        sha256: null,
        url: 'https://mention.earth/p/abc',
      },
    ]);

    const [event] = await getDb()
      .select()
      .from(contentClaimEvents)
      .where(eq(contentClaimEvents.claimId, claim.id));
    expect(event).toMatchObject({
      action: 'referred',
      actorUserId: null,
      toState: 'received',
      details: { reason: 'child_safety', applicationId: app, files: 1, pages: 1 },
    });

    // Only the staff are written to; nothing is blocked until a person acts.
    expect(await notifications(claim.id)).toEqual([
      { kind: 'referral_staff', recipient: 'staff', recipientUserId: null },
    ]);
    expect((await fileRow(file.id)).status).toBe('active');
  });

  it('answers the same referral with the same claim, and a different one with another', async () => {
    const app = await application(false);
    asService(app);
    const first = await storedRow(png(), { ownerUserId: await account() });
    const second = await storedRow(png(), { ownerUserId: await account() });

    const a = await send('POST', '/content-claims/referrals', {
      reason: 'child_safety',
      fileIds: [first.id, second.id],
    });
    // The same targets in another order, with a repeat: still the same referral.
    const again = await send('POST', '/content-claims/referrals', {
      reason: 'child_safety',
      fileIds: [second.id, first.id, first.id],
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(a.body);

    const other = await send('POST', '/content-claims/referrals', {
      reason: 'child_safety',
      fileIds: [first.id],
    });
    expect(other.body.id).not.toBe(a.body.id);

    // Another service referring the same files opens its own.
    asService(await application(false));
    const elsewhere = await send('POST', '/content-claims/referrals', {
      reason: 'child_safety',
      fileIds: [first.id, second.id],
    });
    expect(elsewhere.body.id).not.toBe(a.body.id);
  });

  it('can be referred again once the earlier referral closed', async () => {
    asService(await application(false));
    const file = await storedRow(png(), { ownerUserId: await account() });
    const referral = { reason: 'child_safety', fileIds: [file.id] };
    const first = await send('POST', '/content-claims/referrals', referral);

    await reviewer();
    const rejected = await send('POST', `/content-claims/${first.body.id}/reject`, {
      reason: 'Reviewed: an ordinary family photo.',
    });
    expect(rejected.status).toBeLessThan(300);

    const second = await send('POST', '/content-claims/referrals', referral);
    expect(second.status).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
    // A rejection of a referral writes to nobody: there is no claimant.
    expect(await notifications(first.body.id)).toEqual([
      { kind: 'referral_staff', recipient: 'staff', recipientUserId: null },
    ]);
  });
});

describe('reviewing a child-safety referral', () => {
  async function referred() {
    const app = await application(false);
    asService(app);
    const owner = await account();
    const file = await storedRow(png(), { ownerUserId: owner }, { visibility: 'public' });
    const answer = await send('POST', '/content-claims/referrals', {
      reason: 'child_safety',
      fileIds: [file.id],
    });
    return {
      claimId: answer.body.id as string,
      reference: answer.body.reference as string,
      file,
      owner,
    };
  }

  it('shows in the queue as a referral, filterable by reason, with no claimant in its detail', async () => {
    const { claimId } = await referred();
    await reviewer();

    const queue = await send('GET', '/content-claims?referral=child_safety&limit=100');
    expect(queue.status).toBe(200);
    const row = queue.body.claims.find((claim: { id: string }) => claim.id === claimId);
    expect(row).toMatchObject({
      kind: 'illegal_content',
      relationship: null,
      referral: { reason: 'child_safety' },
      state: 'received',
    });
    expect(queue.body.claims.every((claim: { referral: unknown }) => claim.referral !== null)).toBe(
      true,
    );

    const detail = await send('GET', `/content-claims/${claimId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.claimant).toBeNull();
    expect(detail.body.referral.reason).toBe('child_safety');
    expect(detail.body.targets).toHaveLength(1);
  });

  it('blocks the bytes for everyone and writes to no owner and no claimant', async () => {
    const { claimId, file } = await referred();
    await reviewer();
    expect((await send('POST', `/content-claims/${claimId}/review`)).status).toBeLessThan(300);
    const blocked = await send('POST', `/content-claims/${claimId}/block`, {});
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ filesBlocked: 1, hashesBlocked: 1, ownersNotified: 0 });

    expect((await fileRow(file.id)).status).toBe('blocked');
    const listed = await getDb()
      .select({ sha256: blockedContentHashes.sha256 })
      .from(blockedContentHashes)
      .where(eq(blockedContentHashes.claimId, claimId));
    expect(listed).toEqual([{ sha256: file.sha256 }]);
    expect((await claimRow(claimId)).state).toBe('actioned');

    expect(await notifications(claimId)).toEqual([
      { kind: 'referral_staff', recipient: 'staff', recipientUserId: null },
    ]);
  });

  it('answers the owner’s counter-notice exactly like no claim, by reference and by file', async () => {
    const { claimId, reference, file, owner } = await referred();
    await reviewer();
    await send('POST', `/content-claims/${claimId}/review`);
    await send('POST', `/content-claims/${claimId}/block`, {});

    mockUser = { _id: owner, isStaff: false };
    const byReference = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ reference }),
    );
    const byFile = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ fileIds: [file.id] }),
    );
    expect(byReference.status).toBe(404);
    expect(byFile.status).toBe(404);
    expect(byFile.body).toEqual(byReference.body);
    expect((await claimRow(claimId)).state).toBe('actioned');
  });

  it('can still be reversed by staff, who record the dispute and reinstate', async () => {
    const { claimId, file } = await referred();
    await reviewer();
    await send('POST', `/content-claims/${claimId}/review`);
    await send('POST', `/content-claims/${claimId}/block`, {});

    const disputed = await send('POST', `/content-claims/${claimId}/counter-notice`, {
      note: 'Reviewed again with the owner: a medical textbook illustration.',
    });
    expect(disputed.status).toBeLessThan(300);
    const reinstated = await send('POST', `/content-claims/${claimId}/reinstate`, {});
    expect(reinstated.status).toBe(200);
    expect(reinstated.body).toMatchObject({ filesRestored: 1 });

    expect((await fileRow(file.id)).status).toBe('active');
    expect((await claimRow(claimId)).state).toBe('reinstated');
    // Still nobody but the staff was written to.
    expect(await notifications(claimId)).toEqual([
      { kind: 'referral_staff', recipient: 'staff', recipientUserId: null },
    ]);
  });
});

describe('the staff email about a referral', () => {
  it('counts what was referred and names none of it', () => {
    const mail = renderContentClaimMail('referral_staff', {
      reference: 'OXY-7K3M-9Q2D',
      claimKind: 'illegal_content',
      greetingName: null,
      note: null,
      fileNames: [],
      targetCount: 3,
      fileCount: 2,
    });
    expect(mail.subject).toBe('Content referred for review: OXY-7K3M-9Q2D');
    expect(mail.text).toContain('2 files, 3 targets in all');
    expect(mail.text).toContain('Nothing is blocked until a person acts on it.');
  });
});

describe('the schema’s own rule for a referral', () => {
  it('refuses a claim that is both a claimant’s and a referral, and one that is neither', async () => {
    const insert = (values: Partial<typeof contentClaims.$inferInsert>) =>
      getDb()
        .insert(contentClaims)
        .values({
          reference: `OXY-${randomBytes(2).toString('hex').toUpperCase()}-TEST`,
          kind: 'illegal_content',
          ...values,
        } as typeof contentClaims.$inferInsert);

    await expect(
      insert({ relationship: 'other', referralReason: 'child_safety', referralKey: 'k1' }),
    ).rejects.toThrow();
    await expect(insert({ relationship: null })).rejects.toThrow();
    await expect(
      insert({ relationship: null, referralReason: 'child_safety', referralKey: null }),
    ).rejects.toThrow();
    await expect(
      insert({
        kind: 'copyright',
        relationship: null,
        referralReason: 'child_safety',
        referralKey: `k-${randomBytes(4).toString('hex')}`,
      }),
    ).rejects.toThrow();
  });
});
