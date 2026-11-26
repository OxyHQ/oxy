/**
 * "Apps with access" (ADR 0043 stage 4c): the read returns a file's
 * applications with access, and a revoke removes the application from the
 * held list at once (an optimistic layer), restores it when the revoke fails,
 * and reads the list again either way.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { type Store, withStore } from '@oxy.so/bloom-data';
import type { FileApplicationAccess } from '@oxy.so/core';
import { dataWrapper, openTestStore } from '../helpers/dataStore';

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

import { FileAppAccess } from '../../src/ui/data/files';
import {
  useFileAppAccess,
  useRevokeFileAppAccess,
} from '../../src/ui/hooks/queries/useFileQueries';

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
  const store: Store = openTestStore();
  return { store, wrapper: dataWrapper(store) };
}

/** What the store holds for file `f`. */
const held = (store: Store) => withStore(store, () => FileAppAccess.get('f')?.apps);

beforeEach(() => {
  listAppAccess.mockReset();
  revokeAppAccess.mockReset();
});

describe('useFileAppAccess', () => {
  it("reads the file's applications with access", async () => {
    listAppAccess.mockResolvedValueOnce([syra, alia]);
    const { wrapper } = setup();
    const { result } = renderHook(() => useFileAppAccess('file-1'), { wrapper });
    await waitFor(() => expect(result.current.value?.apps).toEqual([syra, alia]));
    expect(listAppAccess).toHaveBeenCalledWith('file-1');
  });

  it('does not fetch while disabled (not the owner)', () => {
    const { wrapper } = setup();
    renderHook(() => useFileAppAccess('file-1', false), { wrapper });
    expect(listAppAccess).not.toHaveBeenCalled();
  });
});

describe('useRevokeFileAppAccess', () => {
  it('removes the application at once, then re-reads the list', async () => {
    const { store, wrapper } = setup();
    withStore(store, () => FileAppAccess.put({ id: 'f', apps: [syra, alia] }));
    listAppAccess.mockResolvedValue([alia]);
    let finish: (value: unknown) => void = () => undefined;
    revokeAppAccess.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(() => useRevokeFileAppAccess(), { wrapper });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.run({ fileId: 'f', applicationId: 'app-syra' });
    });
    expect(held(store)).toEqual([alia]);
    expect(revokeAppAccess).toHaveBeenCalledWith('f', 'app-syra');
    expect(listAppAccess).not.toHaveBeenCalled();

    await act(async () => {
      finish({ fileId: 'f', applicationId: 'app-syra', revoked: true, streamsRevoked: 1 });
      await pending;
    });
    // A refresh after the write: the list is read again.
    await waitFor(() => expect(listAppAccess).toHaveBeenCalledWith('f'));
    expect(held(store)).toEqual([alia]);
  });

  it('puts the application back when the revoke fails', async () => {
    const { store, wrapper } = setup();
    withStore(store, () => FileAppAccess.put({ id: 'f', apps: [syra, alia] }));
    let refuse: (error: Error) => void = () => undefined;
    revokeAppAccess.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );
    listAppAccess.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useRevokeFileAppAccess(), { wrapper });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.run({ fileId: 'f', applicationId: 'app-syra' });
    });
    expect(held(store)).toEqual([alia]);

    await act(async () => {
      refuse(new Error('offline'));
      await expect(pending).rejects.toThrow('offline');
    });
    // The optimistic layer is dropped: the list is what it was.
    expect(held(store)).toEqual([syra, alia]);
    expect(result.current.error).toEqual(new Error('offline'));
    expect(listAppAccess).toHaveBeenCalledWith('f');
  });
});
