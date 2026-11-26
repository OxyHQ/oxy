/**
 * Tests for `useOnlineStatus`.
 *
 * The boolean from this hook is consumed by app shells to render
 * "You're offline" banners. Bugs are subtle: a stuck `true` would
 * hide the banner forever during a real outage; a stuck `false`
 * would scare users into thinking they're offline when they aren't.
 */

import { act, renderHook } from '@testing-library/react';
import { environment } from '@oxy.so/bloom-data';
import { useOnlineStatus } from '../../src/ui/hooks/useOnlineStatus';

describe('useOnlineStatus', () => {
  afterEach(() => {
    environment.setOnline(true);
  });

  it('reflects the environment on initial render', () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it('starts false when the environment reports offline', () => {
    environment.setOnline(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });

  it('rerenders when the device comes back online', () => {
    environment.setOnline(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);

    act(() => {
      environment.setOnline(true);
    });
    expect(result.current).toBe(true);
  });
});
