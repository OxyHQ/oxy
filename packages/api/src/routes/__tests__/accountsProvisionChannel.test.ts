/**
 * Service-scoped channel provisioning — `POST /accounts/service/channels` and
 * its two membership routes.
 *
 * Mounts the REAL accounts router over HTTP against a real Postgres, because the
 * gates being tested are all reads of stored values: the target's `kind`, its
 * `accountStatus`, and whether the named owner/member rows exist. Only the
 * service-token verification is mocked, so `req.serviceApp.scopes` can be driven
 * directly.
 *
 * THE TEST THAT MATTERS is `refuses to add a member to a non-channel account`.
 * Membership on a kind that CAN be acted as (`organization`/`project`/`bot`)
 * plus `account:act_as` is a session — so a membership endpoint that accepted an
 * arbitrary account id would let this credential add a principal to somebody's
 * organization and then have them switch into it. The `kind: 'channel'`
 * restriction is what keeps the scope bounded to publishing rights on an
 * identity nobody can occupy, and it is why this surface does not reopen what
 * the act-as predicates closed.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';

/**
 * Ids and usernames are MINTED PER TEST, and nothing is deleted globally.
 *
 * The whole jest run shares one database and suites execute in parallel, so a
 * `delete(users)` in `beforeEach` — the obvious way to get a clean slate — wipes
 * rows other suites are mid-assertion on. It passes in isolation and fails only
 * under the full run, which is the worst shape of flake to hand somebody.
 */
let seq = 0;
const uniqueId = (): string => `6b${String(++seq).padStart(6, '0')}${Date.now().toString(16)}`;
const uniqueUsername = (prefix: string): string => `${prefix}-${seq}-${Date.now().toString(36)}`;

let OWNER_ID = '';
let MEMBER_ID = '';
let ORG_ID = '';

let serviceScopes: string[] = ['accounts:provision'];

jest.mock('../../middleware/auth', () => ({
  // Never reached: every route under test is registered ABOVE the router's
  // `authMiddleware`, which is the ordering this suite also pins.
  authMiddleware: (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ message: 'session auth should not run for service routes' });
  },
  serviceAuthMiddleware: (
    req: { serviceApp?: { appId: string; scopes: string[] } },
    _res: unknown,
    next: () => void
  ) => {
    req.serviceApp = { appId: 'app_mention', scopes: serviceScopes };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/requireStaff', () => ({ isStaffUser: () => false }));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import accountsRouter from '../accounts';
import { errorHandler } from '../../middleware/errorHandler';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';

interface JsonResponse {
  status: number;
  body: Record<string, unknown> & {
    account?: { id?: string; kind?: string; name?: { displayName?: string } };
    member?: { role?: string; memberUserId?: string };
    message?: string;
  };
}

function request(
  srv: http.Server,
  method: 'POST' | 'DELETE',
  path: string,
  payload?: unknown
): Promise<JsonResponse> {
  const address = srv.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer service-token',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as JsonResponse['body']) : {},
          });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('service-scoped channel provisioning', () => {
  let server: http.Server;

  beforeAll(async () => {
    await connectPostgres();
    const app = express();
    app.use(express.json());
    app.use('/accounts', accountsRouter);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePostgres();
  });

  beforeEach(async () => {
    serviceScopes = ['accounts:provision'];
    OWNER_ID = uniqueId();
    MEMBER_ID = uniqueId();
    ORG_ID = uniqueId();
    await getDb().insert(users).values([
      { id: OWNER_ID, color: 'teal', username: uniqueUsername('owner'), kind: 'personal' },
      { id: MEMBER_ID, color: 'teal', username: uniqueUsername('member'), kind: 'personal' },
      { id: ORG_ID, color: 'teal', username: uniqueUsername('acme-org'), kind: 'organization' },
    ]);
  });

  it('mints a channel under the named owner, with an explicit display name', async () => {
    const res = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: OWNER_ID,
      username: uniqueUsername('notas-de-nate'),
      name: { displayName: 'Notas de Nate' },
    });

    expect(res.status).toBe(201);
    expect(res.body.account?.kind).toBe('channel');
    // The title is stored as the EXPLICIT display name, not smuggled into the
    // given-name field, which is the whole point of the `name_display` column.
    expect(res.body.account?.name?.displayName).toBe('Notas de Nate');

    const channelId = res.body.account?.id ?? '';
    const [row] = await getDb().select().from(users).where(eq(users.id, channelId));
    expect(row.nameDisplay).toBe('Notas de Nate');
    expect(row.nameFirst).toBeNull();
    expect(row.parentAccountId).toBe(OWNER_ID);

    // No login, ever: provisioning writes no credential of any kind.
    const methods = await getDb()
      .select({ id: userAuthMethods.id })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, channelId));
    expect(methods).toEqual([]);

    // The named owner is recorded as the channel's owner member.
    const [membership] = await getDb()
      .select()
      .from(accountMembers)
      .where(eq(accountMembers.accountId, channelId));
    expect(membership.memberUserId).toBe(OWNER_ID);
    expect(membership.role).toBe('owner');
  });

  it('refuses a credential without the accounts:provision scope', async () => {
    serviceScopes = ['files:read'];
    const res = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: OWNER_ID,
      username: uniqueUsername('nope'),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown owner', async () => {
    const res = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: '6b00000000000000000000ff',
      username: uniqueUsername('orphan'),
    });
    expect(res.status).toBe(404);
  });

  it('will not mint an account of any kind but channel', async () => {
    // `kind` is not part of the schema, so naming one is a 400 rather than a
    // silently-honoured escalation into a kind somebody could act as.
    const res = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: OWNER_ID,
      username: uniqueUsername('sneaky'),
      kind: 'organization',
    });
    expect(res.status).toBe(400);
  });

  it('grants membership on a channel', async () => {
    const created = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: OWNER_ID,
      username: uniqueUsername('daily-news'),
    });
    const channelId = created.body.account?.id ?? '';

    const res = await request(
      server,
      'POST',
      `/accounts/service/channels/${channelId}/members`,
      { memberUserId: MEMBER_ID, role: 'editor' }
    );

    expect(res.status).toBe(201);
    expect(res.body.member?.role).toBe('editor');

    const [membership] = await getDb()
      .select()
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, channelId),
          eq(accountMembers.memberUserId, MEMBER_ID)
        )
      );
    expect(membership.role).toBe('editor');
    expect(membership.status).toBe('active');
  });

  /**
   * The load-bearing gate. Without it this scope would grant "add any principal
   * to any organization", and org membership carrying `account:act_as` is a
   * session — the exact escalation `POST /accounts/:id/switch` refuses.
   */
  it('refuses to add a member to a non-channel account', async () => {
    const res = await request(server, 'POST', `/accounts/service/channels/${ORG_ID}/members`, {
      memberUserId: MEMBER_ID,
      role: 'editor',
    });

    expect(res.status).toBe(404);
    const rows = await getDb()
      .select()
      .from(accountMembers)
      .where(eq(accountMembers.accountId, ORG_ID));
    expect(rows).toEqual([]);
  });

  it('refuses to remove a member from a non-channel account', async () => {
    const res = await request(
      server,
      'DELETE',
      `/accounts/service/channels/${ORG_ID}/members/${MEMBER_ID}`
    );
    expect(res.status).toBe(404);
  });

  it('revokes membership on a channel by member user id', async () => {
    const created = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: OWNER_ID,
      username: uniqueUsername('weekly'),
    });
    const channelId = created.body.account?.id ?? '';
    await request(server, 'POST', `/accounts/service/channels/${channelId}/members`, {
      memberUserId: MEMBER_ID,
      role: 'editor',
    });

    const res = await request(
      server,
      'DELETE',
      `/accounts/service/channels/${channelId}/members/${MEMBER_ID}`
    );
    expect(res.status).toBe(204);

    const [membership] = await getDb()
      .select()
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, channelId),
          eq(accountMembers.memberUserId, MEMBER_ID)
        )
      );
    expect(membership?.status).toBe('removed');
  });

  it('will not let a channel own another channel', async () => {
    const created = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: OWNER_ID,
      username: uniqueUsername('parent-channel'),
    });
    const channelId = created.body.account?.id ?? '';

    const res = await request(server, 'POST', '/accounts/service/channels', {
      ownerUserId: channelId,
      username: uniqueUsername('child-channel'),
    });
    expect(res.status).toBe(400);
  });
});
