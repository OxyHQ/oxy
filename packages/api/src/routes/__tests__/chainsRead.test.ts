/**
 * `GET /chains/records` — the multi-subject read, over a real HTTP server and a
 * real database.
 *
 * The case this suite exists for is the leak: a caller naming a PRIVATE
 * collection must get nothing, and it must get nothing even when that collection
 * has records and the caller is otherwise entitled. Everything else here is
 * scaffolding around that one assertion.
 *
 * `serviceAuthMiddleware` is mocked because the credential is the parameter under
 * test. The read service is NOT mocked — it is the component doing the
 * narrowing, and stubbing it would leave the narrowing untested.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

let currentServiceApp: Record<string, unknown> | undefined;

jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (req: { serviceApp?: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.serviceApp = currentServiceApp;
    next();
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { buildUserDid } from '../../services/did.service';
import chainsRoutes from '../chains';

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/chains', chainsRoutes);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePostgres();
});

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** Seed one verified v2 row under `collection`. Envelopes are well-formed but unsigned — no read here verifies. */
async function seed(userId: string, collection: string, seq: number, at: Date): Promise<string> {
  const subjectDid = buildUserDid(userId);
  const recordId = `${userId}-${collection}-${seq}`;
  await getDb().insert(signedRecords).values({
    subjectDid,
    userId,
    type: 'app_record',
    envelope: {
      version: 2,
      type: 'app_record',
      subject: subjectDid,
      issuer: subjectDid,
      record: { marker: recordId },
      issuedAt: at.getTime(),
      seq,
      prev: null,
      collection,
      rkey: String(seq),
      publicKey: 'pk',
      alg: 'ES256K-DER-SHA256',
      signature: 'unsigned-fixture',
    },
    publicKey: 'pk',
    verified: true,
    seq,
    prev: null,
    recordId,
    nsid: collection,
    rkey: String(seq),
    createdAt: at,
  });
  return recordId;
}

function get(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: address.port, path: `/chains/records?${query}` }, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function present(scopes: string[]): void {
  currentServiceApp = { type: 'service', appId: 'app-under-test', scopes };
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe('GET /chains/records', () => {
  it('refuses a credential without chains:read', async () => {
    present(['chains:write']);
    const res = await get(`authors=${await account()}&collections=app.mention.feed.post`);
    expect(res.status).toBe(403);
  });

  it('returns records from several subjects, oldest first', async () => {
    present(['chains:read']);
    const [a, b] = [await account(), await account()];
    await seed(a, 'app.mention.feed.post', 0, at(1000));
    await seed(b, 'app.mention.feed.post', 0, at(2000));
    await seed(a, 'app.mention.feed.post', 1, at(3000));

    const res = await get(`authors=${a},${b}&collections=app.mention.feed.post`);

    expect(res.status).toBe(200);
    const records = res.body.records as Array<{ recordId: string; oxyUserId: string }>;
    expect(records.map((r) => r.recordId)).toEqual([
      `${a}-app.mention.feed.post-0`,
      `${b}-app.mention.feed.post-0`,
      `${a}-app.mention.feed.post-1`,
    ]);
  });

  /**
   * The leak this endpoint was withheld for until the policy existed. The rows
   * ARE there and the caller IS entitled to read — and still gets nothing,
   * because the collection is private by kind.
   */
  it('returns NOTHING for a private collection, even though the records exist', async () => {
    present(['chains:read']);
    const userId = await account();
    await seed(userId, 'app.mention.feed.bookmark', 0, at(1000));

    const res = await get(`authors=${userId}&collections=app.mention.feed.bookmark`);

    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('drops the private collection from a MIXED request and keeps the public one', async () => {
    // The shape a careless narrowing gets wrong: asking for both must not be a
    // way to smuggle the private one in beside a legitimate request.
    present(['chains:read']);
    const userId = await account();
    await seed(userId, 'app.mention.feed.post', 0, at(1000));
    await seed(userId, 'app.mention.feed.bookmark', 1, at(2000));

    const res = await get(
      `authors=${userId}&collections=app.mention.feed.post,app.mention.feed.bookmark`,
    );

    const records = res.body.records as Array<{ collection: string }>;
    expect(records).toHaveLength(1);
    expect(records[0].collection).toBe('app.mention.feed.post');
  });

  it('pages with an opaque cursor and reaches every record exactly once', async () => {
    present(['chains:read']);
    const userId = await account();
    await seed(userId, 'app.mention.feed.post', 0, at(1000));
    await seed(userId, 'app.mention.feed.post', 1, at(2000));

    const first = await get(`authors=${userId}&collections=app.mention.feed.post&limit=1`);
    expect((first.body.records as unknown[]).length).toBe(1);
    const cursor = first.body.nextCursor as string;
    expect(typeof cursor).toBe('string');

    const second = await get(
      `authors=${userId}&collections=app.mention.feed.post&since=${encodeURIComponent(cursor)}`,
    );

    const seen = [...(first.body.records as Array<{ recordId: string }>), ...(second.body.records as Array<{ recordId: string }>)]
      .map((r) => r.recordId);
    expect([...seen].sort()).toEqual(
      [`${userId}-app.mention.feed.post-0`, `${userId}-app.mention.feed.post-1`].sort(),
    );
    expect(new Set(seen).size).toBe(2);
  });

  it('treats an unreadable cursor as the start rather than an error', async () => {
    present(['chains:read']);
    const userId = await account();
    await seed(userId, 'app.mention.feed.post', 0, at(1000));

    const res = await get(`authors=${userId}&collections=app.mention.feed.post&since=not-a-cursor`);

    expect(res.status).toBe(200);
    expect((res.body.records as unknown[]).length).toBe(1);
  });

  it('rejects an oversized author list rather than truncating it', async () => {
    present(['chains:read']);
    const authors = Array.from({ length: 301 }, (_, i) => `u${i}`).join(',');
    const res = await get(`authors=${authors}&collections=app.mention.feed.post`);
    expect(res.status).toBe(400);
  });
});
