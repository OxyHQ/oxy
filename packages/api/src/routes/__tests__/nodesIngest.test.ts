/**
 * The F5b ingest-notify endpoint, against a REAL Postgres.
 *
 * `POST /nodes/ingest/notify/:userId` is an unauthenticated HINT: it enqueues a
 * background re-pull of the NAMED user's own node and answers 202 either way.
 * The only observable difference between "hint accepted and scheduled" and "hint
 * accepted and dropped" is whether the queue was touched, so that is what these
 * cases assert.
 *
 * ## Why this suite no longer mocks the model
 *
 * It used to replace `models/UserNode` with a `jest.fn()` and assert the FILTER
 * OBJECT the route passed it (`{ userId, status: { $ne: 'revoked' } }`). That is
 * a statement about a query's SHAPE, and a shape assertion stays green against a
 * port that queries nothing, because the shape it describes no longer exists.
 * Here the rows are real and the assertions are about which ids reach the queue.
 *
 * ## The case the old suite asserted BACKWARDS
 *
 * Its third case fed `not-an-id` and asserted the model was never touched,
 * locking in the `isValidObjectId` pre-filter. That filter was a Mongoose
 * `CastError` guard, and it silently rejected every uuid v7 — i.e. every account
 * minted since the Postgres cutover — so the notify was a permanent no-op for
 * exactly those accounts, with an identical 202 to hide it. The port deletes the
 * guard; this suite pins the consequence with a uuid-v7 account that HAS a node
 * and must be enqueued.
 *
 * The queue is mocked (this is not a test about BullMQ); the node registry is
 * mocked away from the OTHER routes in the router. The `user_nodes` rows, the
 * `status <> 'revoked'` filter and the `user_id` foreign key are real.
 */

const mockEnqueue = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../queue/nodeIngest.queue', () => ({
  enqueueNodeIngest: (...a: unknown[]) => mockEnqueue(...a),
}));
jest.mock('../../services/nodeRegistry.service', () => ({
  getUserNode: jest.fn(),
  removeNode: jest.fn(),
  provisionManagedVault: jest.fn(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userNodes, type USER_NODE_STATUSES } from '../../db/schema/userNodes';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import nodeRoutes from '../nodes';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

async function post(path: string): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertNode(
  userId: string,
  status: (typeof USER_NODE_STATUSES)[number]
): Promise<void> {
  await getDb().insert(userNodes).values({
    userId,
    endpoint: 'https://node.example',
    nodePublicKey: '04'.repeat(33),
    status,
  });
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/nodes', nodeRoutes);
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
  jest.clearAllMocks();
});

describe('POST /nodes/ingest/notify/:userId', () => {
  it('enqueues a background ingest + returns 202 when the user has a node', async () => {
    const userId = await insertUser();
    await insertNode(userId, 'active');

    const res = await post(`/nodes/ingest/notify/${userId}`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(mockEnqueue).toHaveBeenCalledWith(userId);
  });

  it('enqueues for an `unreachable` node — only `revoked` opts out', async () => {
    const userId = await insertUser();
    await insertNode(userId, 'unreachable');

    const res = await post(`/nodes/ingest/notify/${userId}`);

    expect(res.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith(userId);
  });

  it('returns 202 WITHOUT enqueueing when the node is revoked', async () => {
    const userId = await insertUser();
    await insertNode(userId, 'revoked');

    const res = await post(`/nodes/ingest/notify/${userId}`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('returns 202 WITHOUT enqueueing when the user has no node', async () => {
    const userId = await insertUser();

    const res = await post(`/nodes/ingest/notify/${userId}`);

    expect(res.status).toBe(202);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('returns 202 WITHOUT enqueueing for an id that matches no row', async () => {
    const res = await post(`/nodes/ingest/notify/${randomUUID()}`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('answers a free-form id with 202 and no enqueue — text ids just match nothing', async () => {
    const res = await post('/nodes/ingest/notify/not-an-id');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('enqueues for a POST-CUTOVER uuid v7 account — what the deleted ObjectId guard blocked', async () => {
    // `insertUser` takes the schema's own `generatedId()` default, which IS a
    // uuid v7 — the id shape every account minted since the cutover carries and
    // the one `isValidObjectId` rejected outright.
    const userId = await insertUser();
    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await insertNode(userId, 'active');

    const res = await post(`/nodes/ingest/notify/${userId}`);

    expect(res.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith(userId);
  });
});
