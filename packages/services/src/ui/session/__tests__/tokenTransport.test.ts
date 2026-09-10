import type { DeviceSessionState } from '@oxy.so/contracts';
import { logger } from '@oxy.so/core';
import { createTokenTransport } from '../tokenTransport';

// The device-first transport no longer owns a private mint single-flight: it
// routes through the ONE shared `oxyServices.httpService.refreshAccessToken(...)`
// the scheduler/preflight/401 use, so concurrent lanes can never double-rotate
// the device secret. It short-circuits ONLY when the planted bearer already
// identifies the state's active account — a bearer for a DIFFERENT account (an
// account switch) must still mint the new account's token. These tests exercise
// that account-match contract and the transport's error/swallow behavior.

function fakeOxy(currentUserId: string | null, refreshAccessToken = jest.fn(async () => 'minted-token')) {
  return {
    getCurrentUserId: jest.fn().mockReturnValue(currentUserId),
    httpService: { refreshAccessToken },
  };
}

const state: DeviceSessionState = {
  deviceId: 'device-1',
  accounts: [{ accountId: 'a1', sessionId: 'sess-a1', authuser: 0 }],
  activeAccountId: 'a1',
  revision: 1,
  updatedAt: Date.UTC(2026, 6, 1, 0, 0, 0, 0),
};

describe('createTokenTransport', () => {
  test('no-ops when the planted bearer already belongs to the active account', async () => {
    const refreshAccessToken = jest.fn(async () => 'minted-token');
    const oxy = fakeOxy('a1', refreshAccessToken);
    const transport = createTokenTransport(oxy as never);

    await transport.ensureActiveToken(state);

    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  test('mints when the planted bearer belongs to a DIFFERENT account (account switch)', async () => {
    // The core account-switch 404 fix: a bearer for the PREVIOUS account must
    // NOT short-circuit — it must mint the new active account's token.
    const refreshAccessToken = jest.fn(async () => 'minted-token');
    const oxy = fakeOxy('previous-account', refreshAccessToken);
    const transport = createTokenTransport(oxy as never);

    await transport.ensureActiveToken(state);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).toHaveBeenCalledWith('preflight');
  });

  test('mints via the shared httpService.refreshAccessToken single-flight when no bearer is present', async () => {
    const refreshAccessToken = jest.fn(async () => 'minted-token');
    const oxy = fakeOxy(null, refreshAccessToken);
    const transport = createTokenTransport(oxy as never);

    await transport.ensureActiveToken(state);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).toHaveBeenCalledWith('preflight');
  });

  test('resolves (never rejects) and logs a warning when the refresh throws', async () => {
    const refreshAccessToken = jest.fn(async () => {
      throw new Error('mint boom');
    });
    const oxy = fakeOxy(null, refreshAccessToken);
    const transport = createTokenTransport(oxy as never);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(transport.ensureActiveToken(state)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      'ensureActiveToken: refresh failed',
      { component: 'TokenTransport' },
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  test('resolves cleanly when the refresh produces no session', async () => {
    const refreshAccessToken = jest.fn(async () => null);
    const oxy = fakeOxy(null, refreshAccessToken);
    const transport = createTokenTransport(oxy as never);

    await expect(transport.ensureActiveToken(state)).resolves.toBeUndefined();
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  test('delegates concurrent calls to the shared single-flight (no private guard of its own)', async () => {
    // The transport keeps NO local coalescing — it forwards each call to the
    // shared `httpService.refreshAccessToken`, which owns the single-flight that
    // collapses concurrent mints into one server rotation (covered in core).
    const refreshAccessToken = jest.fn(async () => 'minted-token');
    const oxy = fakeOxy(null, refreshAccessToken);
    const transport = createTokenTransport(oxy as never);

    const first = transport.ensureActiveToken(state);
    const second = transport.ensureActiveToken(state);
    // Both concurrent callers reached the shared entry point synchronously — the
    // transport does not swallow the second behind a private guard; dedup is the
    // shared single-flight's job.
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  test('never mints while identity-bound, even when the device switched to another account', async () => {
    // `sessionMode: 'identity'`: the bearer belongs to the PINNED account and is
    // minted for it by the cold boot / re-mint lane. Converging it on
    // `state.activeAccountId` — here a DIFFERENT account another app switched the
    // device to — is exactly the drift the mode prevents, so the transport must
    // short-circuit even though the bearer/active-account check disagrees.
    const refreshAccessToken = jest.fn(async () => 'minted-token');
    const oxy = fakeOxy('pinned-account', refreshAccessToken);
    const transport = createTokenTransport(oxy as never, () => 'pinned-account');

    await transport.ensureActiveToken({
      ...state,
      accounts: [
        { accountId: 'pinned-account', sessionId: 'sess-pinned', authuser: 0 },
        { accountId: 'a1', sessionId: 'sess-a1', authuser: 1 },
      ],
      activeAccountId: 'a1',
    });

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(oxy.getCurrentUserId).not.toHaveBeenCalled();
  });

  test('a resolver reporting no pin (every account-mode provider) behaves exactly as an absent one', async () => {
    const refreshAccessToken = jest.fn(async () => 'minted-token');
    const oxy = fakeOxy('previous-account', refreshAccessToken);
    const transport = createTokenTransport(oxy as never, () => null);

    await transport.ensureActiveToken(state);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).toHaveBeenCalledWith('preflight');
  });

  test('treats a throwing bearer-account check as a mismatch and still mints', async () => {
    const refreshAccessToken = jest.fn(async () => 'minted-token');
    const oxy = fakeOxy(null, refreshAccessToken);
    oxy.getCurrentUserId.mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const transport = createTokenTransport(oxy as never);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(transport.ensureActiveToken(state)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      'ensureActiveToken: bearer-account check threw',
      { component: 'TokenTransport' },
      expect.any(Error),
    );
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
