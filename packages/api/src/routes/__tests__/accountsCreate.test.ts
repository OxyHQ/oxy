/**
 * POST /accounts — user-scoped account creation guards.
 *
 * Every CHILD kind is creatable here with the caller's own bearer, `channel`
 * included. A channel was once refused, on the reasoning that channels are
 * service-provisioned only — but what keeps a channel safe does not depend on
 * who creates it: `createChildAccount` writes no auth method, and
 * `POST /accounts/:id/switch` refuses the kind, so no session can ever have a
 * channel as its subject. `personal` stays refused, by the schema: it is a human
 * login, minted at signup.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const OPERATOR_ID = '6c0000000000000000000001';

const mockCreateChildAccount = jest.fn();
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: {
    createChildAccount: (...args: unknown[]) => mockCreateChildAccount(...args),
    resolveEffectiveAccess: jest.fn(async () => ({
      role: 'owner',
      permissions: ['children:create'],
      inherit: true,
    })),
  },
}));

// The real `authMiddleware` assigns `{ ...user, id: user._id }`, so an
// authenticated request carries BOTH keys — and `requireUserId` in the router
// reads `_id`. A mock that sets only `id` therefore fails the guard and every
// route under it answers 401, which reads as "the refusal below is missing"
// rather than "the fixture is not shaped like a real request".
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { _id: OPERATOR_ID, id: OPERATOR_ID };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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

interface JsonResponse {
  status: number;
  body: { message?: string };
}

function request(
  srv: http.Server,
  payload: Record<string, unknown>
): Promise<JsonResponse> {
  const address = srv.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/accounts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer user-token',
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

describe('POST /accounts', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/accounts', accountsRouter);
    app.use(errorHandler);
    server = app.listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    mockCreateChildAccount.mockReset();
    // The route destructures `{ account, membership }` and builds an AccountNode
    // from it, so a bare `jest.fn()` returning undefined would throw before any
    // status could be asserted — a 500 that reads like a refusal.
    //
    // `membership` is serialised, so it has to carry the columns the serializer
    // reads. It does NOT carry `permissions`: that is derived from the role plus
    // the two delta columns (`effectivePermissionsForMember`), and a fixture
    // supplying it would be asserting a field the service never returns.
    mockCreateChildAccount.mockImplementation(
      async (_parentId: string, _actorId: string, input: { kind: string; username: string }) => ({
        account: {
          id: 'acct-new',
          kind: input.kind,
          username: input.username,
          parentAccountId: OPERATOR_ID,
          rootAccountId: OPERATOR_ID,
        },
        membership: {
          role: 'owner',
          permissionGrants: [],
          permissionRevokes: [],
        },
      })
    );
  });

  it('creates a channel account with the caller\'s own bearer', async () => {
    const res = await request(server, {
      kind: 'channel',
      username: 'daily-news',
      name: { displayName: 'Daily News' },
    });

    expect(res.status).toBe(201);
    // The kind reaches the service unchanged — the route neither rewrites it nor
    // routes a channel somewhere else.
    expect(mockCreateChildAccount).toHaveBeenCalledWith(
      OPERATOR_ID,
      OPERATOR_ID,
      expect.objectContaining({ kind: 'channel', username: 'daily-news' })
    );
  });

  it.each(['organization', 'project', 'bot'])(
    'still creates a %s account, unchanged',
    async (kind) => {
      const res = await request(server, { kind, username: `acct-${kind}` });

      expect(res.status).toBe(201);
      expect(mockCreateChildAccount).toHaveBeenCalledWith(
        OPERATOR_ID,
        OPERATOR_ID,
        expect.objectContaining({ kind })
      );
    }
  );

  /**
   * `personal` is the one kind this route must never mint: it is a human login,
   * created at signup. It is refused by the SCHEMA (`childAccountKindSchema`),
   * not by a handler check — which is why it is asserted here rather than
   * assumed. Without it, a suite that only ever sends creatable kinds cannot
   * tell a route that validates its input from one that does not.
   */
  /**
   * THE HANDOFF, which is its own failure mode.
   *
   * This handler does not spread `req.body` — it names every field and passes
   * them one by one, which is what stops mass assignment. The cost is that a
   * field the schema accepts and this list omits is dropped BETWEEN validation
   * and the insert, with no error at any layer: the request succeeds, the
   * account is created, and it is simply discoverable when the caller asked for
   * the opposite. Neither the contract test nor the service test can see that
   * gap, because each one is on the far side of it.
   */
  it('passes isPrivateAccount through to the service', async () => {
    const res = await request(server, {
      kind: 'bot',
      username: 'unpublished-agent',
      isPrivateAccount: true,
    });

    expect(res.status).toBe(201);
    expect(mockCreateChildAccount).toHaveBeenCalledWith(
      OPERATOR_ID,
      OPERATOR_ID,
      expect.objectContaining({ isPrivateAccount: true })
    );
  });

  it('passes nothing when the caller says nothing, leaving the platform default', async () => {
    // `undefined`, not `false`. The service must be able to tell "the caller did
    // not say" from "the caller said discoverable", because only the first one
    // is allowed to fall through to the column default.
    await request(server, { kind: 'bot', username: 'ordinary-agent' });

    const [, , input] = mockCreateChildAccount.mock.calls[0] as [
      string,
      string,
      { isPrivateAccount?: boolean },
    ];
    expect(input.isPrivateAccount).toBeUndefined();
  });

  it('refuses a personal account (400)', async () => {
    const res = await request(server, { kind: 'personal', username: 'someone' });

    expect(res.status).toBe(400);
    expect(mockCreateChildAccount).not.toHaveBeenCalled();
  });
});
