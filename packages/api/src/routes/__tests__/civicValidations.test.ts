/**
 * Validator-jury HTTP contract (Fase 2 Part B), against a REAL Postgres.
 *
 * Locks what the SDK and Commons build against: opening a request
 * (service-token only, `reputation:write`), the juror inbox, and the rejection
 * statuses for voting and recusal.
 *
 * The previous version mocked `validator.service` and asserted the shape of the
 * value it had just handed the route back — so it could not notice that the
 * route now reads `request.id` rather than a Mongo `_id`, nor that opening a
 * request first checks the subject EXISTS (a real 400 for a body field, added
 * because an unknown subject would otherwise reach a foreign key and answer
 * 500). Both of those are why it went red.
 *
 * The service is fully ported, so it runs for real here. Jury selection reads
 * every eligible `reputation_balances` row in the database, which other suites
 * also write, so the tests that need a SPECIFIC juror seat seed the request and
 * its seats directly instead of hoping the reservoir draws them.
 *
 * Only the auth middleware and the rate limiter are mocked — the principal and
 * the budget, which is exactly their production contract. Signature-bearing vote
 * paths are covered by the service's own suite; what belongs here is the
 * route's mapping from a rejection reason to an HTTP status, which is reachable
 * before any signature is inspected.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

/** The principals the mocked auth middlewares attach. */
let currentUserId: string | undefined;
let currentServiceScopes: string[] = ['reputation:write'];

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!currentUserId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }
    req.user = { _id: currentUserId, id: currentUserId };
    next();
  },
  serviceAuthMiddleware: (
    req: { serviceApp?: { appId: string | undefined; scopes: string[] } },
    _res: unknown,
    next: () => void,
  ) => {
    // No `appId`: `validation_requests.application_id` is a real foreign key
    // now, and this suite is not about application attribution.
    req.serviceApp = { appId: undefined, scopes: currentServiceScopes };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { reputationBalances } from '../../db/schema/reputationBalances';
import {
  validationRequests,
  validationRequestValidators,
} from '../../db/schema/validationRequests';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import {
  VALIDATION_TTL_MS,
  VALIDATOR_COUNT,
  VALIDATOR_QUORUM,
} from '../../utils/civic.constants';
import civicRoutes from '../civic';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function send(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers:
          body !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** An account carrying a jury-eligible reputation balance. */
async function eligibleJuror(): Promise<string> {
  const userId = await account({
    username: `juror${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
  await getDb()
    .insert(reputationBalances)
    .values({ userId, total: 150, positive: 150, trustTier: 'trusted' });
  return userId;
}

/** A pending request with the given jurors seated — deterministic, no reservoir. */
async function seatedRequest(
  subjectUserId: string,
  jurorIds: string[],
  overrides: Partial<typeof validationRequests.$inferInsert> = {},
): Promise<string> {
  const [request] = await getDb()
    .insert(validationRequests)
    .values({
      subjectUserId,
      actionType: 'claim',
      sourceActionId: `src_${randomUUID()}`,
      payload: { x: 1 },
      payloadHash: 'a'.repeat(64),
      status: 'pending',
      quorum: VALIDATOR_QUORUM,
      threshold: VALIDATOR_QUORUM,
      rngSeed: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + VALIDATION_TTL_MS),
      ...overrides,
    })
    .returning({ id: validationRequests.id });
  if (jurorIds.length > 0) {
    await getDb()
      .insert(validationRequestValidators)
      .values(jurorIds.map((userId, position) => ({ requestId: request.id, userId, position })));
  }
  return request.id;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/civic', civicRoutes);
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
  currentUserId = undefined;
  currentServiceScopes = ['reputation:write'];
});

describe('POST /civic/validations', () => {
  it('rejects a service token without the reputation:write scope, and opens nothing', async () => {
    const subject = await account();
    currentServiceScopes = [];

    const res = await send('POST', '/civic/validations', {
      subjectUserId: subject,
      actionType: 'claim',
      sourceActionId: `src_${randomUUID()}`,
      payload: { x: 1 },
    });

    expect(res.status).toBe(403);
    const stored = await getDb()
      .select({ id: validationRequests.id })
      .from(validationRequests)
      .where(eq(validationRequests.subjectUserId, subject));
    expect(stored).toHaveLength(0);
  });

  it('400s a subjectUserId that names no account', async () => {
    const res = await send('POST', '/civic/validations', {
      subjectUserId: randomUUID(),
      actionType: 'claim',
      sourceActionId: `src_${randomUUID()}`,
      payload: { x: 1 },
    });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/subjectUserId/i);
  });

  it('400s a body missing the required fields', async () => {
    const res = await send('POST', '/civic/validations', { actionType: 'claim' });

    expect(res.status).toBe(400);
  });

  it('opens a request, seats a real jury, and stores it', async () => {
    const subject = await account();
    // Enough eligible candidates that the reservoir can fill a full panel; the
    // pool is global, so this is a floor, not an exact population.
    for (let index = 0; index < VALIDATOR_COUNT; index += 1) {
      await eligibleJuror();
    }
    const sourceActionId = `src_${randomUUID()}`;

    const res = await send('POST', '/civic/validations', {
      subjectUserId: subject,
      actionType: 'claim',
      sourceActionId,
      payload: { x: 1 },
    });

    expect(res.status).toBe(201);
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.selectedValidatorCount).toBe(VALIDATOR_COUNT);
    expect(typeof res.body.expiresAt).toBe('string');

    const [stored] = await getDb()
      .select({
        id: validationRequests.id,
        subjectUserId: validationRequests.subjectUserId,
        actionType: validationRequests.actionType,
        status: validationRequests.status,
        quorum: validationRequests.quorum,
      })
      .from(validationRequests)
      .where(eq(validationRequests.id, String(res.body.requestId)));
    expect(stored.subjectUserId).toBe(subject);
    expect(stored.actionType).toBe('claim');
    expect(stored.status).toBe('pending');
    expect(stored.quorum).toBe(VALIDATOR_QUORUM);

    const seats = await getDb()
      .select({ userId: validationRequestValidators.userId })
      .from(validationRequestValidators)
      .where(eq(validationRequestValidators.requestId, stored.id));
    expect(seats).toHaveLength(VALIDATOR_COUNT);
    expect(seats.map((seat) => seat.userId)).not.toContain(subject);
  });

  it('is idempotent on sourceActionId — a repeat returns the SAME request', async () => {
    const subject = await account();
    for (let index = 0; index < VALIDATOR_COUNT; index += 1) {
      await eligibleJuror();
    }
    const sourceActionId = `src_${randomUUID()}`;
    const body = {
      subjectUserId: subject,
      actionType: 'claim',
      sourceActionId,
      payload: { x: 1 },
    };

    const first = await send('POST', '/civic/validations', body);
    const second = await send('POST', '/civic/validations', body);

    expect(second.status).toBe(201);
    expect(second.body.requestId).toBe(first.body.requestId);
    const stored = await getDb()
      .select({ id: validationRequests.id })
      .from(validationRequests)
      .where(eq(validationRequests.subjectUserId, subject));
    expect(stored).toHaveLength(1);
  });
});

describe('GET /civic/validations/inbox', () => {
  it('returns the juror summaries for the caller', async () => {
    const subject = await account();
    const juror = await eligibleJuror();
    const requestId = await seatedRequest(subject, [juror]);
    currentUserId = juror;

    const res = await send('GET', '/civic/validations/inbox');

    expect(res.status).toBe(200);
    const requests = res.body.requests as Array<Record<string, unknown>>;
    const entry = requests.find((row) => row.id === requestId);
    expect(entry).toEqual({
      id: requestId,
      subjectUserId: subject,
      actionType: 'claim',
      payload: { x: 1 },
      payloadHash: 'a'.repeat(64),
      status: 'pending',
      highValue: false,
      expiresAt: expect.any(String),
    });
  });

  it('does not list a request the caller is not seated on', async () => {
    const subject = await account();
    const seatedJuror = await eligibleJuror();
    const requestId = await seatedRequest(subject, [seatedJuror]);
    currentUserId = await eligibleJuror();

    const res = await send('GET', '/civic/validations/inbox');

    const requests = res.body.requests as Array<Record<string, unknown>>;
    expect(requests.map((row) => row.id)).not.toContain(requestId);
  });

  it('rejects an anonymous caller', async () => {
    const res = await send('GET', '/civic/validations/inbox');

    expect(res.status).toBe(401);
  });
});

describe('POST /civic/validations/:id/vote', () => {
  it('404s an unknown request id', async () => {
    currentUserId = await eligibleJuror();

    const res = await send('POST', `/civic/validations/${randomUUID()}/vote`, {
      version: 1,
      type: 'validation_verdict',
      subject: 'did:web:oxy.so:u:x',
      issuer: 'did:web:oxy.so:u:x',
      record: {},
      issuedAt: Date.now(),
      publicKey: '04ab',
      alg: 'ES256K-DER-SHA256',
      signature: 'deadbeef',
    });

    expect(res.status).toBe(404);
  });

  it('403s a caller who is not on the jury', async () => {
    const subject = await account();
    const seatedJuror = await eligibleJuror();
    const requestId = await seatedRequest(subject, [seatedJuror]);
    currentUserId = await eligibleJuror();

    const res = await send('POST', `/civic/validations/${requestId}/vote`, {
      version: 1,
      type: 'validation_verdict',
      subject: 'did:web:oxy.so:u:x',
      issuer: 'did:web:oxy.so:u:x',
      record: {},
      issuedAt: Date.now(),
      publicKey: '04ab',
      alg: 'ES256K-DER-SHA256',
      signature: 'deadbeef',
    });

    expect(res.status).toBe(403);
    expect(String(res.body.message)).toMatch(/not on this validation jury/i);
  });

  it('409s a request that is already closed', async () => {
    const subject = await account();
    const juror = await eligibleJuror();
    const requestId = await seatedRequest(subject, [juror], { status: 'expired' });
    currentUserId = juror;

    const res = await send('POST', `/civic/validations/${requestId}/vote`, {
      version: 1,
      type: 'validation_verdict',
      subject: 'did:web:oxy.so:u:x',
      issuer: 'did:web:oxy.so:u:x',
      record: {},
      issuedAt: Date.now(),
      publicKey: '04ab',
      alg: 'ES256K-DER-SHA256',
      signature: 'deadbeef',
    });

    expect(res.status).toBe(409);
  });

  it('400s a body that is not a signed-record envelope', async () => {
    currentUserId = await eligibleJuror();

    const res = await send('POST', `/civic/validations/${randomUUID()}/vote`, { verdict: 'valid' });

    expect(res.status).toBe(400);
  });
});

describe('POST /civic/validations/:id/deny', () => {
  it('removes the caller\'s seat and answers { denied: true }', async () => {
    const subject = await account();
    const juror = await eligibleJuror();
    const other = await eligibleJuror();
    const requestId = await seatedRequest(subject, [juror, other]);
    currentUserId = juror;

    const res = await send('POST', `/civic/validations/${requestId}/deny`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ denied: true });
    const seats = await getDb()
      .select({ userId: validationRequestValidators.userId })
      .from(validationRequestValidators)
      .where(eq(validationRequestValidators.requestId, requestId));
    expect(seats.map((seat) => seat.userId)).toEqual([other]);
  });

  it('403s a caller who has no seat, and disturbs no other seat', async () => {
    const subject = await account();
    const seatedJuror = await eligibleJuror();
    const requestId = await seatedRequest(subject, [seatedJuror]);
    currentUserId = await eligibleJuror();

    const res = await send('POST', `/civic/validations/${requestId}/deny`);

    expect(res.status).toBe(403);
    const seats = await getDb()
      .select({ userId: validationRequestValidators.userId })
      .from(validationRequestValidators)
      .where(
        and(
          eq(validationRequestValidators.requestId, requestId),
          eq(validationRequestValidators.userId, seatedJuror),
        ),
      );
    expect(seats).toHaveLength(1);
  });

  it('404s an unknown request id', async () => {
    currentUserId = await eligibleJuror();

    const res = await send('POST', `/civic/validations/${randomUUID()}/deny`);

    expect(res.status).toBe(404);
  });
});
