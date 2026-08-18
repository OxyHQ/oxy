/**
 * The `/nodes` per-user budgets are REACHABLE — each of the three principal-keyed
 * limiters bounds one account, not one address.
 *
 * ## What was wrong, and why a test rather than a reading
 *
 * `nodeReadLimiter`, `nodeAdminLimiter` and `nodeManagedLimiter` were each mounted
 * IMMEDIATELY BEFORE `authMiddleware` on their route. Express runs middleware in
 * declaration order, so `req.user` was undefined every time a key was computed and
 * the old `: ${scope}:ip:${hashedIpKey(req)}` arm was not a fallback — it was the
 * only branch that ever executed. The per-user budget each limiter advertises was
 * unreachable: every caller behind one NAT egress shared one bucket, and one
 * flood took out everybody on it.
 *
 * No IP leaked (`hashedIpKey` is the sanctioned transient path, unlike the raw
 * `req.ip` the same shape produced in `routes/store.ts`), so what this file is
 * about is the DEAD BUDGET: the limiter's stated unit of account was a fiction.
 *
 * None of that is visible at the limiter — the keyGenerator reads as
 * user-keyed-with-a-fallback and is correct in isolation; the bug is the order of
 * two arguments a hundred lines below it. And it is invisible to any suite that
 * mocks `middleware/rateLimiter` away, which is what the other node suites do.
 * Hence a suite that mounts the real router, the real limiters and the real
 * ordering, and asks WHOSE budget a request spends.
 *
 * ## The rate limiter is NOT mocked here, deliberately
 *
 * Redis is unset locally, so `rateLimit` falls back to express-rate-limit's
 * in-memory store: the counting is real, the key derivation is real, and the
 * middleware order is real. Only the data layer is stubbed — a node row is not
 * what is being measured, and the stubs answer SUCCESS so a served request is a
 * 2xx and cannot be confused with a refusal.
 *
 * ## Every ceiling assertion is paired with a control
 *
 * A limiter that refused everything, or one that refused nothing, would satisfy a
 * bare "the N+1th is a 429" or a bare "the Nth is a 200". So each case pins BOTH
 * sides: what must still be served, and what must be refused.
 *
 * Mutation-tested against both halves of the bug — restoring the ordering alone
 * (every request is then skipped, so no ceiling ever fires) and restoring the
 * ordering together with the IP arm (one address, one bucket). See the PR body.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Stands in for the real `authMiddleware` and, crucially, ONLY WHERE IT STANDS.
 *
 * It sets `req.user` from the `x-test-account` header, so "which account is
 * calling" is per-request while the limiters under test are process-wide. Because
 * it is mounted at the position the real middleware occupies, the ORDERING is what
 * this file exercises: with a limiter declared first the mock has not run when the
 * key is computed, exactly as the real middleware had not, and the user branch is
 * unreachable.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string }; headers: Record<string, unknown> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    const account = req.headers['x-test-account'];
    if (typeof account !== 'string' || account.length === 0) {
      // The real middleware's own behaviour: no credential, no principal, 401.
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { _id: account, id: account };
    next();
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/**
 * The node registry, stubbed. `getUserNode` answers "no node registered" (a 200
 * with `{ node: null }`), `removeNode` answers "revoked" and
 * `provisionManagedVault` answers a materialized vault — every one a 2xx, so a
 * served request is never confusable with a refusal.
 */
jest.mock('../../services/nodeRegistry.service', () => ({
  getUserNode: jest.fn(async () => null),
  removeNode: jest.fn(async () => true),
  provisionManagedVault: jest.fn(async () => ({
    ok: true,
    node: { nodeDid: 'did:web:node.example', endpoint: 'https://node.example', managed: true },
  })),
}));

/** Reached only by `POST /nodes/ingest/notify/:userId`, which this file never calls. */
jest.mock('../../config/postgres', () => ({ getDb: jest.fn() }));
jest.mock('../../queue/nodeIngest.queue', () => ({ enqueueNodeIngest: jest.fn() }));

import { errorHandler } from '../../middleware/errorHandler';
import nodeRouter from '../nodes';

let server: http.Server;

/** Each limiter's ceiling, mirrored from `routes/nodes.ts` so the arithmetic reads. */
const MAX_READS_PER_MINUTE = 120;
const MAX_ADMIN_PER_MINUTE = 20;
const MAX_MANAGED_PER_MINUTE = 10;

interface HttpResponse {
  status: number;
  /** Raw, because a 429 from express-rate-limit is plain text, not JSON. */
  raw: string;
}

/**
 * One request. Every request in this file comes from 127.0.0.1 — that is the
 * point: the address is held constant so any difference in outcome can only have
 * come from the account.
 */
function call(method: 'GET' | 'DELETE' | 'POST', path: string, account: string | null): Promise<HttpResponse> {
  const address = server.address() as AddressInfo;
  const body = method === 'POST' ? '{}' : null;
  const headers: Record<string, string | number> = { Authorization: 'Bearer t' };
  if (body !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  if (account !== null) {
    headers['x-test-account'] = account;
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      { method, host: '127.0.0.1', port: address.port, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });
}

const readStatus = (account: string | null) => call('GET', '/nodes/me', account);
const revokeNode = (account: string | null) => call('DELETE', '/nodes/me', account);
const provisionVault = (account: string | null) => call('POST', '/nodes/managed', account);

/** Distinct per case, so one case cannot spend another's budget. */
let accountCounter = 0;
function account(): string {
  accountCounter += 1;
  return `acct-${process.pid}-${accountCounter}`;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/nodes', nodeRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('GET /nodes/me is bounded per user, never per address', () => {
  it('serves the budget and refuses the read past it', async () => {
    const owner = account();

    for (let attempt = 1; attempt <= MAX_READS_PER_MINUTE; attempt += 1) {
      // The control on the ceiling. Without it, a limiter that refused from the
      // first read would satisfy the 429 below just as well — and so would one
      // that skipped every request, which is what these limiters do when they
      // cannot resolve a user.
      expect((await readStatus(owner)).status).toBe(200);
    }

    const refused = await readStatus(owner);
    expect(refused.status).toBe(429);
    expect(refused.raw).toContain('Too many node status requests');
  });

  it('does not spend one user’s budget on another — the user branch is LIVE', async () => {
    const first = account();
    for (let attempt = 1; attempt <= MAX_READS_PER_MINUTE; attempt += 1) {
      expect((await readStatus(first)).status).toBe(200);
    }
    expect((await readStatus(first)).status).toBe(429);

    // THE assertion this file exists for. A second account, from the SAME address
    // and through the SAME limiter, is untouched. Under the bug — a hashed-IP key,
    // because `req.user` was not yet set — this is a 429, which is what makes it
    // the discriminator rather than a restatement of the case above.
    const second = account();
    expect((await readStatus(second)).status).toBe(200);
  });
});

describe('DELETE /nodes/me is bounded per user, never per address', () => {
  it('serves the budget and refuses the revoke past it', async () => {
    const owner = account();

    for (let attempt = 1; attempt <= MAX_ADMIN_PER_MINUTE; attempt += 1) {
      expect((await revokeNode(owner)).status).toBe(200);
    }

    const refused = await revokeNode(owner);
    expect(refused.status).toBe(429);
    expect(refused.raw).toContain('Too many node management requests');
  });

  it('does not spend one user’s budget on another', async () => {
    const first = account();
    for (let attempt = 1; attempt <= MAX_ADMIN_PER_MINUTE; attempt += 1) {
      expect((await revokeNode(first)).status).toBe(200);
    }
    expect((await revokeNode(first)).status).toBe(429);

    const second = account();
    expect((await revokeNode(second)).status).toBe(200);
  });
});

describe('POST /nodes/managed is bounded per user, never per address', () => {
  it('serves the budget and refuses the provision past it', async () => {
    const owner = account();

    for (let attempt = 1; attempt <= MAX_MANAGED_PER_MINUTE; attempt += 1) {
      expect((await provisionVault(owner)).status).toBe(201);
    }

    const refused = await provisionVault(owner);
    expect(refused.status).toBe(429);
    expect(refused.raw).toContain('Too many managed vault requests');
  });

  it('does not spend one user’s budget on another', async () => {
    const first = account();
    for (let attempt = 1; attempt <= MAX_MANAGED_PER_MINUTE; attempt += 1) {
      expect((await provisionVault(first)).status).toBe(201);
    }
    expect((await provisionVault(first)).status).toBe(429);

    const second = account();
    expect((await provisionVault(second)).status).toBe(201);
  });
});

describe('the three budgets are independent of each other and of the pre-auth lane', () => {
  it('exhausting the managed budget leaves the same user’s read and admin budgets intact', async () => {
    // Each limiter carries its own `prefix`, so they count in separate buckets.
    // Sharing one would be an `ERR_ERL_DOUBLE_COUNT` on Redis and a silently
    // halved budget in memory; here it would show up as the cheapest ceiling
    // (10/min) closing the other two routes for this user.
    const owner = account();
    for (let attempt = 1; attempt <= MAX_MANAGED_PER_MINUTE; attempt += 1) {
      expect((await provisionVault(owner)).status).toBe(201);
    }
    expect((await provisionVault(owner)).status).toBe(429);

    expect((await readStatus(owner)).status).toBe(200);
    expect((await revokeNode(owner)).status).toBe(200);
  });

  it('refuses an unauthenticated request at the auth gate, spending no budget', async () => {
    // The limiters now run AFTER `authMiddleware`, so the pre-auth lane reaches
    // them not at all: an anonymous flood is 401 the whole way down rather than
    // 429, and — the part that matters — it cannot consume anybody's budget.
    for (let attempt = 1; attempt <= MAX_MANAGED_PER_MINUTE * 2; attempt += 1) {
      expect((await provisionVault(null)).status).toBe(401);
      expect((await revokeNode(null)).status).toBe(401);
      expect((await readStatus(null)).status).toBe(401);
    }

    // CONTROL: a real user's budget is intact after all of it. This is what an
    // unauthenticated caller COULD do under the bug — every one of those requests
    // keyed on the shared address and drained the bucket every authenticated user
    // behind it had to share.
    const owner = account();
    expect((await provisionVault(owner)).status).toBe(201);
    expect((await revokeNode(owner)).status).toBe(200);
    expect((await readStatus(owner)).status).toBe(200);
  });
});
