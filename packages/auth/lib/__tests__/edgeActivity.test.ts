import { expect, test } from 'bun:test';
import { onRequest } from '../../functions/_middleware';

test('edge middleware preserves hub cookies, streams, and errors while telemetry is disabled', async () => {
  const response = new Response('private hub response', { headers: { 'set-cookie': '__Host-oxy-device=private; Secure; HttpOnly; Path=/' } });
  const context = {
    request: new Request('https://auth.oxy.so/hub/session'), env: {},
    waitUntil() { throw new Error('disabled telemetry scheduled work'); },
    next: async () => response,
  };
  expect(await onRequest(context)).toBe(response);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(await response.text()).toBe('private hub response');
  const failure = new Error('existing hub failure');
  context.next = async () => { throw failure; };
  await expect(onRequest(context)).rejects.toBe(failure);
});

test('enabled edge activity observes hub operations without publishing cookies or payloads', async () => {
  const previousFetch = globalThis.fetch;
  const batches: Array<Array<Record<string, unknown>>> = [];
  const pending: Promise<unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/auth/service-token') return Response.json({ token: 'test-token', expiresIn: 3600 });
    batches.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const request = new Request('https://auth.oxy.so/hub/session', { method: 'POST', headers: { cookie: '__Host-oxy-device=private-cookie' }, body: 'private-payload' });
    Object.defineProperty(request, 'cf', { value: { colo: 'MAD' } });
    const response = await onRequest({
      request,
      env: { OXY_EDGE_ACTIVITY_ENABLED: 'true', OXY_EDGE_ACTIVITY_API_KEY: 'key', OXY_EDGE_ACTIVITY_API_SECRET: 'secret' },
      waitUntil(promise) { pending.push(promise); },
      next: async () => new Response('private-hub-result'),
    });
    expect(await response.text()).toBe('private-hub-result');
    await Promise.all(pending);
    expect(batches.flat().map(event => [event.service, event.region, event.direction])).toEqual([['auth', 'edge-mad', 'inbound'], ['auth', 'edge-mad', 'outbound']]);
    expect(JSON.stringify(batches)).not.toMatch(/private-cookie|private-payload|private-hub-result|secret/);
  } finally { globalThis.fetch = previousFetch; }
});
