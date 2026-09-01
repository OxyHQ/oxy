/**
 * Signed-record endpoints (B5) — the HTTP envelope, against a REAL Postgres.
 *
 * Locks the EXACT response shapes the `@oxyhq/core` identity mixin parses:
 *  - POST /identity/records                       → { envelope, verified }
 *  - GET  /identity/records/:userId/:type          → { record }
 *  - GET  /identity/records/:userId/:type/verify   → { verified, reason? }
 *
 * ## The guarantee this file adds
 *
 * **A post-cutover account can publish and re-verify a record.** These routes
 * used to run `:userId` through the legacy 24-hex id predicate in
 * `utils/validation.ts` and 404 on a miss — which rejects the uuid v7 every
 * account minted since the cutover carries. The previous suite stubbed that
 * predicate with the SAME regex and used a hard-coded 24-hex id, so the guard
 * was satisfied by construction and the format was never in question. Here the
 * account is a real row with the id the schema actually mints.
 *
 * The signed-record SERVICE stays mocked: its cryptography is covered by
 * `services/__tests__/signedRecord.service.test.ts`, and what this file locks is
 * the HTTP envelope plus the subject-existence branch of `/verify`, which is now
 * a real `users` read.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { ec as EC } from 'elliptic';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

const ec = new EC('secp256k1');
const PUBLIC_KEY = ec.genKeyPair().getPublic('hex');

/** The account `authMiddleware` injects for the current test. */
let currentUserId = '';

const mockVerifyAndStore = jest.fn();
const mockVerifyEnvelope = jest.fn();
const mockGetLatest = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: currentUserId, id: currentUserId };
    next();
  },
}));

jest.mock('../../services/signedRecord.service', () => ({
  verifyAndStoreRecord: (...args: unknown[]) => mockVerifyAndStore(...args),
  verifyEnvelope: (...args: unknown[]) => mockVerifyEnvelope(...args),
  getLatestRecord: (...args: unknown[]) => mockGetLatest(...args),
}));

// repoLog.service backs the chain-head/log endpoints, which have their own
// suites (chainHead.test.ts, nodesLog.test.ts); stubbed here so this file
// exercises only the B5 record routes.
jest.mock('../../services/repoLog.service', () => ({
  getHead: jest.fn(),
  getPublicLogSince: jest.fn(),
  resolveCursorSeq: jest.fn(),
}));

// nodeRegistry.service is a transitive import of the identity routes (F5a) and
// is still Mongoose-backed (a sibling port).
jest.mock('../../services/nodeRegistry.service', () => ({
  materializeNodeFromRecord: jest.fn(),
  getUserNode: jest.fn(() => Promise.resolve(null)),
  removeNode: jest.fn(),
  probeLiveness: jest.fn(),
  sweepNodeLiveness: jest.fn(),
}));

jest.mock('@oxyhq/core/server', () => ({ safeFetch: jest.fn() }));
jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: jest.fn() } }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import identityRoutes from '../identity';
import { errorHandler } from '../../middleware/errorHandler';

/** The two ids the `text` primary key can hold; only one of them is minted now. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

function envelope(userId: string): SignedRecordEnvelope {
  return {
    version: 1,
    type: 'identity',
    subject: `did:web:oxy.so:u:${userId}`,
    issuer: `did:web:oxy.so:u:${userId}`,
    record: { displayName: 'Nate' },
    issuedAt: 1_800_000_000_000,
    publicKey: PUBLIC_KEY,
    alg: 'ES256K-DER-SHA256',
    signature: 'deadbeef',
  };
}

interface JsonResponse { status: number; body: Record<string, unknown>; }

async function request(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: body !== undefined
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A fresh account, made the CURRENT caller. */
async function signInAsFreshAccount(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u${randomUUID().replace(/-/g, '')}` })
    .returning({ id: users.id });
  currentUserId = row.id;
  return row.id;
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity', identityRoutes);
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

beforeEach(async () => {
  jest.clearAllMocks();
  await signInAsFreshAccount();
});

describe('POST /identity/records', () => {
  it('returns { envelope, verified } on success', async () => {
    const env = envelope(currentUserId);
    mockVerifyAndStore.mockResolvedValueOnce({ ok: true, record: { envelope: env, verified: true } });

    const res = await request('POST', '/identity/records', env);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ envelope: env, verified: true });
    expect(mockVerifyAndStore).toHaveBeenCalledWith(env, currentUserId);
  });

  it('returns 400 when the service rejects the envelope', async () => {
    mockVerifyAndStore.mockResolvedValueOnce({ ok: false, reason: 'bad_signature' });

    const res = await request('POST', '/identity/records', envelope(currentUserId));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'Signed record rejected: bad_signature',
    });
  });
});

describe('GET /identity/records/:userId/:type', () => {
  it('returns { record } (the bare envelope)', async () => {
    const env = envelope(currentUserId);
    mockGetLatest.mockResolvedValueOnce({ envelope: env });

    const res = await request('GET', `/identity/records/${currentUserId}/identity`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ record: env });
    expect(mockGetLatest).toHaveBeenCalledWith(currentUserId, 'identity');
  });

  it('serves the record of a post-cutover account', async () => {
    // The premise: the guard this replaces rejected this id outright.
    expect(currentUserId).not.toMatch(OBJECT_ID_HEX);
    mockGetLatest.mockResolvedValueOnce({ envelope: envelope(currentUserId) });

    const res = await request('GET', `/identity/records/${currentUserId}/identity`);

    expect(res.status).toBe(200);
  });

  it('rejects an unknown record type with 400', async () => {
    const res = await request('GET', `/identity/records/${currentUserId}/nonsense`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'type must be "identity" or "profile"',
    });
    expect(mockGetLatest).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no such record', async () => {
    mockGetLatest.mockResolvedValueOnce(null);

    const res = await request('GET', `/identity/records/${currentUserId}/profile`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Record not found' });
  });

  it('answers a malformed id with the SAME 404, by querying rather than guessing', async () => {
    // No shape precheck any more: the store finds no record for a value that
    // matches no row, which is the exact body the deleted guard produced.
    mockGetLatest.mockResolvedValueOnce(null);

    const res = await request('GET', '/identity/records/not-an-id/identity');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Record not found' });
  });
});

describe('GET /identity/records/:userId/:type/verify', () => {
  it('returns { verified: true } when the stored record re-verifies', async () => {
    mockGetLatest.mockResolvedValueOnce({ envelope: envelope(currentUserId) });
    mockVerifyEnvelope.mockResolvedValueOnce({ ok: true });

    const res = await request('GET', `/identity/records/${currentUserId}/identity/verify`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });
  });

  it('returns { verified: false, reason } when it does not', async () => {
    mockGetLatest.mockResolvedValueOnce({ envelope: envelope(currentUserId) });
    mockVerifyEnvelope.mockResolvedValueOnce({ ok: false, reason: 'stale_issued_at' });

    const res = await request('GET', `/identity/records/${currentUserId}/identity/verify`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: false, reason: 'stale_issued_at' });
  });

  it('returns 404 when the SUBJECT account no longer exists', async () => {
    // The verdict is computed against the account's CURRENT verification
    // methods, so a record whose subject is gone is reported as absent rather
    // than as unverifiable — and the envelope is never re-checked.
    mockGetLatest.mockResolvedValueOnce({ envelope: envelope(currentUserId) });

    const res = await request('GET', `/identity/records/${randomUUID()}/identity/verify`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Record not found' });
    expect(mockVerifyEnvelope).not.toHaveBeenCalled();
  });
});
