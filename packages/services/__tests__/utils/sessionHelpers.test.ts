/**
 * Tests for session helpers.
 *
 * These helpers normalize the various session payload shapes returned by
 * the API into the canonical `ClientSession` shape consumed by the auth
 * context. Bugs here surface as missing deviceIds (sessions get dropped
 * from the UI) or as wrong userIds (sessions attributed to the wrong
 * account in the switcher).
 */

import {
  fetchSessionsWithFallback,
  mapSessionsToClient,
} from '../../src/ui/utils/sessionHelpers';

describe('mapSessionsToClient', () => {
  it('passes through every primary field unchanged', () => {
    const sessions = [{
      sessionId: 's1',
      deviceId: 'd1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      lastActive: '2025-01-01T00:00:00.000Z',
      userId: 'u1',
      isCurrent: true,
    }];
    const result = mapSessionsToClient(sessions);
    expect(result).toEqual([{
      sessionId: 's1',
      deviceId: 'd1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      lastActive: '2025-01-01T00:00:00.000Z',
      userId: 'u1',
      isCurrent: true,
    }]);
  });

  it('uses fallbackDeviceId when deviceId is missing', () => {
    const [mapped] = mapSessionsToClient(
      [{ sessionId: 's1' }],
      'fallback-device',
      'fallback-user',
    );
    expect(mapped.deviceId).toBe('fallback-device');
    expect(mapped.userId).toBe('fallback-user');
  });

  it('extracts userId from session.user.id', () => {
    const [mapped] = mapSessionsToClient([{
      sessionId: 's1',
      user: { id: 'user-from-nested' },
    }]);
    expect(mapped.userId).toBe('user-from-nested');
  });

  it('extracts userId from session.user._id when id is missing', () => {
    const [mapped] = mapSessionsToClient([{
      sessionId: 's1',
      user: { _id: { toString: () => 'user-from-objectid' } },
    }]);
    expect(mapped.userId).toBe('user-from-objectid');
  });

  it('coerces isCurrent to boolean', () => {
    const result = mapSessionsToClient([
      { sessionId: 's1', isCurrent: true },
      { sessionId: 's2', isCurrent: undefined },
    ]);
    expect(result[0].isCurrent).toBe(true);
    expect(result[1].isCurrent).toBe(false);
  });

  it('generates a 7-day expiration when expiresAt is missing', () => {
    const before = Date.now() + 7 * 24 * 60 * 60 * 1000 - 1000;
    const [mapped] = mapSessionsToClient([{ sessionId: 's1' }]);
    const after = Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000;
    const expires = Date.parse(mapped.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before);
    expect(expires).toBeLessThanOrEqual(after);
  });
});

describe('fetchSessionsWithFallback', () => {
  it('returns mapped device sessions on the happy path', async () => {
    const oxy = {
      devices: { sessions: jest.fn().mockResolvedValue([{ sessionId: 's1', userId: 'u1' }]) },
      session: { list: jest.fn() },
    };
    const result = await fetchSessionsWithFallback(oxy, 's1');
    expect(oxy.devices.sessions).toHaveBeenCalledWith('s1');
    expect(oxy.session.list).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('s1');
  });

  it('falls back to getSessionsBySessionId when device endpoint throws', async () => {
    const oxy = {
      devices: { sessions: jest.fn().mockRejectedValue(new Error('404')) },
      session: { list: jest.fn().mockResolvedValue([
        { sessionId: 's1', userId: 'u1' },
        { sessionId: 's2', userId: 'u1' },
      ]) },
    };
    const result = await fetchSessionsWithFallback(oxy, 's1', { fallbackUserId: 'u1' });
    expect(oxy.session.list).toHaveBeenCalledWith('s1');
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('propagates rejection from the fallback endpoint', async () => {
    const oxy = {
      devices: { sessions: jest.fn().mockRejectedValue(new Error('device down')) },
      session: { list: jest.fn().mockRejectedValue(new Error('user down')) },
    };
    await expect(fetchSessionsWithFallback(oxy, 's1')).rejects.toThrow('user down');
  });
});
