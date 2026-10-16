/**
 * `DELETE /users/me` deletes the account's stored uploads (OxyHQ/Mention#1178),
 * on both outcomes — the hard delete and the archive kept for financial records
 * — through the real router and a REAL Postgres.
 *
 * Stubbed as in `usersDeleteAccountEvent.test.ts`: the session/signature proof
 * and the destructive side systems that have their own tests. The financial-
 * holds answer is switchable, so one test takes the archive path. What is under
 * test is that the deletion's own transaction records the storage owed a delete
 * and removes the asset rows, and that a refused deletion records none.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

let currentUserId: string | undefined;
let currentServiceAppId: string | undefined;
let signatureValid = true;
let forceArchive = false;
let afterHoldsRead: (() => Promise<void>) | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    if (currentUserId) req.user = { id: currentUserId };
    next();
  },
  serviceAuthMiddleware: (
    req: { serviceApp?: { appId: string } },
    _res: unknown,
    next: () => void,
  ) => {
    if (currentServiceAppId) req.serviceApp = { appId: currentServiceAppId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {
    verifySignature: () => signatureValid,
    isTimestampFresh: () => true,
  },
}));
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { deactivateAllUserSessions: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: { purgeAccountFromAllDevices: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/user.service', () => ({
  userService: { purgeUserSocialGraph: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
  isOwnFederationDomain: jest.fn(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../utils/graphCache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));
jest.mock('../../services/accountFinancialHolds.service', () => {
  const actual = jest.requireActual('../../services/accountFinancialHolds.service');
  return {
    ...actual,
    describeAccountFinancialHolds: async (accountId: string) => {
      const holds = await actual.describeAccountFinancialHolds(accountId);
      const hook = afterHoldsRead;
      afterHoldsRead = undefined;
      if (hook) await hook();
      return forceArchive ? { ...holds, blocksHardDelete: true } : holds;
    },
  };
});
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { generateKeyPairSync } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { fileVariants } from '../../db/schema/fileVariants';
import { storageObjectDeletions } from '../../db/schema/storageObjectDeletions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import usersRouter from '../users';
import {
  personalPlanCheckoutIntents,
  accountClosureFences,
  applications,
  fileEventDeliveries,
} from '../../db/schema';
import { addFileReferences } from '../../services/fileRepository';
import { sealFileWebhookSecret } from '../../services/fileEvents.service';
import { productAccessFixture } from '../../services/__fixtures__/productAccessFixtures';
import {
  startPersonalPlanCheckout,
  closePersonalPlanCheckoutFromProvider,
  type PersonalCheckoutProvider,
} from '../../services/personalPlanCheckout.service';
import {
  EMPTY_PRODUCT_BILLING_CATALOGUE,
  productBillingCatalogueSchema,
} from '../../services/productBillingCatalogue.service';
import {
  beginAccountClosure,
  archiveAccountForRetention,
  describeAccountFinancialHolds,
} from '../../services/accountFinancialHolds.service';

jest.setTimeout(60_000);

const signingKey = generateKeyPairSync('ed25519');
const savedEnv = { ...process.env };
let server: http.Server;

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  process.env.SERVICE_TOKEN_SIGNING_KEY_ID = 'users-delete-storage-test';
  process.env.SERVICE_TOKEN_PRIVATE_KEY = signingKey.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  delete process.env.SERVICE_TOKEN_PUBLIC_JWKS;
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

async function callDelete(
  body: unknown,
): Promise<{ status: number; body: { data?: { retained?: boolean } } }> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/users/me',
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function seedPersonWithUploads() {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await getDb()
    .insert(users)
    .values({
      username: `uploader-${suffix}`,
      email: `uploader-${suffix}@example.test`,
      publicKey: `02${randomBytes(32).toString('hex')}`,
    })
    .returning({ id: users.id, username: users.username });
  if (!person) throw new Error('Missing fixture person');
  const sha256 = randomBytes(32).toString('hex');
  const storageKey = `public/content/2026/09/${sha256.slice(0, 2)}/${sha256}.jpg`;
  const [photo] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'image/jpeg',
      ext: 'jpg',
      ownerUserId: person.id,
      storageKey,
      visibility: 'public',
    })
    .returning({ id: files.id });
  if (!photo) throw new Error('Missing fixture photo');
  await getDb()
    .insert(fileVariants)
    .values({
      fileId: photo.id,
      type: 'thumb',
      key: `public/variants/2026/09/${sha256.slice(0, 2)}/${sha256}/thumb.webp`,
    });
  return { person, photoId: photo.id, sha256 };
}

function deleteBody(username: string) {
  return { signature: 'ab'.repeat(64), timestamp: Date.now(), confirmText: username };
}

async function owed(accountId: string) {
  return (
    await getDb()
      .select({ kind: storageObjectDeletions.kind, target: storageObjectDeletions.target })
      .from(storageObjectDeletions)
      .where(eq(storageObjectDeletions.accountId, accountId))
  )
    .map((row) => `${row.kind}:${row.target}`)
    .sort();
}

describe("DELETE /users/me deletes the account's stored uploads", () => {
  beforeEach(() => {
    signatureValid = true;
    forceArchive = false;
  });

  it('hard delete: the rows cascade and their storage is recorded for deletion in the same commit', async () => {
    const { person, photoId, sha256 } = await seedPersonWithUploads();
    currentUserId = person.id;

    const response = await callDelete(deleteBody(person.username ?? ''));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ retained: false });

    expect(
      await getDb().select({ id: files.id }).from(files).where(eq(files.id, photoId)),
    ).toHaveLength(0);
    expect(await owed(person.id)).toEqual([
      `object:content/2026/09/${sha256.slice(0, 2)}/${sha256}.jpg`,
      `prefix:variants/2026/09/${sha256.slice(0, 2)}/${sha256}/`,
    ]);
  });

  it('archive for retention: the asset rows are removed and their storage recorded, though the account row stays', async () => {
    const { person, photoId, sha256 } = await seedPersonWithUploads();
    currentUserId = person.id;
    forceArchive = true;

    const response = await callDelete(deleteBody(person.username ?? ''));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ retained: true });

    const [account] = await getDb()
      .select({ status: users.accountStatus })
      .from(users)
      .where(eq(users.id, person.id));
    expect(account).toMatchObject({ status: 'archived' });
    expect(
      await getDb().select({ id: files.id }).from(files).where(eq(files.id, photoId)),
    ).toHaveLength(0);
    expect(await owed(person.id)).toEqual([
      `object:content/2026/09/${sha256.slice(0, 2)}/${sha256}.jpg`,
      `prefix:variants/2026/09/${sha256.slice(0, 2)}/${sha256}/`,
    ]);
  });

  it('records nothing and keeps the uploads when the deletion is refused', async () => {
    const { person, photoId } = await seedPersonWithUploads();
    currentUserId = person.id;
    signatureValid = false;

    const response = await callDelete(deleteBody(person.username ?? ''));
    expect(response.status).toBe(401);
    expect(
      await getDb().select({ id: files.id }).from(files).where(eq(files.id, photoId)),
    ).toHaveLength(1);
    expect(await owed(person.id)).toEqual([]);
  });
});

/** An application using the person's photo, with or without a verified file-events endpoint. */
async function usingApplication(photoId: string, entityId: string, withWebhook: boolean) {
  const suffix = randomUUID().slice(0, 8);
  const [developer] = await getDb()
    .insert(users)
    .values({ username: `dev-${suffix}` })
    .returning({ id: users.id });
  const id = randomBytes(12).toString('hex');
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `Reader ${suffix}`,
      type: 'third_party',
      ownerAccountId: developer.id,
      createdByUserId: developer.id,
      ...(withWebhook
        ? {
            filesWebhookUrl: 'https://receiver.example/files',
            filesWebhookSecretCiphertext: sealFileWebhookSecret(id, 'whsec_test'),
            filesWebhookVerifiedAt: new Date(),
          }
        : {}),
    });
  await addFileReferences([{ fileId: photoId, applicationId: id, entityType: 'post', entityId }]);
  return id;
}

async function fileDeletedDeliveries(photoId: string) {
  return getDb()
    .select({
      applicationId: fileEventDeliveries.applicationId,
      type: fileEventDeliveries.type,
      payload: fileEventDeliveries.payload,
    })
    .from(fileEventDeliveries)
    .where(eq(fileEventDeliveries.fileId, photoId));
}

describe('DELETE /users/me tells the applications using its files (ADR 0042 D9, stage 4b)', () => {
  beforeEach(() => {
    signatureValid = true;
    forceArchive = false;
  });

  for (const archive of [false, true]) {
    it(`${archive ? 'archive' : 'hard delete'}: one file.deleted per subscribed application, none without an endpoint`, async () => {
      const { person, photoId } = await seedPersonWithUploads();
      const subscribed = await usingApplication(photoId, 'post-1', true);
      await usingApplication(photoId, 'post-2', false);
      currentUserId = person.id;
      forceArchive = archive;

      const response = await callDelete(deleteBody(person.username ?? ''));
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ retained: archive });

      const deliveries = await fileDeletedDeliveries(photoId);
      expect(deliveries).toEqual([
        {
          applicationId: subscribed,
          type: 'file.deleted',
          payload: expect.objectContaining({
            type: 'file.deleted',
            file: { id: photoId, ownerKind: 'account', visibility: 'public', status: 'deleted' },
            references: [{ entityType: 'post', entityId: 'post-1' }],
          }),
        },
      ]);
    });
  }

  it('a refused deletion tells nobody', async () => {
    const { person, photoId } = await seedPersonWithUploads();
    await usingApplication(photoId, 'post-1', true);
    currentUserId = person.id;
    signatureValid = false;

    expect((await callDelete(deleteBody(person.username ?? ''))).status).toBe(401);
    expect(await fileDeletedDeliveries(photoId)).toEqual([]);
  });
});

async function checkoutFixture(
  subjectAccountId: string,
  create: PersonalCheckoutProvider['create'],
) {
  const f = await productAccessFixture();
  const catalogue = productBillingCatalogueSchema.parse({
    ...EMPTY_PRODUCT_BILLING_CATALOGUE,
    products: f.products,
    offers: f.offers,
    personalPlans: [
      {
        offerId: f.offers[0].id,
        offerVersion: 1,
        displayName: 'Fixture',
        kind: 'oxy_one',
        audience: 'personal',
        benefitNames: ['First', 'Second'],
      },
    ],
    prices: [
      {
        priceId: 'price_closure_fixture',
        provider: 'peable',
        providerAccountId: 'merch_closure_fixture',
        mode: 'live',
        environment: 'production',
        offerId: f.offers[0].id,
        offerVersion: 1,
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: null,
        currency: 'usd',
        amountMinorUnits: 2999,
        offerKind: 'bundle',
        kind: 'oxy_one',
      },
    ],
  });
  return {
    start: () =>
      startPersonalPlanCheckout(
        subjectAccountId,
        {
          expectedSubjectAccountId: subjectAccountId,
          offerId: f.offers[0].id,
          offerVersion: 1,
          idempotencyKey: randomUUID(),
        },
        { catalogue, provider: { kind: 'synthetic', create } },
      ),
  };
}

it('HTTP closure refuses a live pending session and preserves checkout correlation and optional data', async () => {
  const { person, photoId } = await seedPersonWithUploads();
  currentUserId = person.id;
  signatureValid = true;
  forceArchive = false;
  const fixture = await checkoutFixture(person.id, async () => ({
    sessionId: 'cs_closure',
    checkoutUrl: 'https://checkout.invalid/closure',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }));
  const checkout = await fixture.start();
  if (checkout.state !== 'pending') throw new Error('Expected pending checkout');
  const response = await callDelete(deleteBody(person.username ?? ''));
  expect(response.status).toBe(409);
  const holds = await describeAccountFinancialHolds(person.id);
  expect(holds.pendingCheckoutIntentIds).toEqual([checkout.intentId]);
  await expect(archiveAccountForRetention(person.id)).rejects.toMatchObject({ statusCode: 409 });
  await expect(getDb().delete(users).where(eq(users.id, person.id))).rejects.toThrow();
  expect(
    await getDb()
      .select()
      .from(personalPlanCheckoutIntents)
      .where(eq(personalPlanCheckoutIntents.id, checkout.intentId)),
  ).toHaveLength(1);
  expect(await getDb().select().from(files).where(eq(files.id, photoId))).toHaveLength(1);
  expect(await owed(person.id)).toEqual([]);
  expect(
    await getDb()
      .select()
      .from(accountClosureFences)
      .where(eq(accountClosureFences.accountId, person.id)),
  ).toEqual([]);
  // Only the exact trusted terminal observation releases closure; history is retained.
  await closePersonalPlanCheckoutFromProvider({
    intentId: checkout.intentId,
    subjectAccountId: person.id,
    mode: 'live',
    environment: 'production',
    providerAccountRef: 'merch_closure_fixture',
    providerSessionId: 'cs_closure',
    reason: 'expired',
  });
  expect((await callDelete(deleteBody(person.username ?? ''))).status).toBe(200);
  expect(
    (await getDb().select().from(users).where(eq(users.id, person.id)))[0]?.accountStatus,
  ).toBe('archived');
  expect(
    (
      await getDb()
        .select()
        .from(personalPlanCheckoutIntents)
        .where(eq(personalPlanCheckoutIntents.id, checkout.intentId))
    )[0]?.state,
  ).toBe('closed');
});

it('reservation holds closure during remote dispatch and after a lost response without any session reference', async () => {
  const { person, photoId } = await seedPersonWithUploads();
  currentUserId = person.id;
  signatureValid = true;
  forceArchive = false;
  let signalEntered: () => void = () => {
    throw new Error('Uninitialized latch');
  };
  let release: () => void = () => {
    throw new Error('Uninitialized latch');
  };
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await checkoutFixture(person.id, async () => {
    signalEntered();
    await paused;
    throw new Error('provider response lost');
  });
  const dispatch = fixture.start();
  const outcome = dispatch.catch((error: Error) => error);
  await entered;
  expect((await callDelete(deleteBody(person.username ?? ''))).status).toBe(409);
  await expect(beginAccountClosure(person.id)).rejects.toMatchObject({ statusCode: 409 });
  release();
  expect(await outcome).toMatchObject({ message: 'provider response lost' });
  const [intent] = await getDb()
    .select()
    .from(personalPlanCheckoutIntents)
    .where(eq(personalPlanCheckoutIntents.subjectAccountId, person.id));
  expect(intent.state).toBe('reserved');
  expect(intent.providerSessionId).toBeNull();
  // Unknown remote effect stays held: neither time passing nor missing session proves expiry.
  expect((await callDelete(deleteBody(person.username ?? ''))).status).toBe(409);
  expect(await getDb().select().from(files).where(eq(files.id, photoId))).toHaveLength(1);
  expect(await owed(person.id)).toEqual([]);
});

it('closure winning the account lock prevents a checkout reservation and remote dispatch', async () => {
  const { person } = await seedPersonWithUploads();
  await beginAccountClosure(person.id);
  const create = jest.fn(async () => ({
    sessionId: 'never',
    checkoutUrl: 'https://checkout.invalid/never',
  }));
  const fixture = await checkoutFixture(person.id, create);
  await expect(fixture.start()).rejects.toMatchObject({ statusCode: 403 });
  expect(create).not.toHaveBeenCalled();
  expect(
    await getDb()
      .select()
      .from(personalPlanCheckoutIntents)
      .where(eq(personalPlanCheckoutIntents.subjectAccountId, person.id)),
  ).toEqual([]);
});

it('locked closure recheck refuses checkout committed after the HTTP preflight saw no holds', async () => {
  const { person, photoId } = await seedPersonWithUploads();
  currentUserId = person.id;
  signatureValid = true;
  forceArchive = false;
  let signalRead: () => void = () => {
    throw new Error('Uninitialized latch');
  };
  let releaseRead: () => void = () => {
    throw new Error('Uninitialized latch');
  };
  const read = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  afterHoldsRead = async () => {
    signalRead();
    await paused;
  };
  const deletion = callDelete(deleteBody(person.username ?? ''));
  await read;
  try {
    const fixture = await checkoutFixture(person.id, async () => ({
      sessionId: 'cs_after_preflight',
      checkoutUrl: 'https://checkout.invalid/after-preflight',
    }));
    expect((await fixture.start()).state).toBe('pending');
  } finally {
    releaseRead();
  }
  expect((await deletion).status).toBe(409);
  expect(await getDb().select().from(files).where(eq(files.id, photoId))).toHaveLength(1);
  expect(await owed(person.id)).toEqual([]);
  expect(
    await getDb()
      .select()
      .from(accountClosureFences)
      .where(eq(accountClosureFences.accountId, person.id)),
  ).toEqual([]);
});
