/**
 * Focused unit tests for `runProviderColdBoot`'s cold-boot BOUNDING wiring.
 *
 * These isolate the two additive behaviours Workstream 2 adds around
 * `runSessionColdBoot` (which is fully mocked here — the integration path lives
 * in `context/coldBoot.test.tsx`):
 *
 *  1. It ALWAYS forwards the 12s overall deadline + an `onStepDeadline`
 *     warn-logger, so a black-hole network step can never hang app routing.
 *  2. The best-effort connectivity probe resolves an EXPLICIT offline verdict to
 *     `isOffline() === true` and every AMBIGUOUS outcome (web `navigator.onLine`
 *     not exactly `false`, an unknown NetInfo `isConnected: null`, or a probe
 *     that never settles) to `false` (assume online) — so a flaky probe can
 *     never falsely skip a real sign-in.
 */

type ColdBootOpts = {
  overallDeadlineMs?: number;
  isOffline?: () => boolean;
  onStepDeadline?: (id: string) => void;
  sessionMode?: 'account' | 'identity';
  identity?: { pinStore: unknown };
};

// Controls the web-vs-native branch of the probe. Mutated per test.
let isWeb = true;
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  isWebBrowser: () => isWeb,
}));

const runSessionColdBootMock = jest.fn(
  (_opts: ColdBootOpts): Promise<{ kind: 'unauthenticated' }> =>
    Promise.resolve({ kind: 'unauthenticated' }),
);
const loggerWarn = jest.fn();
jest.mock('@oxyhq/core', () => ({
  logger: { warn: (...args: unknown[]) => loggerWarn(...args), debug: jest.fn(), error: jest.fn() },
  runSessionColdBoot: (opts: ColdBootOpts) => runSessionColdBootMock(opts),
}));

jest.mock('../../src/ui/utils/deviceCredential', () => ({
  loadPersistedDeviceCredential: jest.fn(async () => null),
}));
jest.mock('../../src/ui/utils/oauthReturn', () => ({
  tryCompleteOAuthReturn: jest.fn(async () => false),
}));

const netInfoFetch = jest.fn();
jest.mock('@react-native-community/netinfo', () => ({
  // `__esModule: true` so the dynamic `import()` interop exposes `.default`
  // directly (matching the real ESM module) instead of double-wrapping it —
  // otherwise `NetInfo.default.fetch` is undefined and the probe silently
  // catches, masking the offline verdict.
  __esModule: true,
  default: { fetch: (...args: unknown[]) => netInfoFetch(...args) },
}));

import {
  runProviderColdBoot,
  COLD_BOOT_OVERALL_DEADLINE_MS,
} from '../../src/ui/boot/runProviderColdBoot';
import { tryCompleteOAuthReturn } from '../../src/ui/utils/oauthReturn';

const tryCompleteOAuthReturnMock = tryCompleteOAuthReturn as jest.MockedFunction<
  typeof tryCompleteOAuthReturn
>;

function makeOpts() {
  return {
    oxyServices: {} as never,
    authStore: {} as never,
    sessionClient: { start: jest.fn(async () => undefined) } as never,
    syncDeviceCredentialToHost: jest.fn(async () => undefined),
    commitSession: jest.fn(async () => undefined),
    markAuthResolved: jest.fn(),
    setTokenReady: jest.fn(),
    clientId: 'oxy_test_client',
  };
}

function capturedOpts(): ColdBootOpts {
  expect(runSessionColdBootMock).toHaveBeenCalledTimes(1);
  return runSessionColdBootMock.mock.calls[0][0];
}

describe('runProviderColdBoot — cold-boot bounding wiring', () => {
  beforeEach(() => {
    isWeb = true;
    runSessionColdBootMock.mockClear();
    loggerWarn.mockClear();
    netInfoFetch.mockReset();
  });

  it('exports a 12s overall deadline and forwards it + an onStepDeadline warn-logger', async () => {
    expect(COLD_BOOT_OVERALL_DEADLINE_MS).toBe(12_000);

    await runProviderColdBoot(makeOpts());

    const opts = capturedOpts();
    expect(opts.overallDeadlineMs).toBe(12_000);
    expect(typeof opts.onStepDeadline).toBe('function');

    // The forwarded hook warn-logs the offending step via the module logger.
    opts.onStepDeadline?.('device-secret-mint');
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(String(loggerWarn.mock.calls[0][0])).toContain('device-secret-mint');
  });

  it('web: navigator.onLine !== false ⇒ isOffline() === false (assume online)', async () => {
    isWeb = true;
    await runProviderColdBoot(makeOpts());
    expect(capturedOpts().isOffline?.()).toBe(false);
  });

  it('web: an explicit navigator.onLine === false ⇒ isOffline() === true', async () => {
    isWeb = true;
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    try {
      await runProviderColdBoot(makeOpts());
      expect(capturedOpts().isOffline?.()).toBe(true);
    } finally {
      if (original) {
        Object.defineProperty(window.navigator, 'onLine', original);
      }
    }
  });

  it('native: an unknown NetInfo state (isConnected: null) ⇒ isOffline() === false (assume online)', async () => {
    isWeb = false;
    netInfoFetch.mockResolvedValue({ isConnected: null });
    await runProviderColdBoot(makeOpts());
    expect(capturedOpts().isOffline?.()).toBe(false);
  });

  it('native: an EXPLICIT disconnected NetInfo state (isConnected: false) ⇒ isOffline() === true', async () => {
    isWeb = false;
    netInfoFetch.mockResolvedValue({ isConnected: false });
    await runProviderColdBoot(makeOpts());
    expect(capturedOpts().isOffline?.()).toBe(true);
  });

  it('native: connected but explicitly unreachable ⇒ isOffline() === true', async () => {
    isWeb = false;
    netInfoFetch.mockResolvedValue({ isConnected: true, isInternetReachable: false });
    await runProviderColdBoot(makeOpts());
    expect(capturedOpts().isOffline?.()).toBe(true);
  });

  it('native: a NetInfo probe that never settles is raced out by the 500ms timeout ⇒ isOffline() === false', async () => {
    isWeb = false;
    netInfoFetch.mockReturnValue(new Promise(() => undefined)); // never resolves
    jest.useFakeTimers();
    try {
      const done = runProviderColdBoot(makeOpts());
      // The only timer scheduled up to this await is the 500ms probe timeout;
      // firing it lets the race resolve to the "unknown → online" verdict.
      await jest.advanceTimersByTimeAsync(500);
      await done;
      expect(capturedOpts().isOffline?.()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * `sessionMode` wiring (issue #691). The mode + identity binding are forwarded
 * verbatim to `runSessionColdBoot`, and identity mode additionally SKIPS the web
 * OAuth return leg — it commits whichever account the IdP resolves, which for an
 * identity-bound client is somebody else's account by construction.
 */
describe('runProviderColdBoot — sessionMode wiring', () => {
  const identity = { pinStore: { load: jest.fn(), save: jest.fn(), clear: jest.fn() } };

  beforeEach(() => {
    isWeb = true;
    runSessionColdBootMock.mockClear();
    netInfoFetch.mockReset();
    tryCompleteOAuthReturnMock.mockClear();
  });

  it('defaults to account mode: forwards no identity binding and runs the web OAuth return leg', async () => {
    await runProviderColdBoot(makeOpts());

    const opts = capturedOpts();
    expect(opts.sessionMode).toBe('account');
    expect(opts.identity).toBeUndefined();
    expect(tryCompleteOAuthReturnMock).toHaveBeenCalledTimes(1);
  });

  it('identity mode: forwards the mode + binding and skips the web OAuth return leg', async () => {
    await runProviderColdBoot({
      ...makeOpts(),
      sessionMode: 'identity',
      identity: identity as never,
    });

    const opts = capturedOpts();
    expect(opts.sessionMode).toBe('identity');
    expect(opts.identity).toBe(identity);
    expect(tryCompleteOAuthReturnMock).not.toHaveBeenCalled();
  });
});
