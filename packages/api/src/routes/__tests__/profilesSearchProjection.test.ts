/**
 * `GET /profiles/search` — protected-column leak guard, over a REAL row that
 * actually carries every protected value.
 *
 * This surface is the one with the worst history: it once shipped an EXCLUSION
 * `$project` (`{ password: 0, refreshToken: 0, … }`), which loaded whole user
 * documents into the pipeline and left the serializer as the only thing between
 * a private field and an unauthenticated client. The Postgres read is an
 * INCLUSION list (`publicUserColumns`), which is the right shape — and this
 * suite is what notices if it ever stops being one.
 *
 * Driven by the registry (`USERS_PROTECTED_COLUMNS`) so a newly protected column
 * extends the assertion automatically, and seeded with a distinct sentinel per
 * column so a value that leaks under a different key is caught too.
 *
 * The list surface is checked separately from the two single-profile surfaces
 * because it reaches its rows through a different query — the page select, not
 * `loadProfileByPredicate` — and both the page and the federated PREPEND are
 * covered here.
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

interface SearchResponse {
  status: number;
  raw: string;
  body: { data?: Array<Record<string, unknown>> };
}

interface SeededSecrets {
  term: string;
  username: string;
  id: string;
  values: string[];
}

let server: http.Server;

/** See `profilesUsernameProjection.test.ts` for why the hashes are read back. */
async function seedUserWithEverySecret(
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<SeededSecrets> {
  const term = `t${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const username = `secretive${term}`;
  const email = `${username}@oxy.so`;

  const [inserted] = await getDb()
    .insert(users)
    .values({
      username,
      nameFirst: 'Secretive',
      avatar: 'file_public',
      bio: 'public bio',
      description: 'public description',
      email,
      phone: `+34600${term.replace(/\D/g, '0').slice(0, 6)}`,
      publicKey: `04${term}${randomUUID().replace(/-/g, '')}`,
      refreshToken: `rt_secret_${term}`,
      emailSignature: `signature_secret_${term}`,
      autoForwardTo: `forward_secret_${term}@example.com`,
      autoForwardKeepCopy: false,
      accountStatus: 'active',
      reputationTier: 'trusted',
      reputationRankWeight: 1.25,
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

  return { term, username, id: inserted.id, values };
}

function search(query: string): Promise<SearchResponse> {
  const address = server.address() as AddressInfo;
  const queryString = new URLSearchParams({ query, limit: '10', offset: '0' });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path: `/profiles/search?${queryString.toString()}`,
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

function expectNoSecrets(res: SearchResponse, values: string[]): void {
  const row = res.body.data?.[0];
  expect(row).toBeDefined();
  for (const column of USERS_PROTECTED_COLUMNS) {
    expect(row).not.toHaveProperty(column);
  }
  expect(row).not.toHaveProperty('email');
  expect(row).not.toHaveProperty('publicKey');
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

describe('GET /profiles/search — protected columns', () => {
  it('emits no protected column on a page row, by key or by value', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await search(seeded.term);

    expect(res.status).toBe(200);
    expectNoSecrets(res, seeded.values);
  });

  it('emits no protected column on a PREPENDED federated actor either', async () => {
    const seeded = await seedUserWithEverySecret({ type: 'federated' });
    const handle = `${seeded.term}@remote.example`;
    mockResolveAndUpsert.mockResolvedValue({ _id: seeded.id });

    const res = await search(handle);

    expect(res.status).toBe(200);
    expect(res.body.data?.[0]?.id).toBe(seeded.id);
    expectNoSecrets(res, seeded.values);
  });

  it('emits none of the ordering/gate columns the query reads', async () => {
    const seeded = await seedUserWithEverySecret({
      accountStatus: 'active',
      reputationTier: 'trusted',
      reputationRankWeight: 1.25,
    });

    const res = await search(seeded.term);

    const row = res.body.data?.[0];
    expect(row).not.toHaveProperty('accountStatus');
    expect(row).not.toHaveProperty('reputationTier');
    expect(row).not.toHaveProperty('reputationRankWeight');
  });

  it('still emits the public fields the search row renders', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await search(seeded.term);

    // The vacuity floor for the two assertions above.
    const row = res.body.data?.[0];
    expect(row?.id).toBe(seeded.id);
    expect(row?.username).toBe(seeded.username);
    expect(row?.avatar).toBe('file_public');
    expect(row?.bio).toBe('public bio');
    expect(row?.description).toBe('public description');
    expect(row?._count).toEqual({ followers: 0, following: 0 });
    expect(row?.fediverseSharing).toBe(true);
    expect(row).not.toHaveProperty('privacySettings');
    expect(row).not.toHaveProperty('accountStatus');
    expect(row).not.toHaveProperty('reputationTier');
    expect(row).not.toHaveProperty('reputationRankWeight');
  });
});
