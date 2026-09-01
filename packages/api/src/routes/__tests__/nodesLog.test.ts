/**
 * Route-shape tests for the public node-log endpoints (F5a Oxy→node export).
 *
 *  - GET /identity/log/:userId?since=<seq|recordId>&limit= → { records, count }
 *    forwarding the resolved `since` seq + limit to `getPublicLogSince`.
 *  - GET /identity/head/:userId → { seq, headRecordId, recordCount } (or empty).
 *
 * Both routes used to run `:userId` through the legacy 24-hex id predicate in
 * `utils/validation.ts` and 404 on a miss, which rejects the uuid v7 every
 * account minted since the Postgres cutover carries — so a personal data node
 * could not replicate such an account's chain at all. The guard is deleted, and
 * `USER_ID` here is a post-cutover id so nothing below can pass on the old shape.
 *
 * The repoLog service is mocked (its ordering/capping is covered in
 * repoLog.test.ts); this suite locks the HTTP envelope + the cursor resolution.
 */

import { randomUUID } from 'node:crypto';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

const mockGetPublicLogSince = jest.fn();
const mockGetHead = jest.fn();
const mockResolveCursorSeq = jest.fn();

/** A post-cutover account id — the shape the deleted guard rejected. */
const USER_ID = randomUUID();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../services/signedRecord.service', () => ({
  verifyAndStoreRecord: jest.fn(),
  verifyEnvelope: jest.fn(),
  getLatestRecord: jest.fn(),
}));

jest.mock('../../services/repoLog.service', () => ({
  getHead: (...args: unknown[]) => mockGetHead(...args),
  getPublicLogSince: (...args: unknown[]) => mockGetPublicLogSince(...args),
  resolveCursorSeq: (...args: unknown[]) => mockResolveCursorSeq(...args),
}));

jest.mock('../../services/nodeRegistry.service', () => ({ materializeNodeFromRecord: jest.fn() }));
jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: jest.fn() } }));
jest.mock('@oxyhq/core/server', () => ({ safeFetch: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import identityRoutes from '../identity';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse { status: number; body: Record<string, unknown>; }

async function request(server: http.Server, method: string, path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, host: '127.0.0.1', port: address.port, path },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function envelope(seq: number): SignedRecordEnvelope {
  return {
    version: 2,
    type: 'identity',
    subject: `did:web:oxy.so:u:${USER_ID}`,
    issuer: `did:web:oxy.so:u:${USER_ID}`,
    record: { seq },
    issuedAt: 1_700_000_000_000 + seq,
    seq,
    prev: seq === 0 ? null : 'p'.repeat(64),
    collection: 'app.oxy.identity',
    rkey: 'self',
    publicKey: 'ab'.repeat(33),
    alg: 'ES256K-DER-SHA256',
    signature: 'deadbeef',
  };
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/identity', identityRoutes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});
afterAll((done) => { server.close(done); });
beforeEach(() => { jest.clearAllMocks(); });

describe('GET /identity/log/:userId', () => {
  it('returns { records, count } from genesis when no since is given', async () => {
    mockGetPublicLogSince.mockResolvedValueOnce([envelope(0), envelope(1)]);

    const res = await request(server, 'GET', `/identity/log/${USER_ID}`);

    expect(res.status).toBe(200);
    expect(mockGetPublicLogSince).toHaveBeenCalledWith(USER_ID, -1, undefined);
    expect(res.body.count).toBe(2);
    expect(Array.isArray(res.body.records)).toBe(true);
    expect((res.body.records as unknown[]).length).toBe(2);
  });

  it('forwards a numeric since (exclusive) and the limit', async () => {
    mockGetPublicLogSince.mockResolvedValueOnce([envelope(4)]);

    const res = await request(server, 'GET', `/identity/log/${USER_ID}?since=3&limit=10`);

    expect(res.status).toBe(200);
    expect(mockGetPublicLogSince).toHaveBeenCalledWith(USER_ID, 3, 10);
  });

  it('resolves a recordId cursor to its seq', async () => {
    mockResolveCursorSeq.mockResolvedValueOnce(9);
    mockGetPublicLogSince.mockResolvedValueOnce([envelope(10)]);

    const recordId = 'r'.repeat(64);
    const res = await request(server, 'GET', `/identity/log/${USER_ID}?since=${recordId}`);

    expect(res.status).toBe(200);
    expect(mockResolveCursorSeq).toHaveBeenCalledWith(USER_ID, recordId);
    expect(mockGetPublicLogSince).toHaveBeenCalledWith(USER_ID, 9, undefined);
  });

  it('returns 400 for an unknown recordId cursor', async () => {
    mockResolveCursorSeq.mockResolvedValueOnce(null);
    const res = await request(server, 'GET', `/identity/log/${USER_ID}?since=${'r'.repeat(64)}`);
    expect(res.status).toBe(400);
    expect(mockGetPublicLogSince).not.toHaveBeenCalled();
  });

  it('serves the log of a post-cutover account', async () => {
    // The premise: the deleted guard rejected this id shape outright, so a node
    // could never replicate the chain of an account minted after the cutover.
    expect(USER_ID).not.toMatch(/^[0-9a-f]{24}$/i);
    mockGetPublicLogSince.mockResolvedValueOnce([envelope(0)]);

    const res = await request(server, 'GET', `/identity/log/${USER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('answers a malformed id with the same empty log, by asking the store', async () => {
    // An unknown account already answered the empty log — the guard only made a
    // MALFORMED id a different outcome, which is the CastError shim, not a
    // contract.
    mockGetPublicLogSince.mockResolvedValueOnce([]);

    const res = await request(server, 'GET', '/identity/log/not-an-id');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ records: [], count: 0 });
    expect(mockGetPublicLogSince).toHaveBeenCalledWith('not-an-id', -1, undefined);
  });
});

describe('GET /identity/head/:userId', () => {
  it('returns the chain head', async () => {
    mockGetHead.mockResolvedValueOnce({ seq: 5, headRecordId: 'abc', recordCount: 6 });
    const res = await request(server, 'GET', `/identity/head/${USER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: 5, headRecordId: 'abc', recordCount: 6 });
  });

  it('returns the empty form when there is no chain', async () => {
    mockGetHead.mockResolvedValueOnce(null);
    const res = await request(server, 'GET', `/identity/head/${USER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: -1, headRecordId: null, recordCount: 0 });
  });

  it('answers a malformed id with the same empty form', async () => {
    mockGetHead.mockResolvedValueOnce(null);
    const res = await request(server, 'GET', '/identity/head/not-an-id');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: -1, headRecordId: null, recordCount: 0 });
    expect(mockGetHead).toHaveBeenCalledWith('not-an-id');
  });
});
