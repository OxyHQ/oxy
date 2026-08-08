/**
 * Route-shape tests for the v2 chain-head endpoint (F0.2).
 *
 * Locks the EXACT public response shape a client fetches before signing the next
 * v2 record:
 *  - GET /identity/records/:userId/chain/head
 *      → with a chain: { headRecordId: string, seq: number, recordCount: number }
 *      → no chain yet:  { headRecordId: null, seq: -1, recordCount: 0 }
 *
 * ## Why the id format is load-bearing here
 *
 * `@oxyhq/core` fetches this endpoint IMMEDIATELY BEFORE signing every v2 record
 * (`OxyServices.civic.ts` `_signMyCivicRecordV2`, `OxyServices.nodes.ts`
 * `registerMyNode`) to learn the `seq`/`prev` it must sign over. The route used
 * to run `:userId` through the legacy 24-hex id predicate in
 * `utils/validation.ts` and throw a 404 on a miss — which rejects the uuid v7
 * every account minted since the Postgres cutover carries, so the fetch threw
 * and NO civic record or node registration could be signed at all for such an
 * account. The guard is deleted; a uuid v7 and an unknown id now both resolve to
 * the chain the store actually holds.
 *
 * The repoLog SERVICE is mocked; this suite only locks the HTTP shape + that the
 * route is PUBLIC (no auth applied) and CORS-open.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';

/** A post-cutover account id — the shape the deleted guard rejected. */
const USER_ID = randomUUID();

const mockGetHead = jest.fn();

// authMiddleware is mocked but the chain-head route does NOT use it (public).
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../services/repoLog.service', () => ({
  getHead: (...args: unknown[]) => mockGetHead(...args),
}));

jest.mock('../../services/signedRecord.service', () => ({
  verifyAndStoreRecord: jest.fn(),
  verifyEnvelope: jest.fn(),
  getLatestRecord: jest.fn(),
}));

// nodeRegistry.service is transitively imported by the identity routes (F5a);
// mock it so this suite exercises the chain-head route and not the node registry.
jest.mock('../../services/nodeRegistry.service', () => ({
  materializeNodeFromRecord: jest.fn(),
  getUserNode: jest.fn(() => Promise.resolve(null)),
  removeNode: jest.fn(),
  probeLiveness: jest.fn(),
  sweepNodeLiveness: jest.fn(),
}));

jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: jest.fn() } }));
jest.mock('@oxyhq/core/server', () => ({ safeFetch: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import identityRoutes from '../identity';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

async function request(server: http.Server, path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {}, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
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

describe('GET /identity/records/:userId/chain/head', () => {
  it('returns { headRecordId, seq, recordCount } when a chain exists', async () => {
    // The id is a post-cutover uuid v7: the deleted guard 404'd here without
    // ever calling the store, which aborts every v2 signature client-side.
    expect(USER_ID).not.toMatch(/^[0-9a-f]{24}$/i);
    mockGetHead.mockResolvedValueOnce({ headRecordId: 'a'.repeat(64), seq: 3, recordCount: 4 });

    const res = await request(server, `/identity/records/${USER_ID}/chain/head`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ headRecordId: 'a'.repeat(64), seq: 3, recordCount: 4 });
    expect(mockGetHead).toHaveBeenCalledWith(USER_ID);
    // Public + CORS-open + cacheable.
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('returns an empty head for a user with no chain', async () => {
    mockGetHead.mockResolvedValueOnce(null);

    const res = await request(server, `/identity/records/${USER_ID}/chain/head`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ headRecordId: null, seq: -1, recordCount: 0 });
  });

  it('answers a malformed id with the same empty head, by asking the store', async () => {
    // The guard that used to 404 here was the CastError shim: an unknown account
    // already answered the empty chain, so a malformed id now does the same
    // rather than being a separate, id-shape-dependent outcome.
    mockGetHead.mockResolvedValueOnce(null);

    const res = await request(server, '/identity/records/not-an-objectid/chain/head');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ headRecordId: null, seq: -1, recordCount: 0 });
    expect(mockGetHead).toHaveBeenCalledWith('not-an-objectid');
  });
});
