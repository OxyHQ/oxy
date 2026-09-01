/**
 * The chains client — what it puts on the wire.
 *
 * There is exactly one piece of real logic here and it is the read's query
 * string: joining two lists, and including `since`/`limit` only when the caller
 * gave them. Everything else is a pass-through, so these cases pin the part that
 * can actually be wrong rather than restating the method bodies.
 *
 * `makeServiceRequest` is stubbed because it belongs to the auth mixin and has
 * its own suites; what matters here is the method, path and payload it is handed.
 */

import { OxyServicesChainsMixin } from '../OxyServices.chains';

type Call = { method: string; url: string; data?: unknown };

/** A minimal host carrying the mixin, with the service transport recorded. */
function client(): { calls: Call[]; api: any } {
  const calls: Call[] = [];
  class Base {
    makeServiceRequest(method: string, url: string, data?: unknown) {
      calls.push({ method, url, data });
      return Promise.resolve({ records: [], nextCursor: null });
    }
  }
  const Mixed = OxyServicesChainsMixin(Base as any);
  return { calls, api: new (Mixed as any)() };
}

describe('appendChainRecord', () => {
  it('POSTs the record to /chains/records untouched', async () => {
    const { calls, api } = client();

    await api.appendChainRecord({
      oxyUserId: 'u1',
      collection: 'app.mention.feed.post',
      rkey: 'p1',
      record: { text: 'hi' },
    });

    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/chains/records',
        data: {
          oxyUserId: 'u1',
          collection: 'app.mention.feed.post',
          rkey: 'p1',
          record: { text: 'hi' },
        },
      },
    ]);
  });
});

describe('readChainRecords', () => {
  it('joins authors and collections into one comma-separated query each', async () => {
    const { calls, api } = client();

    await api.readChainRecords({
      oxyUserIds: ['u1', 'u2'],
      collections: ['app.mention.feed.post', 'app.mention.feed.like'],
    });

    const url = new URL(`http://x${calls[0].url}`);
    expect(calls[0].method).toBe('GET');
    expect(url.pathname).toBe('/chains/records');
    expect(url.searchParams.get('authors')).toBe('u1,u2');
    expect(url.searchParams.get('collections')).toBe('app.mention.feed.post,app.mention.feed.like');
  });

  it('omits since and limit when the caller gave neither', async () => {
    // A `since=` or `limit=` sent as an empty string is not the same request —
    // the server validates both, so an always-present key would 400 a first page.
    const { calls, api } = client();

    await api.readChainRecords({ oxyUserIds: ['u1'], collections: ['app.mention.feed.post'] });

    const url = new URL(`http://x${calls[0].url}`);
    expect(url.searchParams.has('since')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('sends since and limit when it did', async () => {
    const { calls, api } = client();

    await api.readChainRecords({
      oxyUserIds: ['u1'],
      collections: ['app.mention.feed.post'],
      since: 'Y3Vyc29y',
      limit: 25,
    });

    const url = new URL(`http://x${calls[0].url}`);
    expect(url.searchParams.get('since')).toBe('Y3Vyc29y');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('escapes a cursor that is not URL-safe', async () => {
    // Cursors are opaque to the caller, so this client must not assume the
    // encoding the server happens to use today.
    const { calls, api } = client();

    await api.readChainRecords({
      oxyUserIds: ['u1'],
      collections: ['app.mention.feed.post'],
      since: 'a+b/c=',
    });

    const url = new URL(`http://x${calls[0].url}`);
    expect(url.searchParams.get('since')).toBe('a+b/c=');
  });
});
