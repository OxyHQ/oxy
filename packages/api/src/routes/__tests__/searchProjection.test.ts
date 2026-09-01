/**
 * `GET /search` — protected-column leak guard, over a REAL row that actually
 * carries every protected value.
 *
 * `/search` is mounted with NO auth and NO CSRF (`server.ts`), so every field it
 * emits is world-readable. It once shipped an exclusion `$project`
 * (`{ password: 0, refreshToken: 0, … }`), which put `email`, `publicKey` and
 * the full `privacySettings` object on that public response.
 *
 * The Postgres read is an INCLUSION list (`publicUserColumns`), which is the
 * right shape — and this suite is what notices if it ever stops being one. It
 * matters more here than on the profiles surfaces because this route serializes
 * through a DIFFERENT function (`utils/userTransform.formatUserResponse`), which
 * happily emits `email`, `publicKey` and a whole `privacySettings` object when
 * its input carries them. The selection is the only thing between those columns
 * and the wire.
 *
 * Driven by the registry (`USERS_PROTECTED_COLUMNS`) so a newly protected column
 * extends the assertion automatically, and seeded with a distinct sentinel per
 * column so a value that leaks under a different key is caught too.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { USERS_PROTECTED_COLUMNS } from '../../db/schema/protectedColumns';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import searchRouter from '../search';

interface SearchResponse {
  status: number;
  raw: string;
  body: { users?: Array<Record<string, unknown>> };
}

interface SeededSecrets {
  term: string;
  username: string;
  id: string;
  values: string[];
}

let server: http.Server;

/** See `profilesUsernameProjection.test.ts` for why the hashes are read back. */
async function seedUserWithEverySecret(): Promise<SeededSecrets> {
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
      // A privacy block that is NOT all-default, so a wholesale
      // `privacySettings` leak would be visible in the response body.
      privacyDiscoverableByEmail: true,
      privacyBiometricLogin: true,
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
  const queryString = new URLSearchParams({ query, limit: '10' });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path: `/search?${queryString}` },
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
  app.use('/search', searchRouter);
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

describe('GET /search — protected columns', () => {
  it('emits no protected column on the unauthenticated response, by key or by value', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await search(seeded.term);

    expect(res.status).toBe(200);
    const row = res.body.users?.[0];
    expect(row).toBeDefined();
    for (const column of USERS_PROTECTED_COLUMNS) {
      expect(row).not.toHaveProperty(column);
    }
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('publicKey');
    for (const secret of seeded.values) {
      expect(res.raw).not.toContain(secret);
    }
  });

  it('emits ONLY the public fediverseSharing leaf under privacySettings', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await search(seeded.term);

    expect(res.body.users?.[0]?.privacySettings).toEqual({ fediverseSharing: true });
  });

  it('still emits the public fields the search row renders', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await search(seeded.term);

    // The vacuity floor for the assertions above.
    const row = res.body.users?.[0];
    expect(row?.id).toBe(seeded.id);
    expect(row?.username).toBe(seeded.username);
    expect(row?.avatar).toBe('file_public');
    expect(row?.bio).toBe('public bio');
    expect(row?.description).toBe('public description');
    expect(row?.name).toEqual({ displayName: 'Secretive', first: 'Secretive', full: 'Secretive' });
  });

  it('emits none of the ordering/gate columns the query reads', async () => {
    const seeded = await seedUserWithEverySecret();

    const res = await search(seeded.term);

    const row = res.body.users?.[0];
    expect(row).not.toHaveProperty('accountStatus');
    expect(row).not.toHaveProperty('reputationTier');
    expect(row).not.toHaveProperty('reputationRankWeight');
  });
});
