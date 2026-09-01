/**
 * The identity cache-key enumeration, checked against the keys REAL reads
 * produce.
 *
 * A list-equality assertion on `OXY_IDENTITY_CACHE_PREFIXES` alone would be
 * satisfied forever by a typo (`GET:/profile/username/`) — it pins the list's
 * shape, not its correctness. So the load-bearing test here drives each prefix
 * from the SDK method that actually reads under it, over the real
 * `HttpService` cache, and asserts the sweep evicts every one. A prefix that
 * stops matching its read fails here rather than in production.
 *
 * The list is shared by every profile writer (`updateProfile`,
 * `updatePrivacySettings`, `updateAccount`) and by the Node-only
 * `oxy:user:invalidate` subscriber in `@oxyhq/core/server`, precisely because
 * two hand-written copies of it had already drifted apart.
 */

import { OxyServices } from '../../OxyServices';
import {
  OXY_IDENTITY_CACHE_PREFIXES,
  evictOxyIdentityCache,
  oxyUserByIdCacheKey,
  type OxyIdentityCacheEvictor,
} from '../identityCacheSweep';

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  })}.sig`;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRecordingEvictor() {
  const entries: string[] = [];
  const prefixes: string[] = [];
  const evictor: OxyIdentityCacheEvictor = {
    clearCacheEntry: (key) => {
      entries.push(key);
    },
    clearCacheByPrefix: (prefix) => {
      prefixes.push(prefix);
      return 0;
    },
  };
  return { evictor, entries, prefixes };
}

describe('evictOxyIdentityCache — the key list', () => {
  it('sweeps every identity prefix and the exact by-id entry', () => {
    const { evictor, entries, prefixes } = makeRecordingEvictor();
    evictOxyIdentityCache(evictor, 'abc123');

    expect(prefixes).toEqual([
      'GET:/session/user/',
      'GET:/users/me',
      'GET:/auth/lookup/',
      'GET:/profiles/username/',
      'GET:/profiles/resolve',
    ]);
    expect(prefixes).toEqual([...OXY_IDENTITY_CACHE_PREFIXES]);
    expect(entries).toEqual([oxyUserByIdCacheKey('abc123')]);
  });

  it('sweeps the prefixes but writes no by-id entry when the id is unknown', () => {
    const { evictor, entries, prefixes } = makeRecordingEvictor();
    evictOxyIdentityCache(evictor);

    expect(prefixes).toEqual([...OXY_IDENTITY_CACHE_PREFIXES]);
    expect(entries).toEqual([]);
  });

  it('treats an empty-string id as unknown rather than building `GET:/users/`', () => {
    // `GET:/users/` would be a prefix-shaped key handed to an EXACT-match
    // deleter, so it evicts nothing while looking like it evicted something.
    const { evictor, entries } = makeRecordingEvictor();
    evictOxyIdentityCache(evictor, '');
    expect(entries).toEqual([]);
  });
});

describe('evictOxyIdentityCache — every prefix matches a real read', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  const USER_ID = 'user-77';

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({
      baseURL: 'http://test.invalid',
      enableRetry: false,
      requestTimeout: 1000,
    });
    oxy.httpService.setTokens(makeJwt({ userId: USER_ID }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  /** One real read per swept key, each warmed into the real response cache. */
  const reads: ReadonlyArray<{
    key: string;
    warm: (client: OxyServices) => Promise<unknown>;
  }> = [
    { key: 'GET:/session/user/', warm: (c) => c.getUserBySession('sess-1') },
    { key: 'GET:/users/me', warm: (c) => c.getCurrentUser() },
    { key: 'GET:/auth/lookup/', warm: (c) => c.lookupUsername('alice') },
    { key: 'GET:/profiles/username/', warm: (c) => c.getProfileByUsername('alice') },
    { key: 'GET:/profiles/resolve', warm: (c) => c.resolveProfile('@alice@test.invalid') },
    { key: 'GET:/users/<id>', warm: (c) => c.getUserById(USER_ID) },
  ];

  it('covers every prefix in the list with a read (no prefix goes unexercised)', () => {
    // Vacuity floor: adding a prefix to the list without adding the read that
    // exercises it fails HERE, rather than silently shrinking the test below.
    expect(reads).toHaveLength(OXY_IDENTITY_CACHE_PREFIXES.length + 1);
    for (const prefix of OXY_IDENTITY_CACHE_PREFIXES) {
      expect(reads.some((read) => read.key === prefix)).toBe(true);
    }
  });

  it.each(reads)('evicts the entry warmed by $key', async ({ warm }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: USER_ID, username: 'alice' }));
    await warm(oxy);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Control: the entry really is warm (a miss would call the un-queued mock).
    await warm(oxy);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    evictOxyIdentityCache(oxy, USER_ID);

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: USER_ID, username: 'alice-2' }));
    await warm(oxy);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
