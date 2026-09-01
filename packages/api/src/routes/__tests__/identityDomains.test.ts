/**
 * Verified-domain badges (B7), against a REAL Postgres.
 *
 * ## The guarantees this file exists for
 *
 * 1. **A pending challenge's EXPIRY is enforced on the READ.** `db/expiry.ts`
 *    sweeps `domain_verifications` on an interval, so a row outlives its own
 *    deadline by up to one sweep. `schema/CONVENTIONS.md` ("Expiry", class (A))
 *    is explicit that a read which filtered on expiry itself must keep filtering
 *    VERBATIM — dropping the check because "the sweep handles it" turns a bounded
 *    lag into a live credential: a token published in DNS a month ago would still
 *    grant the badge.
 * 2. **Proving a domain is ATOMIC.** The badge write and the burn of the spent
 *    challenge commit together, so no crash can leave a granted badge beside a
 *    still-spendable token.
 * 3. **One badge and one challenge per (account, domain), case-insensitively.**
 *    Both tables are unique on `(user_id, lower(domain))`, so re-requesting
 *    replaces a token rather than issuing a second valid one, and re-verifying
 *    refreshes a badge rather than duplicating it.
 * 4. **`userCache.invalidate` fires after every write**, or the DID document and
 *    `/users/me` keep serving the pre-write badge set.
 *
 * The suite this replaces asserted none of them: it stubbed both models with
 * `jest.fn()`s, so "the challenge was stored" meant "a mock was called with an
 * object" and the expiry, the uniqueness and the atomicity were all unobservable.
 * Here every assertion reads the STORED ROWS.
 *
 * ## What is mocked, and why
 *
 * The two proof CHANNELS (`dns.promises.resolveTxt` and the SSRF-safe
 * `safeFetch`) — they reach the public internet, and what matters here is what a
 * given proof outcome does to the database. Plus the auth middleware (identity
 * injection) and `userCache` (an in-memory singleton whose invalidation is the
 * thing under test). The rate limiter is REAL.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { Readable } from 'stream';
import { and, eq } from 'drizzle-orm';

/** The account `authMiddleware` injects for the current test. */
let currentUserId = '';

const mockInvalidate = jest.fn();
const mockResolveTxt = jest.fn();
const mockSafeFetch = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: currentUserId, id: currentUserId };
    next();
  },
}));

jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: (...args: unknown[]) => mockInvalidate(...args) },
}));

jest.mock('dns', () => ({
  promises: { resolveTxt: (...args: unknown[]) => mockResolveTxt(...args) },
}));

jest.mock('@oxyhq/core/server', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { domainVerifications } from '../../db/schema/domainVerifications';
import { users } from '../../db/schema/users';
import { userVerifiedDomains } from '../../db/schema/userVerifiedDomains';
import identityRoutes from '../identity';
import { errorHandler } from '../../middleware/errorHandler';

/** The two ids the `text` primary key can hold; only one of them is minted now. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

const DAY_MS = 24 * 60 * 60 * 1000;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: body !== undefined
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          // The rate-limit middleware answers with a plain-text body, not JSON.
          let parsed: JsonResponse['body'] = {};
          if (raw.length) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { message: raw };
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A fresh account, made the CURRENT caller. */
async function signInAsFreshAccount(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u${randomUUID().replace(/-/g, '')}` })
    .returning({ id: users.id });
  currentUserId = row.id;
  return row.id;
}

/** Every pending challenge stored for an account. */
async function storedChallenges(userId: string) {
  return getDb()
    .select()
    .from(domainVerifications)
    .where(eq(domainVerifications.userId, userId))
    .orderBy(domainVerifications.createdAt, domainVerifications.id);
}

/** Every verified-domain badge stored for an account. */
async function storedBadges(userId: string) {
  return getDb()
    .select()
    .from(userVerifiedDomains)
    .where(eq(userVerifiedDomains.userId, userId))
    .orderBy(userVerifiedDomains.createdAt, userVerifiedDomains.id);
}

/** Seed a pending challenge directly, so its expiry can be chosen. */
async function seedChallenge(userId: string, domain: string, token: string, expiresAt: Date): Promise<string> {
  const [row] = await getDb()
    .insert(domainVerifications)
    .values({ userId, domain, token, expiresAt })
    .returning({ id: domainVerifications.id });
  return row.id;
}

/** A `safeFetch` result whose body is `text`. */
function wellKnownResponse(status: number, text: string) {
  return {
    status,
    response: Readable.from([Buffer.from(text)]),
    headers: {},
    finalUrl: 'https://nate.example/.well-known/oxy-domain',
  };
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity', identityRoutes);
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

beforeEach(async () => {
  jest.clearAllMocks();
  await signInAsFreshAccount();
});

describe('the id format must not decide whether a domain can be proven', () => {
  it('proves a domain for an account whose id the deleted 24-hex guard would reject', async () => {
    // The premise: every account minted since the cutover carries a uuid v7.
    expect(currentUserId).not.toMatch(OBJECT_ID_HEX);

    const issued = await request('POST', '/identity/domains', { domain: 'nate.example' });
    expect(issued.status).toBe(201);

    mockResolveTxt.mockResolvedValueOnce([[`oxy-domain-verification=${issued.body.token as string}`]]);
    const verified = await request('POST', '/identity/domains/nate.example/verify');

    expect(verified.status).toBe(200);
    expect((await storedBadges(currentUserId)).map((row) => row.domain)).toEqual(['nate.example']);
  });
});

describe('POST /identity/domains', () => {
  it('issues a token and STORES the challenge it hands out', async () => {
    const before = Date.now();
    const res = await request('POST', '/identity/domains', { domain: 'nate.example' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      domain: 'nate.example',
      token: expect.stringMatching(/^[a-f0-9]{32}$/),
      dns: {
        name: '_oxy-identity.nate.example',
        value: `oxy-domain-verification=${res.body.token as string}`,
      },
      wellKnown: {
        url: 'https://nate.example/.well-known/oxy-domain',
        body: res.body.token,
      },
    });

    // The instructions are only useful if the token they publish is the one the
    // verify path will look for.
    const stored = await storedChallenges(currentUserId);
    expect(stored).toHaveLength(1);
    expect(stored[0].domain).toBe('nate.example');
    expect(stored[0].token).toBe(res.body.token);
    expect(stored[0].expiresAt).toBeInstanceOf(Date);
    expect(stored[0].expiresAt.getTime()).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(stored[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY_MS);
  });

  it('normalizes the domain before storing it', async () => {
    const res = await request('POST', '/identity/domains', { domain: '  NATE.Example  ' });

    expect(res.status).toBe(201);
    expect(res.body.domain).toBe('nate.example');
    expect((await storedChallenges(currentUserId))[0].domain).toBe('nate.example');
  });

  it('REPLACES the outstanding token rather than issuing a second valid one', async () => {
    const first = await request('POST', '/identity/domains', { domain: 'nate.example' });
    const firstRow = (await storedChallenges(currentUserId))[0];

    const second = await request('POST', '/identity/domains', { domain: 'nate.example' });

    expect(second.body.token).not.toBe(first.body.token);
    const rows = await storedChallenges(currentUserId);
    // One row, same row: two live tokens for one domain would mean an old,
    // already-published proof stays spendable after a re-request.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstRow.id);
    expect(rows[0].token).toBe(second.body.token);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThanOrEqual(firstRow.expiresAt.getTime());
  });

  it('treats a re-request in different CASE as the same challenge', async () => {
    // The unique index is on `lower(domain)`; Mongoose's `lowercase: true` setter
    // has no Postgres counterpart, so the route re-applies it.
    await request('POST', '/identity/domains', { domain: 'nate.example' });
    await request('POST', '/identity/domains', { domain: 'NATE.EXAMPLE' });

    expect(await storedChallenges(currentUserId)).toHaveLength(1);
  });

  it('keeps challenges for different accounts apart', async () => {
    const first = currentUserId;
    await request('POST', '/identity/domains', { domain: 'shared.example' });
    const second = await signInAsFreshAccount();
    await request('POST', '/identity/domains', { domain: 'shared.example' });

    expect(await storedChallenges(first)).toHaveLength(1);
    expect(await storedChallenges(second)).toHaveLength(1);
  });

  it('rejects a malformed domain with 400 and stores nothing', async () => {
    const res = await request('POST', '/identity/domains', { domain: 'not a domain!!' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'BAD_REQUEST', message: 'Invalid domain' });
    expect(await storedChallenges(currentUserId)).toHaveLength(0);
  });

  it('enforces the 10/hour per-account rate limit', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const res = await request('POST', '/identity/domains', { domain: `d${index}.example` });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
  });
});

describe('POST /identity/domains/:domain/verify', () => {
  it('grants the badge on a DNS-TXT proof, burns the challenge, and invalidates the cache', async () => {
    const token = 'tok-dns';
    await seedChallenge(currentUserId, 'nate.example', token, new Date(Date.now() + 60_000));
    mockResolveTxt.mockResolvedValueOnce([['oxy-domain-verification=', token]]);

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(mockResolveTxt).toHaveBeenCalledWith('_oxy-identity.nate.example');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verified: true,
      domain: { domain: 'nate.example', verifiedAt: expect.any(String), method: 'dns-txt' },
    });

    const badges = await storedBadges(currentUserId);
    expect(badges).toHaveLength(1);
    expect(badges[0].domain).toBe('nate.example');
    expect(badges[0].method).toBe('dns-txt');
    expect(badges[0].verifiedAt).toBeInstanceOf(Date);
    // The response echoes exactly what was stored.
    expect(badges[0].verifiedAt.toISOString()).toBe((res.body.domain as { verifiedAt: string }).verifiedAt);

    // Atomic with the grant: a spent challenge must not remain spendable.
    expect(await storedChallenges(currentUserId)).toHaveLength(0);
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);
  });

  it('falls back to the well-known proof through safeFetch', async () => {
    const token = 'tok-wk';
    await seedChallenge(currentUserId, 'nate.example', token, new Date(Date.now() + 60_000));
    mockResolveTxt.mockRejectedValueOnce(new Error('ENOTFOUND'));
    mockSafeFetch.mockResolvedValueOnce(wellKnownResponse(200, token));

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://nate.example/.well-known/oxy-domain',
      { maxRedirects: 2, headersTimeoutMs: 5000 },
    );
    expect(res.status).toBe(200);
    expect((await storedBadges(currentUserId))[0].method).toBe('well-known');
    expect(await storedChallenges(currentUserId)).toHaveLength(0);
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);
  });

  it('REFUSES an expired challenge even though the sweep has not removed it yet', async () => {
    // THE class (A) read filter. The sweep lags by up to one interval, so a
    // month-old token is still a row; without this check its already-published
    // DNS record would still grant the badge.
    const token = 'tok-stale';
    await seedChallenge(currentUserId, 'nate.example', token, new Date(Date.now() - 1));
    mockResolveTxt.mockResolvedValue([[`oxy-domain-verification=${token}`]]);

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'No active verification challenge for this domain. Request one first.',
    });
    // No badge, and the proof channel was never even consulted.
    expect(await storedBadges(currentUserId)).toHaveLength(0);
    expect(mockResolveTxt).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('refuses a challenge whose deadline has just passed, with a VALID proof published', async () => {
    // The boundary is inclusive on the refusal side: `expiresAt <= now` is spent.
    // The proof is made to succeed so expiry is the ONLY thing that can refuse
    // this request — otherwise the case would pass against a missing expiry
    // check simply because no proof was published.
    const token = 'tok-edge';
    await seedChallenge(currentUserId, 'nate.example', token, new Date(Date.now() - 1));
    mockResolveTxt.mockResolvedValue([[`oxy-domain-verification=${token}`]]);
    mockSafeFetch.mockResolvedValue(wellKnownResponse(200, token));

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'No active verification challenge for this domain. Request one first.',
    });
    expect(await storedBadges(currentUserId)).toHaveLength(0);
  });

  it('grants nothing when neither proof is present', async () => {
    await seedChallenge(currentUserId, 'nate.example', 'tok-none', new Date(Date.now() + 60_000));
    mockResolveTxt.mockRejectedValueOnce(new Error('ENOTFOUND'));
    mockSafeFetch.mockResolvedValueOnce(wellKnownResponse(404, 'nope'));

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'Domain ownership could not be verified. Publish the DNS-TXT record or well-known file and try again.',
    });
    expect(await storedBadges(currentUserId)).toHaveLength(0);
    // The challenge survives a failed attempt, so the owner can publish and retry.
    expect(await storedChallenges(currentUserId)).toHaveLength(1);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('grants nothing when the well-known body carries the WRONG token', async () => {
    await seedChallenge(currentUserId, 'nate.example', 'tok-right', new Date(Date.now() + 60_000));
    mockResolveTxt.mockRejectedValueOnce(new Error('ENOTFOUND'));
    mockSafeFetch.mockResolvedValueOnce(wellKnownResponse(200, 'tok-wrong'));

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(res.status).toBe(400);
    expect(await storedBadges(currentUserId)).toHaveLength(0);
  });

  it('does not crash when safeFetch rejects an SSRF target', async () => {
    await seedChallenge(currentUserId, 'internal.example', 'tok-ssrf', new Date(Date.now() + 60_000));
    mockResolveTxt.mockRejectedValueOnce(new Error('ENOTFOUND'));
    mockSafeFetch.mockRejectedValueOnce(new Error('SSRF: private IP blocked'));

    const res = await request('POST', '/identity/domains/internal.example/verify');

    expect(res.status).toBe(400);
    expect(await storedBadges(currentUserId)).toHaveLength(0);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('refuses when there is no challenge at all', async () => {
    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(res.status).toBe(400);
    expect(mockResolveTxt).not.toHaveBeenCalled();
  });

  it("does not accept another account's challenge", async () => {
    // The lookup is scoped to the caller: a token issued to somebody else must
    // not prove anything here, however real the published DNS record is.
    const other = await signInAsFreshAccount();
    await seedChallenge(other, 'nate.example', 'tok-other', new Date(Date.now() + 60_000));
    await signInAsFreshAccount();
    mockResolveTxt.mockResolvedValue([['oxy-domain-verification=tok-other']]);

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(res.status).toBe(400);
    expect(await storedBadges(currentUserId)).toHaveLength(0);
  });

  it('REFRESHES an already-proven domain in place instead of adding a second badge', async () => {
    await getDb().insert(userVerifiedDomains).values({
      userId: currentUserId,
      domain: 'nate.example',
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      method: 'well-known',
    });
    await seedChallenge(currentUserId, 'nate.example', 'tok-again', new Date(Date.now() + 60_000));
    mockResolveTxt.mockResolvedValueOnce([['oxy-domain-verification=tok-again']]);

    const res = await request('POST', '/identity/domains/nate.example/verify');

    expect(res.status).toBe(200);
    const badges = await storedBadges(currentUserId);
    expect(badges).toHaveLength(1);
    expect(badges[0].method).toBe('dns-txt');
    expect(badges[0].verifiedAt.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00.000Z').getTime());
  });

  it('rejects a malformed domain with 400 before touching the database', async () => {
    const res = await request('POST', '/identity/domains/not_a_domain/verify');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'BAD_REQUEST', message: 'Invalid domain' });
    expect(mockResolveTxt).not.toHaveBeenCalled();
  });
});

describe('GET /identity/domains', () => {
  it('returns the badges as { domains }, in insertion order', async () => {
    await getDb().insert(userVerifiedDomains).values([
      { userId: currentUserId, domain: 'first.example', verifiedAt: new Date('2026-01-01T00:00:00.000Z'), method: 'dns-txt', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { userId: currentUserId, domain: 'second.example', verifiedAt: new Date('2026-02-01T00:00:00.000Z'), method: 'well-known', createdAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);

    const res = await request('GET', '/identity/domains');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      domains: [
        { domain: 'first.example', verifiedAt: '2026-01-01T00:00:00.000Z', method: 'dns-txt' },
        { domain: 'second.example', verifiedAt: '2026-02-01T00:00:00.000Z', method: 'well-known' },
      ],
    });
  });

  it('returns an empty list for an account with no badges', async () => {
    const res = await request('GET', '/identity/domains');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ domains: [] });
  });

  it("never returns another account's badges", async () => {
    const other = await signInAsFreshAccount();
    await getDb().insert(userVerifiedDomains).values({
      userId: other,
      domain: 'theirs.example',
      verifiedAt: new Date(),
      method: 'dns-txt',
    });
    await signInAsFreshAccount();

    const res = await request('GET', '/identity/domains');

    expect(res.body).toEqual({ domains: [] });
  });
});

describe('DELETE /identity/domains/:domain', () => {
  it('removes the badge, clears any outstanding challenge, and invalidates the cache', async () => {
    await getDb().insert(userVerifiedDomains).values({
      userId: currentUserId,
      domain: 'nate.example',
      verifiedAt: new Date(),
      method: 'dns-txt',
    });
    await seedChallenge(currentUserId, 'nate.example', 'tok-leftover', new Date(Date.now() + 60_000));

    const res = await request('DELETE', '/identity/domains/nate.example');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(await storedBadges(currentUserId)).toHaveLength(0);
    // A token issued before the badge was revoked must not survive it.
    expect(await storedChallenges(currentUserId)).toHaveLength(0);
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);
  });

  it('leaves other badges untouched', async () => {
    await getDb().insert(userVerifiedDomains).values([
      { userId: currentUserId, domain: 'keep.example', verifiedAt: new Date(), method: 'dns-txt' },
      { userId: currentUserId, domain: 'drop.example', verifiedAt: new Date(), method: 'dns-txt' },
    ]);

    await request('DELETE', '/identity/domains/drop.example');

    expect((await storedBadges(currentUserId)).map((row) => row.domain)).toEqual(['keep.example']);
  });

  it('returns 404 when the domain is not verified for this account', async () => {
    const res = await request('DELETE', '/identity/domains/nate.example');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'NOT_FOUND',
      message: 'Domain is not verified for this account',
    });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("refuses to remove another account's badge", async () => {
    const other = await signInAsFreshAccount();
    await getDb().insert(userVerifiedDomains).values({
      userId: other,
      domain: 'theirs.example',
      verifiedAt: new Date(),
      method: 'dns-txt',
    });
    await signInAsFreshAccount();

    const res = await request('DELETE', '/identity/domains/theirs.example');

    expect(res.status).toBe(404);
    expect(
      await getDb()
        .select({ id: userVerifiedDomains.id })
        .from(userVerifiedDomains)
        .where(and(eq(userVerifiedDomains.userId, other), eq(userVerifiedDomains.domain, 'theirs.example'))),
    ).toHaveLength(1);
  });
});
