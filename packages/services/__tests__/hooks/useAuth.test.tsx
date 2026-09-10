/**
 * Tests for the high-level `useAuth` hook.
 *
 * The public web sign-in path opens the unified account dialog on its sign-in
 * view (`openAccountDialog('signin')`) — there is NO automatic navigation to any
 * login page. Cross-domain restore is handled during the device-first cold boot;
 * an explicit user click just presents the SDK sign-in surface. Native with a
 * public key still signs in with the cryptographic identity directly.
 */

import { act, renderHook } from '@testing-library/react';

interface MockOxyState {
  user: { id: string; username: string } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isTokenReady: boolean;
  hasAccessToken: boolean;
  canUsePrivateApi: boolean;
  isPrivateApiPending: boolean;
  isAuthResolved: boolean;
  error: string | null;
  signIn: jest.Mock;
  logout: jest.Mock;
  logoutAll: jest.Mock;
  refreshSessions: jest.Mock;
  oxyServices: Record<string, unknown>;
  hasIdentity: jest.Mock;
  getPublicKey: jest.Mock;
  showBottomSheet: jest.Mock;
  openAvatarPicker: jest.Mock;
  openAccountDialog: jest.Mock;
}

const defaultMockState = (): MockOxyState => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  isTokenReady: false,
  hasAccessToken: false,
  canUsePrivateApi: false,
  isPrivateApiPending: true,
  isAuthResolved: false,
  error: null,
  signIn: jest.fn(async (key: string) => ({ id: 'u1', username: 'native-user', publicKey: key })),
  logout: jest.fn(async () => undefined),
  logoutAll: jest.fn(async () => undefined),
  refreshSessions: jest.fn(async () => undefined),
  oxyServices: {},
  hasIdentity: jest.fn(async () => false),
  getPublicKey: jest.fn(async () => null),
  showBottomSheet: jest.fn(),
  openAvatarPicker: jest.fn(),
  openAccountDialog: jest.fn(),
});

let mockState: MockOxyState = defaultMockState();

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => mockState,
  useOxyAuthActions: () => mockState,
}));

jest.mock('../../src/ui/runtime', () => ({
  __esModule: true,
  useOxyRuntime: () => ({
    getSnapshot: () => ({
      account: mockState.user,
      isLoading: mockState.isLoading,
      tokenReady: mockState.isTokenReady,
      hasAccessToken: mockState.hasAccessToken,
      authResolved: mockState.isAuthResolved,
      error: mockState.error ? { message: mockState.error, code: 'test' } : null,
    }),
  }),
  useRuntimeSelector: (runtime: { getSnapshot: () => unknown }, selector: (snapshot: unknown) => unknown) =>
    selector(runtime.getSnapshot()),
}));

import { useAuth } from '../../src/ui/hooks/useAuth';

describe('useAuth — state passthrough', () => {
  beforeEach(() => {
    mockState = defaultMockState();
  });

  it('passes auth state through', () => {
    mockState.user = { id: 'u1', username: 'alice' };
    mockState.isAuthenticated = true;
    mockState.isLoading = false;
    mockState.isTokenReady = true;
    mockState.hasAccessToken = true;
    mockState.canUsePrivateApi = true;
    mockState.isPrivateApiPending = false;
    mockState.isAuthResolved = true;

    const { result } = renderHook(() => useAuth());

    expect(result.current.user).toEqual({ id: 'u1', username: 'alice' });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isReady).toBe(true);
    expect(result.current.hasAccessToken).toBe(true);
    expect(result.current.canUsePrivateApi).toBe(true);
    expect(result.current.isPrivateApiPending).toBe(false);
    expect(result.current.isAuthResolved).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe('useAuth.signIn — web dialog path', () => {
  beforeEach(() => {
    mockState = defaultMockState();
  });

  it('opens the unified account dialog on its sign-in view instead of navigating', async () => {
    const { result } = renderHook(() => useAuth());

    let outcome: Awaited<ReturnType<typeof result.current.signIn>> | undefined;
    await act(async () => {
      outcome = await result.current.signIn();
    });

    expect(outcome).toEqual({ status: 'dialog-opened' });
    expect(mockState.openAccountDialog).toHaveBeenCalledWith('signin');
    // No key-based sign-in, no redirect helper.
    expect(mockState.signIn).not.toHaveBeenCalled();
  });
});

describe('useAuth.signIn — native key-based path', () => {
  beforeEach(() => {
    mockState = defaultMockState();
  });

  it('calls signIn with the provided publicKey when one is passed', async () => {
    const { result } = renderHook(() => useAuth());

    let outcome: Awaited<ReturnType<typeof result.current.signIn>> | undefined;
    await act(async () => {
      outcome = await result.current.signIn('explicit-pubkey');
    });

    expect(outcome).toEqual({
      status: 'authenticated',
      user: { id: 'u1', username: 'native-user', publicKey: 'explicit-pubkey' },
    });
    expect(mockState.signIn).toHaveBeenCalledWith('explicit-pubkey');
    expect(mockState.openAccountDialog).not.toHaveBeenCalled();
  });
});

describe('useAuth.signOut / signOutAll / refresh', () => {
  beforeEach(() => {
    mockState = defaultMockState();
  });

  it('delegates signOut to context.logout', async () => {
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.signOut();
    });
    expect(mockState.logout).toHaveBeenCalledTimes(1);
  });

  it('delegates signOutAll to context.logoutAll', async () => {
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.signOutAll();
    });
    expect(mockState.logoutAll).toHaveBeenCalledTimes(1);
  });

  it('delegates refresh to context.refreshSessions', async () => {
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.refresh();
    });
    expect(mockState.refreshSessions).toHaveBeenCalledTimes(1);
  });
});
