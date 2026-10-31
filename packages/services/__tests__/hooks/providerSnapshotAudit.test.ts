/** @jest-environment node */
import { OxyServices } from '@oxy.so/core';

const token = (userId: string) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId })).toString('base64url')}.fixture`;

it('shows an independently observed provider can be replaced before the request', async () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example', enableRetry: false });
  const http = oxy.http;
  const alice = token('alice');
  const bob = token('bob');
  const source = { read: () => alice, snapshot: () => 'alice:0' };
  http.setTokens(alice);
  http.setAccessTokenProvider(source.read);
  const capturedSource = source.snapshot();
  const capturedEpoch = http.getSessionEpoch();
  const belongsToAlice = () => source.snapshot() === capturedSource && http.getSessionEpoch() === capturedEpoch;
  let sentTo: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(async (_url, init) => {
    sentTo = new Headers(init?.headers).get('authorization');
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    http.setAccessTokenProvider(() => bob);
    expect(belongsToAlice()).toBe(true);
    await http.post('/action', { text: 'alice input' }, { retry: false });
    expect(sentTo).toBe(`Bearer ${bob}`);
    expect(http.getSessionEpoch()).not.toBe(capturedEpoch);
  } finally {
    globalThis.fetch = originalFetch;
    oxy.dispose();
  }
});

it('checks the authoritative root before a linked client has received its token event', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  oxy.session.setAccessToken(token('alice'));
  const capturedEpoch = oxy.http.getSessionEpoch();
  let linked!: ReturnType<OxyServices['createLinkedClient']>;
  let duringNotification: { rootStillOwned: boolean; linkedStillAlice: boolean } | null = null;
  const unsubscribe = oxy.session.onChange(() => {
    duringNotification = {
      rootStillOwned: oxy.http.getSessionEpoch() === capturedEpoch,
      linkedStillAlice: linked.client.getAccessToken() === token('alice'),
    };
  });
  linked = oxy.createLinkedClient({ baseURL: 'https://api.example' });
  try {
    oxy.session.setAccessToken(token('bob'));
    expect(duringNotification).toEqual({ rootStillOwned: false, linkedStillAlice: true });
    expect(linked.client.getAccessToken()).toBe(token('bob'));
    oxy.session.setAccessToken(token('alice'));
    expect(oxy.http.getSessionEpoch()).not.toBe(capturedEpoch);
  } finally {
    unsubscribe();
    linked.dispose();
    oxy.dispose();
  }
});
