/**
 * Security activity, authentication and sign-in methods on
 * `@oxy.so/bloom-data`: paging, gating and the refresh after a write.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DataProvider, Store } from '@oxy.so/bloom-data';

const mockOxy = {
  oxyServices: {
    devices: { securityActivity: jest.fn() },
    identity: { authMethods: jest.fn() },
    auth: { methods: jest.fn() },
  },
  activeSessionId: 's1' as string | null,
};

jest.mock('../../context/oxyRuntimeContext', () => ({
  __esModule: true,
  useOxy: () => mockOxy,
}));

import { useAuthMethods, useSignInMethods } from '../../hooks/queries/useAuthMethods';
import {
  useInfiniteSecurityActivity,
  useRecentSecurityActivity,
  useSecurityActivity,
} from '../../hooks/queries/useSecurityQueries';

const event = (id: string) => ({
  id,
  userId: 'u1',
  eventType: 'sign_in',
  eventDescription: 'Signed in',
  timestamp: '2026-11-20T00:00:00.000Z',
  severity: 'low',
  createdAt: '2026-11-20T00:00:00.000Z',
});

const page = (ids: string[], offset: number, limit: number, hasMore: boolean) => ({
  data: ids.map(event),
  total: 5,
  limit,
  offset,
  hasMore,
});

let store: Store;
const wrapper = ({ children }: { children?: ReactNode }) => (
  <DataProvider store={store}>{children}</DataProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  store = new Store();
  mockOxy.activeSessionId = 's1';
});

afterEach(() => store.close());

describe('security activity', () => {
  it('pages through every event by offset until the API reports no more', async () => {
    const activity = mockOxy.oxyServices.devices.securityActivity;
    activity
      .mockResolvedValueOnce(page(['e1', 'e2'], 0, 2, true))
      .mockResolvedValueOnce(page(['e3', 'e4'], 2, 2, true))
      .mockResolvedValueOnce(page(['e5'], 4, 2, false));
    const { result } = renderHook(() => useInfiniteSecurityActivity({ limit: 2 }), { wrapper });
    await waitFor(() => expect(result.current.ids).toEqual(['e1', 'e2']));
    expect(result.current.hasMore).toBe(true);

    await act(() => result.current.more());
    await act(() => result.current.more());
    expect(result.current.ids).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(result.current.hasMore).toBe(false);
    expect(activity.mock.calls).toEqual([
      [2, 0, undefined],
      [2, 2, undefined],
      [2, 4, undefined],
    ]);
  });

  it('keeps what a single page says beside its events', async () => {
    mockOxy.oxyServices.devices.securityActivity.mockResolvedValueOnce(
      page(['e3', 'e4'], 2, 2, true),
    );
    const { result } = renderHook(
      () => useSecurityActivity({ limit: 2, offset: 2, eventType: 'sign_in' as never }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.ids).toEqual(['e3', 'e4']));
    expect(result.current.extra).toEqual({ total: 5, limit: 2, offset: 2, hasMore: true });
    expect(mockOxy.oxyServices.devices.securityActivity).toHaveBeenCalledWith(2, 2, 'sign_in');
  });

  it('reads nothing without an active session', () => {
    mockOxy.activeSessionId = null;
    const recent = renderHook(() => useRecentSecurityActivity(5), { wrapper });
    const all = renderHook(() => useInfiniteSecurityActivity(), { wrapper });
    expect(recent.result.current.ids).toEqual([]);
    expect(all.result.current.isLoading).toBe(false);
    expect(mockOxy.oxyServices.devices.securityActivity).not.toHaveBeenCalled();
  });
});

describe('sign-in and authentication methods', () => {
  it('reads the sign-in methods again when a panel refreshes them after a write', async () => {
    mockOxy.oxyServices.auth.methods
      .mockResolvedValueOnce({
        hasEmail: true,
        hasPassword: false,
        totpEnabled: false,
        backupCodesRemaining: 0,
      })
      .mockResolvedValueOnce({
        hasEmail: true,
        hasPassword: true,
        totpEnabled: false,
        backupCodesRemaining: 0,
      });
    const { result } = renderHook(() => useSignInMethods(), { wrapper });
    await waitFor(() => expect(result.current.value?.hasPassword).toBe(false));

    await act(() => result.current.refresh());
    expect(result.current.value?.hasPassword).toBe(true);
    expect(mockOxy.oxyServices.auth.methods).toHaveBeenCalledTimes(2);
  });

  it('gives the linked methods and the DID, empty while loading', async () => {
    mockOxy.oxyServices.identity.authMethods.mockResolvedValueOnce({
      did: 'did:oxy:u1',
      methods: [{ type: 'identity', linkedAt: '2026-01-01T00:00:00.000Z' }],
    });
    const { result } = renderHook(() => useAuthMethods(), { wrapper });
    expect(result.current.methods).toEqual([]);
    expect(result.current.did).toBeNull();
    await waitFor(() => expect(result.current.did).toBe('did:oxy:u1'));
    expect(result.current.methods).toHaveLength(1);
  });

  it('reads no methods while turned off', () => {
    renderHook(() => useSignInMethods({ enabled: false }), { wrapper });
    renderHook(() => useAuthMethods({ enabled: false }), { wrapper });
    expect(mockOxy.oxyServices.auth.methods).not.toHaveBeenCalled();
    expect(mockOxy.oxyServices.identity.authMethods).not.toHaveBeenCalled();
  });
});
