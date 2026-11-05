import { HttpService } from '../HttpService';

function jwt(actor: string, context: string, nonce: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({
    ver: 2,
    type: 'access',
    userId: 'collective',
    sub: 'collective',
    sessionId: 'same-session',
    sid: 'same-session',
    act: { sub: actor },
    device_context_id: context,
    exp: 4102444800,
    jti: nonce,
  })}.signature`;
}

describe('audit of delegated claims in the HTTP session fence', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it.each([
    ['same actor, different context', 'nate', 'ctx-old', 'nate', 'ctx-new'],
    ['different actor, same session', 'nate', 'ctx-old', 'alice', 'ctx-new'],
  ])('%s: documents the current local behavior with synthetic tokens', async (_label, firstActor, firstContext, nextActor, nextContext) => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = jest.fn(async () => {
      started();
      return new Promise<Response>((resolve) => { release = resolve; });
    }) as typeof fetch;
    const http = new HttpService({ baseURL: 'https://oxy.example', enableRetry: false });
    http.setTokens(jwt(firstActor, firstContext, 'one'));
    const before = http.getSessionEpoch();
    const request = http.get('/private', { retry: false, cache: false });
    await requestStarted;
    http.setTokens(jwt(nextActor, nextContext, 'two'));
    expect(http.getSessionEpoch()).toBe(before);
    release(new Response(JSON.stringify({ data: { owner: firstActor } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(request).resolves.toMatchObject({ owner: firstActor });
  });
});
