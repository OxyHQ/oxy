/**
 * `follows.statuses` — batched follow-status resolution tests.
 *
 * The SDK method collapses N per-button `follows.status` calls into one bulk
 * `POST /users/follow-status/bulk` per chunk. It must:
 *  - dedup + drop blank ids, and resolve to `{}` with NO network call on empty
 *    input;
 *  - POST `{ userIds }` uncached (`{ cache: false }`) so the UI store owns
 *    follow-status freshness;
 *  - chunk at the server cap (200) and MERGE the per-chunk `{ statuses }` maps
 *    into one record covering every requested id.
 *
 * `makeRequest` is stubbed so the tests run with no network.
 */

import { OxyServices } from '../../OxyServices';

describe('OxyServices.follows.statuses — batched follow status', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'request');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns {} and performs no network call for empty / whitespace input', async () => {
    await expect(oxy.follows.statuses([])).resolves.toEqual({});
    await expect(oxy.follows.statuses(['', '   '])).resolves.toEqual({});
    expect(makeRequestSpy).not.toHaveBeenCalled();
  });

  it('POSTs { userIds } uncached and returns the statuses map', async () => {
    makeRequestSpy.mockResolvedValueOnce({ statuses: { a: true, b: false } });

    const result = await oxy.follows.statuses(['a', 'b']);

    expect(makeRequestSpy).toHaveBeenCalledTimes(1);
    expect(makeRequestSpy).toHaveBeenCalledWith(
      'POST',
      '/users/follow-status/bulk',
      { userIds: ['a', 'b'] },
      { cache: false },
    );
    expect(result).toEqual({ a: true, b: false });
  });

  it('de-duplicates ids and drops blanks before the request', async () => {
    makeRequestSpy.mockResolvedValueOnce({ statuses: { a: true } });

    await oxy.follows.statuses(['a', 'a', '   ', 'a']);

    expect(makeRequestSpy).toHaveBeenCalledTimes(1);
    expect(makeRequestSpy).toHaveBeenCalledWith(
      'POST',
      '/users/follow-status/bulk',
      { userIds: ['a'] },
      { cache: false },
    );
  });

  it('chunks at 200 ids per request and merges the per-chunk maps', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    makeRequestSpy.mockImplementation(
      async (
        _method: string,
        _url: string,
        data?: { userIds: string[] },
      ): Promise<{ statuses: Record<string, boolean> }> => {
        const statuses: Record<string, boolean> = {};
        for (const id of data?.userIds ?? []) {
          statuses[id] = id.endsWith('0'); // deterministic mix of true/false
        }
        return { statuses };
      },
    );

    const result = await oxy.follows.statuses(ids);

    // 450 unique ids => 200 + 200 + 50 across three POSTs.
    expect(makeRequestSpy).toHaveBeenCalledTimes(3);
    const chunkSizes = makeRequestSpy.mock.calls.map(
      (call) => (call[2] as { userIds: string[] }).userIds.length,
    );
    expect(chunkSizes).toEqual([200, 200, 50]);
    // Every requested id is present in the merged result.
    expect(Object.keys(result)).toHaveLength(450);
    expect(result['id-10']).toBe(true);
    expect(result['id-11']).toBe(false);
  });
});
