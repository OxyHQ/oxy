/**
 * The CORS header lists, asserted by NAME.
 *
 * These two arrays are the whole reason a browser can send or read anything
 * beyond the CORS-safelisted headers, and getting one wrong fails in the worst
 * available way: `res.headers.get('X-Oxy-Request-Id')` returns `null`, no error
 * is thrown, nothing appears in a network log, and the calling code reads the
 * absence as "the server did not send it". There is no runtime symptom to
 * notice, so the only place this can be caught is here.
 *
 * Each assertion below names the headers it requires rather than counting them,
 * and each has an exact-length floor beside it. The floor is not redundant: an
 * edit that EMPTIED either array would satisfy every `not.toContain` in a
 * membership-only test, and a `toBeGreaterThan` floor is eroded by the list's own
 * growth. `toHaveLength` fails both on a deletion and on an unreviewed addition,
 * which is the review this file is standing in for.
 */

import { ALLOWED_HEADERS, ALLOWED_METHODS, EXPOSED_HEADERS } from '../cors';

/**
 * Every `X-Oxy-*` header the inference edge sets on a response.
 *
 * Kept as a list here rather than imported from the edge, deliberately: the
 * point of the assertion is that the CORS configuration and the edge AGREE, and
 * importing the edge's own constants would make the test pass by construction
 * whatever either side says.
 */
const EDGE_RESPONSE_HEADERS = [
  'X-Oxy-Request-Id',
  'X-Oxy-Inference-Contract-Version',
  'X-Oxy-Model',
  'X-Oxy-Provider',
  'X-Oxy-Routing-Policy',
  'X-Oxy-Routing-Policy-Version',
  'X-Oxy-Usage-Input-Tokens',
  'X-Oxy-Usage-Cached-Input-Tokens',
  'X-Oxy-Usage-Output-Tokens',
  'X-Oxy-Usage-Reasoning-Tokens',
  'X-Oxy-Error-Code',
  'X-Oxy-Error-Retryable',
  'X-Oxy-Finish-Reason',
] as const;

describe('EXPOSED_HEADERS', () => {
  it('exposes every X-Oxy-* header the inference edge sets', () => {
    const exposed = new Set<string>(EXPOSED_HEADERS);

    // POSITIVE CONTROL: a header that has always been in the list. If this fails
    // the import is broken and every assertion below would be measuring nothing.
    expect(exposed.has('ETag')).toBe(true);

    expect(EDGE_RESPONSE_HEADERS.filter((header) => !exposed.has(header))).toEqual([]);
  });

  it('has exactly the entries reviewed here, so neither a deletion nor an addition passes', () => {
    // VACUITY FLOOR. A membership test alone is satisfied by an EMPTY list, and
    // an empty `Access-Control-Expose-Headers` is precisely the silent breakage
    // this file exists to catch. Nine pre-existing entries + the edge's thirteen.
    expect(EXPOSED_HEADERS).toHaveLength(9 + EDGE_RESPONSE_HEADERS.length);
  });

  it('never exposes a header carrying credentials or CSRF state to a third-party origin', () => {
    // The non-credentialed lane still receives this list, so an authentication
    // header appearing here would be readable by any registered third-party app.
    const exposed = new Set<string>(EXPOSED_HEADERS);
    expect(exposed.has('Authorization')).toBe(false);
    expect(exposed.has('Set-Cookie')).toBe(false);
  });
});

describe('ALLOWED_HEADERS', () => {
  it('lets a browser send Idempotency-Key to the inference edge', () => {
    const allowed = new Set<string>(ALLOWED_HEADERS);

    // POSITIVE CONTROL: the header without which no authenticated call works at
    // all, so a broken import cannot make the claim below pass.
    expect(allowed.has('Authorization')).toBe(true);

    expect(allowed.has('Idempotency-Key')).toBe(true);
  });

  it('has exactly the entries reviewed here', () => {
    // VACUITY FLOOR, as above: seventeen pre-existing entries + `Idempotency-Key`.
    expect(ALLOWED_HEADERS).toHaveLength(18);
  });
});

describe('ALLOWED_METHODS', () => {
  it('admits the methods the API actually serves, and no others', () => {
    // `HEAD` is absent and must stay absent from the list: Express answers a
    // HEAD by routing it to the GET handler, and naming it here would advertise
    // a method the router does not register.
    expect([...ALLOWED_METHODS]).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']);
  });
});
