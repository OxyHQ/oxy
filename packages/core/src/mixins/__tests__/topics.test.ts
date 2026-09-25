/**
 * Topics mixin envelope-unwrapping tests.
 *
 * oxy-api returns ENVELOPES for the list/collection topic routes
 * (`{ topics, total, limit, offset }`, `{ categories }`, `{ topics }`,
 * `{ topics: <name-keyed map> }`), while the SDK's `unwrapResponse` only unwraps
 * the `{ data }` success shape. These tests pin the mixin's own unwrapping so the
 * public methods genuinely return `TopicData[]` / the pagination envelope — not a
 * raw wrapper that a caller would `.map` over and crash on.
 *
 * They drive the REAL `makeRequest` path by mocking `globalThis.fetch`, so the
 * `unwrapResponse` pass-through (no `data` key) is exercised end to end.
 */

import { OxyServices } from '../../OxyServices';

/** A raw JSON `Response` — the body is exactly what the topic routes return. */
function rawResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A non-verified JWT whose payload decodes to the given claims. Puts the SDK in
 * an authenticated state so the `POST /topics/resolve` carries a bearer header.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const fullPayload = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(fullPayload)}.sig`;
}

const topic = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  name,
  slug: name,
  displayName: name,
  description: '',
  type: 'topic',
  source: 'ai',
  aliases: [],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('topics mixin envelope unwrapping', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid', enableRetry: false });
    // Authenticate so the resolve POST carries a bearer. Harmless for GETs.
    oxy.httpService.setTokens(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('getTopicCategories', () => {
    it('unwraps { categories } into a TopicData[]', async () => {
      fetchMock.mockResolvedValueOnce(
        rawResponse({ categories: [topic('c1', 'tech', { type: 'category' }), topic('c2', 'sports', { type: 'category' })] }),
      );
      const result = await oxy.getTopicCategories();
      expect(Array.isArray(result)).toBe(true);
      expect(result.map((t) => t._id)).toEqual(['c1', 'c2']);
    });

    it('returns [] when the envelope omits categories', async () => {
      fetchMock.mockResolvedValueOnce(rawResponse({}));
      await expect(oxy.getTopicCategories()).resolves.toEqual([]);
    });
  });

  describe('searchTopics', () => {
    it('unwraps { topics } into a TopicData[]', async () => {
      fetchMock.mockResolvedValueOnce(rawResponse({ topics: [topic('t1', 'react'), topic('t2', 'reactivity')] }));
      const result = await oxy.searchTopics('react');
      expect(result.map((t) => t.name)).toEqual(['react', 'reactivity']);
    });

    it('returns [] when the envelope omits topics', async () => {
      fetchMock.mockResolvedValueOnce(rawResponse({}));
      await expect(oxy.searchTopics('nothing')).resolves.toEqual([]);
    });
  });

  describe('listTopics', () => {
    it('returns the full pagination envelope', async () => {
      fetchMock.mockResolvedValueOnce(
        rawResponse({ topics: [topic('t1', 'a'), topic('t2', 'b')], total: 42, limit: 2, offset: 10 }),
      );
      const result = await oxy.listTopics({ limit: 2, offset: 10 });
      expect(result.topics.map((t) => t._id)).toEqual(['t1', 't2']);
      expect(result.total).toBe(42);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(10);
    });

    it('falls back to the requested limit/offset and topics.length when the server omits them', async () => {
      fetchMock.mockResolvedValueOnce(rawResponse({ topics: [topic('t1', 'a')] }));
      const result = await oxy.listTopics({ limit: 5, offset: 3 });
      expect(result.topics).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(5);
      expect(result.offset).toBe(3);
    });

    it('returns an empty envelope when the server returns nothing useful', async () => {
      fetchMock.mockResolvedValueOnce(rawResponse({}));
      const result = await oxy.listTopics();
      expect(result).toEqual({ topics: [], total: 0, limit: 0, offset: 0 });
    });
  });

  describe('resolveTopicNames', () => {
    it('flattens the name-keyed { topics } map into a TopicData[]', async () => {
      // POST /topics/resolve returns a Record keyed by lowercased name, NOT an array.
      fetchMock.mockResolvedValueOnce(
        rawResponse({ topics: { react: topic('t1', 'react'), vue: topic('t2', 'vue') } }),
      );
      const result = await oxy.resolveTopicNames([
        { name: 'react', type: 'topic' },
        { name: 'vue', type: 'topic' },
      ]);
      expect(Array.isArray(result)).toBe(true);
      expect(result.map((t) => t.name).sort()).toEqual(['react', 'vue']);
    });

    it('returns [] when the map is empty or missing', async () => {
      fetchMock.mockResolvedValueOnce(rawResponse({ topics: {} }));
      await expect(oxy.resolveTopicNames([])).resolves.toEqual([]);
    });
  });

  describe('getTopicBySlug (single, no envelope)', () => {
    it('returns the raw TopicData unchanged', async () => {
      fetchMock.mockResolvedValueOnce(rawResponse(topic('t1', 'react')));
      const result = await oxy.getTopicBySlug('react');
      expect(result._id).toBe('t1');
      expect(result.name).toBe('react');
    });
  });
});
