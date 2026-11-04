import { createSignedFetcher, type SingleHopFetchInit } from '../node/signedFetch';

const INSTANCE_KEY = 'https://app.example/actor#main-key';
const ALICE_KEY = 'https://app.example/ap/users/alice#main-key';

/** A signed fetch over a scripted transport, recording each hop's URL and signing keyId. */
function rig(responses: Response[]) {
  const hops: Array<{ url: string; keyId: string | null }> = [];
  const fetcher = createSignedFetcher({
    sign: async () => 'sig',
    getInstanceKeyId: async () => INSTANCE_KEY,
    fetchSingleHop: async (url: string, init: SingleHopFetchInit) => {
      hops.push({ url, keyId: /keyId="([^"]+)"/.exec(init.headers.Signature ?? '')?.[1] ?? null });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected hop to ${url}`);
      return next;
    },
    userAgent: 'test',
  });
  const signedFetch = async (...args: Parameters<typeof fetcher>) =>
    (await fetcher(...args)).response;
  return { signedFetch, fetcher, hops };
}

it('signs as the instance and retries a 5xx unsigned', async () => {
  const { signedFetch, hops } = rig([new Response(null, { status: 502 }), new Response('{}')]);

  const res = await signedFetch('https://remote.example/notes/1', 'application/activity+json');

  expect(res.status).toBe(200);
  expect(hops).toEqual([
    { url: 'https://remote.example/notes/1', keyId: INSTANCE_KEY },
    { url: 'https://remote.example/notes/1', keyId: null },
  ]);
});

it('signs every hop as the given actor and never retries an actor-signed request unsigned', async () => {
  const redirected = rig([
    new Response(null, { status: 301, headers: { location: '/statuses/1' } }),
    new Response(null, { status: 401 }),
  ]);
  const refused = await redirected.signedFetch(
    'https://remote.example/notes/1',
    'application/activity+json',
    { keyId: ALICE_KEY },
  );
  expect(refused.status).toBe(401);
  expect(redirected.hops).toEqual([
    { url: 'https://remote.example/notes/1', keyId: ALICE_KEY },
    { url: 'https://remote.example/statuses/1', keyId: ALICE_KEY },
  ]);

  const failing = rig([new Response(null, { status: 503 })]);
  const res = await failing.signedFetch(
    'https://remote.example/notes/1',
    'application/activity+json',
    { keyId: ALICE_KEY },
  );
  expect(res.status).toBe(503);
  expect(failing.hops).toHaveLength(1);
});

it('retries a redirected 5xx unsigned from where the redirect landed, and reports that URL', async () => {
  const { fetcher, hops } = rig([
    new Response(null, { status: 302, headers: { location: '/users/bob' } }),
    new Response(null, { status: 502 }),
    new Response('{}'),
  ]);

  const { response, finalUrl } = await fetcher(
    'https://remote.example/@bob',
    'application/activity+json',
  );

  expect(response.status).toBe(200);
  expect(finalUrl).toBe('https://remote.example/users/bob');
  expect(hops).toEqual([
    { url: 'https://remote.example/@bob', keyId: INSTANCE_KEY },
    { url: 'https://remote.example/users/bob', keyId: INSTANCE_KEY },
    { url: 'https://remote.example/users/bob', keyId: null },
  ]);
});
