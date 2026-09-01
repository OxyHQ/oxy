/**
 * Sender-avatar resolution and its cache, against a REAL Postgres.
 *
 * Two separate concerns live here.
 *
 * **The SSRF posture**, which the Mongo-era tests already pinned: the API never
 * probes a sender-controlled host, private and loopback hosts are refused, and
 * a hung BIMI resolver cannot stall the caller.
 *
 * **The expiry predicate, which is new and is the point of the port.**
 * `sender_avatars` is the table `db/schema/CONVENTIONS.md` names as its class-(B)
 * example: both reads returned the cached row with NO expiry filter, so the
 * only thing standing between a user and a stale avatar was Mongo's TTL monitor
 * having got there first — a background job as part of the table's CORRECTNESS.
 * The ported reads carry `senderAvatarIsFresh()`, so an expired row that the
 * sweep has not reached yet is a MISS. Both reads are asserted, because they
 * are separate queries and only one of them having the predicate is exactly the
 * shape that ships.
 */

const mockResolveTxt = jest.fn();

jest.mock('dns/promises', () => ({
  __esModule: true,
  default: { resolveTxt: (...args: unknown[]) => mockResolveTxt(...args) },
  resolveTxt: (...args: unknown[]) => mockResolveTxt(...args),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { senderAvatars } from '../../db/schema/senderAvatars';
import { users } from '../../db/schema/users';
import { getAvatarPath, getAvatarPathsBatch } from '../senderAvatar.service';

const unique = () => randomUUID().replace(/-/g, '');

/** The path the proxy serves an external image through. */
const proxied = (url: string) => `/email/proxy?url=${Buffer.from(url).toString('base64')}`;

async function cachedRow(email: string) {
  const [row] = await getDb()
    .select()
    .from(senderAvatars)
    .where(eq(senderAvatars.email, email));
  return row;
}

const fetchMock = jest.fn();

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  mockResolveTxt.mockRejectedValue(new Error('no bimi'));
  fetchMock.mockResolvedValue({ ok: false, headers: { get: jest.fn() } });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('senderAvatar.service — SSRF posture', () => {
  it('does not fetch sender-controlled favicon hosts from the API server', async () => {
    const domain = `d${unique().slice(0, 10)}.example`;
    const avatarPath = await getAvatarPath(`sender@${domain}`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://www.gravatar.com/avatar/');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`${domain}/favicon.ico`))).toBe(
      false,
    );
    expect(avatarPath).toBe(proxied(`https://${domain}/favicon.ico`));
  });

  it('rejects localhost and private IP domains for favicon fallback', async () => {
    await expect(getAvatarPath(`a${unique().slice(0, 8)}@localhost`)).resolves.toBeNull();
    await expect(getAvatarPath(`b${unique().slice(0, 8)}@127.0.0.1`)).resolves.toBeNull();
    await expect(getAvatarPath(`c${unique().slice(0, 8)}@10.0.0.5`)).resolves.toBeNull();

    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('www.gravatar.com'))).toBe(
      true,
    );
  });

  it('bounds BIMI DNS lookups so unresolved domains do not stall avatar resolution', async () => {
    // Real timers, deliberately. The resolution now ends in a DATABASE WRITE,
    // and postgres.js is not driven by jest's fake clock — freezing time for
    // the whole call hangs the suite rather than failing it. The BIMI bound is
    // 1500ms, so waiting it out costs one real second and a half and proves
    // the same thing: a resolver that never answers does not stall the caller.
    mockResolveTxt.mockReturnValue(new Promise(() => undefined));
    const domain = `slow${unique().slice(0, 8)}.example`;
    const email = `attacker@${domain}`;

    const startedAt = Date.now();
    await expect(getAvatarPath(email)).resolves.toBe(proxied(`https://${domain}/favicon.ico`));
    const elapsed = Date.now() - startedAt;

    expect(mockResolveTxt).toHaveBeenCalledWith(`default._bimi.${domain}`);
    // Bounded, and actually bounded BY the timeout rather than by luck.
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(6000);
    expect(await cachedRow(email)).toMatchObject({ source: 'favicon' });
  }, 15_000);
});

describe('senderAvatar.service — the cache', () => {
  it('resolves an Oxy account`s avatar without any outbound request', async () => {
    const username = `oxyuser${unique().slice(0, 10)}`;
    const avatarFileId = unique();
    await getDb().insert(users).values({ username, avatar: avatarFileId, color: 'teal' });

    const path = await getAvatarPath(`${username}@oxy.so`);

    expect(path).toBe(`/api/assets/${avatarFileId}/stream`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await cachedRow(`${username}@oxy.so`)).toMatchObject({ source: 'oxy' });
  });

  it('serves the second lookup from the cache, resolving nothing again', async () => {
    const email = `cached${unique().slice(0, 8)}@example.com`;

    const first = await getAvatarPath(email);
    fetchMock.mockClear();
    const second = await getAvatarPath(email);

    expect(second).toBe(first);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes case and surrounding space before reading or writing', async () => {
    // A write that skips the normalization creates a second cache row that no
    // read will ever find — the call-site obligation `senderAvatars` records.
    const email = `Mixed${unique().slice(0, 8)}@Example.COM`;

    await getAvatarPath(`  ${email}  `);

    expect(await cachedRow(email.toLowerCase())).toBeDefined();
    expect(await cachedRow(email)).toBeUndefined();
  });

  it('re-resolves an EXPIRED row rather than serving it — the single read', async () => {
    // Without `senderAvatarIsFresh()` this returns the stale value and the
    // assertion below reads `/stale`. The sweep is not involved: the row is
    // still present, deliberately.
    const email = `stale${unique().slice(0, 8)}@example.com`;
    await getDb().insert(senderAvatars).values({
      email,
      avatarPath: '/stale',
      source: 'gravatar',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const path = await getAvatarPath(email);

    expect(path).not.toBe('/stale');
    const refreshed = await cachedRow(email);
    expect(refreshed.avatarPath).toBe(path);
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('re-resolves an EXPIRED row rather than serving it — the BATCH read', async () => {
    // The batch is a SECOND query. Carrying the predicate on only one of the
    // two is exactly the shape that ships and is never noticed.
    const email = `stalebatch${unique().slice(0, 8)}@example.com`;
    await getDb().insert(senderAvatars).values({
      email,
      avatarPath: '/stale-batch',
      source: 'gravatar',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const resolved = await getAvatarPathsBatch([email]);

    expect(resolved.get(email)).not.toBe('/stale-batch');
    expect((await cachedRow(email)).expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('serves a still-fresh row from the batch without resolving it again', async () => {
    const email = `fresh${unique().slice(0, 8)}@example.com`;
    await getDb().insert(senderAvatars).values({
      email,
      avatarPath: '/fresh',
      source: 'gravatar',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const resolved = await getAvatarPathsBatch([email]);

    expect(resolved.get(email)).toBe('/fresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deduplicates and normalizes a batch, and returns one entry per address', async () => {
    const email = `Batch${unique().slice(0, 8)}@Example.com`;
    await getDb().insert(senderAvatars).values({
      email: email.toLowerCase(),
      avatarPath: '/one',
      source: 'gravatar',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const resolved = await getAvatarPathsBatch([email, `  ${email.toUpperCase()}  `]);

    expect(resolved.size).toBe(1);
    expect(resolved.get(email.toLowerCase())).toBe('/one');
  });

  it('returns an empty map for an empty batch without touching the database', async () => {
    await expect(getAvatarPathsBatch([])).resolves.toEqual(new Map());
  });
});
