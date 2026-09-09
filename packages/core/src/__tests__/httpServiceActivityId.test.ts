import { HttpService } from '../HttpService';

describe('HttpService browser activity identifier', () => {
  const originalFetch = globalThis.fetch;
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (originalDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    jest.restoreAllMocks();
  });

  it('adds the runtime identifier after caller headers', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {},
    });
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    await http.get('/session/status', {
      headers: { 'X-Oxy-Activity-Id': 'caller-controlled' },
    });

    const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(requestHeaders['X-Oxy-Activity-Id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(requestHeaders['X-Oxy-Activity-Id']).not.toBe('caller-controlled');
  });
});
