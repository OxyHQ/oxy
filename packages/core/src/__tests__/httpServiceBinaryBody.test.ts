/**
 * Raw byte request bodies.
 *
 * The service-token stream uploads (`POST /assets/service/app`,
 * `/assets/service/user-media`) take a file's bytes as the WHOLE body with the
 * file's own `Content-Type`. Before this path existed a `Uint8Array` fell
 * through to `JSON.stringify` and left as `{"0":137,"1":80,…}` under
 * `application/json` — the server would have hashed and stored that text.
 */

import { HttpService } from '../HttpService';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function readHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

describe('HttpService binary bodies', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function post(body: unknown, headers?: Record<string, string>): Promise<FetchCall> {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    await http.post('/assets/service/app', body, { skipAuth: true, cache: false, headers });
    const call = calls.find((entry) => entry.url.endsWith('/assets/service/app'));
    if (!call) throw new Error('no upload call was made');
    return call;
  }

  it('sends a Uint8Array as the body itself, under the caller’s Content-Type', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const call = await post(bytes, { 'Content-Type': 'image/png' });

    expect(call.init?.body).toBe(bytes);
    expect(readHeaders(call.init)['Content-Type']).toBe('image/png');
  });

  it('sends an ArrayBuffer and a Blob as given, defaulting to application/octet-stream', async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const bufferCall = await post(buffer);
    expect(bufferCall.init?.body).toBe(buffer);
    expect(readHeaders(bufferCall.init)['Content-Type']).toBe('application/octet-stream');

    const blob = new Blob([new Uint8Array([4, 5])], { type: 'image/webp' });
    const blobCall = await post(blob, { 'Content-Type': 'image/webp' });
    expect(blobCall.init?.body).toBe(blob);
  });

  it('still sends a plain object as JSON', async () => {
    const call = await post({ visibility: 'public' });

    expect(call.init?.body).toBe(JSON.stringify({ visibility: 'public' }));
    expect(readHeaders(call.init)['Content-Type']).toBe('application/json');
  });
});
