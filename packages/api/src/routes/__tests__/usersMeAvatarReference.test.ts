/**
 * `PUT /users/me` keeps the profile's avatar referenced by Oxy Accounts (ADR
 * 0042 D4, stage 4b), through the real router, the real `userService` and a
 * REAL Postgres.
 *
 * Stubbed: the session middleware, the rate limiter, and the asset singleton's
 * best-effort `ensureOwnedAssetPublic` (S3; it has its own tests).
 *
 * Invariants:
 *  1. Setting the avatar to the account's own file references it — Oxy
 *     Accounts, `avatar`, the account's id — created BY the account (ADR 0021's
 *     owner-linked predicate), in the profile write's transaction.
 *  2. Replacing it moves the reference: the old file is no longer referenced
 *     and becomes *not in use* — never trashed (D5). A stale `avatar` reference
 *     the SDK's `uploadAvatar` left for an earlier avatar goes too.
 *  3. Clearing it removes the reference.
 *  4. Another account's file (or a value naming no file) is never referenced;
 *     the profile write still lands as before.
 *  5. Re-sending the same avatar changes nothing.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';

let currentUserId: string | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    if (currentUserId) req.user = { id: currentUserId };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, fileReferences, files, users } from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import usersRouter from '../users';
import { PROFILE_AVATAR_ENTITY_TYPE } from '../../services/profileMediaReferences.service';

jest.setTimeout(60_000);

let server: http.Server;
let accountsAppId: string;

async function person(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `avatar${suffix}`, email: `avatar-${suffix}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function photo(ownerUserId: string): Promise<string> {
  const sha256 = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'image/jpeg',
      ext: 'jpg',
      ownerUserId,
      status: 'active',
      visibility: 'public',
      storageKey: `public/content/2026/10/${sha256.slice(0, 2)}/${sha256}.jpg`,
    })
    .returning({ id: files.id });
  return row.id;
}

/** Exactly one active official "Oxy Accounts": the `profiles` alias resolves to it. */
async function oxyAccountsApplication(): Promise<string> {
  await getDb()
    .update(applications)
    .set({ status: 'suspended' })
    .where(and(eq(applications.name, 'Oxy Accounts'), ne(applications.type, 'third_party')));
  const [row] = await getDb()
    .insert(applications)
    .values({ name: 'Oxy Accounts', ownerAccountId: await person(), type: 'first_party' })
    .returning({ id: applications.id });
  return row.id;
}

async function avatarReferences(userId: string) {
  return getDb()
    .select({
      fileId: fileReferences.fileId,
      createdByUserId: fileReferences.createdByUserId,
    })
    .from(fileReferences)
    .where(
      and(
        eq(fileReferences.applicationId, accountsAppId),
        eq(fileReferences.entityType, PROFILE_AVATAR_ENTITY_TYPE),
        eq(fileReferences.entityId, userId),
      ),
    );
}

async function fileState(ids: string[]) {
  const rows = await getDb()
    .select({ id: files.id, status: files.status, unreferencedSince: files.unreferencedSince })
    .from(files)
    .where(inArray(files.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

function putMe(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/users/me',
        method: 'PUT',
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

beforeAll(async () => {
  await connectPostgres();
  accountsAppId = await oxyAccountsApplication();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('PUT /users/me and the avatar reference', () => {
  it('references the new avatar, created by the account', async () => {
    const me = await person();
    const avatar = await photo(me);
    currentUserId = me;

    const res = await putMe({ avatar });
    expect(res.status).toBe(200);

    expect(await avatarReferences(me)).toEqual([{ fileId: avatar, createdByUserId: me }]);
    expect((await fileState([avatar])).get(avatar)?.unreferencedSince).toBeNull();
  });

  it('moves the reference on replace; the old file is not in use, never trashed', async () => {
    const me = await person();
    const first = await photo(me);
    const second = await photo(me);
    const sdkLeftover = await photo(me);
    currentUserId = me;
    // What the SDK's `uploadAvatar` wrote for an earlier avatar it never unlinked.
    await getDb().insert(fileReferences).values({
      fileId: sdkLeftover,
      applicationId: accountsAppId,
      entityType: PROFILE_AVATAR_ENTITY_TYPE,
      entityId: me,
      createdByUserId: me,
    });

    expect((await putMe({ avatar: first })).status).toBe(200);
    expect((await putMe({ avatar: second })).status).toBe(200);

    expect(await avatarReferences(me)).toEqual([{ fileId: second, createdByUserId: me }]);
    const state = await fileState([first, second, sdkLeftover]);
    for (const id of [first, sdkLeftover]) {
      expect(state.get(id)?.status).toBe('active');
      expect(state.get(id)?.unreferencedSince).toBeInstanceOf(Date);
    }
    expect(state.get(second)?.unreferencedSince).toBeNull();
  });

  it('removes the reference when the avatar is cleared', async () => {
    const me = await person();
    const avatar = await photo(me);
    currentUserId = me;
    await putMe({ avatar });

    expect((await putMe({ avatar: '' })).status).toBe(200);

    expect(await avatarReferences(me)).toEqual([]);
    const [row] = await getDb()
      .select({ avatar: users.avatar })
      .from(users)
      .where(eq(users.id, me));
    expect(row.avatar).toBeNull();
    const state = (await fileState([avatar])).get(avatar);
    expect(state?.status).toBe('active');
    expect(state?.unreferencedSince).toBeInstanceOf(Date);
  });

  it('never references another account’s file, nor a value naming no file', async () => {
    const me = await person();
    const someoneElse = await person();
    const theirs = await photo(someoneElse);
    const mine = await photo(me);
    currentUserId = me;
    await putMe({ avatar: mine });

    expect((await putMe({ avatar: theirs })).status).toBe(200);
    // The profile write lands as it always did; Oxy Accounts uses nothing of theirs,
    // and my previous avatar is no longer the avatar.
    expect(await avatarReferences(me)).toEqual([]);
    const [theirReference] = await getDb()
      .select({ id: fileReferences.id })
      .from(fileReferences)
      .where(eq(fileReferences.fileId, theirs));
    expect(theirReference).toBeUndefined();

    expect((await putMe({ avatar: 'https://example.test/me.png' })).status).toBe(200);
    expect(await avatarReferences(me)).toEqual([]);
  });

  it('changes nothing when the same avatar is sent again, and nothing when it is not sent', async () => {
    const me = await person();
    const avatar = await photo(me);
    currentUserId = me;
    await putMe({ avatar });
    const [before] = await getDb()
      .select({ id: fileReferences.id, createdAt: fileReferences.createdAt })
      .from(fileReferences)
      .where(eq(fileReferences.fileId, avatar));

    expect((await putMe({ avatar })).status).toBe(200);
    expect((await putMe({ bio: 'hello' })).status).toBe(200);

    const after = await getDb()
      .select({ id: fileReferences.id, createdAt: fileReferences.createdAt })
      .from(fileReferences)
      .where(eq(fileReferences.fileId, avatar));
    expect(after).toEqual([before]);
  });
});
