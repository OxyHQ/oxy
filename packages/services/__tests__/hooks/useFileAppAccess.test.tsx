/**
 * "Apps with access" (ADR 0043 stage 4c): the query reads a file's
 * applications with access, and a revoke removes the application from the
 * cached list at once, restores it when the revoke fails, and re-reads the
 * list either way.
 */
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileApplicationAccess } from '@oxy.so/core';

const listAppAccess = jest.fn();
const revokeAppAccess = jest.fn();

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    oxyServices: { assets: { listAppAccess, revokeAppAccess } },
    activeSessionId: 'session-1',
  }),
}));

jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  authenticatedApiCall: (_oxy: unknown, _session: unknown, call: () => Promise<unknown>) => call(),
}));

import { queryKeys } from '../../src/ui/hooks/queries/queryKeys';
import {
  removeAppAccessFromCache,
  useFileAppAccess,
} from '../../src/ui/hooks/queries/useFileQueries';
import { useRevokeFileAppAccess } from '../../src/ui/hooks/mutations/useAccountMutations';

const syra: FileApplicationAccess = {
  applicationId: 'app-syra',
  name: 'Syra',
  icon: null,
  via: ['upload'],
  since: '2026-10-16T00:00:00.000Z',
};
const alia: FileApplicationAccess = {
  applicationId: 'app-alia',
  name: 'Alia',
  icon: 'https://cloud.oxy.so/alia.png',
  via: ['upload', 'link'],
  since: '2026-10-15T00:00:00.000Z',
};

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  listAppAccess.mockReset();
  revokeAppAccess.mockReset();
});

describe('useFileAppAccess', () => {
  it("reads the file's applications with access", async () => {
    listAppAccess.mockResolvedValueOnce([syra, alia]);
    const { wrapper } = setup();
    const { result } = renderHook(() => useFileAppAccess('file-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([syra, alia]));
    expect(listAppAccess).toHaveBeenCalledWith('file-1');
  });

  it('does not fetch while disabled (not the owner)', () => {
    const { wrapper } = setup();
    renderHook(() => useFileAppAccess('file-1', false), { wrapper });
    expect(listAppAccess).not.toHaveBeenCalled();
  });
});

describe('removeAppAccessFromCache', () => {
  it('drops one application and returns the list before', () => {
    const { queryClient } = setup();
    queryClient.setQueryData(queryKeys.files.appAccess('f'), [syra, alia]);
    expect(removeAppAccessFromCache(queryClient, 'f', 'app-syra')).toEqual([syra, alia]);
    expect(queryClient.getQueryData(queryKeys.files.appAccess('f'))).toEqual([alia]);
  });

  it('is a no-op when nothing is cached', () => {
    const { queryClient } = setup();
    expect(removeAppAccessFromCache(queryClient, 'f', 'app-syra')).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.files.appAccess('f'))).toBeUndefined();
  });

  it('lives under the files root, so a library invalidation refreshes it', () => {
    expect(queryKeys.files.appAccess('f').slice(0, 1)).toEqual([...queryKeys.files.all]);
  });
});

describe('useRevokeFileAppAccess', () => {
  it('removes the application at once, then re-reads the list', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(queryKeys.files.appAccess('f'), [syra, alia]);
    let finish: (value: unknown) => void = () => undefined;
    revokeAppAccess.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRevokeFileAppAccess(), { wrapper });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({ fileId: 'f', applicationId: 'app-syra' });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.files.appAccess('f'))).toEqual([alia]),
    );
    expect(revokeAppAccess).toHaveBeenCalledWith('f', 'app-syra');

    await act(async () => {
      finish({ fileId: 'f', applicationId: 'app-syra', revoked: true, streamsRevoked: 1 });
      await pending;
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.files.appAccess('f') });
  });

  it('puts the application back when the revoke fails', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(queryKeys.files.appAccess('f'), [syra, alia]);
    revokeAppAccess.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useRevokeFileAppAccess(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ fileId: 'f', applicationId: 'app-syra' }),
      ).rejects.toThrow('offline');
    });
    expect(queryClient.getQueryData(queryKeys.files.appAccess('f'))).toEqual([syra, alia]);
  });
});
