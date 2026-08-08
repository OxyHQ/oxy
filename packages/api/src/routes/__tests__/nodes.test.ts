/**
 * Route-shape tests for the user-node management endpoints (F5a).
 *
 *  - GET    /nodes/me → { node } (serialized) or { node: null }
 *  - DELETE /nodes/me → { success: true } | 404 when nothing to revoke
 *
 * The nodeRegistry service is mocked; this suite locks the HTTP shapes and that
 * the owner id is resolved from the session (never the body).
 */

const mockGetUserNode = jest.fn();
const mockRemoveNode = jest.fn();

const USER_ID = '507f1f77bcf86cd799439011';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: USER_ID, id: USER_ID };
    next();
  },
  AuthRequest: class {},
}));

jest.mock('../../services/nodeRegistry.service', () => ({
  getUserNode: (...args: unknown[]) => mockGetUserNode(...args),
  removeNode: (...args: unknown[]) => mockRemoveNode(...args),
}));

// F5b additions to routes/nodes.ts pull in the ObjectId validator (which loads
// the heavy User model), the ingest queue (BullMQ), and the UserNode model.
// Mock them so this F5a unit suite stays isolated (no DB / no BullMQ).
jest.mock('../../utils/validation', () => ({ isValidObjectId: (id: string) => /^[a-f0-9]{24}$/i.test(id) }));
jest.mock('../../queue/nodeIngest.queue', () => ({ enqueueNodeIngest: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import nodeRoutes from '../nodes';
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

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/nodes', nodeRoutes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});
afterAll((done) => { server.close(done); });
beforeEach(() => { jest.clearAllMocks(); });

describe('GET /nodes/me', () => {
  it('returns the serialized node for the caller', async () => {
    mockGetUserNode.mockResolvedValueOnce({
      userId: USER_ID,
      endpoint: 'https://node.example.com',
      nodePublicKey: 'ab'.repeat(33),
      mode: 'pull',
      status: 'active',
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await request(server, 'GET', '/nodes/me');

    expect(res.status).toBe(200);
    expect(mockGetUserNode).toHaveBeenCalledWith(USER_ID);
    const node = res.body.node as Record<string, unknown>;
    expect(node).toMatchObject({ endpoint: 'https://node.example.com', mode: 'pull', status: 'active' });
    // Mongo internals are not leaked.
    expect(node.userId).toBeUndefined();
    expect(node._id).toBeUndefined();
  });

  it('returns { node: null } when the caller has no node', async () => {
    mockGetUserNode.mockResolvedValueOnce(null);
    const res = await request(server, 'GET', '/nodes/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ node: null });
  });
});

describe('DELETE /nodes/me', () => {
  it('revokes the node and returns { success: true }', async () => {
    mockRemoveNode.mockResolvedValueOnce(true);
    const res = await request(server, 'DELETE', '/nodes/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockRemoveNode).toHaveBeenCalledWith(USER_ID);
  });

  it('returns 404 when there is no active node to revoke', async () => {
    mockRemoveNode.mockResolvedValueOnce(false);
    const res = await request(server, 'DELETE', '/nodes/me');
    expect(res.status).toBe(404);
  });
});
