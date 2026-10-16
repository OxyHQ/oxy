/**
 * `useAppAssertion()` (ADR 0045): the provider obtains the assertion for the
 * signed-in session with no app code, and a consumer (Alia's SDK) reads it or
 * asks for request headers.
 */
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  AppAssertionProvider,
  AppAssertionProviderMissingError,
  useAppAssertion,
} from '../../src/ui/appAssertion/AppAssertionContext';
import { createMemoryStorage, fakeOxy, platform } from './fakes';

function wrapper(
  oxy: ReturnType<typeof fakeOxy>,
  session: { userId: string | null; sessionId: string | null },
) {
  return ({ children }: { children: ReactNode }) => (
    <AppAssertionProvider
      oxyServices={oxy as never}
      clientId="oxy_dk_mention"
      userId={session.userId}
      sessionId={session.sessionId}
      storage={createMemoryStorage()}
      storageKeyPrefix="oxy"
      integrity={platform('web')}
    >
      {children}
    </AppAssertionProvider>
  );
}

describe('useAppAssertion', () => {
  it('becomes ready for the signed-in session, and hands out request headers', async () => {
    const oxy = fakeOxy();
    const { result } = renderHook(() => useAppAssertion(), {
      wrapper: wrapper(oxy, { userId: 'person-1', sessionId: 'session-1' }),
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({
      assertion: 'head.assertion-1.sig',
      applicationId: 'mention-app',
      platform: 'web',
    });
    await expect(result.current.getAppAssertionHeaders()).resolves.toEqual({
      'X-Oxy-App-Assertion': 'head.assertion-1.sig',
    });
  });

  it('asks for nothing while signed out', async () => {
    const oxy = fakeOxy();
    const { result } = renderHook(() => useAppAssertion(), {
      wrapper: wrapper(oxy, { userId: null, sessionId: null }),
    });
    expect(result.current.status).toBe('idle');
    await expect(result.current.getAppAssertion()).resolves.toBeNull();
    expect(oxy.assertions.create).not.toHaveBeenCalled();
  });

  it('drops the assertion when the session changes and obtains one for the new session', async () => {
    const oxy = fakeOxy();
    let seen: ReturnType<typeof useAppAssertion> | null = null;
    const Probe = () => {
      seen = useAppAssertion();
      return null;
    };
    const tree = (sessionId: string) => {
      const Wrapper = wrapper(oxy, { userId: 'person-1', sessionId });
      return (
        <Wrapper>
          <Probe />
        </Wrapper>
      );
    };
    const view = render(tree('session-1'));
    await waitFor(() => expect(seen?.assertion).toBe('head.assertion-1.sig'));
    act(() => {
      view.rerender(tree('session-2'));
    });
    await waitFor(() => expect(seen?.assertion).toBe('head.assertion-2.sig'));
    expect(oxy.assertions.create).toHaveBeenCalledTimes(2);
  });

  it('throws outside the provider', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useAppAssertion())).toThrow(AppAssertionProviderMissingError);
  });
});
