/**
 * Admin route authorization tests — the security core of the publish API. A
 * service token may only publish to its OWN app and only with the
 * `updates:publish` scope; a user bearer needs the `updates:manage` application
 * permission (owner/admin/developer).
 *
 * The permission map (`accountRoles`), the contract schemas and the
 * `applications` rows the route resolves ownership from are REAL; the token
 * verifier, session middleware, account service and publish service are mocked.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const mockVerify = jest.fn();
const mockAuthMiddleware = jest.fn();
const mockResolveAccess = jest.fn();
const mockCreateUpdate = jest.fn();

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/serviceToken', () => ({
  __esModule: true,
  verifyServiceToken: (...a: unknown[]) => mockVerify(...a),
}));
jest.mock('../../middleware/auth', () => ({
  __esModule: true,
  authMiddleware: (...a: unknown[]) => mockAuthMiddleware(...a),
}));
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: { resolveEffectiveAccess: (...a: unknown[]) => mockResolveAccess(...a) },
}));
jest.mock('../../services/updates/publish.service', () => ({
  __esModule: true,
  initAssets: jest.fn(),
  completeAssets: jest.fn(),
  createUpdate: (...a: unknown[]) => mockCreateUpdate(...a),
  setRollout: jest.fn(),
  rollback: jest.fn(),
  rollbackToEmbedded: jest.fn(),
  promote: jest.fn(),
  listChannels: jest.fn(),
  listUpdates: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import adminRouter from '../updatesAdmin';
import { errorHandler } from '../../middleware/errorHandler';
import {
  resolveEffectivePermissions,
  type AccountPermission,
  type AccountRole,
} from '../../utils/accountRoles';

function makeServer(): http.Server {
  const app = express();
  app.use(express.json());
  app.use('/updates/v1', adminRouter);
  app.use(errorHandler);
  return http.createServer(app);
}

async function post(
  server: http.Server,
  path: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** A real application, plus the id of the account that owns it. */
async function application(
  status: 'active' | 'deleted' = 'active'
): Promise<{ applicationId: string; ownerAccountId: string }> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({
    id: users.id,
  });
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `OTA ${randomUUID()}`, ownerAccountId: owner.id, status })
    .returning({ id: applications.id });
  return { applicationId: row.id, ownerAccountId: owner.id };
}

function createBody(applicationId: string): Record<string, unknown> {
  return {
    applicationId,
    channel: 'production',
    runtimeVersion: '1.0.0',
    platform: 'ios',
    launchAsset: { sha256: SHA_A, key: 'bundle', contentType: 'application/javascript' },
    assets: [{ sha256: SHA_B, key: 'img', contentType: 'image/png', fileExtension: '.png' }],
    extra: { expoClient: { name: 'demo' } },
  };
}

let server: http.Server;
let appId: string;
let ownerAccountId: string;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateUpdate.mockResolvedValue({ id: 'new-uuid' });
  ({ applicationId: appId, ownerAccountId } = await application());
  server = makeServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterEach((done) => {
  server.close(done);
});

describe('service-token authorization', () => {
  test('valid scope + matching appId → publishes', async () => {
    mockVerify.mockReturnValue({
      ok: true,
      payload: { type: 'service', appId, appName: 'x', credentialId: 'c', scopes: ['updates:publish'] },
    });
    const { status } = await post(server, '/updates/v1/updates', createBody(appId));
    expect(status).toBe(200);
    expect(mockCreateUpdate).toHaveBeenCalledTimes(1);
  });

  test('missing updates:publish scope → 403', async () => {
    mockVerify.mockReturnValue({
      ok: true,
      payload: { type: 'service', appId, appName: 'x', credentialId: 'c', scopes: ['files:read'] },
    });
    const { status } = await post(server, '/updates/v1/updates', createBody(appId));
    expect(status).toBe(403);
    expect(mockCreateUpdate).not.toHaveBeenCalled();
  });

  test('appId not matching the target application → 403', async () => {
    const other = await application();
    mockVerify.mockReturnValue({
      ok: true,
      payload: {
        type: 'service',
        appId: other.applicationId,
        appName: 'x',
        credentialId: 'c',
        scopes: ['updates:publish'],
      },
    });
    const { status } = await post(server, '/updates/v1/updates', createBody(appId));
    expect(status).toBe(403);
    expect(mockCreateUpdate).not.toHaveBeenCalled();
  });
});

describe('user-bearer authorization', () => {
  beforeEach(() => {
    // Not a service token → fall through to the (mocked) session middleware.
    mockVerify.mockReturnValue({ ok: false, reason: 'not_service' });
  });

  function authAs(userId: string): void {
    mockAuthMiddleware.mockImplementation((req: express.Request, _res: express.Response, next: () => void) => {
      (req as express.Request & { user?: unknown }).user = { _id: { toString: () => userId } };
      next();
    });
  }

  /**
   * What the REAL `resolveEffectiveAccess` returns: a role AND the effective
   * permission list, which is the role's baseline with the membership row's own
   * deltas applied. A fake returning only `{ role }` would let this suite pass
   * over a gate that had stopped reading the deltas — which is the bug the
   * `revokes` argument below exists to catch (issue #978).
   */
  function accessAs(
    role: AccountRole,
    deltas: { grants?: AccountPermission[]; revokes?: AccountPermission[] } = {}
  ) {
    return {
      role,
      permissions: resolveEffectivePermissions(role, deltas.grants ?? [], deltas.revokes ?? []),
      source: 'direct' as const,
      membership: null,
    };
  }

  test('developer role (has updates:manage) → publishes', async () => {
    authAs('user1');
    mockResolveAccess.mockResolvedValue(accessAs('developer'));
    const { status } = await post(server, '/updates/v1/updates', createBody(appId));
    expect(status).toBe(200);
    expect(mockCreateUpdate).toHaveBeenCalledTimes(1);
    // Access is resolved against the OWNING ACCOUNT read from the row, never
    // against an id the request supplied.
    expect(mockResolveAccess).toHaveBeenCalledWith('user1', ownerAccountId);
  });

  test('owner role → publishes', async () => {
    authAs('user1');
    mockResolveAccess.mockResolvedValue(accessAs('owner'));
    const { status } = await post(server, '/updates/v1/updates', createBody(appId));
    expect(status).toBe(200);
  });

  test('viewer role (no updates:manage) → 403', async () => {
    authAs('user1');
    mockResolveAccess.mockResolvedValue(accessAs('viewer'));
    const { status } = await post(server, '/updates/v1/updates', createBody(appId));
    expect(status).toBe(403);
    expect(mockCreateUpdate).not.toHaveBeenCalled();
  });

  test('an admin whose apps:update was REVOKED cannot publish (issue #978)', async () => {
    // `updates:manage` answers to `apps:update`: publishing replaces the code
    // the app ships, so withdrawing the right to update the account's apps
    // withdraws this too. The pair is what makes it a gate — the control differs
    // only by the revoke.
    authAs('user1');
    mockResolveAccess.mockResolvedValue(accessAs('admin', { revokes: ['apps:update'] }));
    const revoked = await post(server, '/updates/v1/updates', createBody(appId));
    expect(revoked.status).toBe(403);
    expect(mockCreateUpdate).not.toHaveBeenCalled();

    mockResolveAccess.mockResolvedValue(accessAs('admin'));
    const permitted = await post(server, '/updates/v1/updates', createBody(appId));
    expect(permitted.status).toBe(200);
    expect(mockCreateUpdate).toHaveBeenCalledTimes(1);
  });

  test('no account access to the app → 403', async () => {
    authAs('user1');
    mockResolveAccess.mockResolvedValue(null);
    const { status } = await post(server, '/updates/v1/updates', createBody(appId));
    expect(status).toBe(403);
  });

  test('an applicationId that names no row → 404, whatever its shape', async () => {
    authAs('user1');
    mockResolveAccess.mockResolvedValue(accessAs('owner'));
    // There is no id-shape guard any more: the only question is whether the row
    // exists, which is a 404 for a uuid and for a string that never could be one.
    for (const missing of [randomUUID(), 'not-an-id-at-all']) {
      const { status } = await post(server, '/updates/v1/updates', createBody(missing));
      expect(status).toBe(404);
    }
    expect(mockCreateUpdate).not.toHaveBeenCalled();
  });

  test('a soft-deleted application → 404', async () => {
    authAs('user1');
    mockResolveAccess.mockResolvedValue(accessAs('owner'));
    const deleted = await application('deleted');
    const { status } = await post(server, '/updates/v1/updates', createBody(deleted.applicationId));
    expect(status).toBe(404);
    expect(mockCreateUpdate).not.toHaveBeenCalled();
  });
});

describe('request validation', () => {
  test('an invalid body is rejected before any authorization side effects', async () => {
    mockVerify.mockReturnValue({
      ok: true,
      payload: { type: 'service', appId, appName: 'x', credentialId: 'c', scopes: ['updates:publish'] },
    });
    // Missing launchAsset/assets/extra → schema failure → 422 (ValidationError).
    const { status } = await post(server, '/updates/v1/updates', {
      applicationId: appId,
      channel: 'production',
      runtimeVersion: '1.0.0',
      platform: 'ios',
    });
    expect(status).toBe(422);
    expect(mockCreateUpdate).not.toHaveBeenCalled();
  });
});
