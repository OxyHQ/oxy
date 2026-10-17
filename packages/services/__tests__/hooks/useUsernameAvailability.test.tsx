import { act, renderHook } from '@testing-library/react';
import { useUsernameAvailability } from '../../src/ui/hooks/useUsernameAvailability';

const checkUsername = jest.fn();
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ user: { username: 'existinguser' }, oxyServices: client }),
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
