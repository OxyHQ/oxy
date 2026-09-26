import type { IdentityLinkState } from '@oxy.so/contracts';
import { awaitLinkCompletion } from '@/lib/link-account/awaitLinkCompletion';

const state = (status: IdentityLinkState['status'], expiresAt = 10_000): IdentityLinkState => ({
  status,
  userId: 'user-1',
  username: 'ada',
  publicKey: null,
  audience: 'oxy-api/identity',
  expiresAt,
});

const noSleep = async () => undefined;

describe('awaitLinkCompletion', () => {
  it('waits through signed until auth.oxy.so completes the link', async () => {
    const getState = jest.fn()
      .mockResolvedValueOnce(state('signed'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(state('completed'));
    await expect(
      awaitLinkCompletion({ getState, signal: new AbortController().signal, sleep: noSleep, now: () => 0 }),
    ).resolves.toBe('completed');
    expect(getState).toHaveBeenCalledTimes(3);
  });

  it('ends on a cancelled request, and on its deadline', async () => {
    await expect(
      awaitLinkCompletion({ getState: async () => state('cancelled'), signal: new AbortController().signal, sleep: noSleep }),
    ).resolves.toBe('cancelled');
    await expect(
      awaitLinkCompletion({ getState: async () => state('signed', 5), signal: new AbortController().signal, sleep: noSleep, now: () => 6 }),
    ).resolves.toBe('expired');
  });

  it('stops when the screen goes away', async () => {
    const controller = new AbortController();
    const getState = jest.fn(async () => {
      controller.abort();
      return state('signed');
    });
    await expect(awaitLinkCompletion({ getState, signal: controller.signal, sleep: noSleep, now: () => 0 })).resolves.toBe('aborted');
  });
});
