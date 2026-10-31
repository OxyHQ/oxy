import { act, renderHook } from '@testing-library/react';
import { OxyServices } from '@oxy.so/core';
import {
  hasKnownSubjectMismatch,
  useKnownBearerSubject,
} from '../../src/ui/hooks/useKnownBearerSubject';

const token = (userId: string, version: number) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, version, exp: 2000000000 })).toString('base64url')}.fixture`;

it('observes the real SDK bearer subject through switches, refresh and opaque tokens', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const { result, unmount } = renderHook(() => useKnownBearerSubject(oxy));
  try {
    expect(result.current).toBeNull();
    act(() => oxy.session.setAccessToken(token('alice', 1)));
    expect(result.current).toBe('alice');
    act(() => oxy.session.setAccessToken(token('alice', 2)));
    expect(result.current).toBe('alice');
    act(() => oxy.session.setAccessToken(token('bob', 1)));
    expect(result.current).toBe('bob');
    expect(hasKnownSubjectMismatch('alice', result.current)).toBe(true);
    const subOnly = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', exp: 2000000000 })).toString('base64url')}.fixture`;
    act(() => oxy.session.setAccessToken(subOnly));
    expect(result.current).toBeNull();
    expect(hasKnownSubjectMismatch('alice', result.current)).toBe(false);
    act(() => oxy.session.setAccessToken('opaque-token'));
    expect(result.current).toBeNull();
    expect(hasKnownSubjectMismatch('alice', result.current)).toBe(false);
  } finally {
    unmount();
    oxy.dispose();
  }
});
