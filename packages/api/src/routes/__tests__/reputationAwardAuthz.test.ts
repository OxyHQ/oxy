/**
 * `POST /reputation/award` authorization, against a REAL Postgres.
 *
 * Awarding mutates the GLOBAL reputation ledger, so the gate is narrow: a
 * service token carrying the privileged `reputation:write` scope, or platform
 * staff. A regular user session may never award — there is no self-award.
 *
 * The second half of the gate is attribution: when a service token awards, the
 * source-app identity comes from the TOKEN, and any `applicationId` /
 * `credentialId` in the request body is ignored. The old suite asserted that a
 * mocked `award` had been *called* with those values; here the write lands in
 * `reputation_transactions` and the stored row is read back, so a spoofed
 * attribution would be visible in the data rather than only in a call log.
 *
 * `jsonwebtoken` is restored to the real implementation: `authUserOrService`
 * decides between the user and service lanes by verifying the token's `type`
 * claim itself, so a stubbed `verify` would make that dispatch untestable. The
 * two middlewares it dispatches TO are mocked — they attach the principal, which
 * is their production contract.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { reputationTransactionSchema, safeParseContract } from '@oxyhq/contracts';

/** `authUserOrService` verifies the token itself, so the real JWT must be used. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

const ACCESS_TOKEN_SECRET = 'reputation-award-test-secret';

/** The principal the dispatched middleware attaches. */
let currentServiceApp: { appId: string; credentialId: string; scopes: string[] } | undefined;
let currentUser: { _id: string; isStaff?: boolean } | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; isStaff?: boolean } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!currentUser) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }
    req.user = currentUser;
    next();
  },
  serviceAuthMiddleware: (
    req: {
      serviceApp?: {
        type: string;
        appId: string;
        appName: string;
        credentialId: string;
        scopes: string[];
      };
    },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!currentServiceApp) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid service token' });
      return;
    }
    req.serviceApp = { type: 'service', appName: 'Test App', ...currentServiceApp };
    next();
  },
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { reputationRules } from '../../db/schema/reputationRules';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import reputationRouter from '../reputation.routes';

interface JsonResponse {
  status: number;
  body: { error?: string; message?: string; data?: { transaction?: Record<string, unknown> } };
}

let server: http.Server;

function award(payload: unknown, tokenType: 'service' | 'user'): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  const token = jwt.sign(
    tokenType === 'service' ? { type: 'service' } : { type: 'access' },
    ACCESS_TOKEN_SECRET,
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: '/reputation/award',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          connection: 'close',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** An application plus one service credential, both real rows the FKs can point at. */
async function serviceApplication(): Promise<{ appId: string; credentialId: string }> {
  const ownerAccountId = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'internal',
      scopes: ['user:read'],
      ownerAccountId,
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'service',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return { appId: app.id, credentialId: credential.id };
}

/** A rule the award can resolve. Randomized so parallel suites cannot collide. */
async function awardableAction(points = 5): Promise<string> {
  const actionType = `test_action_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(reputationRules).values({
    actionType,
    points,
    category: 'content',
    description: 'Test action',
  });
  return actionType;
}

async function storedTransactions(userId: string) {
  return getDb()
    .select({
      id: reputationTransactions.id,
      points: reputationTransactions.points,
      applicationId: reputationTransactions.applicationId,
      credentialId: reputationTransactions.credentialId,
      createdByUserId: reputationTransactions.createdByUserId,
      sourceActionId: reputationTransactions.sourceActionId,
    })
    .from(reputationTransactions)
    .where(eq(reputationTransactions.userId, userId));
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET;
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/reputation', reputationRouter);
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
  currentServiceApp = undefined;
  currentUser = undefined;
});

describe('POST /reputation/award — service-token scope gate', () => {
  it('rejects a service token that lacks reputation:write, and writes nothing', async () => {
    const service = await serviceApplication();
    const subject = await account();
    const actionType = await awardableAction();
    currentServiceApp = { ...service, scopes: [] };

    const res = await award(
      { userId: subject, actionType, sourceActionId: 'attacker-controlled-action' },
      'service',
    );

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/reputation:write/i);
    expect(await storedTransactions(subject)).toHaveLength(0);
  });

  it('allows a service token that carries reputation:write', async () => {
    const service = await serviceApplication();
    const subject = await account();
    const actionType = await awardableAction(7);
    currentServiceApp = { ...service, scopes: ['reputation:write'] };

    const res = await award(
      { userId: subject, actionType, sourceActionId: 'real-action' },
      'service',
    );

    expect(res.status).toBe(201);
    const transaction = res.body.data?.transaction ?? {};
    expect(transaction.userId).toBe(subject);
    expect(transaction.points).toBe(7);
    expect(transaction.actionType).toBe(actionType);
    expect(transaction.category).toBe('content');
    expect(transaction.status).toBe('active');
    expect(safeParseContract(reputationTransactionSchema, transaction)).not.toBeNull();
  });

  it('attributes the stored row to the TOKEN, ignoring a spoofed body attribution', async () => {
    const service = await serviceApplication();
    const otherTenant = await serviceApplication();
    const subject = await account();
    const actionType = await awardableAction();
    currentServiceApp = { ...service, scopes: ['reputation:write'] };

    const res = await award(
      {
        userId: subject,
        actionType,
        applicationId: otherTenant.appId,
        credentialId: otherTenant.credentialId,
        sourceActionId: 'real-action',
      },
      'service',
    );

    expect(res.status).toBe(201);
    const stored = await storedTransactions(subject);
    expect(stored).toHaveLength(1);
    expect(stored[0].applicationId).toBe(service.appId);
    expect(stored[0].credentialId).toBe(service.credentialId);
    expect(stored[0].sourceActionId).toBe('real-action');
    expect(stored[0].createdByUserId).toBeNull();
  });

  it('rejects an unknown action type rather than inventing points for it', async () => {
    const service = await serviceApplication();
    const subject = await account();
    currentServiceApp = { ...service, scopes: ['reputation:write'] };

    const res = await award(
      { userId: subject, actionType: `unknown_${randomUUID().replace(/-/g, '')}` },
      'service',
    );

    expect(res.status).toBe(400);
    expect(await storedTransactions(subject)).toHaveLength(0);
  });
});

describe('POST /reputation/award — user lane', () => {
  it('refuses a regular authenticated user, and writes nothing', async () => {
    const subject = await account();
    const actionType = await awardableAction();
    currentUser = { _id: await account() };

    const res = await award({ userId: subject, actionType }, 'user');

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/service token or staff/i);
    expect(await storedTransactions(subject)).toHaveLength(0);
  });

  it('refuses a user awarding THEMSELVES', async () => {
    const self = await account();
    const actionType = await awardableAction();
    currentUser = { _id: self };

    const res = await award({ userId: self, actionType }, 'user');

    expect(res.status).toBe(403);
    expect(await storedTransactions(self)).toHaveLength(0);
  });

  it('allows staff, and records them as the actor', async () => {
    const subject = await account();
    const actionType = await awardableAction(3);
    const staff = await account({ isStaff: true });
    currentUser = { _id: staff, isStaff: true };

    const res = await award({ userId: subject, actionType }, 'user');

    expect(res.status).toBe(201);
    const stored = await storedTransactions(subject);
    expect(stored).toHaveLength(1);
    expect(stored[0].points).toBe(3);
    expect(stored[0].createdByUserId).toBe(staff);
    expect(stored[0].applicationId).toBeNull();
  });

  it('rejects a request with no authorization header at all', async () => {
    const address = server.address() as AddressInfo;
    const body = JSON.stringify({ userId: await account(), actionType: await awardableAction() });
    const res = await new Promise<JsonResponse>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port: address.port,
          path: '/reputation/award',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            connection: 'close',
          },
        },
        (response) => {
          let raw = '';
          response.on('data', (chunk) => {
            raw += chunk;
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: raw.length > 0 ? JSON.parse(raw) : {},
            }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    expect(res.status).toBe(401);
  });
});
