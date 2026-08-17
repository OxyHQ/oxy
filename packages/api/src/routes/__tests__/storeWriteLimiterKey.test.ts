/**
 * `/store` writes are bounded PER ACCOUNT, and no rate-limit key derived from a
 * client IP is ever minted.
 *
 * ## What was wrong, and why a test rather than a reading
 *
 * `writeLimiter` was declared with
 * `keyGenerator: (req) => req.user?._id?.toString() ?? req.ip ?? 'unknown'` and
 * mounted IMMEDIATELY BEFORE `authMiddleware` on all nine write routes. Express
 * runs middleware in declaration order, so `req.user` was undefined every single
 * time the key was computed: `?? req.ip` was not a fallback, it was the only
 * branch that ever executed. Two consequences, both of which the file's own
 * comment asserted the opposite of:
 *
 *   - every store write minted a Redis key holding a RAW CLIENT IP, against the
 *     platform invariant that no user IP is persisted in any form (the sanctioned
 *     transient exception is `hashedIpKey`, which this did not go through);
 *   - one office network shared one 20-writes-per-minute budget, which the
 *     comment named as the reason NOT to key on an IP.
 *
 * Neither is visible in the limiter's own source — the bug is the ORDER of two
 * arguments two hundred lines away — and neither shows up in a suite that mocks
 * `middleware/rateLimiter` away, which is what every other store-adjacent suite
 * does. Hence a suite that mounts the real router, the real limiter and the real
 * ordering, and asks about the key by observing WHOSE budget a request spends.
 *
 * ## The rate limiter is NOT mocked here, deliberately
 *
 * Redis is unset locally, so `rateLimit` falls back to express-rate-limit's
 * in-memory store: the counting is real, the key derivation is real, and the
 * middleware order is real. `store.service` is stubbed, because a review row is
 * not what is being measured — and it answers SUCCESS, so a served request is a
 * 200 and cannot be confused with a refusal.
 *
 * ## Every ceiling assertion is paired with a control
 *
 * A limiter that refused everything, or one that refused nothing, would satisfy
 * a bare "the 21st is a 429" or a bare "the 21st is a 200". So each case pins
 * BOTH sides: what must still be served, and what must be refused.
 *
 * Mutation-tested against the bug it is about — restoring either half of it
 * (`?? req.ip`, or `writeLimiter` back in front of `authMiddleware`) turns cases
 * in here red. See the PR body for the two runs.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Stands in for the real `authMiddleware` and, crucially, ONLY WHERE IT STANDS.
 *
 * It sets `req.user` from the `x-test-account` header, so "which account is
 * calling" is per-request while the limiter under test is process-wide. Because
 * it is mounted at the position the real middleware occupies, the ORDERING is
 * what this file exercises: with `writeLimiter` declared first the mock has not
 * run when the key is computed, exactly as the real middleware had not, and the
 * account branch is unreachable.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string; isStaff: boolean }; headers: Record<string, unknown> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    const account = req.headers['x-test-account'];
    if (typeof account !== 'string' || account.length === 0) {
      // The real middleware's own behaviour: no credential, no principal, 401.
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { _id: account, id: account, isStaff: true };
    next();
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/**
 * The store's data layer, stubbed. Only `upsertReview` is reached below; the
 * rest are here because the router imports them at module load.
 */
jest.mock('../../services/store.service', () => ({
  approveListing: jest.fn(async () => ({ status: 'published' })),
  createCategory: jest.fn(async () => ({ slug: 'games' })),
  deleteCategory: jest.fn(async () => ({ uncategorised: 0 })),
  deleteOwnReview: jest.fn(async () => undefined),
  deleteReply: jest.fn(async () => undefined),
  getOwnReview: jest.fn(async () => null),
  getPublishedListing: jest.fn(async () => null),
  listCategories: jest.fn(async () => []),
  listListingsAwaitingReview: jest.fn(async () => ({ items: [], total: 0 })),
  listPublishedListings: jest.fn(async () => ({ items: [], total: 0 })),
  listReviews: jest.fn(async () => null),
  rejectListing: jest.fn(async () => ({ status: 'rejected' })),
  updateCategory: jest.fn(async () => ({ slug: 'games' })),
  upsertReply: jest.fn(async () => ({ id: 'reply' })),
  upsertReview: jest.fn(async () => ({ id: 'review' })),
}));

import { errorHandler } from '../../middleware/errorHandler';
import storeRouter from '../store';

let server: http.Server;

/** `writeLimiter`'s ceiling, mirrored so the arithmetic below reads. */
const MAX_WRITES_PER_MINUTE = 20;

interface HttpResponse {
  status: number;
  /** Raw, because a 429 from express-rate-limit is plain text, not JSON. */
  raw: string;
}

/**
 * One review write. Every request in this file comes from 127.0.0.1 — that is
 * the point: the address is held constant so that any difference in outcome can
 * only have come from the account.
 */
function writeReview(account: string | null, slug = 'some-app'): Promise<HttpResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify({ rating: 5, title: 'Good', body: 'Works well.' });
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // Bearer, so `csrfProtection` passes through — CSRF guards ambient cookie
    // credentials, and this file is about the limiter, not about CSRF.
    Authorization: 'Bearer t',
  };
  if (account !== null) {
    headers['x-test-account'] = account;
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      { method: 'PUT', host: '127.0.0.1', port: address.port, path: `/store/apps/${slug}/review`, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
      }
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

/** Distinct per case, so one case cannot spend another's budget. */
let accountCounter = 0;
function account(): string {
  accountCounter += 1;
  return `acct-${process.pid}-${accountCounter}`;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/store', storeRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

describe('/store writes are bounded per account, never per IP', () => {
  it('serves the budget and refuses the write past it', async () => {
    const reviewer = account();

    for (let attempt = 1; attempt <= MAX_WRITES_PER_MINUTE; attempt += 1) {
      // The control on the ceiling. Without it, a limiter that refused from the
      // first write would satisfy the 429 below just as well — and so would a
      // limiter that skipped every request, which is what `writeLimiter` does
      // when it cannot resolve an account.
      expect((await writeReview(reviewer)).status).toBe(200);
    }

    const refused = await writeReview(reviewer);
    expect(refused.status).toBe(429);
    expect(refused.raw).toContain('Too many requests');
  });

  it('does not spend one account’s budget on another — the account branch is LIVE', async () => {
    const first = account();
    for (let attempt = 1; attempt <= MAX_WRITES_PER_MINUTE; attempt += 1) {
      expect((await writeReview(first)).status).toBe(200);
    }
    expect((await writeReview(first)).status).toBe(429);

    // THE assertion this file exists for. A second account, from the SAME
    // address and through the SAME limiter, is untouched. Under the bug — an IP
    // key, because `req.user` was not yet set — this is a 429, which is what
    // makes it the discriminator rather than a restatement of the case above.
    const second = account();
    expect((await writeReview(second)).status).toBe(200);
  });

  it('does not throttle a shared address to one reviewer — the office-network case', async () => {
    // Five accounts behind one NAT egress, each spending its whole budget. 100
    // served writes from one address; under an IP key the 21st is refused and
    // the remaining four reviewers are locked out by the first.
    const reviewers = [account(), account(), account(), account(), account()];
    for (const reviewer of reviewers) {
      for (let attempt = 1; attempt <= MAX_WRITES_PER_MINUTE; attempt += 1) {
        expect((await writeReview(reviewer)).status).toBe(200);
      }
    }

    // CONTROL: the limiter is still counting after all of that — the case above
    // would also pass against a limiter that had stopped limiting entirely.
    expect((await writeReview(reviewers[0])).status).toBe(429);
  });

  it('spends one budget across every app the account reviews', async () => {
    // The budget is the account's, not the account's per listing: the point of
    // keying on the reviewer is to bound how fast one person churns reviews
    // ACROSS apps, since one review per app is already a database constraint.
    const reviewer = account();
    for (let attempt = 1; attempt <= MAX_WRITES_PER_MINUTE; attempt += 1) {
      expect((await writeReview(reviewer, `app-${attempt}`)).status).toBe(200);
    }
    expect((await writeReview(reviewer, 'app-21')).status).toBe(429);
  });

  it('refuses an unauthenticated write at the auth gate, spending no budget', async () => {
    // The limiter now runs AFTER `authMiddleware`, so the pre-auth lane reaches
    // it not at all: an anonymous flood is 401 the whole way down rather than
    // 429, and — the part that matters — it cannot consume anybody's budget.
    for (let attempt = 1; attempt <= MAX_WRITES_PER_MINUTE + 5; attempt += 1) {
      expect((await writeReview(null)).status).toBe(401);
    }

    // CONTROL: a real account's budget is intact after all of it. This is what
    // an unauthenticated caller could NOT do under the bug — every one of those
    // requests keyed on the shared address and drained the bucket that every
    // authenticated reviewer behind it had to share.
    const reviewer = account();
    expect((await writeReview(reviewer)).status).toBe(200);
  });
});
