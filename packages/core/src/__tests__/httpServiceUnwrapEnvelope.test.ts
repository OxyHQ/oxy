/**
 * `HttpService.unwrapResponse` envelope tests — driven through the REAL class
 * against a stubbed `fetch`, never by calling the private method.
 *
 * The convenience unwrap reduces the house `{ data: <payload> }` envelope to its
 * payload, and in doing so it discards every sibling key. That silently killed
 * pagination on the account audit trails (`GET /accounts/:id/audit` and
 * `GET /accounts/:id/billing/audit`, which answer `{ data, count, nextCursor }`):
 * the caller got a bare array, `getNextPageParam` read `undefined`, and there was
 * nothing at the call site to show that page 2 could never be requested.
 *
 * The three cases below are the whole contract, and each is load-bearing:
 *
 *  - a cursor page travels WHOLE (the regression),
 *  - a `{ data, pagination }` page still travels whole (the behaviour that
 *    already existed — the positive control for "pages are preserved"),
 *  - a bare `{ data }` body still unwraps (the control proving the convenience
 *    every other call site depends on is intact).
 *
 * Reverting the fix must redden the first and leave the other two green.
 */

import { HttpService } from '../HttpService';

/** One entry of an audit page — only the shape matters here. */
const ENTRY = { source: 'application_credential', eventType: 'created' } as const;

function jsonBody(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpService response-envelope unwrapping', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Drive a real `HttpService.get` against a stubbed wire body. */
  async function fetchWireBody<T>(body: unknown): Promise<T> {
    globalThis.fetch = jest.fn(async () => jsonBody(body)) as unknown as typeof fetch;
    const http = new HttpService({ baseURL: 'http://api.test.invalid' });
    return http.get<T>('/accounts/acct-1/audit', { cache: false });
  }

  it('preserves a cursor page whole — `count` and `nextCursor` reach the caller', async () => {
    const wire = { data: [ENTRY], count: 1, nextCursor: 'CURSOR-XYZ' };

    const page = await fetchWireBody<typeof wire>(wire);

    expect(page).toEqual(wire);
    // The cursor is the only thing that says where page 2 starts. Asserted on
    // its own because `toEqual` above would also pass a body that merely
    // happened to be an array of one entry.
    expect(page.nextCursor).toBe('CURSOR-XYZ');
    expect(page.count).toBe(1);
    expect(page.data).toEqual([ENTRY]);
  });

  it('preserves the LAST cursor page, where `nextCursor` is null', async () => {
    // The recognition is by key presence, not truthiness: if the envelope
    // collapsed into a bare array exactly when the stream ended, every caller
    // would crash on the final page instead of finishing.
    const wire = { data: [ENTRY], count: 1, nextCursor: null };

    const page = await fetchWireBody<typeof wire>(wire);

    expect(page).toEqual(wire);
    expect(page.nextCursor).toBeNull();
  });

  it('preserves the offset-paginated `{ data, pagination }` envelope (control)', async () => {
    const wire = {
      data: [ENTRY],
      pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
    };

    const page = await fetchWireBody<typeof wire>(wire);

    expect(page).toEqual(wire);
  });

  it('still unwraps a bare `{ data }` success envelope to its payload (control)', async () => {
    const payload = { id: 'acct-1', name: 'Acme' };

    const unwrapped = await fetchWireBody<typeof payload>({ data: payload });

    expect(unwrapped).toEqual(payload);
  });

  it('still unwraps `{ data, count }`, which a dozen callers type as the bare payload', async () => {
    // `{ data, count }` is answered by ~15 routes whose Console call sites type
    // the result `Array<T>`. `count` is `data.length` — recoverable — so this
    // envelope deliberately does NOT survive, and widening the rule to "any
    // sibling key" would break every one of those callers at runtime.
    const entries = [ENTRY, ENTRY];

    const unwrapped = await fetchWireBody<typeof entries>({ data: entries, count: 2 });

    expect(unwrapped).toEqual(entries);
  });

  it('passes through a body that has no `data` key at all', async () => {
    // The cursor surfaces already in the SDK (`{ follows, nextCursor }`,
    // `{ records, nextCursor }`) rely on this lane.
    const wire = { follows: [{ relationshipId: 'rel-1' }], nextCursor: 'CURSOR-ABC' };

    const passed = await fetchWireBody<typeof wire>(wire);

    expect(passed).toEqual(wire);
  });
});
