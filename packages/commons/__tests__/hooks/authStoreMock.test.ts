import { act, renderHook } from '@testing-library/react';
import { __resetOxyState, __setOxyState, useAuthStore } from '@/__mocks__/oxy-services';

describe('auth store test adapter', () => {
  beforeEach(() => __resetOxyState());

  it('notifies account selectors when the signed-in account changes or signs out', () => {
    const { result } = renderHook(() => useAuthStore((state) => state.user?.id));
    expect(result.current).toBeUndefined();
    act(() => __setOxyState({ user: { id: 'A' }, isAuthenticated: true }));
    expect(result.current).toBe('A');
    act(() => __setOxyState({ user: { id: 'B' } }));
    expect(result.current).toBe('B');
    act(() => __setOxyState({ user: null, isAuthenticated: false }));
    expect(result.current).toBeUndefined();
  });
});
