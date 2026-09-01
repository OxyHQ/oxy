/**
 * Route-shape tests for the public transparency-log endpoints.
 *
 * These endpoints exist to be consumed by people auditing Oxy, including from
 * other origins and from tooling that is not a browser — so this suite locks
 * that they are PUBLIC (no auth), CORS-open, and that the response shapes match
 * the `@oxyhq/contracts` schemas a verifier parses. The service is mocked; the
 * checkpoint math is covered in the service and protocol suites.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { transparencyCheckpointSchema, transparencyInclusionProofSchema } from '@oxyhq/contracts';

const CHECKPOINT = {
  index: 3,
  periodEnd: 1_800_000_000_000,
  treeSize: 2,
  root: 'a'.repeat(64),
  prevCheckpointHash: 'b'.repeat(64),
  signatures: [{ publicKey: '04'.padEnd(130, 'a'), alg: 'ES256K-DER-SHA256', signature: 'sig' }],
  anchors: [],
};

const PROOF = {
  checkpoint: CHECKPOINT,
  subjectDid: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
  seq: 4,
  headRecordId: 'd'.repeat(64),
  leaf: 'e'.repeat(64),
  leafIndex: 1,
  proof: ['f'.repeat(64)],
};

const mockGetLatest = jest.fn();
const mockGetCheckpoint = jest.fn();
const mockListCheckpoints = jest.fn();
const mockGetInclusionProof = jest.fn();

jest.mock('../../services/transparency.service', () => ({
  getLatestCheckpoint: () => mockGetLatest(),
  getCheckpoint: (...args: unknown[]) => mockGetCheckpoint(...args),
  listCheckpoints: (...args: unknown[]) => mockListCheckpoints(...args),
  getInclusionProof: (...args: unknown[]) => mockGetInclusionProof(...args),
}));

// The limiter is Redis-backed in production; the route shape is what matters here.
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import transparencyRoutes from '../transparency';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server;

beforeAll(async () => {
  const app = express();
  app.use('/transparency', transparencyRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLatest.mockResolvedValue(CHECKPOINT);
  mockGetCheckpoint.mockResolvedValue(CHECKPOINT);
  mockListCheckpoints.mockResolvedValue([CHECKPOINT]);
  mockGetInclusionProof.mockResolvedValue(PROOF);
});

async function get(path: string): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', host: '127.0.0.1', port, path }, (res) => {
      let raw = '';
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: raw.length ? JSON.parse(raw) : {},
          headers: res.headers,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /transparency/checkpoints/latest', () => {
  it('serves the newest checkpoint in the contract shape', async () => {
    const res = await get('/transparency/checkpoints/latest');
    expect(res.status).toBe(200);
    expect(transparencyCheckpointSchema.safeParse(res.body).success).toBe(true);
  });

  it('is CORS-open, so any origin can audit', async () => {
    const res = await get('/transparency/checkpoints/latest');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('404s before the first checkpoint is published', async () => {
    mockGetLatest.mockResolvedValue(null);
    const res = await get('/transparency/checkpoints/latest');
    expect(res.status).toBe(404);
  });
});

describe('GET /transparency/checkpoints/:index', () => {
  it('serves a checkpoint by index', async () => {
    const res = await get('/transparency/checkpoints/3');
    expect(res.status).toBe(200);
    expect(mockGetCheckpoint).toHaveBeenCalledWith(3);
    expect(transparencyCheckpointSchema.safeParse(res.body).success).toBe(true);
  });

  it('does not shadow the latest route with the index route', async () => {
    // `/latest` must never be parsed as an index; the ordering of the two route
    // registrations is what guarantees it.
    await get('/transparency/checkpoints/latest');
    expect(mockGetCheckpoint).not.toHaveBeenCalled();
    expect(mockGetLatest).toHaveBeenCalled();
  });

  it('rejects a non-numeric index', async () => {
    const res = await get('/transparency/checkpoints/abc');
    expect(res.status).toBe(400);
  });

  it('rejects a negative index', async () => {
    const res = await get('/transparency/checkpoints/-1');
    expect(res.status).toBe(400);
  });

  it('404s for an index that was never published', async () => {
    mockGetCheckpoint.mockResolvedValue(null);
    const res = await get('/transparency/checkpoints/99');
    expect(res.status).toBe(404);
  });
});

describe('GET /transparency/checkpoints', () => {
  it('lists the checkpoint chain from a cursor', async () => {
    const res = await get('/transparency/checkpoints?since=2');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checkpoints)).toBe(true);
    expect(mockListCheckpoints).toHaveBeenCalledWith(2, expect.any(Number));
  });

  it('defaults the cursor to genesis', async () => {
    await get('/transparency/checkpoints');
    expect(mockListCheckpoints).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it('caps the page size so one request cannot pull the whole log', async () => {
    await get('/transparency/checkpoints?limit=100000');
    const [, limit] = mockListCheckpoints.mock.calls[0] as [number, number];
    expect(limit).toBeLessThanOrEqual(200);
  });

  it('rejects a malformed since cursor', async () => {
    const res = await get('/transparency/checkpoints?since=abc');
    expect(res.status).toBe(400);
    expect(mockListCheckpoints).not.toHaveBeenCalled();
  });

  it('rejects a negative limit', async () => {
    const res = await get('/transparency/checkpoints?limit=-1');
    expect(res.status).toBe(400);
    expect(mockListCheckpoints).not.toHaveBeenCalled();
  });
});

describe('GET /transparency/proof', () => {
  it('serves an inclusion proof for a subject against the latest checkpoint', async () => {
    const res = await get(`/transparency/proof?subject=${encodeURIComponent(PROOF.subjectDid)}`);
    expect(res.status).toBe(200);
    expect(mockGetInclusionProof).toHaveBeenCalledWith(PROOF.subjectDid, undefined);
    expect(transparencyInclusionProofSchema.safeParse(res.body).success).toBe(true);
  });

  it('serves a proof against a specific checkpoint', async () => {
    await get(`/transparency/proof?subject=${encodeURIComponent(PROOF.subjectDid)}&index=3`);
    expect(mockGetInclusionProof).toHaveBeenCalledWith(PROOF.subjectDid, 3);
  });

  it('requires a subject rather than dumping the leaf set', async () => {
    const res = await get('/transparency/proof');
    expect(res.status).toBe(400);
    expect(mockGetInclusionProof).not.toHaveBeenCalled();
  });

  it('404s when the subject is not in the checkpoint', async () => {
    mockGetInclusionProof.mockResolvedValue(null);
    const res = await get('/transparency/proof?subject=did:web:oxy.so:u:nobody');
    expect(res.status).toBe(404);
  });
});
