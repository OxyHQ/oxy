import { act, renderHook } from '@testing-library/react';
import { useUsernameAvailability } from '../../src/ui/hooks/useUsernameAvailability';
import {
  resetUsernameLookupBudget,
  shareUsernameLookup,
  USERNAME_LOOKUP_BACKGROUND_MAX,
  USERNAME_LOOKUP_LIMIT,
} from '../../src/ui/utils/usernameLookupBudget';

const checkUsername = jest.fn();
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ user: { username: 'existinguser' }, oxyServices: client }),
  useOptionalOxy: () => null,
}));
const client = { auth: { checkUsername } };
const advance = async () => {
  await act(async () => {
    jest.advanceTimersByTime(350);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  checkUsername.mockReset();
  resetUsernameLookupBudget();
});
afterEach(() => {
  jest.useRealTimers();
});

test('keeps the current handle usable and rejects invalid handles without requesting', async () => {
  const { result, rerender } = renderHook(({ name }) => useUsernameAvailability(name, true), {
    initialProps: { name: 'ExistingUser' },
  });
  expect(result.current.canSave).toBe(true);
  rerender({ name: 'not a username' });
  await advance();
  expect(result.current.status).toBe('invalid');
  expect(result.current.invalid).toBe("Usernames can't contain spaces. Use - or _ instead.");
  expect(result.current.canSave).toBe(false);
  expect(checkUsername).not.toHaveBeenCalled();
});

test('debounces edits and ignores an older response after a newer draft', async () => {
  let finishOld!: (value: { available: boolean }) => void;
  checkUsername
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce({ available: false });
  const { result, rerender } = renderHook(({ name }) => useUsernameAvailability(name, true), {
    initialProps: { name: 'firstdraft' },
  });
  await advance();
  rerender({ name: 'seconddraft' });
  expect(result.current.canSave).toBe(false);
  await advance();
  expect(result.current.status).toBe('taken');
  await act(async () => finishOld({ available: true }));
  expect(result.current.status).toBe('taken');
  expect(checkUsername.mock.calls).toEqual([['firstdraft'], ['seconddraft']]);
});

test('checks a new account even when the handle matches the signed-in one', async () => {
  checkUsername.mockResolvedValueOnce({ available: false });
  const { result } = renderHook(() =>
    useUsernameAvailability('existinguser', true, { matchCurrentUser: false }),
  );
  expect(result.current.status).toBe('checking');
  await advance();
  expect(result.current.status).toBe('taken');
  expect(checkUsername).toHaveBeenCalledWith('existinguser');
});

test('does not treat connection failure as availability and can retry', async () => {
  checkUsername
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ available: true });
  const { result } = renderHook(() => useUsernameAvailability('newhandle', true));
  await advance();
  expect(result.current.status).toBe('error');
  expect(result.current.canSave).toBe(false);
  act(() => result.current.retry());
  expect(result.current.status).toBe('checking');
  await advance();
  expect(result.current.canSave).toBe(true);
});

test('preview lookups leave the production quota one request for continue', async () => {
  checkUsername.mockResolvedValue({ available: true });
  const { result, rerender } = renderHook(
    ({ name }) => useUsernameAvailability(name, true, { reserveSubmit: true }),
    { initialProps: { name: 'user00' } },
  );
  for (let i = 0; i < USERNAME_LOOKUP_BACKGROUND_MAX; i++) {
    rerender({ name: `user${String(i).padStart(2, '0')}` });
    await advance();
    expect(result.current.status).toBe('available');
  }
  expect(checkUsername).toHaveBeenCalledTimes(USERNAME_LOOKUP_BACKGROUND_MAX);
  rerender({ name: 'user09' });
  await advance();
  expect(checkUsername).toHaveBeenCalledTimes(USERNAME_LOOKUP_BACKGROUND_MAX);
  expect(result.current.status).toBe('deferred');
  await expect(shareUsernameLookup('user09', 'submit', checkUsername)).resolves.toEqual({
    available: true,
  });
  expect(checkUsername).toHaveBeenCalledTimes(USERNAME_LOOKUP_LIMIT);
});
