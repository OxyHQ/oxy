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

import type { AuthStateStore, PersistedAuthState, SessionClient } from '@oxy.so/core/session';

jest.mock('@oxy.so/core/session', () => {
  const actual = jest.requireActual('@oxy.so/core/session');
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

import { runSessionColdBoot } from '@oxy.so/core/session';
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

/** An auth store holding this origin's device credential. */
function makeCredentialAuthStore(): AuthStateStore {
  return {
    load: jest.fn(
      async (): Promise<PersistedAuthState | null> => ({ deviceId: 'd1', deviceSecret: 's1' }),
    ),
    save: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  } as unknown as AuthStateStore;
}

/** Put an OAuth return (`?code=`) on the address bar, as the IdP's redirect does. */
function landWithAuthorizationCode(): void {
  window.history.replaceState(null, '', '/?code=auth-code&state=auth-state');
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
    oxyServices: {
      apps: {
        getPublic: jest.fn(async () => ({
          id: 'registered-app',
          name: 'Registered App',
          type: 'first_party',
          isOfficial: false,
          isInternal: false,
          scopes: [],
        })),
      },
    } as unknown as RunProviderColdBootOptions['oxyServices'],
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
    window.history.replaceState(null, '', '/');
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
    const { options, commitSession } = makeHarness({ authStore: makeCredentialAuthStore() });

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
      landWithAuthorizationCode();
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
      landWithAuthorizationCode();
      const { options } = makeHarness();

      await runProviderColdBoot(options);

      expect(mockTryCompleteOAuthReturn).toHaveBeenCalledTimes(1);
    });

    it('commits the OAuth return as a deliberate sign-in', async () => {
      mockTryCompleteOAuthReturn.mockImplementation(async () => true);
      landWithAuthorizationCode();
      const { options } = makeHarness();

      await runProviderColdBoot(options);

      const commit = mockTryCompleteOAuthReturn.mock.calls[0][0] as {
        commitSession: (input: unknown) => Promise<void>;
      };
      await commit.commitSession({ sessionId: 's1', userId: 'u1' });
      expect(options.commitSession).toHaveBeenCalledWith(
        { sessionId: 's1', userId: 'u1' },
        { activate: true, oauth: true },
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

// Each case lands with an OAuth return on the URL — the boot that must classify
// before it does anything — so "nothing ran first" is a real claim. The web
// origin with nothing to restore, which resolves before classification, is
// covered on its own below.
describe('registered cold-boot classification', () => {
  beforeEach(() => {
    mockRunSessionColdBoot.mockReset();
    mockTryCompleteOAuthReturn.mockReset();
    mockTryCompleteOAuthReturn.mockResolvedValue(false);
    landWithAuthorizationCode();
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });
  it('external classification bypasses prior secrets, shared device and identity pin work', async () => {
    const { options } = makeHarness({ authStore: makeCredentialAuthStore() });
    (options.oxyServices.apps.getPublic as jest.Mock).mockResolvedValue({
      id: 'external',
      name: 'External',
      type: 'third_party',
      isOfficial: false,
      isInternal: false,
      scopes: [],
    });
    const beforeDeviceBoot = jest.fn();
    await runProviderColdBoot({ ...options, beforeDeviceBoot });
    expect(options.oxyServices.apps.getPublic).toHaveBeenCalledWith(CLIENT_ID, { cache: false });
    expect(options.authStore.load).not.toHaveBeenCalled();
    expect(options.authStore.clear).not.toHaveBeenCalled();
    expect(options.syncDeviceCredentialToHost).not.toHaveBeenCalled();
    expect(beforeDeviceBoot).not.toHaveBeenCalled();
    expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
  });
  it.each(['missing', 'inactive', 'offline', 'invalid'])(
    'fails closed for %s before secrets and callback work',
    async (mode) => {
      const { options } = makeHarness();
      if (mode === 'missing') options.clientId = undefined;
      else if (mode === 'invalid')
        (options.oxyServices.apps.getPublic as jest.Mock).mockResolvedValue({ type: 'unknown' });
      else (options.oxyServices.apps.getPublic as jest.Mock).mockRejectedValue(new Error(mode));
      await runProviderColdBoot(options);
      expect(options.markAuthResolved).toHaveBeenCalled();
      expect(options.authStore.load).not.toHaveBeenCalled();
      expect(options.authStore.clear).not.toHaveBeenCalled();
      expect(options.syncDeviceCredentialToHost).not.toHaveBeenCalled();
      expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
      expect(mockTryCompleteOAuthReturn).not.toHaveBeenCalled();
    },
  );
  it('a cold external OAuth callback never probes a previous device secret', async () => {
    const { options } = makeHarness();
    (options.oxyServices.apps.getPublic as jest.Mock).mockResolvedValue({
      id: 'external',
      name: 'External',
      type: 'third_party',
      isOfficial: false,
      isInternal: false,
      scopes: [],
    });
    mockTryCompleteOAuthReturn.mockImplementation(async ({ commitSession }) => {
      await commitSession({
        sessionId: 'isolated',
        userId: 'external-user',
        accessToken: 'isolated-bearer',
      });
      return true;
    });
    await runProviderColdBoot(options);
    expect(options.commitSession).toHaveBeenCalledWith(
      { sessionId: 'isolated', userId: 'external-user', accessToken: 'isolated-bearer' },
      { activate: true, oauth: true },
    );
    expect(options.authStore.load).not.toHaveBeenCalled();
    expect(options.syncDeviceCredentialToHost).not.toHaveBeenCalled();
    expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
  });
});

it('an unresponsive registry resolves signed-out without a late privileged continuation', async () => {
  jest.useFakeTimers();
  landWithAuthorizationCode();
  try {
    const { options } = makeHarness({ authStore: makeCredentialAuthStore() });
    let release!: (app: unknown) => void;
    (options.oxyServices.apps.getPublic as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mockRunSessionColdBoot.mockReset();
    mockTryCompleteOAuthReturn.mockReset();
    const boot = runProviderColdBoot(options);
    await jest.advanceTimersByTimeAsync(5000);
    await boot;
    expect(options.markAuthResolved).toHaveBeenCalled();
    expect(options.authStore.load).not.toHaveBeenCalled();
    release({
      id: 'app',
      name: 'Late',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      scopes: [],
    });
    await Promise.resolve();
    expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
    expect(mockTryCompleteOAuthReturn).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
    window.history.replaceState(null, '', '/');
  }
});

/**
 * A web origin with nothing to restore — no warm token, no device secret, no
 * OAuth return on the URL — ends signed out on either lane, so its routing does
 * not wait on the registry round trip. Everything that would USE a credential
 * still waits for the verdict.
 */
describe('web origin with nothing to restore', () => {
  const official = {
    id: 'registered-app',
    name: 'Registered App',
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    scopes: [],
  };

  beforeEach(() => {
    mockRunSessionColdBoot.mockReset();
    mockTryCompleteOAuthReturn.mockReset();
    mockTryCompleteOAuthReturn.mockResolvedValue(false);
    window.history.replaceState(null, '', '/');
  });

  function pendingRegistry(options: RunProviderColdBootOptions): (app: unknown) => void {
    let release!: (app: unknown) => void;
    (options.oxyServices.apps.getPublic as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    return (app) => release(app);
  }

  it('resolves auth before the registry answers, and still classifies with no cache', async () => {
    const { options, markAuthResolved } = makeHarness();
    const onClassified = jest.fn();
    const release = pendingRegistry(options);

    const boot = runProviderColdBoot({ ...options, onClassified });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markAuthResolved).toHaveBeenCalled();
    expect(options.oxyServices.apps.getPublic).toHaveBeenCalledWith(CLIENT_ID, { cache: false });
    expect(onClassified).not.toHaveBeenCalled();

    release(official);
    await boot;

    expect(onClassified).toHaveBeenCalledWith('device');
    expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
    expect(mockTryCompleteOAuthReturn).not.toHaveBeenCalled();
    expect(options.syncDeviceCredentialToHost).not.toHaveBeenCalled();
    expect(options.commitSession).not.toHaveBeenCalled();
  });

  it('a failed classification after the early resolution restores nothing', async () => {
    const { options, markAuthResolved } = makeHarness();
    (options.oxyServices.apps.getPublic as jest.Mock).mockRejectedValue(new Error('offline'));

    await runProviderColdBoot(options);

    expect(markAuthResolved).toHaveBeenCalled();
    expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
    expect(options.syncDeviceCredentialToHost).not.toHaveBeenCalled();
  });

  it('an origin holding a device secret still waits for the verdict before using it', async () => {
    stubSignedOutBoot();
    const { options, markAuthResolved } = makeHarness({ authStore: makeCredentialAuthStore() });
    const release = pendingRegistry(options);

    const boot = runProviderColdBoot(options);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markAuthResolved).not.toHaveBeenCalled();
    expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
    expect(options.syncDeviceCredentialToHost).not.toHaveBeenCalled();

    release(official);
    await boot;

    expect(mockRunSessionColdBoot).toHaveBeenCalledTimes(1);
    expect(markAuthResolved).toHaveBeenCalled();
  });

  it('an origin holding a device secret classified external never uses it', async () => {
    const { options } = makeHarness({ authStore: makeCredentialAuthStore() });
    (options.oxyServices.apps.getPublic as jest.Mock).mockResolvedValue({
      ...official,
      type: 'third_party',
      isOfficial: false,
    });

    await runProviderColdBoot(options);

    expect(mockRunSessionColdBoot).not.toHaveBeenCalled();
    expect(options.syncDeviceCredentialToHost).not.toHaveBeenCalled();
    expect(options.authStore.save).not.toHaveBeenCalled();
    expect(options.authStore.clear).not.toHaveBeenCalled();
  });

  it('an OAuth return on the URL waits for the verdict', async () => {
    landWithAuthorizationCode();
    const { options, markAuthResolved } = makeHarness();
    const release = pendingRegistry(options);

    const boot = runProviderColdBoot(options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markAuthResolved).not.toHaveBeenCalled();
    expect(options.authStore.load).not.toHaveBeenCalled();

    release(official);
    await boot;
    expect(mockTryCompleteOAuthReturn).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, '', '/');
  });

  it('identity mode always waits for the verdict', async () => {
    stubSignedOutBoot();
    const { options, markAuthResolved } = makeHarness({ sessionMode: 'identity' });
    const release = pendingRegistry(options);

    const boot = runProviderColdBoot(options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markAuthResolved).not.toHaveBeenCalled();

    release(official);
    await boot;
    expect(markAuthResolved).toHaveBeenCalled();
  });
});
