/**
 * `/security/activity` — the controller's own contract.
 *
 * ## Why this suite mocks its data source
 *
 * The service is now on Drizzle, and its own real-Postgres suite
 * (`services/__tests__/securityActivityService.test.ts`) holds the query
 * properties — including the one this file cannot: "this endpoint never returns
 * another user's rows" is a property of a QUERY, and a mocked query cannot hold
 * it. It is asserted there against real rows, for real accounts.
 *
 * The service stays mocked HERE so the cases below isolate what lives in the
 * controller:
 *
 *  - the pagination envelope, exactly (`sendPaginated`'s `{data, pagination}`),
 *  - the DTO field NAMES on the wire — in particular `timestamp`, which the
 *    table calls `occurred_at`; the rename must never reach a client, and the
 *    controller is the single place that translation happens,
 *  - the closed event-type set, and that an unknown value is a 400,
 *  - that the account read is taken from the AUTHENTICATED caller and from
 *    nowhere else, so no request-supplied parameter can widen it.
 *
 * The last one is the controller's half of the isolation guarantee: it proves
 * the endpoint has no widening INPUT. The service suite proves the predicate
 * itself is scoped.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockAuthMiddleware = jest.fn();
const mockGetUserSecurityActivity = jest.fn();
const mockLogPrivateKeyExported = jest.fn();
const mockLogBackupCreated = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...a: unknown[]) => mockAuthMiddleware(...a),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: {
    getUserSecurityActivity: (...a: unknown[]) => mockGetUserSecurityActivity(...a),
    logPrivateKeyExported: (...a: unknown[]) => mockLogPrivateKeyExported(...a),
    logBackupCreated: (...a: unknown[]) => mockLogBackupCreated(...a),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { SECURITY_EVENT_TYPES } from '../../db/schema/securityActivities';
import securityRouter from '../../routes/security';
import { errorHandler } from '../../middleware/errorHandler';

const CALLER = '64b0000000000000000000aa';

/**
 * One stored row as the service hands it back — a `SecurityActivityRecord`, with
 * `id`/`userId` as plain strings and the EVENT time as `occurredAt`. The DTO
 * cases below are what pin that `occurredAt` reaches the wire as `timestamp`.
 */
function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    userId: CALLER,
    eventType: 'sign_in',
    eventDescription: 'User signed in',
    metadata: { deviceName: 'Chrome on Linux' },
    userAgent: 'Mozilla/5.0',
    deviceId: 'dev-1',
    occurredAt: new Date('2026-07-07T00:00:00.000Z'),
    severity: 'low',
    createdAt: new Date('2026-07-07T00:00:01.000Z'),
    ...overrides,
  };
}

async function requestJson(method: string, path: string, payload?: unknown) {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          Authorization: 'Bearer t',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let server: http.Server;
/** Whether the mocked bearer layer names a caller. Flipped for the 401 cases. */
let authenticated = true;

beforeAll(async () => {
  mockAuthMiddleware.mockImplementation((req: { user?: unknown }, _res: unknown, next: () => void) => {
    if (authenticated) req.user = { _id: { toString: () => CALLER }, id: CALLER };
    next();
  });
  const app = express();
  app.use(express.json());
  app.use('/security', securityRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  mockGetUserSecurityActivity.mockResolvedValue({ activities: [], total: 0, hasMore: false });
  mockLogPrivateKeyExported.mockResolvedValue(undefined);
  mockLogBackupCreated.mockResolvedValue(undefined);
});

describe('GET /security/activity — pagination contract', () => {
  it('returns the sendPaginated envelope, not a bare array or a cursor page', async () => {
    mockGetUserSecurityActivity.mockResolvedValueOnce({
      activities: [activityRow()],
      total: 137,
      hasMore: true,
    });

    const res = await requestJson('GET', '/security/activity?limit=25&offset=50');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'pagination']);
    expect(res.body.pagination).toEqual({
      total: 137,
      limit: 25,
      offset: 50,
      hasMore: true,
    });
    expect(mockGetUserSecurityActivity).toHaveBeenCalledWith(CALLER, {
      limit: 25,
      offset: 50,
      eventType: undefined,
    });
  });

  it('defaults to limit 50 / offset 0 when neither is supplied', async () => {
    await requestJson('GET', '/security/activity');
    expect(mockGetUserSecurityActivity).toHaveBeenCalledWith(CALLER, {
      limit: 50,
      offset: 0,
      eventType: undefined,
    });
  });

  it('clamps limit to the 100 maximum and floors offset at 0', async () => {
    await requestJson('GET', '/security/activity?limit=5000&offset=-10');
    expect(mockGetUserSecurityActivity).toHaveBeenCalledWith(CALLER, {
      limit: 100,
      offset: 0,
      eventType: undefined,
    });
  });

  it('reports hasMore from the service rather than recomputing it differently', async () => {
    mockGetUserSecurityActivity.mockResolvedValueOnce({ activities: [], total: 10, hasMore: false });
    const res = await requestJson('GET', '/security/activity?limit=50&offset=0');
    // `sendPaginated` derives it as offset + limit < total — 0 + 50 < 10 is false.
    expect((res.body.pagination as { hasMore: boolean }).hasMore).toBe(false);
  });
});

describe('GET /security/activity — the wire DTO', () => {
  it('emits exactly the documented field set, with `timestamp` (never the table\'s occurred_at)', async () => {
    mockGetUserSecurityActivity.mockResolvedValueOnce({
      activities: [activityRow()],
      total: 1,
      hasMore: false,
    });

    const res = await requestJson('GET', '/security/activity');

    const [item] = res.body.data as Record<string, unknown>[];
    expect(Object.keys(item).sort()).toEqual([
      'createdAt',
      'deviceId',
      'eventDescription',
      'eventType',
      'id',
      'metadata',
      'severity',
      'timestamp',
      'userAgent',
      'userId',
    ]);
    expect(item.id).toBe('act-1');
    expect(item.userId).toBe(CALLER);
    expect(item.timestamp).toBe('2026-07-07T00:00:00.000Z');
    expect(item.createdAt).toBe('2026-07-07T00:00:01.000Z');
    expect(item.metadata).toEqual({ deviceName: 'Chrome on Linux' });
  });

  it('never emits an IP or a location field, whatever the stored row carries', async () => {
    // A row that smuggled an address through the open `metadata` column must
    // not cause a TOP-LEVEL address field to appear — the DTO is a fixed set.
    mockGetUserSecurityActivity.mockResolvedValueOnce({
      activities: [activityRow({ ipAddress: '203.0.113.7', location: 'Berlin', country: 'DE' })],
      total: 1,
      hasMore: false,
    });

    const res = await requestJson('GET', '/security/activity');

    const [item] = res.body.data as Record<string, unknown>[];
    expect(item).not.toHaveProperty('ipAddress');
    expect(item).not.toHaveProperty('ip');
    expect(item).not.toHaveProperty('location');
    expect(item).not.toHaveProperty('country');
  });

  it('passes an event with no detail through as an empty object', async () => {
    // The controller no longer coalesces: `SecurityActivityRecord.metadata` is a
    // non-optional object, normalized once by the service at the single point a
    // stored value is read (`toRecord`) — a scalar, an array or a `null` in the
    // `jsonb` column all become `{}` there, which is asserted against real rows
    // in `services/__tests__/securityActivityService.test.ts`. A `|| {}` here
    // would be a second normalization defending against its own type.
    mockGetUserSecurityActivity.mockResolvedValueOnce({
      activities: [activityRow({ metadata: {} })],
      total: 1,
      hasMore: false,
    });
    const res = await requestJson('GET', '/security/activity');
    expect((res.body.data as Record<string, unknown>[])[0].metadata).toEqual({});
  });
});

describe('GET /security/activity — account scoping', () => {
  it('reads the account from the BEARER and ignores a request-supplied userId', async () => {
    await requestJson('GET', `/security/activity?userId=someone-else&user=someone-else`);
    // The only id that ever reaches the query is the authenticated caller's.
    expect(mockGetUserSecurityActivity).toHaveBeenCalledTimes(1);
    expect(mockGetUserSecurityActivity.mock.calls[0][0]).toBe(CALLER);
    expect(JSON.stringify(mockGetUserSecurityActivity.mock.calls[0])).not.toContain('someone-else');
  });

  it('401s without a caller, and never touches the data source', async () => {
    authenticated = false;
    const res = await requestJson('GET', '/security/activity');
    expect(res.status).toBe(401);
    expect(mockGetUserSecurityActivity).not.toHaveBeenCalled();
  });
});

describe('GET /security/activity — eventType filter', () => {
  it.each(SECURITY_EVENT_TYPES)('accepts the known event type %s', async (eventType) => {
    const res = await requestJson('GET', `/security/activity?eventType=${eventType}`);
    expect(res.status).toBe(200);
    expect(mockGetUserSecurityActivity).toHaveBeenCalledWith(CALLER, {
      limit: 50,
      offset: 0,
      eventType,
    });
  });

  it('400s an unknown event type without querying', async () => {
    const res = await requestJson('GET', '/security/activity?eventType=SIGN_IN');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid event type');
    expect(mockGetUserSecurityActivity).not.toHaveBeenCalled();
  });

  it('400s a repeated eventType parameter (an array is not a member of the set)', async () => {
    const res = await requestJson('GET', '/security/activity?eventType=sign_in&eventType=sign_out');
    expect(res.status).toBe(400);
    expect(mockGetUserSecurityActivity).not.toHaveBeenCalled();
  });

  it('treats an EMPTY eventType as "no filter" — unchanged from the Mongo behaviour', async () => {
    const res = await requestJson('GET', '/security/activity?eventType=');
    expect(res.status).toBe(200);
    expect(mockGetUserSecurityActivity).toHaveBeenCalledWith(CALLER, {
      limit: 50,
      offset: 0,
      eventType: undefined,
    });
  });

  it('500s (and does not leak the error) when the data source throws', async () => {
    mockGetUserSecurityActivity.mockRejectedValueOnce(new Error('connection refused: 127.0.0.1:5432'));
    const res = await requestJson('GET', '/security/activity');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch security activity' });
  });
});

describe('POST /security/activity/private-key-exported', () => {
  it('records the event for the authenticated caller', async () => {
    const res = await requestJson('POST', '/security/activity/private-key-exported', {
      deviceId: 'dev-1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockLogPrivateKeyExported).toHaveBeenCalledWith(CALLER, expect.anything(), 'dev-1');
  });

  it('accepts an absent deviceId', async () => {
    const res = await requestJson('POST', '/security/activity/private-key-exported', {});
    expect(res.status).toBe(200);
    expect(mockLogPrivateKeyExported).toHaveBeenCalledWith(CALLER, expect.anything(), undefined);
  });

  it('rejects a non-string deviceId at the schema, before the handler', async () => {
    const res = await requestJson('POST', '/security/activity/private-key-exported', { deviceId: 7 });
    expect(res.status).toBe(400);
    expect(mockLogPrivateKeyExported).not.toHaveBeenCalled();
  });

  it('500s when the write throws, without claiming success', async () => {
    mockLogPrivateKeyExported.mockRejectedValueOnce(new Error('down'));
    const res = await requestJson('POST', '/security/activity/private-key-exported', {});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to log security event' });
  });
});

describe('POST /security/activity/backup-created', () => {
  it('records the event for the authenticated caller', async () => {
    const res = await requestJson('POST', '/security/activity/backup-created', { deviceId: 'dev-2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockLogBackupCreated).toHaveBeenCalledWith(CALLER, expect.anything(), 'dev-2');
  });

  it('401s without a caller, and never writes', async () => {
    authenticated = false;
    const res = await requestJson('POST', '/security/activity/backup-created', {});
    expect(res.status).toBe(401);
    expect(mockLogBackupCreated).not.toHaveBeenCalled();
  });
});
