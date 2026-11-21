/**
 * The account family's writes on `@oxy.so/bloom-data` actions, and the React
 * Query edge cases they carry over:
 * - the optimistic change is a layer on the record, shown at once;
 * - a failure drops exactly its layer (a concurrent write's stays) — the rollback;
 * - success writes the server's answer and reads the account again (the old
 *   invalidation), except where a re-read would race the merged answer;
 * - an answer that lands after the account switched changes nothing.
 */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import type { User } from '@oxy.so/core';
import { toast } from '@oxy.so/bloom/toast';
import { PrivacySettingsOf } from '../../src/ui/data/account';
import { storeUsers, User as UserEntity } from '../../src/ui/data/user';
import {
  useUpdateAccountSettings,
  useUpdatePrivacySettings,
  useUpdateProfile,
} from '../../src/ui/hooks/mutations/useAccountMutations';
import { bindAuthStoreToRuntime, useAuthStore } from '../../src/ui/stores/authStore';
import { createTestRuntime } from '../helpers/runtimeHarness';

const ME = {
  id: 'me',
  username: 'ada',
  name: { displayName: 'Ada' },
  avatar: 'file-old',
  bio: 'old bio',
  privacySettings: { isPrivateAccount: false, allowTagging: true },
  updatedAt: '2026-11-01T00:00:00.000Z',
} as unknown as User;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeServices = () => ({
  users: { updateMe: jest.fn(), me: jest.fn(async () => ME) },
  privacy: {
    updateSettings: jest.fn(),
    settings: jest.fn(async () => ({ isPrivateAccount: false, allowTagging: true })),
  },
});

let mockState = {
  oxyServices: makeServices(),
  activeSessionId: 'sess',
  user: ME as User | null,
};

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  __esModule: true,
  useOxy: () => mockState,
}));

jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  authenticatedApiCall: (_oxy: unknown, _session: unknown, call: () => unknown) => call(),
}));

let store: Store;
let unbind: () => void;
const wrapper = ({ children }: { children: ReactNode }) => (
  <DataProvider store={store}>{children}</DataProvider>
);
const held = () => withStore(store, () => UserEntity.get('me'));

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { oxyServices: makeServices(), activeSessionId: 'sess', user: ME };
  store = new Store();
  withStore(store, () => storeUsers(ME));
  unbind = bindAuthStoreToRuntime(createTestRuntime());
  useAuthStore.setState({ user: ME });
});

afterEach(() => unbind());

describe('useUpdateProfile', () => {
  it('shows the change at once and rolls back only its own fields when refused', async () => {
    const bio = deferred<User>();
    const avatar = deferred<User>();
    mockState.oxyServices.users.updateMe
      .mockReturnValueOnce(bio.promise)
      .mockReturnValueOnce(avatar.promise);
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.run({ bio: 'new bio' }).catch(() => undefined);
      second = result.current.run({ avatar: 'file-new' });
    });
    expect(held()).toMatchObject({ bio: 'new bio', avatar: 'file-new' });
    expect(result.current.isPending).toBe(true);

    // The bio write is refused: its layer goes, the avatar's stays.
    await act(async () => {
      bio.reject(Object.assign(new Error('nope'), { status: 400 }));
      await first;
    });
    expect(held()).toMatchObject({ bio: 'old bio', avatar: 'file-new' });
    expect(toast.error).toHaveBeenCalled();

    await act(async () => {
      avatar.resolve({ ...ME, avatar: 'file-new', updatedAt: '2026-11-02T00:00:00.000Z' });
      await second;
    });
    expect(held()?.avatar).toBe('file-new');
  });

  it("writes the server's answer, with the fields it emptied, and reads the account again", async () => {
    const saved = { ...ME, updatedAt: '2026-11-02T00:00:00.000Z' } as User & { avatar?: string };
    delete saved.avatar;
    mockState.oxyServices.users.updateMe.mockResolvedValue(saved);
    mockState.oxyServices.users.me.mockResolvedValue(saved);
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    await act(async () => {
      await result.current.run({ avatar: '' });
    });
    // The wire omits a cleared field; the write declared it, so it is dropped.
    expect(held()?.avatar).toBeUndefined();
    expect(useAuthStore.getState().user).toMatchObject({ updatedAt: saved.updatedAt });
    expect(mockState.oxyServices.users.me).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when the answer lands after the account switched', async () => {
    const answer = deferred<User>();
    mockState.oxyServices.users.updateMe.mockReturnValue(answer.promise);
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });
    const left = store;

    let write!: Promise<unknown>;
    act(() => {
      write = result.current.run({ bio: 'late bio' });
    });
    // The session opens the next account's store and closes this one.
    await act(async () => {
      await left.close();
    });
    useAuthStore.setState({ user: { id: 'other' } as User });

    await act(async () => {
      answer.resolve({ ...ME, bio: 'late bio', updatedAt: '2026-11-02T00:00:00.000Z' });
      await write;
    });
    expect(useAuthStore.getState().user?.id).toBe('other');
    expect(mockState.oxyServices.users.me).not.toHaveBeenCalled();
  });
});

describe('useUpdatePrivacySettings', () => {
  beforeEach(() => {
    withStore(store, () =>
      PrivacySettingsOf.put({ id: 'me', isPrivateAccount: false, allowTagging: true }),
    );
  });
  const settings = () => withStore(store, () => PrivacySettingsOf.get('me'));

  it('two quick toggles never undo each other; a refusal drops its own and re-reads', async () => {
    const privateAccount = deferred<unknown>();
    const tagging = deferred<unknown>();
    mockState.oxyServices.privacy.updateSettings
      .mockReturnValueOnce(privateAccount.promise)
      .mockReturnValueOnce(tagging.promise);
    const { result } = renderHook(() => useUpdatePrivacySettings(), { wrapper });

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.run({ settings: { isPrivateAccount: true } });
      second = result.current.run({ settings: { allowTagging: false } }).catch(() => undefined);
    });
    expect(settings()).toMatchObject({ isPrivateAccount: true, allowTagging: false });
    expect(held()?.privacySettings).toMatchObject({ isPrivateAccount: true, allowTagging: false });

    await act(async () => {
      tagging.reject(Object.assign(new Error('nope'), { status: 500 }));
      await second;
    });
    expect(settings()).toMatchObject({ isPrivateAccount: true, allowTagging: true });
    expect(mockState.oxyServices.privacy.settings).toHaveBeenCalledTimes(1);

    // Success merges the answer (an older API answered only the changed field)
    // and reads nothing again: the merged answer is the truth.
    await act(async () => {
      privateAccount.resolve({ isPrivateAccount: true });
      await first;
    });
    expect(settings()).toMatchObject({ isPrivateAccount: true, allowTagging: true });
    expect(useAuthStore.getState().user?.privacySettings).toMatchObject({
      isPrivateAccount: true,
    });
    await waitFor(() => expect(mockState.oxyServices.privacy.settings).toHaveBeenCalledTimes(1));
  });
});

describe('useUpdateAccountSettings', () => {
  it('refuses without a signed-in person, writing nothing', async () => {
    mockState.user = null;
    const { result } = renderHook(() => useUpdateAccountSettings(), { wrapper });
    await expect(result.current.run({ allowTagging: false })).rejects.toThrow('no current user');
    expect(mockState.oxyServices.privacy.updateSettings).not.toHaveBeenCalled();
  });
});
