/**
 * `GET /profiles/username/:username` — protected-column leak guard, over a REAL
 * row that actually carries every protected value.
 *
 * The subject is unchanged from the Mongo era; the mechanism it guards is not.
 * Mongoose's `select: false` kept `phone` / `refreshToken` / the contact hashes
 * out of a query result unless a caller named them, and this suite used to
 * reproduce that by applying the route's `.select()` string with MongoDB's
 * semantics. Drizzle enumerates columns instead, so the guarantee now rests on
 * the route selecting `publicUserColumns` — an INCLUSION list — and nothing in a
 * type checker notices if a future edit spreads the whole table in beside it.
 *
 * So the assertion is driven by the registry (`USERS_PROTECTED_COLUMNS`) rather
 * than a hand-written list: adding a protected column automatically extends this
 * test, and the row is seeded with a DISTINCT sentinel per column so the check
 * catches a value that leaks under a different key as well as a key that leaks.
 *
 * The sibling `profilesUsername.test.ts` asserts the full positive wire shape;
 * this one exists because a leak is a security failure rather than a shape
 * change, and it should fail loudly, naming the column.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';


jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: (): string | undefined => undefined,
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { USERS_PROTECTED_COLUMNS } from '../../db/schema/protectedColumns';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { federationService } from '../../services/federation.service';
import profilesRouter from '../profiles';

let server: http.Server;

interface SeededSecrets {
  username: string;
  id: string;
  /** Every protected value that is a STRING, so it can be searched for verbatim. */
  values: string[];
}

/**
 * A user row whose every writable protected column holds a unique sentinel.
 *
 * `hashed_email` / `hashed_phone` are GENERATED and therefore not writable; they
 * are read back explicitly — the sanctioned opt-in shape — so their values can
 * be searched for in the response too.
 */
async function seedUserWithEverySecret(): Promise<SeededSecrets> {
  const token = randomUUID().replace(/-/g, '').slice(0, 12);
  const username = `secretive${token}`;
  const email = `${username}@oxy.so`;
  const phone = `+34600${token.replace(/\D/g, '0').slice(0, 6)}`;

  const [inserted] = await getDb()
    .insert(users)
    .values({
      username,
      nameFirst: 'Secretive',
      avatar: 'file_public',
      bio: 'public bio',
      email,
      phone,
      publicKey: `04${token}${randomUUID().replace(/-/g, '')}`,
      refreshToken: `rt_secret_${token}`,
      emailSignature: `signature_secret_${token}`,
      autoForwardTo: `forward_secret_${token}@example.com`,
      autoForwardKeepCopy: false,
    })
    .returning({ id: users.id });

  const [derived] = await getDb()
    .select({
      hashedEmail: users.hashedEmail,
      hashedPhone: users.hashedPhone,
      publicKey: users.publicKey,
      phone: users.phone,
      refreshToken: users.refreshToken,
      emailSignature: users.emailSignature,
      autoForwardTo: users.autoForwardTo,
    })
    .from(users)
    .where(eq(users.id, inserted.id))
    .limit(1);

  const values = [
    email,
    derived.phone,
    derived.publicKey,
    derived.refreshToken,
    derived.emailSignature,
    derived.autoForwardTo,
    derived.hashedEmail,
    derived.hashedPhone,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  // A guard on the guard: if the generated hashes were ever to come back NULL,
  // the sentinel search below would silently stop covering them.
  expect(values).toHaveLength(8);

  return { username, id: inserted.id, values };
}

function lookup(username: string): Promise<{ status: number; raw: string; body: { data?: Record<string, unknown> } }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path: `/profiles/username/${encodeURIComponent(username)}`,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw,
            body: raw.length > 0 ? JSON.parse(raw) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/profiles', profilesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  jest.spyOn(federationService, 'resolveAndUpsert').mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /profiles/username/:username — protected columns', () => {
  it('emits no protected column, by key or by value', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await lookup(seeded.username);

    expect(res.status).toBe(200);
    for (const column of USERS_PROTECTED_COLUMNS) {
      expect(res.body.data).not.toHaveProperty(column);
    }
    // `email` and `public_key` are not on the protected registry (they are
    // omitted by being absent from `publicUserColumns` rather than by a rule),
    // so they are named here explicitly.
    expect(res.body.data).not.toHaveProperty('email');
    expect(res.body.data).not.toHaveProperty('publicKey');
    for (const secret of seeded.values) {
      expect(res.raw).not.toContain(secret);
    }
  });

  it('still emits the public fields the profile row renders', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await lookup(seeded.username);

    // The vacuity floor: the assertion above passes trivially against an empty
    // body, so the same response has to carry the real public row.
    expect(res.body.data?.id).toBe(seeded.id);
    expect(res.body.data?.username).toBe(seeded.username);
    expect(res.body.data?.avatar).toBe('file_public');
    expect(res.body.data?.bio).toBe('public bio');
    expect(res.body.data?.name).toEqual({ displayName: 'Secretive', first: 'Secretive', full: 'Secretive' });
    expect(res.body.data?._count).toEqual({ followers: 0, following: 0 });
  });

  it('emits the derived fediverseSharing flag but not the privacy settings it came from', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await lookup(seeded.username);

    expect(res.body.data?.fediverseSharing).toBe(true);
    expect(res.body.data).not.toHaveProperty('privacySettings');
    expect(res.body.data).not.toHaveProperty('privacyIsPrivateAccount');
    expect(res.body.data).not.toHaveProperty('privacyFediverseSharing');
  });
});
