/**
 * The owner's counter-notice (ADR 0043 D10, 17 U.S.C. § 512(g)) —
 * `POST /content-claims/counter-notices` over real `node:http` and a REAL
 * Postgres, after a real block (`blockClaimTargets`). Stubbed: the session (a
 * switchable account), the rate limiters, S3 (an in-memory map).
 *
 *  1. Only the OWNER of files a claim blocked may answer it; anyone else — a
 *     stranger with the reference, a file id that is not theirs or not
 *     blocked — gets 404, exactly like no claim.
 *  2. `actioned → counter_noticed` under the claim's lock; a claim another
 *     owner already answered records the notice too; any other state is 409;
 *     a second notice from the same account is 409.
 *  3. The notice is SEALED; the trail names the owner; the outbox holds the
 *     claimant's copy, the owner's confirmation and the staff alert, each
 *     naming the notice; the worker sends the notice itself to the claimant
 *     only for a copyright claim.
 *  4. Files blocked by two claims need the reference (400 ambiguous).
 *  5. The notice is erased on the claimant's clock when the claim closes.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, asc, eq } from 'drizzle-orm';

let mockUser: { _id: string; isStaff: boolean } = { _id: 'nobody', isStaff: false };
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
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { ...mockUser, id: mockUser._id };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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

import { COUNTER_NOTICE_STATEMENT_VERSION } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  contentClaimCounterNotices,
  contentClaimEvents,
  contentClaimNotifications,
  contentClaims,
  files,
  users,
} from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import { assetService } from '../../services/assetServiceSingleton';
import {
  blockClaimTargets,
  getContentClaim,
  startContentClaimReview,
  submitContentClaim,
  upholdContentClaim,
} from '../../services/contentClaims/contentClaim.service';
import { runContentClaimNotificationBatch } from '../../services/contentClaims/contentClaimNotification.worker';
import fileCache from '../../utils/fileCache';
import contentClaimsRouter from '../contentClaims';

jest.setTimeout(120_000);

let server: http.Server;

interface Answer {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
  body: any;
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
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
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

const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(48)]);

/** An account's stored file of `bytes`. */
async function storedRow(bytes: Buffer, ownerUserId: string, originalName = 'garden.png') {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const storageKey = `content/2026/10/${sha.slice(0, 2)}/${sha}-${randomBytes(3).toString('hex')}.png`;
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: bytes.length,
      mime: 'image/png',
      ext: 'png',
      ownerUserId,
      visibility: 'private',
      status: 'active',
      storageKey,
      originalName,
      metadata: {},
    })
    .returning();
  mockObjects.set(storageKey, bytes);
  return row;
}

/** A claim naming `fileIds`, reviewed and blocked by a reviewer: `actioned`. */
async function blockedClaim(
  fileIds: string[],
  kind: 'copyright' | 'trademark' = 'copyright',
): Promise<{ id: string; reference: string; reviewer: string }> {
  const claim = await submitContentClaim(
    {
      kind,
      contentUrls: fileIds.map((id) => `https://cloud.oxy.so/${id}`),
      description: 'This photo is mine and was posted without my permission.',
      claimant: {
        name: 'Ada Claimant',
        email: `ada-${randomBytes(4).toString('hex')}@example.com`,
        relationship: 'rights_holder',
      },
      statements: { goodFaith: true, accurate: true },
      signature: 'Ada Claimant',
    },
    { submittedByUserId: null, apiHosts: ['api.oxy.so'], cdnHost: 'cloud.oxy.so' },
  );
  const reviewer = await account({ isStaff: true, staffCapabilities: ['content:claims'] });
  await startContentClaimReview(claim.id, { actorUserId: reviewer });
  await blockClaimTargets(claim.id, { actorUserId: reviewer });
  return { ...claim, reviewer };
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
    explanation: 'I took this photo myself; it is not the claimant’s work.',
    statements: { perjury: true, jurisdiction: true, serviceOfProcess: true, disclosure: true },
    signature: 'Grace Owner',
    ...overrides,
  };
}

async function claimState(id: string) {
  const [row] = await getDb()
    .select({ state: contentClaims.state })
    .from(contentClaims)
    .where(eq(contentClaims.id, id));
  return row.state;
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

beforeEach(() => fileCache.clear());

describe('POST /content-claims/counter-notices', () => {
  it('refuses an invalid notice with a sentence per field', async () => {
    mockUser = { _id: await account(), isStaff: false };
    const answer = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({
        statements: {
          perjury: true,
          jurisdiction: false,
          serviceOfProcess: true,
          disclosure: true,
        },
      }),
    );
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({
      error: 'Some details of your counter-notice need attention.',
      code: 'CONTENT_CLAIM_COUNTER_NOTICE_INVALID',
      fields: {
        'statements.jurisdiction': 'Confirm your consent to jurisdiction.',
      },
    });
  });

  it('needs the claim named by reference, id or files', async () => {
    mockUser = { _id: await account(), isStaff: false };
    const answer = await send('POST', '/content-claims/counter-notices', notice());
    expect(answer.status).toBe(400);
    expect(answer.body.fields).toEqual({
      reference: 'Give the reference from the email you received, or the files that were removed.',
    });
  });

  it('answers a stranger exactly like no claim, by reference and by file id', async () => {
    const owner = await account();
    const file = await storedRow(png(), owner);
    const claim = await blockedClaim([file.id]);

    mockUser = { _id: await account(), isStaff: false };
    const byReference = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ reference: claim.reference }),
    );
    const byFile = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ fileIds: [file.id] }),
    );
    const noClaim = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ reference: 'OXY-0000-0000' }),
    );
    for (const answer of [byReference, byFile, noClaim]) {
      expect(answer.status).toBe(404);
      expect(answer.body.message ?? answer.body.error).toBe(
        noClaim.body.message ?? noClaim.body.error,
      );
    }
    // The owner naming a file of theirs that is NOT blocked is no different.
    mockUser = { _id: owner, isStaff: false };
    const other = await storedRow(png(), owner);
    expect(
      (
        await send(
          'POST',
          '/content-claims/counter-notices',
          notice({ reference: claim.reference, fileIds: [other.id] }),
        )
      ).status,
    ).toBe(404);
    expect(await claimState(claim.id)).toBe('actioned');
    const stored = await getDb()
      .select()
      .from(contentClaimCounterNotices)
      .where(eq(contentClaimCounterNotices.claimId, claim.id));
    expect(stored).toEqual([]);
  });

  it('records the owner’s notice: sealed, on the trail, three emails, the claim disputed', async () => {
    const owner = await account();
    const file = await storedRow(png(), owner);
    const claim = await blockedClaim([file.id]);

    mockUser = { _id: owner, isStaff: false };
    const answer = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ reference: claim.reference.toLowerCase() }),
    );
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({
      id: expect.any(String),
      reference: claim.reference,
      state: 'counter_noticed',
      fileIds: [file.id],
    });
    expect(await claimState(claim.id)).toBe('counter_noticed');

    const [row] = await getDb()
      .select()
      .from(contentClaimCounterNotices)
      .where(eq(contentClaimCounterNotices.id, answer.body.id));
    expect(row).toMatchObject({
      claimId: claim.id,
      submittedByUserId: owner,
      fileIds: [file.id],
      statementVersion: COUNTER_NOTICE_STATEMENT_VERSION,
      expiresAt: null,
    });
    // Sealed: nothing the owner wrote is in the row in clear.
    const serialized = JSON.stringify(row);
    for (const clear of ['Grace Owner', 'Harbor Way', '555 010', 'grace@example.com', 'garden']) {
      expect(serialized).not.toContain(clear);
    }

    const [event] = await getDb()
      .select()
      .from(contentClaimEvents)
      .where(
        and(
          eq(contentClaimEvents.claimId, claim.id),
          eq(contentClaimEvents.action, 'counter_notice_submitted'),
        ),
      );
    expect(event).toMatchObject({
      actorUserId: owner,
      fromState: 'actioned',
      toState: 'counter_noticed',
      details: { counterNoticeId: answer.body.id, files: 1 },
    });

    const queued = await getDb()
      .select({
        kind: contentClaimNotifications.kind,
        recipient: contentClaimNotifications.recipient,
        recipientUserId: contentClaimNotifications.recipientUserId,
        counterNoticeId: contentClaimNotifications.counterNoticeId,
      })
      .from(contentClaimNotifications)
      .where(eq(contentClaimNotifications.claimId, claim.id))
      .orderBy(asc(contentClaimNotifications.createdAt), asc(contentClaimNotifications.id));
    expect(
      queued
        .filter((item) => item.counterNoticeId !== null)
        .sort((x, y) => x.kind.localeCompare(y.kind)),
    ).toEqual([
      {
        kind: 'claim_counter_notice_copy',
        recipient: 'claimant',
        recipientUserId: null,
        counterNoticeId: answer.body.id,
      },
      {
        kind: 'counter_notice_received',
        recipient: 'account',
        recipientUserId: owner,
        counterNoticeId: answer.body.id,
      },
      {
        kind: 'counter_notice_staff',
        recipient: 'staff',
        recipientUserId: null,
        counterNoticeId: answer.body.id,
      },
    ]);

    // Staff read it opened on the claim.
    const detail = await getContentClaim(claim.id);
    expect(detail.counterNotices).toEqual([
      expect.objectContaining({
        id: answer.body.id,
        submittedByUserId: owner,
        fileIds: [file.id],
        statement: expect.objectContaining({
          name: 'Grace Owner',
          phone: '+1 555 010 2030',
          signature: 'Grace Owner',
        }),
      }),
    ]);

    // One per account per claim.
    const again = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ reference: claim.reference }),
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('CONTENT_CLAIM_COUNTER_NOTICE_EXISTS');
  });

  it('records a second owner’s notice on a disputed claim, and refuses a closed one (409)', async () => {
    const bytes = png();
    const first = await account();
    const second = await account();
    const third = await account();
    const a = await storedRow(bytes, first);
    const b = await storedRow(bytes, second);
    await storedRow(bytes, third);
    const claim = await blockedClaim([a.id]);

    mockUser = { _id: first, isStaff: false };
    expect(
      (await send('POST', '/content-claims/counter-notices', notice({ fileIds: [a.id] }))).status,
    ).toBe(201);
    mockUser = { _id: second, isStaff: false };
    const secondAnswer = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ fileIds: [b.id] }),
    );
    expect(secondAnswer.status).toBe(201);
    expect(await claimState(claim.id)).toBe('counter_noticed');

    await upholdContentClaim(claim.id, { actorUserId: claim.reviewer });
    mockUser = { _id: third, isStaff: false };
    const late = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ reference: claim.reference }),
    );
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('CONTENT_CLAIM_STATE_CONFLICT');

    // Closing put both notices on the claimant's retention clock.
    const notices = await getDb()
      .select({ expiresAt: contentClaimCounterNotices.expiresAt })
      .from(contentClaimCounterNotices)
      .where(eq(contentClaimCounterNotices.claimId, claim.id));
    expect(notices).toHaveLength(2);
    for (const item of notices) expect(item.expiresAt).toBeInstanceOf(Date);
  });

  it('needs the reference when two claims removed the same files', async () => {
    const owner = await account();
    const file = await storedRow(png(), owner);
    const first = await blockedClaim([file.id]);
    // A second claim naming the same (now blocked) file blocks the same bytes.
    const second = await blockedClaim([file.id]);

    mockUser = { _id: owner, isStaff: false };
    const ambiguous = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ fileIds: [file.id] }),
    );
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toBe('CONTENT_CLAIM_COUNTER_NOTICE_AMBIGUOUS');
    const named = await send(
      'POST',
      '/content-claims/counter-notices',
      notice({ reference: second.reference, fileIds: [file.id] }),
    );
    expect(named.status).toBe(201);
    expect(await claimState(second.id)).toBe('counter_noticed');
    expect(await claimState(first.id)).toBe('actioned');
  });
});

describe('the counter-notice emails', () => {
  async function sendAll() {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    for (let i = 0; i < 20; i += 1) {
      const result = await runContentClaimNotificationBatch({
        ownerId: `test-${randomBytes(3).toString('hex')}`,
        batchSize: 200,
        send: async (message) => {
          sent.push(message);
        },
      });
      if (result.claimed === 0) break;
    }
    return sent;
  }

  it('sends the claimant the notice itself for a copyright claim, the owner a confirmation, staff an alert', async () => {
    await sendAll();
    const owner = await account();
    const file = await storedRow(png(), owner, 'my-garden.png');
    const claim = await blockedClaim([file.id], 'copyright');
    await sendAll();

    mockUser = { _id: owner, isStaff: false };
    expect(
      (
        await send(
          'POST',
          '/content-claims/counter-notices',
          notice({ reference: claim.reference }),
        )
      ).status,
    ).toBe(201);
    const sent = (await sendAll()).filter((mail) => mail.text.includes(claim.reference));

    const copy = sent.find((mail) => mail.subject.startsWith('Counter-notice to your report'));
    expect(copy?.to).toMatch(/^ada-/);
    expect(copy?.text).toContain('Name: Grace Owner');
    expect(copy?.text).toContain('Telephone: +1 555 010 2030');
    expect(copy?.text).toContain('penalty of perjury');
    expect(copy?.text).toContain('10 and no more than 14 business days');

    const confirmation = sent.find((mail) =>
      mail.subject.startsWith('We received your counter-notice'),
    );
    expect(confirmation?.to).toMatch(/@example\.com$/);
    expect(confirmation?.text).toContain('my-garden.png');
    expect(confirmation?.text).not.toContain('Ada Claimant');

    const staff = sent.find((mail) => mail.subject.startsWith('Counter-notice received'));
    expect(staff?.to).toBe('legal@oxy.so');
    expect(staff?.text).toContain('covering 1 file');
    expect(staff?.text).not.toContain('Grace Owner');
  });

  it('never names the owner to the claimant of any other kind of claim', async () => {
    await sendAll();
    const owner = await account();
    const file = await storedRow(png(), owner);
    const claim = await blockedClaim([file.id], 'trademark');
    await sendAll();

    mockUser = { _id: owner, isStaff: false };
    expect(
      (
        await send(
          'POST',
          '/content-claims/counter-notices',
          notice({ reference: claim.reference }),
        )
      ).status,
    ).toBe(201);
    const copy = (await sendAll()).find((mail) =>
      mail.subject.startsWith(`A response to your report ${claim.reference}`),
    );
    expect(copy?.text).toContain('disputes your report');
    expect(copy?.text).not.toContain('Grace Owner');
    expect(copy?.text).not.toContain('grace@example.com');
  });
});
