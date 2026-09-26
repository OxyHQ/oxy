/**
 * `users.getMany` dual-mode auth tests.
 *
 * `POST /users/by-ids` is `optionalUserOrServiceAuth` on oxy-api and returns
 * the identical public `{ data: PublicUserProfile[] }` shape for both a service
 * token and a user session. The SDK method must therefore:
 *  - use the bearer-SERVICE path (`makeServiceRequest`) when the instance was
 *    configured via `configureServiceAuth()` (the backend / hydration case), and
 *  - use the USER path (`makeRequest('POST', ..., { cache: false })`) otherwise
 *    (a browser / RN client with only a user session). Before the dual-mode fix
 *    the method always took the service path, so every client-side caller got
 *    `[]` because `getServiceToken()` had no credentials.
 *
 * Both paths must dedup + chunk, map every result through `normalizeUserIdentity`
 * (so `name.displayName` is present), and tolerate a per-chunk failure without
 * sinking the rest. `makeRequest` / `makeServiceRequest` are stubbed so the
 * tests run with no network.
 */

import { OxyServices } from '../../OxyServices';
import type { User } from '../../models/interfaces';
import type { OxyContext, ServiceLane } from '../../client/context';

const makeRawUser = (id: string): User =>
  // The wire payload is a PublicUserProfile with server-owned name.displayName.
  // Cast through the User shape the API returns post-unwrap.
  ({
    id,
    username: `user_${id}`,
    name: { displayName: `Display ${id}` },
    _count: { followers: 1, following: 2 },
  }) as unknown as User;

describe('users.getMany — dual-mode auth', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;
  let makeServiceRequestSpy: jest.Mock;

  /** Install a fake service lane, as `OxyServer` does. */
  const installLane = (available: boolean): void => {
    const lane: ServiceLane = { available, request: makeServiceRequestSpy as ServiceLane['request'] };
    (oxy as unknown as { context: OxyContext }).context.service = lane;
  };

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'request');
    makeServiceRequestSpy = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns [] and performs no network call for empty / whitespace input', async () => {
    await expect(oxy.users.getMany([])).resolves.toEqual([]);
    await expect(oxy.users.getMany(['', '   '])).resolves.toEqual([]);
    expect(makeRequestSpy).not.toHaveBeenCalled();
    expect(makeServiceRequestSpy).not.toHaveBeenCalled();
  });

  describe('without service credentials (client / user-session path)', () => {
    it('uses the user bearer and cache:false', async () => {
      makeRequestSpy.mockResolvedValueOnce([makeRawUser('a'), makeRawUser('b')]);

      const result = await oxy.users.getMany(['a', 'b']);

      expect(makeServiceRequestSpy).not.toHaveBeenCalled();
      expect(makeRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/users/by-ids',
        { ids: ['a', 'b'] },
        { cache: false },
      );
      // normalizeUserIdentity ran on every entry (display name preserved).
      expect(result).toHaveLength(2);
      expect(result[0].name.displayName).toBe('Display a');
      expect(result[1].id).toBe('b');
    });

    it('de-duplicates ids and drops blanks before the request', async () => {
      makeRequestSpy.mockResolvedValueOnce([makeRawUser('a')]);

      await oxy.users.getMany(['a', 'a', '   ', 'a']);

      expect(makeRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/users/by-ids',
        { ids: ['a'] },
        { cache: false },
      );
    });
  });

  describe('with a service lane (backend / hydration path)', () => {
    beforeEach(() => {
      installLane(true);
    });

    it('uses the service lane and never the user path', async () => {
      makeServiceRequestSpy.mockResolvedValueOnce([makeRawUser('a'), makeRawUser('b')]);

      const result = await oxy.users.getMany(['a', 'b']);

      expect(makeRequestSpy).not.toHaveBeenCalled();
      expect(makeServiceRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeServiceRequestSpy).toHaveBeenCalledWith('POST', '/users/by-ids', {
        ids: ['a', 'b'],
      });
      expect(result).toHaveLength(2);
      expect(result[0].name.displayName).toBe('Display a');
    });
  });

  describe('lane availability', () => {
    it('uses the service lane whenever it is available (a key pair or an attested workload)', async () => {
      installLane(true);
      makeServiceRequestSpy.mockResolvedValueOnce([makeRawUser('a')]);

      const result = await oxy.users.getMany(['a']);

      expect(makeRequestSpy).not.toHaveBeenCalled();
      expect(makeServiceRequestSpy).toHaveBeenCalledWith('POST', '/users/by-ids', { ids: ['a'] });
      expect(result).toHaveLength(1);
    });

    it('stays on the user path when the lane cannot mint a token', async () => {
      installLane(false);
      makeRequestSpy.mockResolvedValueOnce([makeRawUser('a')]);

      await oxy.users.getMany(['a']);

      expect(makeServiceRequestSpy).not.toHaveBeenCalled();
      expect(makeRequestSpy).toHaveBeenCalledWith('POST', '/users/by-ids', { ids: ['a'] }, { cache: false });
    });
  });

  describe('chunking + resilience (applies to both modes)', () => {
    it('chunks at 100 ids per request on the user path and flattens results', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
      makeRequestSpy.mockImplementation(
        async (
          _method: string,
          _url: string,
          data?: { ids: string[] },
        ): Promise<User[]> => (data?.ids ?? []).map((id) => makeRawUser(id)),
      );

      const result = await oxy.users.getMany(ids);

      // 250 unique ids => 100 + 100 + 50 across three POSTs.
      expect(makeRequestSpy).toHaveBeenCalledTimes(3);
      const chunkSizes = makeRequestSpy.mock.calls.map(
        (call) => (call[2] as { ids: string[] }).ids.length,
      );
      expect(chunkSizes).toEqual([100, 100, 50]);
      expect(result).toHaveLength(250);
    });

    it('skips a failed chunk and returns the users that resolved (user path)', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
      makeRequestSpy
        .mockResolvedValueOnce([makeRawUser('id-0')])
        .mockRejectedValueOnce(new Error('chunk boom'));

      const result = await oxy.users.getMany(ids);

      expect(makeRequestSpy).toHaveBeenCalledTimes(2);
      // The failed second chunk contributes nothing; the first survives.
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('id-0');
    });
  });
});
