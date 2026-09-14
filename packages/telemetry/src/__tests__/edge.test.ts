/** @jest-environment node */
import { observeEdgeRequest, type EdgeActivityEnv } from '../edge';

function setup(path = '/private-name.png?email=secret@example.com') {
  const request = new Request(`https://example.com${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.8', 'X-Oxy-Source-Region': 'eu-west-1', Authorization: 'private' } });
  Object.assign(request, { cf: { colo: 'MAD', country: 'ES' } });
  const tasks: Promise<unknown>[] = [];
  const env: EdgeActivityEnv = { OXY_EDGE_ACTIVITY_ENABLED: 'true', OXY_EDGE_ACTIVITY_API_KEY: 'key', OXY_EDGE_ACTIVITY_API_SECRET: 'secret' };
  const fetcher = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('service-token') ? Response.json({ token: 'token', expiresIn: 3600 }) : new Response(null, { status: 204 }));
  return { request, env, tasks, fetcher, ctx: { waitUntil: (task: Promise<unknown>) => tasks.push(task) }, service: 'noted', onError: jest.fn() };
}

test('preserves the response stream, cache headers and media type without personal metadata', async () => {
  const state = setup();
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('image')); c.close(); } }), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=3600' } });
  expect(await observeEdgeRequest({ ...state, next: () => response })).toBe(response);
  expect(response.bodyUsed).toBe(false);
  await Promise.all(state.tasks);
  const calls = state.fetcher.mock.calls as unknown as [URL, RequestInit][];
  expect(JSON.parse(String(calls[0][1].body))).toEqual({ apiKey: 'key', apiSecret: 'secret' });
  const events = JSON.parse(String(calls[1][1].body));
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ region: 'edge-mad', scope: 'external', direction: 'inbound', activityType: 'media', targetRegion: 'edge-mad' });
  expect(events[1]).toMatchObject({ direction: 'outbound', sourceRegion: 'edge-mad' });
  expect(events[0].sourceRegion).toBeUndefined();
  expect(JSON.stringify(events)).not.toMatch(/private|secret|203\.0|example|email|eu-west/);
  expect(await response.text()).toBe('image');
});

test('preserves handler errors and only reports received activity', async () => {
  const state = setup(); const error = new Error('upstream');
  await expect(observeEdgeRequest({ ...state, next: () => { throw error; } })).rejects.toBe(error);
  await Promise.all(state.tasks);
  const calls = state.fetcher.mock.calls as unknown as [URL, RequestInit][];
  expect(JSON.parse(String(calls[1][1].body)).map((x: {direction:string}) => x.direction)).toEqual(['inbound']);
});

test.each(['/health', '/api/ready', '/internal/activity', '/auth/service-token', '/cdn-cgi/trace'])('excludes control route %s', async (path) => {
  const state = setup(path); const response = new Response(null);
  expect(await observeEdgeRequest({ ...state, next: () => response })).toBe(response);
  expect(state.tasks).toHaveLength(0);
});

test('disabled bindings bypass publishing and missing enabled credentials report a fixed error', async () => {
  const state = setup(); state.env = {};
  await observeEdgeRequest({ ...state, next: () => new Response(null) });
  expect(state.tasks).toHaveLength(0);
  state.env.OXY_EDGE_ACTIVITY_ENABLED = 'true';
  await observeEdgeRequest({ ...state, next: () => new Response(null) });
  await Promise.all(state.tasks);
  expect(state.onError).toHaveBeenCalledWith('Edge activity publication failed');
  expect(state.fetcher).not.toHaveBeenCalled();
});

test('verified peer is internal independently of inbound/outbound', async () => {
  const state = setup();
  await observeEdgeRequest({ ...state, peer: {service:'mention', region:'us-west-2'}, next: () => new Response(null) });
  await Promise.all(state.tasks);
  const calls = state.fetcher.mock.calls as unknown as [URL, RequestInit][];
  expect(JSON.parse(String(calls[1][1].body))).toEqual([
    expect.objectContaining({scope:'internal', direction:'inbound', sourceRegion:'us-west-2', sourceService:'mention'}),
    expect.objectContaining({scope:'internal', direction:'outbound', targetRegion:'us-west-2', targetService:'mention'}),
  ]);
});

test('caches token values and invalidates on ingestion 401 without retrying a batch', async () => {
  const state = setup();
  const fetcher = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('service-token') ? Response.json({token:'token',expiresIn:3600}) : new Response(null, {status:401}));
  for (let i=0;i<2;i++) { await observeEdgeRequest({...state, fetcher, next:()=>new Response(null)}); await Promise.all(state.tasks); }
  expect(fetcher.mock.calls.map(([url])=>String(url))).toEqual(['https://api.oxy.so/auth/service-token','https://api.oxy.so/internal/activity','https://api.oxy.so/auth/service-token','https://api.oxy.so/internal/activity']);
});

test('unknown colo stays unknown even when caller spoofs geo headers', async () => {
  const state = setup(); Object.assign(state.request, {cf:undefined});
  await observeEdgeRequest({...state, credential:async()=>'injected', next:()=>new Response(null)}); await Promise.all(state.tasks);
  const calls = state.fetcher.mock.calls as unknown as [URL, RequestInit][];
  expect(calls).toHaveLength(1);
  expect(JSON.parse(String(calls[0][1].body))[0].region).toBe('unknown');
});

test('reuses only a token value on later requests and refreshes after credential rotation', async () => {
  const state = setup();
  for (let i=0;i<2;i++) { await observeEdgeRequest({...state,next:()=>new Response(null)}); await Promise.all(state.tasks); }
  expect(state.fetcher.mock.calls).toHaveLength(3);
  state.env.OXY_EDGE_ACTIVITY_API_SECRET = 'rotated';
  await observeEdgeRequest({...state,next:()=>new Response(null)}); await Promise.all(state.tasks);
  expect(state.fetcher.mock.calls).toHaveLength(5);
});

test('bounds an injected credential that never resolves without delaying the response', async () => {
  jest.useFakeTimers();
  try {
    const state = setup(); const response = new Response(null);
    expect(await observeEdgeRequest({...state,credential:()=>new Promise(()=>{}),next:()=>response})).toBe(response);
    await jest.advanceTimersByTimeAsync(4_000);
    await Promise.all(state.tasks);
    expect(state.onError).toHaveBeenCalledTimes(1);
    expect(state.fetcher).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('bounds token response size and never publishes credentials in diagnostics', async () => {
  const state = setup();
  const fetcher = jest.fn(async()=>new Response('secret'.repeat(4000)));
  await observeEdgeRequest({...state,fetcher,next:()=>new Response(null)});
  await Promise.all(state.tasks);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state.onError).toHaveBeenCalledWith('Edge activity publication failed');
});
