import { OxyServices } from '../../OxyServices';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * `assets.text` / `assets.blob` resolve the asset's download URL through the
 * API, then fetch that URL directly. Cookies go only to the API's own origin —
 * never to whatever host the resolved URL names.
 */
describe('asset content fetch credentials', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  async function contentFetchFor(resolvedUrl: string): Promise<FetchCall> {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('asset-body', { status: 200 });
    }) as typeof fetch;
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    jest.spyOn(oxy, 'request').mockResolvedValue({ url: resolvedUrl });

    expect(await oxy.assets.text('file-1')).toBe('asset-body');
    expect(calls).toHaveLength(1);
    return calls[0];
  }

  it('omits credentials for a URL on another host', async () => {
    const call = await contentFetchFor('https://attacker.oxy.so/cdn/object.txt');
    expect(call.url).toBe('https://attacker.oxy.so/cdn/object.txt');
    expect(call.init?.credentials).toBe('omit');
  });

  it('includes credentials for a URL on the configured API origin', async () => {
    const call = await contentFetchFor('https://api.oxy.so/assets/private-file/stream');
    expect(call.url).toBe('https://api.oxy.so/assets/private-file/stream');
    expect(call.init?.credentials).toBe('include');
  });
});
