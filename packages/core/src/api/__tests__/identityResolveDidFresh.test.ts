/**
 * `resolveDid(userId, { fresh: true })` against the REAL response cache.
 *
 * `#key-1` of a DID document is the account's Peable receive key. A plain
 * `resolveDid` is cached for a minute in the caller's process, so for up to a
 * minute after a key rotation a server deriving a money address from it used
 * the previous key. A fresh read must reach the network even with a warm
 * cache, tell HTTP caches not to answer for the origin, and leave the cache
 * holding nothing older than what it read.
 */

import { OxyServices } from '../../OxyServices';

const OLD_KEY = `04${'aa'.repeat(64)}`;
const NEW_KEY = `04${'bb'.repeat(64)}`;

function didDocument(publicKeyHex: string) {
  const id = 'did:web:oxy.so:u:user-1';
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    controller: [id],
    verificationMethod: [
      {
        id: `${id}#key-1`,
        type: 'EcdsaSecp256k1VerificationKey2019',
        controller: id,
        publicKeyHex,
      },
    ],
    authentication: [`${id}#key-1`],
    assertionMethod: [`${id}#key-1`],
    alsoKnownAs: [],
    service: [],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function keyOf(document: unknown): string | undefined {
  return (document as ReturnType<typeof didDocument>).verificationMethod[0]?.publicKeyHex;
}

describe('oxy.identity.resolveDid fresh reads (real cache)', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid', enableRetry: false });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('a plain read is served from the cache, so it can return a rotated key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(didDocument(OLD_KEY)));
    expect(keyOf(await oxy.identity.resolveDid('user-1'))).toBe(OLD_KEY);
    fetchMock.mockResolvedValueOnce(jsonResponse(didDocument(NEW_KEY)));
    expect(keyOf(await oxy.identity.resolveDid('user-1'))).toBe(OLD_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a fresh read reaches the origin past a warm cache and asks HTTP caches not to answer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(didDocument(OLD_KEY)));
    await oxy.identity.resolveDid('user-1');

    fetchMock.mockResolvedValueOnce(jsonResponse(didDocument(NEW_KEY)));
    expect(keyOf(await oxy.identity.resolveDid('user-1', { fresh: true }))).toBe(NEW_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toBe('http://test.invalid/u/user-1/did.json');
    expect(new Headers(init?.headers).get('cache-control')).toBe('no-cache');
  });

  it('a fresh read drops the stale cached copy, so the next plain read is not older', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(didDocument(OLD_KEY)));
    await oxy.identity.resolveDid('user-1');
    fetchMock.mockResolvedValueOnce(jsonResponse(didDocument(NEW_KEY)));
    await oxy.identity.resolveDid('user-1', { fresh: true });

    fetchMock.mockResolvedValueOnce(jsonResponse(didDocument(NEW_KEY)));
    expect(keyOf(await oxy.identity.resolveDid('user-1'))).toBe(NEW_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('two fresh reads are two requests, never one joined read', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(didDocument(NEW_KEY)));
    await Promise.all([
      oxy.identity.resolveDid('user-1', { fresh: true }),
      oxy.identity.resolveDid('user-1', { fresh: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
