/**
 * The account's sessions and devices on `@oxy.so/bloom-data`: each React
 * Query edge case the session and device hooks relied on, carried over.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { DeviceSession, Session } from '../sessions';
import { User } from '../user';

const mockOxy = {
  oxyServices: {
    session: {
      isAuthenticated: true,
      logout: jest.fn(async (_active: string, _target: string) => undefined),
      validate: jest.fn(),
    },
    devices: {
      sessions: jest.fn(),
      list: jest.fn(),
      rename: jest.fn(async (_active: string, deviceName: string) => ({
        success: true,
        message: 'ok',
        deviceName,
      })),
      remove: jest.fn(async (_deviceId: string) => undefined),
      securityInfo: jest.fn(),
    },
  },
  activeSessionId: 's1' as string | null,
  isAuthenticated: true,
};

jest.mock('../../context/oxyRuntimeContext', () => ({
  __esModule: true,
  useOxy: () => mockOxy,
}));

const mockShowApiError = jest.fn();
jest.mock('../../hooks/useApiErrorToast', () => ({
  __esModule: true,
  useApiErrorToast: () => mockShowApiError,
}));

import { toast } from '@oxy.so/bloom/toast';
import {
  useDeviceSessions,
  useSession,
  useSessions,
  useUserDevices,
} from '../../hooks/queries/useServicesQueries';
import { useLogoutSession, useUpdateDeviceName } from '../../hooks/mutations/useServicesMutations';

const row = (sessionId: string, isCurrent = false) => ({
  sessionId,
  deviceId: 'd1',
  isActive: true,
  lastActive: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  isCurrent,
  user: { id: `u-${sessionId}`, username: `user-${sessionId}`, name: { displayName: 'Ada' } },
});

const device = (id: string) => ({
  id,
  deviceId: id,
  name: id,
  deviceName: id,
  type: 'mobile',
  deviceType: 'mobile',
  lastActive: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  isCurrent: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let store: Store;
const wrapper = ({ children }: { children?: ReactNode }) => (
  <DataProvider store={store}>{children}</DataProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  store = new Store();
  mockOxy.activeSessionId = 's1';
  mockOxy.isAuthenticated = true;
  mockOxy.oxyServices.devices.sessions.mockResolvedValue([row('s1', true), row('s2')]);
  mockOxy.oxyServices.devices.list.mockResolvedValue([device('d1')]);
});

afterEach(async () => {
  jest.useRealTimers();
  await store.close();
});

describe('gated reads', () => {
  it('reads nothing until there is an active session, then reads it', async () => {
    mockOxy.activeSessionId = null;
    const { result, rerender } = renderHook(() => useDeviceSessions(), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.ids).toEqual([]);
    expect(mockOxy.oxyServices.devices.sessions).not.toHaveBeenCalled();

    mockOxy.activeSessionId = 's1';
    rerender();
    await waitFor(() => expect(result.current.ids).toEqual(['s1', 's2']));
    expect(mockOxy.oxyServices.devices.sessions).toHaveBeenCalledWith('s1');
    expect(result.current.extra?.current).toEqual(['s1']);
  });

  it('reads nothing while a caller turns it off', () => {
    renderHook(() => useUserDevices({ enabled: false }), { wrapper });
    renderHook(() => useSessions(undefined, { enabled: false }), { wrapper });
    expect(mockOxy.oxyServices.devices.list).not.toHaveBeenCalled();
    expect(mockOxy.oxyServices.devices.sessions).not.toHaveBeenCalled();
  });
});

describe('staleness', () => {
  it('does not read fresh devices again on mount, and reads them again once stale', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-21T10:00:00.000Z') });
    const first = renderHook(() => useUserDevices(), { wrapper });
    await waitFor(() => expect(first.result.current.ids).toEqual(['d1']));
    first.unmount();

    jest.setSystemTime(new Date('2026-11-21T10:04:59.000Z'));
    const second = renderHook(() => useUserDevices(), { wrapper });
    expect(second.result.current.ids).toEqual(['d1']);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockOxy.oxyServices.devices.list).toHaveBeenCalledTimes(1);
    second.unmount();

    jest.setSystemTime(new Date('2026-11-21T10:05:01.000Z'));
    renderHook(() => useUserDevices(), { wrapper });
    await waitFor(() => expect(mockOxy.oxyServices.devices.list).toHaveBeenCalledTimes(2));
  });
});

describe('the retry rule', () => {
  it('retries a failure another attempt can change, after the backoff', async () => {
    jest.useFakeTimers();
    mockOxy.oxyServices.devices.sessions
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce([row('s1', true)]);
    const { result } = renderHook(() => useDeviceSessions(), { wrapper });
    await waitFor(() => expect(result.current.failureCount).toBe(1));
    expect(result.current.status).toBe('loading');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.ids).toEqual(['s1']));
    expect(mockOxy.oxyServices.devices.sessions).toHaveBeenCalledTimes(2);
  });

  it('fails at once on a refusal another attempt cannot change', async () => {
    jest.useFakeTimers();
    mockOxy.oxyServices.devices.sessions.mockRejectedValue({ status: 401 });
    const { result } = renderHook(() => useDeviceSessions(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(mockOxy.oxyServices.devices.sessions).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(false);
  });
});

describe('an account switch', () => {
  it("drops the late answer of the account that was left, and reads the next one's own", async () => {
    const late = deferred<ReturnType<typeof row>[]>();
    mockOxy.oxyServices.devices.sessions.mockReturnValueOnce(late.promise);
    const left = store;
    const { result, rerender } = renderHook(() => useDeviceSessions(), { wrapper });
    await waitFor(() => expect(mockOxy.oxyServices.devices.sessions).toHaveBeenCalledWith('s1'));

    // The runtime opens the next account's store and closes the previous one.
    store = new Store();
    await left.close();
    mockOxy.activeSessionId = 's9';
    mockOxy.oxyServices.devices.sessions.mockResolvedValueOnce([row('s9', true)]);
    rerender();
    await waitFor(() => expect(result.current.ids).toEqual(['s9']));

    await act(async () => {
      late.resolve([row('s1', true), row('s2')]);
      await late.promise;
    });
    expect(result.current.ids).toEqual(['s9']);
    expect(withStore(store, () => DeviceSession.get('s1'))).toBeUndefined();
    expect(withStore(left, () => DeviceSession.get('s1'))).toBeUndefined();
  });
});

describe('writes', () => {
  it('reads the devices and sessions the account holds again after a rename', async () => {
    const devices = renderHook(() => useUserDevices(), { wrapper });
    const here = renderHook(() => useDeviceSessions(), { wrapper });
    await waitFor(() => expect(devices.result.current.ids).toEqual(['d1']));
    await waitFor(() => expect(here.result.current.ids).toEqual(['s1', 's2']));
    mockOxy.oxyServices.devices.list.mockResolvedValueOnce([device('d1'), device('d2')]);

    const rename = renderHook(() => useUpdateDeviceName(), { wrapper });
    await act(async () => {
      await rename.result.current.run('Kitchen');
    });

    expect(mockOxy.oxyServices.devices.rename).toHaveBeenCalledWith('s1', 'Kitchen');
    expect(toast.success).toHaveBeenCalledWith('Device name updated');
    await waitFor(() => expect(devices.result.current.ids).toEqual(['d1', 'd2']));
    expect(mockOxy.oxyServices.devices.sessions).toHaveBeenCalledTimes(2);
    // Nothing read the security information, so nothing reads it now.
    expect(mockOxy.oxyServices.devices.securityInfo).not.toHaveBeenCalled();
  });

  it('keeps the sessions as they were when a logout fails, and says why', async () => {
    const list = renderHook(() => useSessions(), { wrapper });
    await waitFor(() => expect(list.result.current.ids).toEqual(['s1', 's2']));
    const refused = { status: 403 };
    mockOxy.oxyServices.session.logout.mockRejectedValueOnce(refused);

    const logout = renderHook(() => useLogoutSession(), { wrapper });
    await act(async () => {
      await expect(logout.result.current.run('s2')).rejects.toBe(refused);
    });

    expect(list.result.current.ids).toEqual(['s1', 's2']);
    expect(withStore(store, () => Session.get('s2'))).toBeDefined();
    expect(mockShowApiError).toHaveBeenCalledWith(refused, 'actionErrors.logout');
    expect(logout.result.current.error).toBe(refused);
  });

  it('drops an ended session from every list, then reads the lists again', async () => {
    const list = renderHook(() => useSessions(), { wrapper });
    const here = renderHook(() => useDeviceSessions(), { wrapper });
    await waitFor(() => expect(list.result.current.ids).toEqual(['s1', 's2']));
    await waitFor(() => expect(here.result.current.ids).toEqual(['s1', 's2']));
    const reread = deferred<ReturnType<typeof row>[]>();
    mockOxy.oxyServices.devices.sessions.mockReturnValue(reread.promise);

    const logout = renderHook(() => useLogoutSession(), { wrapper });
    await act(async () => {
      await expect(logout.result.current.run('s2')).resolves.toBe('s2');
    });

    expect(mockOxy.oxyServices.session.logout).toHaveBeenCalledWith('s1', 's2');
    expect(list.result.current.ids).toEqual(['s1']);
    expect(here.result.current.ids).toEqual(['s1']);
    expect(here.result.current.extra?.current).toEqual(['s1']);
    await act(async () => {
      reread.resolve([row('s1', true)]);
      await reread.promise;
    });
    expect(mockOxy.oxyServices.devices.sessions).toHaveBeenCalledTimes(4);
  });
});

describe('the people on this device', () => {
  it("shows a profile edit on the session's row at once", async () => {
    const { result } = renderHook(() => useDeviceSessions(), { wrapper });
    await waitFor(() => expect(result.current.ids).toEqual(['s1', 's2']));
    expect(withStore(store, () => DeviceSession.get('s2'))?.user?.username).toBe('user-s2');

    act(() => withStore(store, () => User.merge('u-s2', { username: 'renamed' })));
    expect(withStore(store, () => DeviceSession.get('s2'))?.user?.username).toBe('renamed');
  });
});

describe('one session', () => {
  it('describes a valid session and keeps its person in User', async () => {
    mockOxy.oxyServices.session.validate.mockResolvedValue({
      valid: true,
      expiresAt: '2026-12-01T00:00:00.000Z',
      lastActivity: '2026-11-20T00:00:00.000Z',
      user: { id: 'u7', username: 'grace', name: { displayName: 'Grace' } },
    });
    const { result } = renderHook(() => useSession('s7'), { wrapper });
    await waitFor(() => expect(result.current.value?.userId).toBe('u7'));
    expect(mockOxy.oxyServices.session.validate).toHaveBeenCalledWith('s7', {
      useHeaderValidation: true,
    });
    expect(withStore(store, () => User.get('u7'))?.username).toBe('grace');
  });

  it('reads nothing without a session id', () => {
    const { result } = renderHook(() => useSession(null), { wrapper });
    expect(result.current.value).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(mockOxy.oxyServices.session.validate).not.toHaveBeenCalled();
  });
});
