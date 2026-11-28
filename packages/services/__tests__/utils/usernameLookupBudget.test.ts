import {
  resetUsernameLookupBudget,
  shareUsernameLookup,
  USERNAME_LOOKUP_BACKGROUND_MAX,
  USERNAME_LOOKUP_LIMIT,
  USERNAME_LOOKUP_WINDOW_MS,
  usernameLookupCooldownSeconds,
} from '../../src/ui/utils/usernameLookupBudget';

const check = jest.fn(async (_username: string) => ({ available: true }));

beforeEach(() => {
  jest.useFakeTimers();
  check.mockClear();
  resetUsernameLookupBudget();
});

afterEach(() => {
  jest.useRealTimers();
});

test('a second ask for the same name waits on the first lookup', async () => {
  let finish!: (value: { available: boolean }) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = shareUsernameLookup('SameName', 'background', check);
  const second = shareUsernameLookup('samename', 'submit', check);
  expect(check).toHaveBeenCalledTimes(1);
  finish({ available: false });
  await expect(first).resolves.toEqual({ available: false });
  await expect(second).resolves.toEqual({ available: false });
  await expect(shareUsernameLookup('samename', 'submit', check)).resolves.toEqual({
    available: false,
  });
  expect(check).toHaveBeenCalledTimes(1);
});

test('preview stops one short of the quota and submit can still spend one', async () => {
  for (let i = 0; i < USERNAME_LOOKUP_BACKGROUND_MAX; i++) {
    await shareUsernameLookup(`name${i}ok`, 'background', check);
  }
  expect(check).toHaveBeenCalledTimes(USERNAME_LOOKUP_BACKGROUND_MAX);
  await expect(shareUsernameLookup('name9ok', 'background', check)).resolves.toBe('deferred');
  expect(check).toHaveBeenCalledTimes(USERNAME_LOOKUP_BACKGROUND_MAX);
  await expect(shareUsernameLookup('name9ok', 'submit', check)).resolves.toEqual({
    available: true,
  });
  expect(check).toHaveBeenCalledTimes(USERNAME_LOOKUP_LIMIT);
  await expect(shareUsernameLookup('name10ok', 'submit', check)).resolves.toBe('deferred');
  expect(check).toHaveBeenCalledTimes(USERNAME_LOOKUP_LIMIT);
  expect(usernameLookupCooldownSeconds()).toBe(60);
});

test('the window opening lets another preview through', async () => {
  for (let i = 0; i < USERNAME_LOOKUP_BACKGROUND_MAX; i++) {
    await shareUsernameLookup(`name${i}ok`, 'background', check);
  }
  await expect(shareUsernameLookup('latername', 'background', check)).resolves.toBe('deferred');
  jest.advanceTimersByTime(USERNAME_LOOKUP_WINDOW_MS);
  await expect(shareUsernameLookup('latername', 'background', check)).resolves.toEqual({
    available: true,
  });
  expect(usernameLookupCooldownSeconds()).toBe(0);
});
