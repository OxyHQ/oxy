/**
 * `users.lookupMany` keeps "the server says nobody" apart from "the request
 * failed".
 *
 * `getMany` folds a failed `/users/by-ids` chunk into an empty answer. Allo's
 * people layer caches every id missing from that answer as unresolvable for
 * five minutes, so one `fetch failed: Fetch request has been canceled` on a
 * phone left a conversation with no name and a placeholder avatar for minutes.
 * These tests pin the three outcomes per id, for each shape the answer can
 * take: all found, some absent, a failed chunk, every chunk failed.
 */

import { OxyServices } from '../../OxyServices';
import type { User } from '../../models/interfaces';
import type { OxyContext, ServiceLane } from '../../client/context';

const rawUser = (id: string): User =>
  ({ id, username: `user_${id}`, name: { displayName: `Display ${id}` } }) as unknown as User;

const ids = (count: number, offset = 0): string[] =>
  Array.from({ length: count }, (_, i) => `id-${i + offset}`);

describe('users.lookupMany', () => {
  let oxy: OxyServices;
  let requestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    requestSpy = jest.spyOn(oxy, 'request');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('makes no call for no ids, and reports nothing', async () => {
    await expect(oxy.users.lookupMany(['', '   '])).resolves.toEqual({
      found: [],
      missing: [],
      failed: [],
    });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('all found: every id answered, nothing missing or failed, no error', async () => {
    requestSpy.mockResolvedValueOnce([rawUser('a'), rawUser('b')]);

    const result = await oxy.users.lookupMany(['a', 'b', 'a']);

    expect(requestSpy).toHaveBeenCalledWith(
      'POST',
      '/users/by-ids',
      { ids: ['a', 'b'] },
      { cache: false },
    );
    expect(result.found.map((u) => u.id)).toEqual(['a', 'b']);
    expect(result.found[0].name.displayName).toBe('Display a');
    expect(result.missing).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result).not.toHaveProperty('error');
  });

  it('partial absence: an id the server answered without is missing, not failed', async () => {
    requestSpy.mockResolvedValueOnce([rawUser('a')]);

    const result = await oxy.users.lookupMany(['a', 'gone', 'hidden']);

    expect(result.found.map((u) => u.id)).toEqual(['a']);
    expect(result.missing).toEqual(['gone', 'hidden']);
    expect(result.failed).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('a failed chunk: its ids are failed, the other chunk still answers, the error is kept', async () => {
    const boom = Object.assign(new Error('fetch failed: Fetch request has been canceled'), {
      status: 0,
    });
    // 150 ids: chunk 1 (id-0..id-99) answers with all but id-5; chunk 2 fails.
    requestSpy
      .mockResolvedValueOnce(
        ids(100)
          .filter((id) => id !== 'id-5')
          .map(rawUser),
      )
      .mockRejectedValueOnce(boom);

    const result = await oxy.users.lookupMany(ids(150));

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(result.found).toHaveLength(99);
    expect(result.missing).toEqual(['id-5']);
    expect(result.failed).toEqual(ids(50, 100));
    expect(result.error).toBe(boom);
  });

  it('all failed: every id failed, none missing, the FIRST error kept, and it resolves', async () => {
    const first = new Error('first');
    const second = new Error('second');
    requestSpy.mockRejectedValueOnce(first).mockRejectedValueOnce(second);

    const result = await oxy.users.lookupMany(ids(150));

    expect(result.found).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.failed).toEqual(ids(150));
    expect(result.error).toBe(first);
  });

  it('an answer that is not an array is a failure, not an empty answer', async () => {
    requestSpy.mockResolvedValueOnce({ unexpected: true });

    const result = await oxy.users.lookupMany(['a']);

    expect(result.missing).toEqual([]);
    expect(result.failed).toEqual(['a']);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('reports the same outcomes over the service lane', async () => {
    const serviceRequest = jest
      .fn()
      .mockResolvedValueOnce([rawUser('id-0')])
      .mockRejectedValueOnce(new Error('503'));
    const lane: ServiceLane = {
      available: true,
      request: serviceRequest as ServiceLane['request'],
    };
    (oxy as unknown as { context: OxyContext }).context.service = lane;

    const result = await oxy.users.lookupMany(ids(101));

    expect(requestSpy).not.toHaveBeenCalled();
    expect(serviceRequest).toHaveBeenCalledWith('POST', '/users/by-ids', { ids: ids(100) });
    expect(result.found.map((u) => u.id)).toEqual(['id-0']);
    expect(result.missing).toEqual(ids(99, 1));
    expect(result.failed).toEqual(['id-100']);
  });

  it('getMany stays the found users only, never rejecting for a failed chunk', async () => {
    requestSpy.mockResolvedValueOnce([rawUser('id-0')]).mockRejectedValueOnce(new Error('boom'));

    await expect(oxy.users.getMany(ids(150))).resolves.toEqual([
      expect.objectContaining({ id: 'id-0' }),
    ]);
  });
});
