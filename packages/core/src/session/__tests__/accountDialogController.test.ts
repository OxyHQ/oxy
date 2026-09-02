import type { DeviceSessionState } from '@oxyhq/contracts';
import type { OxyServices } from '../../OxyServices';
import type { User } from '../../models/interfaces';
import type { SessionLoginResponse, MinimalUserData } from '../../models/session';
import type { AccountNode } from '../../mixins/OxyServices.accounts';
import { SessionClient, type SessionClientHost } from '../SessionClient';
import type { MinimalSocket, SocketIOFactory } from '../socketLoader';
import { logger } from '../../logger';
import { setPlatformOS } from '../../utils/platform';
import {
  AccountDialogController,
  createAccountDialogController,
} from '../accountDialogController';

// A SessionClient whose applied state can be driven directly (applyState is
// protected on the base) — mirrors the existing TestClient pattern.
class TestSessionClient extends SessionClient {
  static readonly instances = new Set<TestSessionClient>();

  constructor(clientHost: SessionClientHost) {
    super(clientHost);
    TestSessionClient.instances.add(this);
  }

  set(state: DeviceSessionState): void {
    this.applyState(state);
  }
}

afterEach(() => {
  for (const client of TestSessionClient.instances) client.stop();
  TestSessionClient.instances.clear();
});

/**
 * A valid, empty directory for the host below.
 *
 * `refresh()` reads `GET /session/device/directory` now, so the shared host has
 * to answer it with something the contract accepts — otherwise every test in
 * this file logs "discarded invalid device directory" and the ones asserting on
 * the logger fail for a reason that has nothing to do with their subject.
 *
 * Its `revision` sits deliberately ahead of every state revision these tests
 * use, so the directory-settle re-read (which has its own suite) never fires
 * here and each test's request count stays about the thing it is testing.
 */
const EMPTY_DIRECTORY = {
  deviceId: 'device-1',
  revision: 9_000,
  activeContextId: null,
  principals: [],
  updatedAt: 1_720_000_000_000,
};

interface RecordingHost {
  host: SessionClientHost;
  /** Every path the client has requested, in order. */
  urls: string[];
  /** Make the next and every subsequent directory read reject with `error`. */
  failDirectory: (error: unknown) => void;
}

function host(): RecordingHost {
  const urls: string[] = [];
  let directoryError: unknown = null;
  return {
    urls,
    failDirectory: (error: unknown) => {
      directoryError = error;
    },
    host: {
      makeRequest: jest.fn(async (_method: string, url: string) => {
        urls.push(url);
        if (url === '/session/device/directory') {
          if (directoryError !== null) throw directoryError;
          return EMPTY_DIRECTORY;
        }
        return undefined;
      }),
      getBaseURL: () => 'http://test.invalid',
      getAccessToken: () => 'token',
      getDeviceCredential: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: jest.fn(),
      getCurrentAccountId: () => null,
    },
  };
}

function state(
  accounts: Array<{ accountId: string; sessionId: string }>,
  activeAccountId: string | null,
  revision = 1,
): DeviceSessionState {
  return {
    deviceId: 'device-1',
    accounts: accounts.map((a) => ({ accountId: a.accountId, sessionId: a.sessionId, authuser: 0 })),
    activeAccountId,
    revision,
    updatedAt: 1_720_000_000_000,
  };
}

function user(id: string, over: Partial<User> = {}): User {
  return {
    id,
    publicKey: `pk_${id}`,
    username: `user_${id}`,
    name: { displayName: `User ${id}` },
    ...over,
  } as User;
}

function graphNode(id: string, over: Partial<AccountNode> = {}): AccountNode {
  return {
    accountId: id,
    kind: 'organization',
    parentAccountId: null,
    account: user(id),
    relationship: 'owner',
    callerMembership: null,
    ...over,
  };
}

interface OxyMock {
  getAccessToken: jest.Mock;
  getBaseURL: jest.Mock;
  onTokensChanged: jest.Mock;
  listAccounts: jest.Mock;
  getUsersByIds: jest.Mock;
  getFileDownloadUrl: jest.Mock;
  switchToAccount: jest.Mock;
  startCommonsSignIn: jest.Mock;
  deliverCommonsSignIn: jest.Mock;
  pollCommonsSignIn: jest.Mock;
  denyCommonsSignIn: jest.Mock;
  claimSessionByToken: jest.Mock;
  signInWithSharedIdentity: jest.Mock;
  /**
   * Test helper: set the current access token and fire every registered
   * `onTokensChanged` listener (mirrors `OxyServices.setTokens`/`clearTokens`).
   * With no listener yet registered (before `start()`), it just sets the token.
   */
  emitTokenChange: (token: string | null) => void;
}

function makeOxy(): OxyMock {
  const tokenListeners = new Set<(token: string | null) => void>();
  // Authenticated by default (mirrors a warm start with a planted bearer).
  let currentToken: string | null = 'access-token';
  return {
    getAccessToken: jest.fn(() => currentToken),
    getBaseURL: jest.fn(() => 'http://test.invalid'),
    onTokensChanged: jest.fn((listener: (token: string | null) => void) => {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    }),
    listAccounts: jest.fn().mockResolvedValue([]),
    getUsersByIds: jest.fn().mockResolvedValue([]),
    getFileDownloadUrl: jest.fn((id: string) => `https://cdn/${id}`),
    switchToAccount: jest.fn(),
    startCommonsSignIn: jest.fn(),
    pollCommonsSignIn: jest.fn(),
    // Default: no capable Commons installation is registered. A NORMAL outcome
    // that resolves the primary route to QR — never an error.
    deliverCommonsSignIn: jest.fn().mockResolvedValue({ delivered: false, targets: 0 }),
    denyCommonsSignIn: jest.fn().mockResolvedValue({ success: true }),
    claimSessionByToken: jest.fn(),
    signInWithSharedIdentity: jest.fn().mockResolvedValue(null),
    emitTokenChange: (token: string | null) => {
      currentToken = token;
      for (const listener of tokenListeners) {
        listener(token);
      }
    },
  };
}

/** Flush pending microtasks (a `start()`-triggered `refresh()` cannot be awaited directly). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  controller: AccountDialogController;
  oxy: OxyMock;
  sc: TestSessionClient;
  commitSession: jest.Mock;
  onSignedIn: jest.Mock;
  /** Every path the session client has requested, in order. */
  urls: string[];
  /** Make every directory read reject with `error`. */
  failDirectory: (error: unknown) => void;
}

function makeHarness(
  over: Partial<{
    clientId: string | null;
    openPopup: () => import('../accountDialogController').PopupWindowHandle | null;
    hubBaseUrl: string;
    platform: import('../../utils/commonsDelivery').CommonsDeliveryPlatform;
    openUrl: (url: string) => void;
    canOpenApp: (url: string) => Promise<boolean>;
  }> = {},
): Harness {
  const oxy = makeOxy();
  const recording = host();
  const sc = new TestSessionClient(recording.host);
  const commitSession = jest.fn().mockResolvedValue(undefined);
  const onSignedIn = jest.fn();
  const controller = createAccountDialogController({
    oxyServices: oxy as unknown as OxyServices,
    sessionClient: sc,
    clientId: 'clientId' in over ? over.clientId : 'oxy_dk_test',
    commitSession,
    onSignedIn,
    pollIntervalMs: 1000,
    openPopup: over.openPopup,
    hubBaseUrl: over.hubBaseUrl,
    platform: over.platform,
    openUrl: over.openUrl,
    canOpenApp: over.canOpenApp,
  });
  return {
    controller,
    oxy,
    sc,
    commitSession,
    onSignedIn,
    urls: recording.urls,
    failDirectory: recording.failDirectory,
  };
}

/** How many times the device directory has been read. */
const directoryReads = (urls: string[]): number =>
  urls.filter((url) => url === '/session/device/directory').length;

describe('AccountDialogController — initial + views', () => {
  it('starts on the accounts view with an empty list and idle sign-in', () => {
    const { controller } = makeHarness();
    const snap = controller.getSnapshot();
    expect(snap.view).toBe('accounts');
    expect(snap.directory).toBeNull();
    expect(snap.activeContext).toBeNull();
    expect(snap.loading).toBe(false);
    expect(snap.activatingContextId).toBeNull();
    expect(snap.removingContextId).toBeNull();
    expect(snap.removingPrincipalId).toBeNull();
    expect(snap.signIn.phase).toBe('idle');
    expect(snap.signIn.route).toBeNull();
    expect(snap.signIn.routeFailed).toBe(false);
    expect(snap.signIn.pushSentAt).toBeNull();
    expect(snap.signIn.openedAt).toBeNull();
    expect(snap.signIn.progress).toBe('idle');
    expect(snap.commonsAvailability).toBe('unknown');
  });

  it('setView / add move between views and notify subscribers', () => {
    const { controller } = makeHarness();
    const seen: string[] = [];
    controller.subscribe((s) => seen.push(s.view));

    controller.add();
    expect(controller.getSnapshot().view).toBe('add');
    controller.setView('signin');
    expect(controller.getSnapshot().view).toBe('signin');
    controller.setView('accounts');
    expect(controller.getSnapshot().view).toBe('accounts');

    expect(seen).toEqual(['add', 'signin', 'accounts']);
  });

  it('startSignup moves to the signup view and notifies subscribers', () => {
    const { controller } = makeHarness();
    const seen: string[] = [];
    controller.subscribe((s) => seen.push(s.view));

    controller.startSignup();
    expect(controller.getSnapshot().view).toBe('signup');
    controller.setView('accounts');
    expect(controller.getSnapshot().view).toBe('accounts');

    expect(seen).toEqual(['signup', 'accounts']);
  });

  it('getSnapshot returns a stable reference until a change occurs', () => {
    const { controller } = makeHarness();
    const a = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(a);
    controller.setView('add');
    expect(controller.getSnapshot()).not.toBe(a);
  });
});

describe('AccountDialogController — auth-gated directory read', () => {
  it('start() while signed out makes no directory call and does not error', async () => {
    const { controller, oxy, sc, urls } = makeHarness();
    // Cold boot: no bearer planted yet (no listeners registered pre-start).
    oxy.emitTokenChange(null);
    sc.set(state([{ accountId: 'a1', sessionId: 's1' }], 'a1'));

    controller.start();
    await flush();

    // The directory read is a PRIVATE call. Issuing it before the cold-boot
    // restore plants the bearer 401s, which clears the token and signs the user
    // out — the failure this gate exists for.
    expect(urls).not.toContain('/session/device/directory');
    const snap = controller.getSnapshot();
    expect(snap.error).toBeNull();
    expect(snap.loading).toBe(false);
    controller.destroy();
  });

  it('start() while authenticated reads the directory exactly once', async () => {
    const { controller, sc, urls } = makeHarness();
    sc.set(state([{ accountId: 'a1', sessionId: 's1' }], 'a1'));

    controller.start();
    await flush();

    expect(directoryReads(urls)).toBe(1);
    controller.destroy();
  });

  it('reads the directory once when the bearer is planted after a signed-out start', async () => {
    const { controller, oxy, urls } = makeHarness();
    oxy.emitTokenChange(null);
    controller.start();
    await flush();
    expect(urls).not.toContain('/session/device/directory');

    // Cold-boot restore plants the token → onTokensChanged → one read.
    oxy.emitTokenChange('access-token');
    await flush();
    expect(directoryReads(urls)).toBe(1);
    controller.destroy();
  });

  it('never reconstructs the account graph — no listAccounts, no getUsersByIds', async () => {
    const { controller, oxy, sc } = makeHarness();
    sc.set(state([{ accountId: 'a1', sessionId: 's1' }], 'a1'));

    controller.start();
    await flush();
    // A device change used to refetch profiles for any newly-seen account id.
    sc.set(state([{ accountId: 'a1', sessionId: 's1' }, { accountId: 'a2', sessionId: 's2' }], 'a2', 2));
    await flush();

    // ADR 0002's whole point: the client holds ONE caller's account graph and
    // cannot enumerate another principal's, so a switcher assembled from it is
    // one person's answer presented as the device's. The directory carries the
    // rows AND the display metadata, so neither private call is made at all.
    expect(oxy.listAccounts).not.toHaveBeenCalled();
    expect(oxy.getUsersByIds).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('does not loop when the directory read rejects — one call per refresh, no re-trigger on device changes', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { controller, sc, urls, failDirectory } = makeHarness();
    failDirectory(new Error('directory boom'));
    sc.set(state([{ accountId: 'a1', sessionId: 's1' }], 'a1'));

    controller.start();
    await flush();
    expect(directoryReads(urls)).toBe(1);
    expect(controller.getSnapshot().error).toBe('directory boom');

    // A subsequent device push must not re-trigger it (the auth edge did not
    // move → `reconcileAuth` is a no-op → no storm).
    sc.set(state([{ accountId: 'a1', sessionId: 's1' }], 'a1', 2));
    await flush();
    expect(directoryReads(urls)).toBe(1);
    controller.destroy();
    warnSpy.mockRestore();
  });

  it('treats a 401 from the directory read as the signed-out edge — debug, no surfaced error, no warn', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const { controller, failDirectory } = makeHarness();
    failDirectory(
      Object.assign(new Error('Invalid or missing authorization header'), { status: 401 }),
    );

    await controller.refresh();

    // A signed-out device is a normal state, not a warning.
    expect(controller.getSnapshot().error).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      '[AccountDialogController] directory unauthorized (signed out)',
      { component: 'AccountDialogController' },
      expect.objectContaining({ status: 401 }),
    );
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });
});

describe('AccountDialogController — sign in with Oxy', () => {
  it('completes silently when a shared identity mints a session', async () => {
    const { controller, oxy, commitSession, onSignedIn } = makeHarness();
    const session: SessionLoginResponse = {
      sessionId: 'sess-shared',
      deviceId: 'device-1',
      expiresAt: '2030-01-01T00:00:00Z',
      accessToken: 'access-shared',
      user: { id: 'a1', username: 'user_a1', name: { displayName: 'User a1' } },
    };
    oxy.signInWithSharedIdentity.mockResolvedValue(session);

    await controller.signInWithOxy();

    expect(commitSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-shared' }));
    expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
    expect(controller.getSnapshot().view).toBe('accounts');
    // Terminal SUCCESS — the surface gets one frame to show "Identity confirmed".
    expect(controller.getSnapshot().signIn.phase).toBe('completed');
    expect(controller.getSnapshot().signIn.progress).toBe('identity-confirmed');
    expect(oxy.startCommonsSignIn).not.toHaveBeenCalled();

    // …and a new intention clears it, so the next entry never opens on the
    // previous sign-in's terminal state.
    controller.add();
    expect(controller.getSnapshot().signIn.phase).toBe('idle');
    expect(controller.getSnapshot().signIn.progress).toBe('idle');
  });

  it('falls through to the QR handoff when no shared identity is present', async () => {
    const { controller, oxy } = makeHarness();
    oxy.signInWithSharedIdentity.mockResolvedValue(null);
    oxy.startCommonsSignIn.mockResolvedValue({
      sessionToken: 'secret-tok',
      authorizeCode: 'AUTH-CODE',
      qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
      expiresAt: Date.now() + 300_000,
      status: 'pending',
    });

    await controller.signInWithOxy();

    expect(oxy.startCommonsSignIn).toHaveBeenCalledWith({ clientId: 'oxy_dk_test' });
    const snap = controller.getSnapshot();
    expect(snap.view).toBe('qr');
    expect(snap.signIn.phase).toBe('waiting');
    expect(snap.signIn.authorizeCode).toBe('AUTH-CODE');
    expect(snap.signIn.qrPayload).toBe('oxycommons://approve?v=1&code=AUTH-CODE');
    expect(oxy.deliverCommonsSignIn).toHaveBeenCalledWith('AUTH-CODE');
    expect(snap.signIn.route).toBe('qr');
    controller.cancelSignIn();
  });

  it('selects await-push when delivery succeeds for a signed-in user', async () => {
    const { controller, oxy } = makeHarness();
    oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: true, targets: 1 });
    oxy.startCommonsSignIn.mockResolvedValue({
      sessionToken: 'secret-tok',
      authorizeCode: 'AUTH-CODE',
      qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
      expiresAt: Date.now() + 300_000,
      status: 'pending',
    });

    await controller.showQr();

    expect(oxy.deliverCommonsSignIn).toHaveBeenCalledWith('AUTH-CODE');
    expect(controller.getSnapshot().signIn.route).toBe('await-push');
    controller.cancelSignIn();
  });

  it('skips deliver when no bearer is planted', async () => {
    const { controller, oxy } = makeHarness();
    oxy.emitTokenChange(null);
    oxy.startCommonsSignIn.mockResolvedValue({
      sessionToken: 'secret-tok',
      authorizeCode: 'AUTH-CODE',
      qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
      expiresAt: Date.now() + 300_000,
      status: 'pending',
    });

    await controller.showQr();

    expect(oxy.deliverCommonsSignIn).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.route).toBe('qr');
    controller.cancelSignIn();
  });

  it('errors when showQr is called without a clientId', async () => {
    const { controller } = makeHarness({ clientId: null });
    await controller.showQr();
    const snap = controller.getSnapshot();
    expect(snap.signIn.phase).toBe('error');
    expect(snap.signIn.error).toMatch(/clientId/);
  });

  it('polls, claims, and commits when the QR flow is authorized', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy, commitSession, onSignedIn } = makeHarness();
      oxy.startCommonsSignIn.mockResolvedValue({
        sessionToken: 'secret-tok',
        authorizeCode: 'AUTH-CODE',
        qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
        expiresAt: Date.now() + 600_000,
        status: 'pending',
      });
      oxy.pollCommonsSignIn
        .mockResolvedValueOnce({ authorized: false, status: 'pending' })
        .mockResolvedValueOnce({ authorized: true, sessionId: 'sess-1', status: 'authorized' });
      oxy.claimSessionByToken.mockResolvedValue({
        accessToken: 'access-1',
        sessionId: 'sess-1',
        deviceId: 'device-1',
        deviceSecret: 'claimed-secret',
        expiresAt: '2030-01-01T00:00:00Z',
        user: user('a1'),
      });

      await controller.showQr();
      expect(controller.getSnapshot().signIn.phase).toBe('waiting');

      await jest.advanceTimersByTimeAsync(1000); // first poll → pending
      expect(oxy.pollCommonsSignIn).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000); // second poll → authorized → claim
      expect(oxy.claimSessionByToken).toHaveBeenCalledWith('secret-tok');
      expect(commitSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          accessToken: 'access-1',
          deviceSecret: 'claimed-secret',
        }),
      );
      expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
      expect(controller.getSnapshot().view).toBe('accounts');
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces a denied QR authorization as an error and stops polling', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeHarness();
      oxy.startCommonsSignIn.mockResolvedValue({
        sessionToken: 'secret-tok',
        authorizeCode: 'AUTH-CODE',
        qrPayload: 'oxycommons://approve',
        expiresAt: Date.now() + 600_000,
        status: 'pending',
      });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'cancelled' });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(1000);

      expect(controller.getSnapshot().signIn.phase).toBe('error');
      expect(controller.getSnapshot().signIn.error).toMatch(/denied/i);

      // No further polls after the terminal error.
      await jest.advanceTimersByTimeAsync(5000);
      expect(oxy.pollCommonsSignIn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancelSignIn stops the poll and resets to idle', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeHarness();
      oxy.startCommonsSignIn.mockResolvedValue({
        sessionToken: 'secret-tok',
        authorizeCode: 'AUTH-CODE',
        qrPayload: 'oxycommons://approve',
        expiresAt: Date.now() + 600_000,
        status: 'pending',
      });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });

      await controller.showQr();
      controller.cancelSignIn();
      expect(controller.getSnapshot().signIn.phase).toBe('idle');
      expect(controller.getSnapshot().signIn.progress).toBe('idle');
      // Cancellation converges server-side too: the abandoned request is
      // withdrawn so a stale QR can never be approved later.
      expect(oxy.denyCommonsSignIn).toHaveBeenCalledWith('AUTH-CODE');

      await jest.advanceTimersByTimeAsync(5000);
      expect(oxy.pollCommonsSignIn).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

/** A controllable fake `PopupWindowHandle` for `startPasskeyHubSignIn` tests. */
function fakePopup(): import('../accountDialogController').PopupWindowHandle & { setClosed: () => void } {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    close: jest.fn(() => {
      closed = true;
    }),
    location: { href: '' },
    setClosed: () => {
      closed = true;
    },
  };
}

describe('AccountDialogController — startPasskeyHubSignIn (b2 passkey hub popup)', () => {
  it('opens the popup synchronously, then navigates it to the hub URL with the authorizeCode once the session exists', async () => {
    const popup = fakePopup();
    const openPopup = jest.fn(() => popup);
    const { controller, oxy } = makeHarness({ openPopup, hubBaseUrl: 'https://auth.oxy.so' });
    oxy.startCommonsSignIn.mockResolvedValue({
      sessionToken: 'secret-tok',
      authorizeCode: 'AUTH-CODE',
      qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
      expiresAt: Date.now() + 300_000,
      status: 'pending',
    });

    await controller.startPasskeyHubSignIn();

    expect(openPopup).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe('https://auth.oxy.so/hub-passkey?code=AUTH-CODE');
    // Same underlying device-flow session showQr would create — the QR view
    // still renders as a fallback/alternative alongside the popup.
    const snap = controller.getSnapshot();
    expect(snap.view).toBe('qr');
    expect(snap.signIn.phase).toBe('waiting');
    expect(snap.signIn.authorizeCode).toBe('AUTH-CODE');
    controller.cancelSignIn();
  });

  it('falls back to the plain QR flow (no navigation) when the popup is blocked', async () => {
    const openPopup = jest.fn(() => null);
    const { controller, oxy } = makeHarness({ openPopup });
    oxy.startCommonsSignIn.mockResolvedValue({
      sessionToken: 'secret-tok',
      authorizeCode: 'AUTH-CODE',
      qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
      expiresAt: Date.now() + 300_000,
      status: 'pending',
    });

    await controller.startPasskeyHubSignIn();

    expect(oxy.startCommonsSignIn).toHaveBeenCalledWith({ clientId: 'oxy_dk_test' });
    const snap = controller.getSnapshot();
    expect(snap.view).toBe('qr');
    expect(snap.signIn.phase).toBe('waiting');
    expect(snap.signIn.qrPayload).toBe('oxycommons://approve?v=1&code=AUTH-CODE');
    controller.cancelSignIn();
  });

  it('closes the popup without navigating it when device-flow session creation fails', async () => {
    const popup = fakePopup();
    const openPopup = jest.fn(() => popup);
    const { controller, oxy } = makeHarness({ openPopup });
    oxy.startCommonsSignIn.mockRejectedValue(new Error('network down'));

    await controller.startPasskeyHubSignIn();

    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe('');
    expect(controller.getSnapshot().signIn.phase).toBe('error');
  });

  it('surfaces "cancelled" and closes the popup watcher when the user closes the popup before authorizing', async () => {
    jest.useFakeTimers();
    try {
      const popup = fakePopup();
      const openPopup = jest.fn(() => popup);
      const { controller, oxy } = makeHarness({ openPopup });
      oxy.startCommonsSignIn.mockResolvedValue({
        sessionToken: 'secret-tok',
        authorizeCode: 'AUTH-CODE',
        qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
        expiresAt: Date.now() + 300_000,
        status: 'pending',
      });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });

      await controller.startPasskeyHubSignIn();
      expect(controller.getSnapshot().signIn.phase).toBe('waiting');

      popup.setClosed();
      await jest.advanceTimersByTimeAsync(1000); // the 1s popup-close watchdog tick

      const snap = controller.getSnapshot();
      expect(snap.signIn.phase).toBe('error');
      expect(snap.signIn.error).toMatch(/cancelled/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes the popup again (never navigates it) when clientId is missing', async () => {
    const popup = fakePopup();
    const openPopup = jest.fn(() => popup);
    const { controller, oxy } = makeHarness({ clientId: null, openPopup });

    await controller.startPasskeyHubSignIn();

    // openPopup is invoked unconditionally (before the clientId check, since it
    // must run synchronously) — but the popup must be closed again rather than
    // navigated, since the flow can't proceed without a clientId.
    expect(oxy.startCommonsSignIn).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe('');
    expect(controller.getSnapshot().signIn.phase).toBe('error');
    expect(controller.getSnapshot().signIn.error).toMatch(/clientId/);
  });
});

describe('AccountDialogController — Commons availability (canOpenApp)', () => {
  const START_HANDLE = {
    sessionToken: 'secret-tok',
    authorizeCode: 'AUTH-CODE',
    qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
    expiresAt: Date.now() + 600_000,
    status: 'pending' as const,
  };

  function makeController(opts: {
    openUrl?: jest.Mock;
    canOpenApp?: jest.Mock;
  }): { controller: AccountDialogController; oxy: OxyMock } {
    const oxy = makeOxy();
    oxy.startCommonsSignIn.mockResolvedValue(START_HANDLE);
    oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });
    const controller = new AccountDialogController({
      oxyServices: oxy as unknown as OxyServices,
      sessionClient: new TestSessionClient(host().host),
      clientId: 'oxy_dk_test',
      pollIntervalMs: 1000,
      openUrl: opts.openUrl,
      canOpenApp: opts.canOpenApp,
      // The deep-link route is mobile-only (`selectCommonsDelivery`), and a
      // `canOpenApp` probe is only ever injected by a native (mobile) host.
      platform: 'mobile',
    });
    return { controller, oxy };
  }

  it('deep-links into Commons via openUrl when canOpenApp reports it installed, keeping the QR/polling fallback', async () => {
    setPlatformOS('ios');
    const openUrl = jest.fn();
    const canOpenApp = jest.fn().mockResolvedValue(true);
    const { controller } = makeController({ openUrl, canOpenApp });

    await controller.showQr();
    await flush(); // let the (non-awaited) canOpenApp probe resolve

    expect(canOpenApp).toHaveBeenCalledWith('oxycommons://');
    expect(openUrl).toHaveBeenCalledWith('oxycommons://approve?v=1&code=AUTH-CODE');
    // The QR + polling remain the fallback path — the flow is still waiting.
    const snap = controller.getSnapshot();
    expect(snap.view).toBe('qr');
    expect(snap.signIn.phase).toBe('waiting');
    expect(snap.signIn.route).toBe('open-commons');
    expect(snap.signIn.qrPayload).toBe('oxycommons://approve?v=1&code=AUTH-CODE');
    expect(snap.commonsAvailability).toBe('available');
    controller.cancelSignIn();
    setPlatformOS('web');
  });

  it('does NOT open Commons when canOpenApp reports it absent (renders QR only)', async () => {
    const openUrl = jest.fn();
    const canOpenApp = jest.fn().mockResolvedValue(false);
    const { controller } = makeController({ openUrl, canOpenApp });

    await controller.showQr();
    await flush();

    expect(canOpenApp).toHaveBeenCalledWith('oxycommons://');
    expect(openUrl).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.phase).toBe('waiting');
    expect(controller.getSnapshot().commonsAvailability).toBe('unavailable');
    controller.cancelSignIn();
  });

  it('never probes or opens when canOpenApp is absent (web — unchanged behavior)', async () => {
    const openUrl = jest.fn();
    const { controller } = makeController({ openUrl });

    await controller.showQr();
    await flush();

    expect(openUrl).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.qrPayload).toBe('oxycommons://approve?v=1&code=AUTH-CODE');
    expect(controller.getSnapshot().commonsAvailability).toBe('unknown');
    controller.cancelSignIn();
  });

  it('swallows a canOpenApp probe rejection, keeps the QR fallback, and records unavailable', async () => {
    const openUrl = jest.fn();
    const canOpenApp = jest.fn().mockRejectedValue(new Error('probe boom'));
    const { controller } = makeController({ openUrl, canOpenApp });

    await controller.showQr();
    await flush();

    expect(openUrl).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.phase).toBe('waiting');
    expect(controller.getSnapshot().commonsAvailability).toBe('unavailable');
    controller.cancelSignIn();
  });

  it('start() eagerly resolves commonsAvailability without requiring a QR flow', async () => {
    const canOpenApp = jest.fn().mockResolvedValue(true);
    const { controller } = makeController({ canOpenApp });

    controller.start();
    await flush();

    expect(canOpenApp).toHaveBeenCalledWith('oxycommons://');
    expect(controller.getSnapshot().commonsAvailability).toBe('available');
    controller.destroy();
  });
});

describe('AccountDialogController — /auth-session socket (instant QR wake)', () => {
  type Handler = (...args: unknown[]) => void;
  class FakeAuthSocket implements MinimalSocket {
    connected = false;
    disconnected = false;
    handlers = new Map<string, Handler[]>();
    emitted: Array<{ event: string; args: unknown[] }> = [];
    on(event: string, cb: Handler) { const l = this.handlers.get(event) ?? []; l.push(cb); this.handlers.set(event, l); }
    off(event: string, cb?: Handler) { if (!cb) { this.handlers.delete(event); return; } this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== cb)); }
    emit(event: string, ...args: unknown[]) { this.emitted.push({ event, args }); }
    connect() { this.connected = true; }
    disconnect() { this.connected = false; this.disconnected = true; }
    /** Simulate a server→client push on this socket. */
    server(event: string, payload?: unknown) { for (const h of this.handlers.get(event) ?? []) h(payload); }
  }

  const START_HANDLE = {
    sessionToken: 'secret-tok',
    authorizeCode: 'AUTH-CODE',
    qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
    expiresAt: Date.now() + 600_000,
    status: 'pending' as const,
  };

  function makeSocketHarness(): { controller: AccountDialogController; oxy: OxyMock; created: () => FakeAuthSocket | null; factory: jest.Mock; commitSession: jest.Mock } {
    const oxy = makeOxy();
    oxy.startCommonsSignIn.mockResolvedValue(START_HANDLE);
    let socket: FakeAuthSocket | null = null;
    const factory = jest.fn((_uri: string, _opts?: Record<string, unknown>): MinimalSocket => {
      socket = new FakeAuthSocket();
      socket.connected = true; // real io autoConnect resolves before we inspect
      return socket;
    });
    const commitSession = jest.fn().mockResolvedValue(undefined);
    const controller = new AccountDialogController({
      oxyServices: oxy as unknown as OxyServices,
      sessionClient: new TestSessionClient(host().host),
      clientId: 'oxy_dk_test',
      commitSession,
      socketFactory: factory as unknown as SocketIOFactory,
    });
    return { controller, oxy, created: () => socket, factory, commitSession };
  }

  it('connects to /auth-session, joins the flow room, and wakes the claim on auth_update — no timer advance', async () => {
    const { controller, oxy, created, factory, commitSession } = makeSocketHarness();
    oxy.pollCommonsSignIn.mockResolvedValue({ authorized: true, sessionId: 'sess-1', status: 'authorized' });
    oxy.claimSessionByToken.mockResolvedValue({
      accessToken: 'access-1', sessionId: 'sess-1', deviceId: 'device-1', expiresAt: '2030-01-01T00:00:00Z', user: user('a1'),
    });

    await controller.showQr();

    expect(factory).toHaveBeenCalledWith('http://test.invalid/auth-session', expect.any(Object));
    const sock = created();
    if (!sock) throw new Error('socket not created');
    expect(sock.emitted).toContainEqual({ event: 'join', args: ['secret-tok'] });

    // The server pushes auth_update → immediate status check + claim, without any poll timer firing.
    sock.server('auth_update', { status: 'authorized', sessionId: 'sess-1' });
    await flush();

    expect(oxy.pollCommonsSignIn).toHaveBeenCalledWith('secret-tok');
    expect(oxy.claimSessionByToken).toHaveBeenCalledWith('secret-tok');
    expect(commitSession).toHaveBeenCalled();
    expect(controller.getSnapshot().view).toBe('accounts');
    expect(sock.disconnected).toBe(true); // torn down on completion
  });

  it('re-joins the room on reconnect (connect event) and tears the socket down on cancelSignIn', async () => {
    const { controller, oxy, created } = makeSocketHarness();
    oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });

    await controller.showQr();
    const sock = created();
    if (!sock) throw new Error('socket not created');
    expect(sock.emitted.filter((e) => e.event === 'join')).toHaveLength(1);

    // A reconnect fires `connect` again → the join is re-issued so it survives drops.
    sock.server('connect');
    expect(sock.emitted.filter((e) => e.event === 'join')).toHaveLength(2);

    controller.cancelSignIn();
    expect(sock.disconnected).toBe(true);
  });

  it('a stale auth_update after the flow was cancelled does not re-poll', async () => {
    const { controller, oxy, created } = makeSocketHarness();
    oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });

    await controller.showQr();
    const sock = created();
    if (!sock) throw new Error('socket not created');
    oxy.pollCommonsSignIn.mockClear();

    controller.cancelSignIn();
    // Even if a late auth_update slips through on the (now-detached) socket, the
    // superseded-token guard drops it.
    sock.server('auth_update', { status: 'authorized' });
    await flush();
    expect(oxy.pollCommonsSignIn).not.toHaveBeenCalled();
  });

  it('stops polling when an OAuth-bound session is authorized without a sessionId', async () => {
    const { controller, oxy, created } = makeSocketHarness();
    oxy.pollCommonsSignIn.mockResolvedValue({
      authorized: true,
      purpose: 'oauth_authorization',
      status: 'authorized',
    });

    await controller.showQr();
    const sock = created();
    if (!sock) throw new Error('socket not created');
    sock.server('auth_update', { status: 'authorized' });
    await flush();

    expect(oxy.claimSessionByToken).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.phase).toBe('error');
    expect(controller.getSnapshot().signIn.error).toContain('OAuth sign-in');
  });
});

// ===========================================================================
// Issue #691, Phase 5 — automatic delivery selection + honest progress
// ===========================================================================

type DeliveryPlatform = import('../../utils/commonsDelivery').CommonsDeliveryPlatform;

const DELIVERY_HANDLE = {
  sessionToken: 'secret-tok',
  authorizeCode: 'AUTH-CODE',
  qrPayload: 'oxycommons://approve?v=1&code=AUTH-CODE',
  status: 'pending' as const,
};

function makeDeliveryHarness(opts: {
  platform?: DeliveryPlatform;
  canOpenApp?: jest.Mock;
  openUrl?: jest.Mock;
  /** Default `true` — a planted bearer, the only state that may push. */
  authenticated?: boolean;
  pollIntervalMs?: number;
}): { controller: AccountDialogController; oxy: OxyMock } {
  const oxy = makeOxy();
  oxy.startCommonsSignIn.mockResolvedValue({ ...DELIVERY_HANDLE, expiresAt: Date.now() + 600_000 });
  oxy.pollCommonsSignIn.mockResolvedValue({
    authorized: false,
    status: 'pending',
    pushSentAt: null,
    openedAt: null,
  });
  if (opts.authenticated === false) oxy.emitTokenChange(null);
  const controller = new AccountDialogController({
    oxyServices: oxy as unknown as OxyServices,
    sessionClient: new TestSessionClient(host().host),
    clientId: 'oxy_dk_test',
    // Every real consumer wires the provider's commit funnel; without it the
    // controller falls back to `SessionClient.registerAndActivate`, which opens
    // a BroadcastChannel this harness has no reason to exercise.
    commitSession: jest.fn().mockResolvedValue(undefined),
    pollIntervalMs: opts.pollIntervalMs ?? 1000,
    platform: opts.platform,
    canOpenApp: opts.canOpenApp,
    openUrl: opts.openUrl,
  });
  return { controller, oxy };
}

describe('AccountDialogController — automatic delivery selection (#691 phase 5)', () => {
  it('chooses open-commons on mobile with a verified Commons link, and never pushes as well', async () => {
    const openUrl = jest.fn();
    const { controller, oxy } = makeDeliveryHarness({
      platform: 'mobile',
      canOpenApp: jest.fn().mockResolvedValue(true),
      openUrl,
    });

    await controller.showQr();
    await flush();

    const snap = controller.getSnapshot();
    expect(snap.signIn.route).toBe('open-commons');
    expect(snap.signIn.routeFailed).toBe(false);
    expect(openUrl).toHaveBeenCalledWith('oxycommons://approve?v=1&code=AUTH-CODE');
    // The identity is reachable on THIS device — pushing would light up a second
    // surface for a request the user is about to confirm here.
    expect(oxy.deliverCommonsSignIn).not.toHaveBeenCalled();
    expect(snap.signIn.progress).toBe('awaiting-approval');
    controller.cancelSignIn();
  });

  it('chooses await-push when the server delivered to at least one known Commons installation', async () => {
    const openUrl = jest.fn();
    const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop', openUrl });
    oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: true, targets: 2 });

    await controller.showQr();
    await flush();

    const snap = controller.getSnapshot();
    expect(oxy.deliverCommonsSignIn).toHaveBeenCalledWith('AUTH-CODE');
    expect(snap.signIn.route).toBe('await-push');
    expect(snap.signIn.routeFailed).toBe(false);
    // "Check Commons on your phone" — the server CONFIRMED the dispatch.
    expect(snap.signIn.progress).toBe('delivered-to-commons');
    expect(openUrl).not.toHaveBeenCalled();
    controller.cancelSignIn();
  });

  it('falls through to QR when the delivery reached zero installations — no error surfaced', async () => {
    const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
    oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: false, targets: 0 });

    await controller.showQr();
    await flush();

    const snap = controller.getSnapshot();
    expect(snap.signIn.route).toBe('qr');
    expect(snap.signIn.routeFailed).toBe(false);
    expect(snap.signIn.phase).toBe('waiting');
    expect(snap.signIn.error).toBeNull();
    expect(snap.error).toBeNull();
    expect(snap.signIn.progress).toBe('awaiting-approval');
    controller.cancelSignIn();
  });

  it('falls through to QR when the delivery call FAILS — silently, as a normal outcome', async () => {
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
    oxy.deliverCommonsSignIn.mockRejectedValue(new Error('delivery boom'));

    await controller.showQr();
    await flush();

    const snap = controller.getSnapshot();
    expect(snap.signIn.route).toBe('qr');
    expect(snap.signIn.phase).toBe('waiting');
    expect(snap.signIn.error).toBeNull();
    expect(snap.error).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      '[AccountDialogController] Commons delivery unavailable (QR route)',
      { component: 'AccountDialogController' },
      expect.any(Error),
    );
    controller.cancelSignIn();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('treats a delivered:false response with a non-zero target count as zero targets (fail-safe to QR)', async () => {
    const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
    oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: false, targets: 3 });

    await controller.showQr();
    await flush();

    expect(controller.getSnapshot().signIn.route).toBe('qr');
    controller.cancelSignIn();
  });

  it('NEVER attempts delivery without a bearer — the unauthenticated surface cannot ring a phone', async () => {
    const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop', authenticated: false });

    await controller.showQr();
    await flush();

    expect(oxy.deliverCommonsSignIn).not.toHaveBeenCalled();
    const snap = controller.getSnapshot();
    expect(snap.signIn.route).toBe('qr');
    expect(snap.signIn.error).toBeNull();
    controller.cancelSignIn();
  });

  it('pushes on mobile when no verified Commons link is available on this device', async () => {
    const openUrl = jest.fn();
    const { controller, oxy } = makeDeliveryHarness({
      platform: 'mobile',
      canOpenApp: jest.fn().mockResolvedValue(false),
      openUrl,
    });
    oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: true, targets: 1 });

    await controller.showQr();
    await flush();

    expect(oxy.deliverCommonsSignIn).toHaveBeenCalledWith('AUTH-CODE');
    expect(controller.getSnapshot().signIn.route).toBe('await-push');
    expect(openUrl).not.toHaveBeenCalled();
    controller.cancelSignIn();
  });

  it('never deep-links from an unclassified surface, even with Commons installed', async () => {
    const openUrl = jest.fn();
    const { controller } = makeDeliveryHarness({
      // No `platform` supplied → 'unknown': the controller says so rather than
      // guessing, and an unresolved custom-scheme navigation is a dead end.
      canOpenApp: jest.fn().mockResolvedValue(true),
      openUrl,
    });

    await controller.showQr();
    await flush();

    expect(openUrl).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.route).toBe('qr');
    expect(controller.getSnapshot().commonsAvailability).toBe('available');
    controller.cancelSignIn();
  });

  it('marks the primary route FAILED (never auto-cascades) when the Commons link cannot be opened', async () => {
    // Route chosen: open-commons. No URL opener was injected, so the one action
    // the route implies cannot happen — the UI needs that fact to reveal
    // "Having trouble?"; the controller must not silently switch to another route.
    const { controller } = makeDeliveryHarness({
      platform: 'mobile',
      canOpenApp: jest.fn().mockResolvedValue(true),
    });

    await controller.showQr();
    await flush();

    const snap = controller.getSnapshot();
    expect(snap.signIn.route).toBe('open-commons');
    expect(snap.signIn.routeFailed).toBe(true);
    // Still a live request — the QR beneath it stays valid.
    expect(snap.signIn.phase).toBe('waiting');
    expect(snap.signIn.qrPayload).toBe('oxycommons://approve?v=1&code=AUTH-CODE');
    controller.cancelSignIn();
  });

  it('marks the primary route FAILED when opening the Commons link throws', async () => {
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const openUrl = jest.fn(() => {
      throw new Error('no handler for scheme');
    });
    const { controller } = makeDeliveryHarness({
      platform: 'mobile',
      canOpenApp: jest.fn().mockResolvedValue(true),
      openUrl,
    });

    await controller.showQr();
    await flush();

    expect(controller.getSnapshot().signIn.route).toBe('open-commons');
    expect(controller.getSnapshot().signIn.routeFailed).toBe(true);
    expect(controller.getSnapshot().signIn.error).toBeNull();
    controller.cancelSignIn();
    debugSpy.mockRestore();
  });

  it('reports "preparing" until a route is actually resolved — it is never guessed', async () => {
    let releaseDelivery: () => void = () => undefined;
    const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
    oxy.deliverCommonsSignIn.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDelivery = () => resolve({ delivered: true, targets: 1 });
        }),
    );

    await controller.showQr();
    // The request exists and the QR is renderable, but no route has been chosen.
    expect(controller.getSnapshot().signIn.phase).toBe('waiting');
    expect(controller.getSnapshot().signIn.route).toBeNull();
    expect(controller.getSnapshot().signIn.progress).toBe('preparing');

    releaseDelivery();
    await flush();
    expect(controller.getSnapshot().signIn.route).toBe('await-push');
    expect(controller.getSnapshot().signIn.progress).toBe('delivered-to-commons');
    controller.cancelSignIn();
  });

  it('abandons route resolution when the flow was cancelled while it was in flight', async () => {
    const openUrl = jest.fn();
    let releaseProbe: (installed: boolean) => void = () => undefined;
    const { controller, oxy } = makeDeliveryHarness({
      platform: 'mobile',
      canOpenApp: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseProbe = resolve;
          }),
      ),
      openUrl,
    });

    await controller.showQr();
    controller.cancelSignIn();
    releaseProbe(true);
    await flush();

    expect(openUrl).not.toHaveBeenCalled();
    expect(oxy.deliverCommonsSignIn).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.route).toBeNull();
  });

  it('abandons route resolution when the request was approved while it was in flight', async () => {
    jest.useFakeTimers();
    try {
      const openUrl = jest.fn();
      let releaseProbe: (installed: boolean) => void = () => undefined;
      const { controller, oxy } = makeDeliveryHarness({
        platform: 'mobile',
        canOpenApp: jest.fn(
          () =>
            new Promise<boolean>((resolve) => {
              releaseProbe = resolve;
            }),
        ),
        openUrl,
      });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: true, sessionId: 'sess-1', status: 'authorized' });
      oxy.claimSessionByToken.mockResolvedValue({
        accessToken: 'access-1',
        sessionId: 'sess-1',
        deviceId: 'device-1',
        expiresAt: '2030-01-01T00:00:00Z',
        user: user('a1'),
      });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(1000); // approval lands first
      expect(controller.getSnapshot().signIn.phase).toBe('completed');

      releaseProbe(true);
      await jest.advanceTimersByTimeAsync(0);

      // Opening Commons after the session is already signed in would be a
      // pointless app switch — the resolution must abandon itself.
      expect(openUrl).not.toHaveBeenCalled();
      expect(controller.getSnapshot().signIn.route).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not run automatic delivery for the passkey hub flow (the popup is the primary surface)', async () => {
    const popup = fakePopup();
    const oxy = makeOxy();
    oxy.startCommonsSignIn.mockResolvedValue({ ...DELIVERY_HANDLE, expiresAt: Date.now() + 600_000 });
    oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });
    oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: true, targets: 1 });
    const controller = new AccountDialogController({
      oxyServices: oxy as unknown as OxyServices,
      sessionClient: new TestSessionClient(host().host),
      clientId: 'oxy_dk_test',
      pollIntervalMs: 1000,
      platform: 'desktop',
      openPopup: () => popup,
      hubBaseUrl: 'https://auth.oxy.so',
    });

    await controller.startPasskeyHubSignIn();
    await flush();

    expect(oxy.deliverCommonsSignIn).not.toHaveBeenCalled();
    expect(controller.getSnapshot().signIn.route).toBe('qr');
    controller.cancelSignIn();
  });

  it('never leaks the secret device-flow token into the snapshot', async () => {
    const { controller } = makeDeliveryHarness({ platform: 'desktop' });

    await controller.showQr();
    await flush();

    const snap = controller.getSnapshot();
    expect(JSON.stringify(snap)).not.toContain('secret-tok');
    expect(Object.keys(snap.signIn)).toEqual([
      'phase',
      'authorizeCode',
      'qrPayload',
      'expiresAt',
      'error',
      'route',
      'routeFailed',
      'pushSentAt',
      'openedAt',
      'progress',
    ]);
    // Only the PUBLIC handles are exposed.
    expect(snap.signIn.authorizeCode).toBe('AUTH-CODE');
    controller.cancelSignIn();
  });
});

describe('AccountDialogController — sign-in progress (#691 phase 5)', () => {
  it('advances only on real signals, in order, to "Identity confirmed"', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: true, targets: 1 });
      oxy.pollCommonsSignIn
        // 1st tick: still nothing but the confirmed push.
        .mockResolvedValueOnce({
          authorized: false,
          status: 'pending',
          pushSentAt: '2026-07-27T10:00:00.000Z',
          openedAt: null,
        })
        // 2nd tick: the approver opened the request.
        .mockResolvedValueOnce({
          authorized: false,
          status: 'pending',
          pushSentAt: '2026-07-27T10:00:00.000Z',
          openedAt: '2026-07-27T10:00:12.000Z',
        })
        // 3rd tick: approved.
        .mockResolvedValue({
          authorized: true,
          sessionId: 'sess-1',
          status: 'authorized',
          pushSentAt: '2026-07-27T10:00:00.000Z',
          openedAt: '2026-07-27T10:00:12.000Z',
        });
      let releaseClaim: () => void = () => undefined;
      oxy.claimSessionByToken.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseClaim = () =>
              resolve({
                accessToken: 'access-1',
                sessionId: 'sess-1',
                deviceId: 'device-1',
                expiresAt: '2030-01-01T00:00:00Z',
                user: user('a1'),
              });
          }),
      );

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(0); // let the route resolve
      expect(controller.getSnapshot().signIn.progress).toBe('delivered-to-commons');

      await jest.advanceTimersByTimeAsync(1000);
      expect(controller.getSnapshot().signIn.pushSentAt).toBe('2026-07-27T10:00:00.000Z');
      expect(controller.getSnapshot().signIn.progress).toBe('delivered-to-commons');

      await jest.advanceTimersByTimeAsync(1000);
      expect(controller.getSnapshot().signIn.openedAt).toBe('2026-07-27T10:00:12.000Z');
      expect(controller.getSnapshot().signIn.progress).toBe('opened-in-commons');

      await jest.advanceTimersByTimeAsync(1000);
      // Approved: the claim/commit is running — "Confirming identity".
      expect(controller.getSnapshot().signIn.phase).toBe('authorized');
      expect(controller.getSnapshot().signIn.progress).toBe('confirming-identity');

      releaseClaim();
      await jest.advanceTimersByTimeAsync(0);
      expect(controller.getSnapshot().signIn.phase).toBe('completed');
      expect(controller.getSnapshot().signIn.progress).toBe('identity-confirmed');
      expect(controller.getSnapshot().view).toBe('accounts');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not advance without a signal — repeated empty polls keep it waiting', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: false, targets: 0 });
      oxy.pollCommonsSignIn.mockResolvedValue({
        authorized: false,
        status: 'pending',
        pushSentAt: null,
        openedAt: null,
      });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(0);
      expect(controller.getSnapshot().signIn.progress).toBe('awaiting-approval');

      await jest.advanceTimersByTimeAsync(5000); // five fallback polls
      expect(oxy.pollCommonsSignIn).toHaveBeenCalledTimes(5);
      expect(controller.getSnapshot().signIn.progress).toBe('awaiting-approval');
      expect(controller.getSnapshot().signIn.pushSentAt).toBeNull();
      expect(controller.getSnapshot().signIn.openedAt).toBeNull();

      controller.cancelSignIn();
    } finally {
      jest.useRealTimers();
    }
  });

  it('is monotone — a later, emptier status response never walks progress backwards', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.deliverCommonsSignIn.mockResolvedValue({ delivered: false, targets: 0 });
      oxy.pollCommonsSignIn
        .mockResolvedValueOnce({
          authorized: false,
          status: 'pending',
          pushSentAt: '2026-07-27T10:00:00.000Z',
          openedAt: '2026-07-27T10:00:12.000Z',
        })
        // An older API build (or a partial payload) omits the progress fields.
        .mockResolvedValue({ authorized: false, status: 'pending' });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(1000);
      expect(controller.getSnapshot().signIn.progress).toBe('opened-in-commons');

      await jest.advanceTimersByTimeAsync(2000);
      expect(controller.getSnapshot().signIn.openedAt).toBe('2026-07-27T10:00:12.000Z');
      expect(controller.getSnapshot().signIn.progress).toBe('opened-in-commons');

      controller.cancelSignIn();
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats "opened in Commons" as progress only — it never claims a session', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.pollCommonsSignIn.mockResolvedValue({
        authorized: false,
        status: 'pending',
        pushSentAt: '2026-07-27T10:00:00.000Z',
        openedAt: '2026-07-27T10:00:12.000Z',
      });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(3000);

      expect(controller.getSnapshot().signIn.progress).toBe('opened-in-commons');
      expect(oxy.claimSessionByToken).not.toHaveBeenCalled();
      expect(controller.getSnapshot().signIn.phase).toBe('waiting');

      controller.cancelSignIn();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AccountDialogController — cancellation converges (#691 phase 5)', () => {
  it('a denial in Commons converges on the waiting surface and stops the flow', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'cancelled' });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(1000);

      const snap = controller.getSnapshot();
      expect(snap.signIn.phase).toBe('error');
      expect(snap.signIn.error).toMatch(/denied/i);
      expect(snap.signIn.progress).toBe('idle');

      await jest.advanceTimersByTimeAsync(10_000);
      expect(oxy.pollCommonsSignIn).toHaveBeenCalledTimes(1);
      expect(oxy.claimSessionByToken).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a server-reported expiry converges and stops the flow', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'expired' });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(1000);

      expect(controller.getSnapshot().signIn.phase).toBe('error');
      expect(controller.getSnapshot().signIn.error).toMatch(/expired/i);

      await jest.advanceTimersByTimeAsync(10_000);
      expect(oxy.pollCommonsSignIn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a locally-observed expiry converges without even asking the server', async () => {
    jest.useFakeTimers();
    try {
      const oxy = makeOxy();
      oxy.startCommonsSignIn.mockResolvedValue({
        ...DELIVERY_HANDLE,
        expiresAt: Date.now() + 500, // expires before the first fallback poll
      });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });
      const controller = new AccountDialogController({
        oxyServices: oxy as unknown as OxyServices,
        sessionClient: new TestSessionClient(host().host),
        clientId: 'oxy_dk_test',
        pollIntervalMs: 1000,
        platform: 'desktop',
      });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(1000);

      expect(oxy.pollCommonsSignIn).not.toHaveBeenCalled();
      expect(controller.getSnapshot().signIn.phase).toBe('error');
      expect(controller.getSnapshot().signIn.error).toMatch(/expired/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closing the surface withdraws the request server-side and stops every timer', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(0);
      expect(controller.getSnapshot().signIn.phase).toBe('waiting');

      controller.cancelSignIn();

      expect(oxy.denyCommonsSignIn).toHaveBeenCalledWith('AUTH-CODE');
      expect(controller.getSnapshot().signIn).toEqual({
        phase: 'idle',
        authorizeCode: null,
        qrPayload: null,
        expiresAt: null,
        error: null,
        route: null,
        routeFailed: false,
        pushSentAt: null,
        openedAt: null,
        progress: 'idle',
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(oxy.pollCommonsSignIn).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not withdraw a request that already reached a terminal state', async () => {
    jest.useFakeTimers();
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'cancelled' });

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(1000);
      expect(controller.getSnapshot().signIn.phase).toBe('error');

      controller.cancelSignIn();
      // Commons already cancelled it — nothing left to withdraw.
      expect(oxy.denyCommonsSignIn).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('swallows a failed withdrawal (an approval may have raced it) without surfacing an error', async () => {
    jest.useFakeTimers();
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      const { controller, oxy } = makeDeliveryHarness({ platform: 'desktop' });
      oxy.denyCommonsSignIn.mockRejectedValue(new Error('already authorized'));

      await controller.showQr();
      await jest.advanceTimersByTimeAsync(0);
      controller.cancelSignIn();
      await jest.advanceTimersByTimeAsync(0);

      expect(controller.getSnapshot().signIn.phase).toBe('idle');
      expect(controller.getSnapshot().error).toBeNull();
      expect(debugSpy).toHaveBeenCalledWith(
        '[AccountDialogController] request withdrawal failed',
        { component: 'AccountDialogController' },
        expect.any(Error),
      );
    } finally {
      jest.useRealTimers();
      debugSpy.mockRestore();
    }
  });

  it('destroy tears down the poll timer, the auth-session socket, and the popup watcher', async () => {
    jest.useFakeTimers();
    try {
      const popup = fakePopup();
      const oxy = makeOxy();
      oxy.startCommonsSignIn.mockResolvedValue({ ...DELIVERY_HANDLE, expiresAt: Date.now() + 600_000 });
      oxy.pollCommonsSignIn.mockResolvedValue({ authorized: false, status: 'pending' });
      let socket: { disconnected: boolean } | null = null;
      const factory = jest.fn((): MinimalSocket => {
        const s: MinimalSocket & { disconnected: boolean } = {
          connected: true,
          disconnected: false,
          on: () => undefined,
          off: () => undefined,
          emit: () => undefined,
          connect: () => undefined,
          disconnect() {
            this.disconnected = true;
          },
        };
        socket = s;
        return s;
      });
      const controller = new AccountDialogController({
        oxyServices: oxy as unknown as OxyServices,
        sessionClient: new TestSessionClient(host().host),
        clientId: 'oxy_dk_test',
        pollIntervalMs: 1000,
        platform: 'desktop',
        openPopup: () => popup,
        socketFactory: factory as unknown as SocketIOFactory,
      });

      await controller.startPasskeyHubSignIn();
      await jest.advanceTimersByTimeAsync(0);
      expect(controller.getSnapshot().signIn.phase).toBe('waiting');

      controller.destroy();

      expect(socket).not.toBeNull();
      expect(socket?.disconnected).toBe(true);
      expect(popup.close).toHaveBeenCalled();
      // No poll timer and no popup watchdog survive the teardown.
      await jest.advanceTimersByTimeAsync(30_000);
      expect(oxy.pollCommonsSignIn).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AccountDialogController — lifecycle', () => {
  it('destroy unsubscribes so later device-state changes do not notify', async () => {
    const { controller, oxy, sc } = makeHarness();
    oxy.getUsersByIds.mockResolvedValue([user('a1')]);
    controller.start();
    await Promise.resolve();
    const seen: string[] = [];
    controller.subscribe((s) => seen.push(s.view));
    controller.destroy();
    // destroy clears all listeners; a subsequent state push notifies nobody.
    sc.set(state([{ accountId: 'a1', sessionId: 's1' }], 'a1'));
    expect(seen).toEqual([]);
  });
});

describe('AccountDialogController — the directory (ADR 0002)', () => {
  /** A two-principal device where `org` is reachable through BOTH people. */
  const sharedDirectory = (revision: number, activeContextId: string | null) => ({
    deviceId: 'device-1',
    revision,
    activeContextId,
    updatedAt: 1_720_000_000_000,
    principals: [
      {
        id: 'p-nate',
        userId: 'nate',
        authuser: 0,
        user: { id: 'nate', username: 'nate' },
        contexts: [
          {
            id: 'ctx-nate-org',
            accountId: 'org',
            kind: 'organization' as const,
            relationship: 'owner' as const,
            account: { id: 'org', username: 'oxy' },
            onDevice: true,
            available: true,
            active: activeContextId === 'ctx-nate-org',
            lastUsedAt: null,
          },
        ],
      },
      {
        id: 'p-alice',
        userId: 'alice',
        authuser: 1,
        user: { id: 'alice', username: 'alice' },
        contexts: [
          {
            id: 'ctx-alice-org',
            accountId: 'org',
            kind: 'organization' as const,
            relationship: 'member' as const,
            account: { id: 'org', username: 'oxy' },
            onDevice: true,
            available: true,
            active: activeContextId === 'ctx-alice-org',
            lastUsedAt: null,
          },
        ],
      },
    ],
  });

  function directoryHarness(activeContextId: string | null) {
    const oxy = makeOxy();
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const sc = new TestSessionClient({
      makeRequest: jest.fn(async (_method: string, url: string, data?: unknown) => {
        urls.push(url);
        bodies.push(data);
        if (url === '/session/device/directory') return sharedDirectory(5, activeContextId);
        if (url === '/session/device/activate') {
          return { directory: sharedDirectory(6, 'ctx-alice-org'), activeToken: null };
        }
        if (url === '/session/device/signout') {
          // The context-aware removals answer with their OWN contract — the
          // directory AND the flat state, because a removal elects a
          // replacement active context and both halves move together.
          return {
            directory: sharedDirectory(7, null),
            state: state([{ accountId: 'org', sessionId: 's-org' }], 'org', 7),
            activeToken: null,
          };
        }
        return undefined;
      }),
      getBaseURL: () => 'http://test.invalid',
      getAccessToken: () => 'token',
      getDeviceCredential: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: jest.fn(),
      getCurrentAccountId: () => null,
    });
    const controller = createAccountDialogController({
      oxyServices: oxy as unknown as OxyServices,
      sessionClient: sc,
      clientId: 'oxy_dk_test',
      commitSession: jest.fn().mockResolvedValue(undefined),
      onSignedIn: jest.fn(),
    });
    return { controller, oxy, sc, urls, bodies };
  }

  it('publishes the directory and the active context on the snapshot', async () => {
    const { controller, oxy } = directoryHarness('ctx-alice-org');
    oxy.listAccounts.mockResolvedValue([]);
    oxy.getUsersByIds.mockResolvedValue([]);

    await controller.refresh();

    const snap = controller.getSnapshot();
    expect(snap.directory?.revision).toBe(5);
    // The flat `accounts` list cannot express this: it is keyed by account id,
    // so ONE of these two routes to `org` would be all a consumer ever saw.
    expect(snap.directory?.principals.map((p) => p.userId)).toEqual(['nate', 'alice']);
    expect(snap.activeContext?.contextId).toBe('ctx-alice-org');
    expect(snap.activeContext?.actor.userId).toBe('alice');
    expect(snap.activeContext?.subject.accountId).toBe('org');
    expect(snap.activeContext?.isDelegated).toBe(true);
  });

  it('activateContext POSTs the contextId and reports the switch in flight', async () => {
    const { controller, oxy, urls, bodies } = directoryHarness('ctx-nate-org');
    oxy.listAccounts.mockResolvedValue([]);
    oxy.getUsersByIds.mockResolvedValue([]);
    await controller.refresh();

    const inFlight: Array<string | null> = [];
    controller.subscribe((s) => inFlight.push(s.activatingContextId));

    expect(await controller.activateContext('ctx-alice-org')).toBe(true);

    expect(urls).toContain('/session/device/activate');
    expect(bodies[urls.indexOf('/session/device/activate')]).toEqual({ contextId: 'ctx-alice-org' });
    // Reported while running, cleared after — a row can show a spinner.
    expect(inFlight).toContain('ctx-alice-org');
    expect(controller.getSnapshot().activatingContextId).toBeNull();
    expect(controller.getSnapshot().activeContext?.actor.userId).toBe('alice');
  });

  it('refuses a second activation while one is in flight', async () => {
    const { controller, oxy } = directoryHarness('ctx-nate-org');
    oxy.listAccounts.mockResolvedValue([]);
    oxy.getUsersByIds.mockResolvedValue([]);
    await controller.refresh();

    const first = controller.activateContext('ctx-alice-org');
    expect(await controller.activateContext('ctx-nate-org')).toBe(false);
    expect(await first).toBe(true);
  });

  it('surfaces an activation failure as a dialog error without wedging the flag', async () => {
    const { controller, oxy, sc } = directoryHarness('ctx-nate-org');
    oxy.listAccounts.mockResolvedValue([]);
    oxy.getUsersByIds.mockResolvedValue([]);
    await controller.refresh();
    // A stale context id is an ordinary outcome, not a bug: the server 404s and
    // heals the row away.
    jest.spyOn(sc, 'activateContext').mockRejectedValue(new Error('Context not on this device'));

    expect(await controller.activateContext('ctx-gone')).toBe(false);

    expect(controller.getSnapshot().error).toBe('Context not on this device');
    expect(controller.getSnapshot().activatingContextId).toBeNull();
  });

  it('keeps the directory it already holds when a later read fails, and says so', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { controller, failDirectory } = makeHarness();

    await controller.refresh();
    expect(controller.getSnapshot().directory?.revision).toBe(9_000);

    failDirectory(new Error('boom'));
    await controller.refresh();

    // Degraded, not blank. A transient outage must not empty a switcher the
    // user is looking at — but it must not pretend either, so the error is on
    // the snapshot for the surface to render.
    const snap = controller.getSnapshot();
    expect(snap.directory?.revision).toBe(9_000);
    expect(snap.error).toBe('boom');
    expect(snap.loading).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[AccountDialogController] directory refresh failed',
      { component: 'AccountDialogController' },
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('spins only while there is nothing to show', async () => {
    const { controller } = makeHarness();
    const loading: boolean[] = [];
    controller.subscribe((s) => loading.push(s.loading));

    // First read: nothing held, so the switcher has nothing to render.
    await controller.refresh();
    expect(loading).toContain(true);
    expect(controller.getSnapshot().loading).toBe(false);

    // Second read, behind a directory already on screen: refreshed in place,
    // never blanked back to a spinner.
    loading.length = 0;
    await controller.refresh();
    expect(loading).not.toContain(true);
  });

  it('removes ONE route to a shared account, naming the pair and not the account', async () => {
    const { controller, urls, bodies } = directoryHarness('ctx-nate-org');
    await controller.refresh();

    const inFlight: Array<string | null> = [];
    controller.subscribe((s) => inFlight.push(s.removingContextId));

    expect(await controller.signOutContext('ctx-alice-org')).toBe(true);

    const index = urls.indexOf('/session/device/signout');
    expect(index).toBeGreaterThanOrEqual(0);
    // `{ contextId }`, never `{ accountId }`. Both people reach `org` here, and
    // an account id would revoke Nate's route as a side effect of Alice tidying
    // her own list.
    expect(bodies[index]).toEqual({ contextId: 'ctx-alice-org' });
    expect(inFlight).toContain('ctx-alice-org');
    expect(controller.getSnapshot().removingContextId).toBeNull();
  });

  it('removes ONE PERSON through the principal id, not through their contexts', async () => {
    const { controller, urls, bodies } = directoryHarness('ctx-nate-org');
    await controller.refresh();

    const inFlight: Array<string | null> = [];
    controller.subscribe((s) => inFlight.push(s.removingPrincipalId));

    expect(await controller.signOutPrincipal('p-alice')).toBe(true);

    const index = urls.indexOf('/session/device/signout');
    // `{ principalId }` — one call, not a loop over that person's contexts, and
    // emphatically not the context endpoint: pointing this at `{ contextId }`
    // would drop one pair and leave the person on the device.
    expect(bodies[index]).toEqual({ principalId: 'p-alice' });
    expect(urls.filter((u) => u === '/session/device/signout')).toHaveLength(1);
    expect(inFlight).toContain('p-alice');
    expect(controller.getSnapshot().removingPrincipalId).toBeNull();
  });

  it('refuses a second removal while one is in flight, of either kind', async () => {
    const { controller, sc } = directoryHarness('ctx-nate-org');
    await controller.refresh();
    let release: () => void = () => undefined;
    jest.spyOn(sc, 'signOutContext').mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const principalSpy = jest.spyOn(sc, 'signOutPrincipal').mockResolvedValue(undefined);

    const first = controller.signOutContext('ctx-alice-org');
    // The two removals share one gate: they mutate the same device and a
    // concurrent pair would race for which replacement context ends up active.
    expect(await controller.signOutPrincipal('p-alice')).toBe(false);
    expect(principalSpy).not.toHaveBeenCalled();

    release();
    expect(await first).toBe(true);
  });

  it('surfaces a failed removal without wedging the flag', async () => {
    const { controller, sc } = directoryHarness('ctx-nate-org');
    await controller.refresh();
    // A context id is not stable across a removal, so a stale one is ordinary:
    // the server refuses and the next read simply does not offer it.
    jest.spyOn(sc, 'signOutContext').mockRejectedValue(new Error('Context not on this device'));

    expect(await controller.signOutContext('ctx-gone')).toBe(false);

    expect(controller.getSnapshot().error).toBe('Context not on this device');
    expect(controller.getSnapshot().removingContextId).toBeNull();
  });

  it('makes no directory call while signed out', async () => {
    const { controller, oxy, urls } = directoryHarness(null);
    oxy.getAccessToken.mockReturnValue(null);
    oxy.listAccounts.mockResolvedValue([]);

    await controller.refresh();

    expect(urls).not.toContain('/session/device/directory');
    expect(controller.getSnapshot().directory).toBeNull();
  });
});

it('createAccountDialogController returns an AccountDialogController instance', () => {
  const { controller } = makeHarness();
  expect(controller).toBeInstanceOf(AccountDialogController);
});

// Ensure the exported type surface is reachable at compile time for binders.
const _typecheck: MinimalUserData | null = null;
void _typecheck;
