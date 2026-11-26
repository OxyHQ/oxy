import { act, renderHook } from '@testing-library/react';
import { activeStore } from '@oxy.so/bloom-data';
import { accountDataKey, SIGNED_OUT_DATA_ACCOUNT, useAccountData } from '../accountData';

const accountA = () => 'a';

describe('useAccountData', () => {
  it('opens the subject at mount, signed out as its own account', () => {
    const signedOut = () => null;
    const { result } = renderHook(() => useAccountData(signedOut));
    expect(activeStore()).toBe(result.current.store);
  });

  it('opens the next account on a subject change and closes the previous store', () => {
    const { result } = renderHook(() => useAccountData(accountA));
    const first = result.current.store;
    act(() => result.current.open('b'));
    expect(result.current.store).not.toBe(first);
    expect(first.closed).toBe(true);
    expect(activeStore()).toBe(result.current.store);
    const second = result.current.store;
    act(() => result.current.open('b'));
    expect(result.current.store).toBe(second);
    act(() => result.current.open(null));
    expect(second.closed).toBe(true);
  });

  it('closes the store on unmount', () => {
    const { result, unmount } = renderHook(() => useAccountData(accountA));
    const store = result.current.store;
    unmount();
    expect(store.closed).toBe(true);
  });

  it('deletes an account once when it is forgotten twice, and again after it reopens', async () => {
    const { result } = renderHook(() => useAccountData(accountA));
    const store = result.current.store;
    const first = result.current.forget('a');
    expect(result.current.forget('a')).toBe(first);
    await act(() => first);
    expect(store.closed).toBe(true);
    act(() => result.current.open('a'));
    expect(result.current.forget('a')).not.toBe(first);
  });

  it('keys a subject by its id, and signed out by the signed-out account', () => {
    expect(accountDataKey('user-1')).toBe('user-1');
    expect(accountDataKey(null)).toBe(SIGNED_OUT_DATA_ACCOUNT);
  });
});
