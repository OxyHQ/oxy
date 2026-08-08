/**
 * `GET /profiles/resolve` — protected-column leak guard, over a REAL row that
 * actually carries every protected value.
 *
 * Same subject and same mechanism note as
 * `profilesUsernameProjection.test.ts`; this covers the OTHER single-profile
 * surface, which reaches the same `loadProfileByPredicate` by a different route
 * and is separately reachable without authentication.
 *
 * Both branches of the route are covered: the local-first hit and the branch
 * that re-reads a freshly discovered actor. They select through the same helper
 * today; asserting only one of them would let a future divergence ship.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';


const mockResolveAndUpsert = jest.fn();

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
  handle: string;
  id: string;
  values: string[];
}

/** See `profilesUsernameProjection.test.ts` for why the hashes are read back. */
async function seedFederatedUserWithEverySecret(
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<SeededSecrets> {
  const token = randomUUID().replace(/-/g, '').slice(0, 12);
  const handle = `remote${token}@mastodon.social`;
  const email = `remote${token}@oxy.so`;

  const [inserted] = await getDb()
    .insert(users)
    .values({
      username: handle,
      nameFirst: 'Remote',
      avatar: 'file_public',
      bio: 'public bio',
      type: 'federated',
      federationActorUri: `https://mastodon.social/users/remote${token}`,
      federationDomain: 'mastodon.social',
      email,
      phone: `+34600${token.replace(/\D/g, '0').slice(0, 6)}`,
      publicKey: `04${token}${randomUUID().replace(/-/g, '')}`,
      refreshToken: `rt_secret_${token}`,
      emailSignature: `signature_secret_${token}`,
      autoForwardTo: `forward_secret_${token}@example.com`,
      autoForwardKeepCopy: false,
      ...overrides,
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
  expect(values).toHaveLength(8);

  return { handle, id: inserted.id, values };
}

function resolveHandle(
  handle: string,
): Promise<{ status: number; raw: string; body: { data?: Record<string, unknown> | null } }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path: `/profiles/resolve?handle=${encodeURIComponent(handle)}`,
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

function expectNoSecrets(
  res: { raw: string; body: { data?: Record<string, unknown> | null } },
  values: string[],
): void {
  for (const column of USERS_PROTECTED_COLUMNS) {
    expect(res.body.data).not.toHaveProperty(column);
  }
  expect(res.body.data).not.toHaveProperty('email');
  expect(res.body.data).not.toHaveProperty('publicKey');
  for (const secret of values) {
    expect(res.raw).not.toContain(secret);
  }
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
  mockResolveAndUpsert.mockReset();
  mockResolveAndUpsert.mockResolvedValue(null);
  jest
    .spyOn(federationService, 'resolveAndUpsert')
    .mockImplementation((...args) => mockResolveAndUpsert(...args));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /profiles/resolve — protected columns', () => {
  it('emits no protected column on the local-first branch, by key or by value', async () => {
    const seeded = await seedFederatedUserWithEverySecret();

    const res = await resolveHandle(seeded.handle);

    expect(res.status).toBe(200);
    expectNoSecrets(res, seeded.values);
  });

  it('emits no protected column on the discovery branch either', async () => {
    // No stored username → the local lookup misses and the route re-reads the
    // row by the id discovery hands back.
    const seeded = await seedFederatedUserWithEverySecret({ username: null });
    const unknownHandle = `unknown${randomUUID().replace(/-/g, '').slice(0, 12)}@mastodon.social`;
    mockResolveAndUpsert.mockResolvedValue({ _id: seeded.id });

    const res = await resolveHandle(unknownHandle);

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(seeded.id);
    expectNoSecrets(res, seeded.values);
  });

  it('still emits the public fields the resolved row renders', async () => {
    const seeded = await seedFederatedUserWithEverySecret();

    const res = await resolveHandle(seeded.handle);

    // The vacuity floor for the two assertions above.
    expect(res.body.data?.id).toBe(seeded.id);
    expect(res.body.data?.username).toBe(seeded.handle);
    expect(res.body.data?.bio).toBe('public bio');
    expect(res.body.data?.isFederated).toBe(true);
    expect(res.body.data?.federation).toEqual({
      actorUri: `https://mastodon.social/users/${seeded.handle.split('@')[0]}`,
      domain: 'mastodon.social',
    });
    expect(res.body.data?.fediverseSharing).toBe(true);
    expect(res.body.data).not.toHaveProperty('privacySettings');
    expect(res.body.data).not.toHaveProperty('accountStatus');
  });
});
