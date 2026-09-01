/**
 * `runProviderColdBoot` — the boot NEVER navigates the top-level window (#691
 * phase 7b).
 *
 * Phase 7b deleted the two SDK-initiated, gesture-less full-page hops to the
 * IdP: the cold-boot `prompt=none` silent restore and the post-sign-in hub sync.
 * A web origin with no local device credential now resolves SIGNED OUT and waits
 * for the user's next explicit "Continue with Oxy".
 *
 * What must still work — and is asserted here — is everything the user actually
 * asked for: an authorization code ALREADY on the URL is completed, which is how
 * a browser-BLOCKED sign-in popup finishes after `startWebOAuthSignIn` falls
 * back to a full-page redirect.
 *
 * Unlike `__tests__/boot/runProviderColdBoot.test.ts` (deadline + connectivity
 * wiring), this suite keeps the real navigation primitive in view: every
 * assertion below reaches `redirectToAuthorize`, the ONLY top-level-window
 * navigation the boot could ever have performed.
 */

import type { AuthStateStore, PersistedAuthState, SessionClient } from '@oxyhq/core';

jest.mock('@oxyhq/core', () => {
  const actual = jest.requireActual('@oxyhq/core');
  return {
    __esModule: true,
    ...actual,
    runSessionColdBoot: jest.fn(),
  };
});

// The ONLY top-level-window navigation primitive the SDK has.
jest.mock('../../components/oauthNavigation', () => ({
  redirectToAuthorize: jest.fn(),
}));

jest.mock('../../utils/oauthReturn', () => {
  const actual = jest.requireActual('../../utils/oauthReturn');
  return {
    __esModule: true,
    ...actual,
    tryCompleteOAuthReturn: jest.fn(async () => false),
  };
});

import { runSessionColdBoot } from '@oxyhq/core';
import { redirectToAuthorize } from '../../components/oauthNavigation';
import { tryCompleteOAuthReturn } from '../../utils/oauthReturn';
import { runProviderColdBoot, type RunProviderColdBootOptions } from '../runProviderColdBoot';

const mockRunSessionColdBoot = runSessionColdBoot as jest.Mock;
const mockRedirectToAuthorize = redirectToAuthorize as jest.Mock;
const mockTryCompleteOAuthReturn = tryCompleteOAuthReturn as jest.Mock;

const CLIENT_ID = 'oxy_dk_test';

/** An auth store holding no device credential — the signed-out domain case. */
function makeEmptyAuthStore(): AuthStateStore {
  return {
    load: jest.fn(async (): Promise<PersistedAuthState | null> => null),
    save: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  } as unknown as AuthStateStore;
}

interface Harness {
  options: RunProviderColdBootOptions;
  commitSession: jest.Mock;
  markAuthResolved: jest.Mock;
  setTokenReady: jest.Mock;
  sessionClientStart: jest.Mock;
}

function makeHarness(overrides: Partial<RunProviderColdBootOptions> = {}): Harness {
  const commitSession = jest.fn(async () => undefined);
  const markAuthResolved = jest.fn();
  const setTokenReady = jest.fn();
  const sessionClientStart = jest.fn(async () => undefined);

  const options: RunProviderColdBootOptions = {
    oxyServices: {} as RunProviderColdBootOptions['oxyServices'],
    authStore: makeEmptyAuthStore(),
    clientId: CLIENT_ID,
    sessionClient: { start: sessionClientStart } as unknown as SessionClient,
    syncDeviceCredentialToHost: jest.fn(async () => undefined),
    commitSession,
    markAuthResolved,
    setTokenReady,
    ...overrides,
  };

  return { options, commitSession, markAuthResolved, setTokenReady, sessionClientStart };
}

/** `runSessionColdBoot` finding no session at all — the signed-out domain. */
function stubSignedOutBoot(): void {
  mockRunSessionColdBoot.mockImplementation(
    async (opts: Parameters<typeof runSessionColdBoot>[0]) => {
      await opts.onSignedOut?.('no_session');
      return { kind: 'unauthenticated' } as const;
    },
  );
}

describe('runProviderColdBoot — no SDK-initiated IdP navigation (#691 phase 7b)', () => {
  beforeEach(() => {
    mockRunSessionColdBoot.mockReset();
    mockRedirectToAuthorize.mockClear();
    mockTryCompleteOAuthReturn.mockClear();
    mockTryCompleteOAuthReturn.mockImplementation(async () => false);
    globalThis.sessionStorage?.clear();
  });

  it('resolves a domain with no local credential SIGNED OUT instead of bouncing to the IdP', async () => {
    stubSignedOutBoot();
    const { options, markAuthResolved, commitSession, sessionClientStart } = makeHarness();

    await runProviderColdBoot(options);

    // Auth resolution concluded (routing can settle), nothing was committed,
    // and with no persisted credential the device socket is not started.
    expect(markAuthResolved).toHaveBeenCalled();
    expect(commitSession).not.toHaveBeenCalled();
    expect(sessionClientStart).not.toHaveBeenCalled();
    expect(mockRedirectToAuthorize).not.toHaveBeenCalled();
  });

  it('does not navigate even with a clientId configured and the mint finding nothing', async () => {
    // The deleted silent-restore lane needed exactly this shape: a registered
    // client id plus a signed-out mint outcome. It must now be inert.
    stubSignedOutBoot();
    const { options } = makeHarness({ clientId: CLIENT_ID, authRedirectUri: 'https://app.oxy.so' });

    await runProviderColdBoot(options);

    expect(mockRedirectToAuthorize).not.toHaveBeenCalled();
  });

  it('does not navigate when the mint already resolved a session', async () => {
    mockRunSessionColdBoot.mockImplementation(
      async (opts: Parameters<typeof runSessionColdBoot>[0]) => {
        const session = {
          sessionId: 's1',
          userId: 'u1',
          accessToken: 'at',
          via: 'device-secret-mint',
        };
        await opts.onSession?.(session);
        return { kind: 'session', via: session.via, session } as const;
      },
    );
    const { options, commitSession } = makeHarness();

    await runProviderColdBoot(options);

    expect(commitSession).toHaveBeenCalledWith(
      { sessionId: 's1', accessToken: 'at', userId: 'u1' },
      { activate: false },
    );
    expect(mockRedirectToAuthorize).not.toHaveBeenCalled();
  });

  describe('the blocked-popup redirect fallback still completes', () => {
    it('completes an authorization code already on the URL', async () => {
      // A popup-mode app lands here whenever the browser blocked the popup and
      // `startWebOAuthSignIn` fell back to a full-page redirect.
      mockTryCompleteOAuthReturn.mockImplementation(async () => true);
      const { options, markAuthResolved, setTokenReady } = makeHarness();

      await runProviderColdBoot(options);

      expect(mockTryCompleteOAuthReturn).toHaveBeenCalledTimes(1);
      expect(setTokenReady).toHaveBeenLastCalledWith(true);
      expect(markAuthResolved).toHaveBeenCalled();
      // The device mint is short-circuited by the completed return leg.
      expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
      expect(mockRedirectToAuthorize).not.toHaveBeenCalled();
    });

    it('runs the return leg even on a boot that finds no session', async () => {
      stubSignedOutBoot();
      const { options } = makeHarness();

      await runProviderColdBoot(options);

      expect(mockTryCompleteOAuthReturn).toHaveBeenCalledTimes(1);
    });

    it('commits the OAuth return as a deliberate sign-in', async () => {
      mockTryCompleteOAuthReturn.mockImplementation(async () => true);
      const { options } = makeHarness();

      await runProviderColdBoot(options);

      const commit = mockTryCompleteOAuthReturn.mock.calls[0][0] as {
        commitSession: (input: unknown) => Promise<void>;
      };
      await commit.commitSession({ sessionId: 's1', userId: 'u1' });
      expect(options.commitSession).toHaveBeenCalledWith(
        { sessionId: 's1', userId: 'u1' },
        { activate: true },
      );
    });
  });

  it('identity mode skips the web OAuth return leg entirely', async () => {
    stubSignedOutBoot();
    const { options } = makeHarness({ sessionMode: 'identity' });

    await runProviderColdBoot(options);

    expect(mockTryCompleteOAuthReturn).not.toHaveBeenCalled();
    expect(mockRedirectToAuthorize).not.toHaveBeenCalled();
  });
});
