/**
 * `OxyAuthChooser` — the account switcher + sign-in/sign-up chooser
 * (extracted from `OxyAccountDialog`, no Dialog chrome).
 *
 * These tests isolate the RN binding over the headless `AccountDialogController`
 * (mocked): the chooser renders the correct view from `snapshot.view`, taps a row
 * through `controller.switchTo`, and auto-starts "Sign in with Oxy" on web when
 * the sign-in entry is reached. The controller's own state machine + projection
 * are unit-tested in `@oxyhq/core`.
 *
 * ONE PRIMARY ACTION (issue #691, Phase 5). The normal surface never presents a
 * menu of authentication methods:
 *  - the sign-in entry renders exactly one primary CTA, "Continue with Oxy";
 *  - the active request renders the route-appropriate primary surface (the QR
 *    plate, or a glyph for a route that lives on the phone) plus a status line
 *    derived ONLY from `snapshot.signIn.progress` — never a timed sequence;
 *  - every alternative (a QR from another device, a passkey on this device,
 *    getting Commons) stays behind "Having trouble?" until the user asks or
 *    `signIn.routeFailed` says the chosen route could not be carried out.
 *
 * Error-surfacing contract (owner mandate: NO error renders inline inside the
 * dialog): every failure — account-switch, passkey sign-in ceremony, passkey
 * account creation, username-availability check — fires a Bloom `toast.error(...)`
 * at the point of failure and paints NO inline banner/text.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { toast } from '@oxyhq/bloom';
import type {
  AccountDialogSnapshot,
  SignInFlowState,
  SwitchableAccount,
  User,
} from '@oxyhq/core';

const makeUser = (id: string): User => ({ id, username: id, name: { displayName: id } } as unknown as User);

const makeAccount = (
  over: Partial<SwitchableAccount> & Pick<SwitchableAccount, 'accountId' | 'displayName'>,
): SwitchableAccount => ({
  isCurrent: false,
  onDevice: true,
  email: null,
  color: null,
  user: makeUser(over.accountId),
  ...over,
});

const IDLE_SIGN_IN: SignInFlowState = {
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
};

const makeSnapshot = (over?: Partial<AccountDialogSnapshot>): AccountDialogSnapshot => ({
  view: 'accounts',
  accounts: [],
  activeAccountId: null,
  loading: false,
  error: null,
  switchingAccountId: null,
  signIn: IDLE_SIGN_IN,
  commonsAvailability: 'unknown',
  ...over,
});

/** An active request on the `qr` view, with a live device-flow session. */
const requestSnapshot = (
  signIn: Partial<SignInFlowState>,
  over?: Partial<AccountDialogSnapshot>,
): AccountDialogSnapshot =>
  makeSnapshot({
    view: 'qr',
    signIn: {
      ...IDLE_SIGN_IN,
      phase: 'waiting',
      authorizeCode: 'CODE',
      qrPayload: 'oxycommons://approve?code=CODE',
      expiresAt: Date.now() + 60_000,
      progress: 'awaiting-approval',
      ...signIn,
    },
    ...over,
  });

/** Every button currently on screen, in DOM order, by its visible label. */
const buttonLabels = (): (string | null)[] =>
  screen.getAllByRole('button').map((button) => button.textContent);

let snapshot = makeSnapshot();
const controller = {
  subscribe: jest.fn((_l: () => void) => () => undefined),
  getSnapshot: () => snapshot,
  switchTo: jest.fn(async () => undefined),
  add: jest.fn(),
  startSignup: jest.fn(),
  showQr: jest.fn(),
  signInWithOxy: jest.fn(),
  startPasskeyHubSignIn: jest.fn(),
  setView: jest.fn(),
  cancelSignIn: jest.fn(),
};

const signInWithPasskey = jest.fn(async () => undefined);
const registerWithPasskey = jest.fn(async () => undefined);
const openAvatarPicker = jest.fn();
const closeAccountDialog = jest.fn();
const showBottomSheet = jest.fn();
const logout = jest.fn(async () => undefined);
const invalidateQueries = jest.fn();
const checkUsernameAvailability = jest.fn(async () => ({ available: true, message: '' }));

/** `null` reproduces `sessionMode: 'identity'`, where no controller is built. */
let mockController: typeof controller | null = controller;

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    accountDialogController: mockController,
    isAccountDialogOpen: true,
    closeAccountDialog,
    showBottomSheet,
    logout,
    logoutAll: jest.fn(async () => undefined),
    refreshAccounts: jest.fn(async () => undefined),
    signInWithPasskey,
    registerWithPasskey,
    openAvatarPicker,
    oxyServices: { checkUsernameAvailability },
  }),
}));

// The account menu wires `useAccountStorageUsage()` (a `useQuery` wrapper) for
// its storage block — stub the query so the hook is inert in these RN-binding
// tests (the storage block then renders its "unavailable" placeholder).
jest.mock('../../src/ui/hooks/queries/useServicesQueries', () => ({
  __esModule: true,
  useAccountStorageUsage: () => ({ data: undefined, isLoading: false, isFetching: false }),
}));

// Resolve REAL copy from the shipped dictionaries rather than stubbing `t` to a
// blank string: every view renders `t(key)` with no inline English fallback, so
// a key that is missing (or renamed) surfaces here as its raw dotted path and
// fails the assertions below.
jest.mock('../../src/ui/hooks/useI18n', () => {
  const { translate } = jest.requireActual('@oxyhq/core');
  return {
    __esModule: true,
    useI18n: () => ({
      t: (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars),
      locale: 'en-US',
    }),
  };
});

jest.mock('@tanstack/react-query', () => ({
  __esModule: true,
  useQueryClient: () => ({ invalidateQueries }),
}));

jest.mock('react-native-qrcode-svg', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) =>
    require('react').createElement('span', { 'data-testid': 'qrcode' }, value),
}));

jest.mock('@expo/vector-icons/Ionicons', () => ({ __esModule: true, default: () => null }));
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  __esModule: true,
  default: () => null,
}));

// The two environment gate probes, toggled per test.
const isWebBrowserMock = jest.fn(() => true);
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => isWebBrowserMock(),
}));

const isOxyRpOriginMock = jest.fn(() => true);
jest.mock('@oxyhq/core', () => {
  const actual = jest.requireActual('@oxyhq/core');
  return { __esModule: true, ...actual, isOxyRpOrigin: () => isOxyRpOriginMock() };
});

// eslint-disable-next-line import/first
import OxyAuthChooser from '../../src/ui/components/OxyAuthChooser';
// eslint-disable-next-line import/first
import { registerAccountDialogConsumerHooks } from '../../src/ui/navigation/accountDialogManager';

describe('OxyAuthChooser', () => {
  afterEach(() => {
    registerAccountDialogConsumerHooks(null);
  });
  beforeEach(() => {
    snapshot = makeSnapshot();
    mockController = controller;
    jest.clearAllMocks();
    isWebBrowserMock.mockReturnValue(true);
    isOxyRpOriginMock.mockReturnValue(true);
  });

  it('renders NOTHING without a controller (sessionMode: "identity" has no account dialog)', () => {
    mockController = null;
    snapshot = makeSnapshot({ view: 'signin' });

    const { container } = render(<OxyAuthChooser />);

    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('continue-with-oxy')).toBeNull();
  });

  it('leads with the hero and collapses the switch list behind the "Switch account" row', () => {
    snapshot = makeSnapshot({
      activeAccountId: 'a',
      accounts: [
        makeAccount({ accountId: 'a', displayName: 'Alice', isCurrent: true, sessionId: 's-a' }),
        makeAccount({ accountId: 'b', displayName: 'Bob', sessionId: 's-b' }),
      ],
    });

    render(<OxyAuthChooser />);

    // The HERO leads: a greeting for the current account + the manage pill,
    // outside any card. Below it a "Switch account" row toggles the list, which
    // stays MOUNTED behind it (so it can animate open and closed) and repeats
    // the CURRENT account — it is no longer a row of its own anywhere else.
    expect(screen.getByText('Hi, Alice!')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage your Oxy account' })).toBeTruthy();
    const row = screen.getByRole('button', { name: 'Switch account' });
    expect(row.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(row);

    expect(
      screen.getByRole('button', { name: 'Switch account' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getByText('Add another account')).toBeTruthy();
    expect(screen.getByText('Manage accounts on this device')).toBeTruthy();
  });

  it('routes manage and add-account to registered consumer hooks', () => {
    const onNavigateManage = jest.fn();
    const onAddAccount = jest.fn();
    registerAccountDialogConsumerHooks({ onNavigateManage, onAddAccount });

    snapshot = makeSnapshot({
      activeAccountId: 'a',
      accounts: [
        makeAccount({ accountId: 'a', displayName: 'Alice', isCurrent: true, sessionId: 's-a' }),
        makeAccount({ accountId: 'b', displayName: 'Bob', sessionId: 's-b' }),
      ],
    });

    render(<OxyAuthChooser />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage your Oxy account' }));
    expect(onNavigateManage).toHaveBeenCalledTimes(1);
    expect(showBottomSheet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    fireEvent.click(screen.getByText('Add another account'));
    expect(onAddAccount).toHaveBeenCalledTimes(1);
    expect(controller.add).not.toHaveBeenCalled();
  });

  it('toasts a failed account switch instead of rendering an inline banner', async () => {
    snapshot = makeSnapshot({
      activeAccountId: 'a',
      accounts: [
        makeAccount({ accountId: 'a', displayName: 'Alice', isCurrent: true, sessionId: 's-a' }),
        makeAccount({ accountId: 'b', displayName: 'Bob', sessionId: 's-b' }),
      ],
    });
    // `switchTo` never throws — it records the failure on the controller's
    // snapshot, which the chooser reads back at the point the switch settles.
    controller.switchTo.mockImplementationOnce(async () => {
      snapshot = makeSnapshot({ ...snapshot, error: 'Account switch did not return a valid session' });
    });

    render(<OxyAuthChooser />);
    // Expand the switcher first — the account rows are collapsed by default.
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'There was a problem switching accounts. Please try again.',
      ),
    );
    // The failure is a toast — never inline text (neither the friendly copy nor
    // the raw controller error string is painted in the dialog body), and the
    // success side effects never run.
    expect(screen.queryByText('There was a problem switching accounts. Please try again.')).toBeNull();
    expect(screen.queryByText('Account switch did not return a valid session')).toBeNull();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not render an inline error banner in the accounts or sign-in views (errors go to toasts)', () => {
    isWebBrowserMock.mockReturnValue(false); // stay on signin, no auto-start to qr
    snapshot = makeSnapshot({ view: 'signin', error: 'Something went wrong.' });

    render(<OxyAuthChooser />);

    // A `snapshot.error` no longer paints an inline banner anywhere — the
    // account-switch failure it represents is surfaced as a toast at the call site.
    expect(screen.queryByText('Something went wrong.')).toBeNull();
  });

  it('switches through controller.switchTo when a non-active row is tapped', async () => {
    snapshot = makeSnapshot({
      activeAccountId: 'a',
      accounts: [
        makeAccount({ accountId: 'a', displayName: 'Alice', isCurrent: true, sessionId: 's-a' }),
        makeAccount({ accountId: 'b', displayName: 'Bob', sessionId: 's-b' }),
      ],
    });

    render(<OxyAuthChooser />);
    // Expand the switcher first — the account rows are collapsed by default.
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));

    await waitFor(() => expect(controller.switchTo).toHaveBeenCalledWith('b'));
    expect(invalidateQueries).toHaveBeenCalled();
    // A successful switch fires no error toast.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('auto-starts the device flow on web the instant the sign-in entry is reached — no click needed', () => {
    snapshot = makeSnapshot({ view: 'signin' });

    render(<OxyAuthChooser />);

    expect(controller.signInWithOxy).toHaveBeenCalledTimes(1);
  });

  it('does not re-trigger the auto-start once a flow is already in flight', () => {
    snapshot = makeSnapshot({
      view: 'signin',
      signIn: { ...IDLE_SIGN_IN, phase: 'waiting', authorizeCode: 'C', qrPayload: 'oxycommons://approve?code=C' },
    });

    render(<OxyAuthChooser />);

    expect(controller.signInWithOxy).not.toHaveBeenCalled();
  });

  describe('sign-in entry — one primary action', () => {
    beforeEach(() => {
      // Native: the entry stays button-driven (web auto-starts straight past it).
      isWebBrowserMock.mockReturnValue(false);
      isOxyRpOriginMock.mockReturnValue(false);
      snapshot = makeSnapshot({ view: 'signin' });
    });

    it('renders exactly ONE primary action and no competing method buttons', () => {
      render(<OxyAuthChooser />);

      // The full inventory: the one primary CTA, the subordinate account-creation
      // link, and the disclosure trigger. Nothing else — no "Scan QR", no
      // "Use a passkey", no "Get Commons" as co-equal buttons.
      expect(buttonLabels()).toEqual([
        'Continue with Oxy',
        'New to Oxy? Create one',
        'Having trouble?',
      ]);
      expect(screen.queryByTestId('scan-qr-link')).toBeNull();
      expect(screen.queryByTestId('passkey-signin-link')).toBeNull();
      expect(screen.queryByTestId('get-commons-link')).toBeNull();
    });

    it('starts the flow — and lets Oxy pick the route — from that one action', () => {
      render(<OxyAuthChooser />);
      expect(controller.signInWithOxy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('continue-with-oxy'));

      expect(controller.signInWithOxy).toHaveBeenCalledTimes(1);
      // The chooser never picks a route itself.
      expect(controller.showQr).not.toHaveBeenCalled();
    });

    it('reveals the alternatives only after "Having trouble?" is opened', () => {
      render(<OxyAuthChooser />);

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));

      expect(screen.getByTestId('scan-qr-link')).toBeTruthy();
      expect(screen.getByTestId('get-commons-link')).toBeTruthy();
      fireEvent.click(screen.getByTestId('scan-qr-link'));
      expect(controller.showQr).toHaveBeenCalledTimes(1);
    });

    it('offers the passkey fallback in that disclosure on web, and never before it', () => {
      isWebBrowserMock.mockReturnValue(true);
      isOxyRpOriginMock.mockReturnValue(true);
      // Web auto-start is gated on an idle flow — a live one keeps the entry up.
      snapshot = makeSnapshot({
        view: 'signin',
        signIn: { ...IDLE_SIGN_IN, phase: 'waiting', authorizeCode: 'C' },
      });
      render(<OxyAuthChooser />);

      expect(screen.queryByTestId('passkey-signin-link')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('passkey-signin-link'));

      expect(signInWithPasskey).toHaveBeenCalledTimes(1);
    });
  });

  describe('active request — one surface per route', () => {
    it('shows "Preparing request" while the route is still being resolved — never a guessed QR', () => {
      snapshot = requestSnapshot({ route: null, progress: 'preparing', phase: 'starting' });
      render(<OxyAuthChooser />);

      expect(screen.getByTestId('signin-progress').textContent).toBe('Preparing request');
      // The payload exists, but presenting it before Oxy chose the route would be
      // guessing — and would flash-then-replace once the real route lands.
      expect(screen.queryByTestId('qrcode')).toBeNull();
    });

    it('renders the QR plate for the qr route', () => {
      snapshot = requestSnapshot({ route: 'qr' });
      render(<OxyAuthChooser />);

      expect(screen.getByTestId('qrcode')).toBeTruthy();
      expect(screen.getByTestId('signin-progress').textContent).toBe(
        'Scan with Commons on your phone',
      );
    });

    it('renders the delivered-to-Commons surface for the await-push route — no QR', () => {
      snapshot = requestSnapshot({ route: 'await-push', progress: 'delivered-to-commons' });
      render(<OxyAuthChooser />);

      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe(
        'Check Commons on your phone',
      );
    });

    it('renders the hand-off surface for the open-commons route — no QR', () => {
      snapshot = requestSnapshot({ route: 'open-commons' });
      render(<OxyAuthChooser />);

      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe('Continue in Commons');
    });

    it('replaces the route surface with the confirmation ladder once the request is authorized', () => {
      snapshot = requestSnapshot({
        route: 'qr',
        phase: 'authorized',
        progress: 'confirming-identity',
      });
      render(<OxyAuthChooser />);

      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe('Confirming identity');
    });

    it('shows the terminal "Identity confirmed" frame', () => {
      snapshot = requestSnapshot({ phase: 'completed', progress: 'identity-confirmed' });
      render(<OxyAuthChooser />);

      expect(screen.getByTestId('signin-progress').textContent).toBe('Identity confirmed');
    });

    it('keeps the alternatives hidden while the chosen route is working', () => {
      snapshot = requestSnapshot({ route: 'qr' });
      render(<OxyAuthChooser />);

      expect(buttonLabels()).toEqual(['New to Oxy? Create one', 'Having trouble?']);
      expect(screen.queryByTestId('passkey-signin-link')).toBeNull();
      expect(screen.queryByTestId('get-commons-link')).toBeNull();
    });

    it('advances the progress line ONLY with the snapshot — never on a timer', () => {
      jest.useFakeTimers();
      try {
        let notify: (() => void) | null = null;
        controller.subscribe.mockImplementationOnce((listener: () => void) => {
          notify = listener;
          return () => undefined;
        });
        snapshot = requestSnapshot({ route: 'await-push', progress: 'delivered-to-commons' });
        render(<OxyAuthChooser />);
        expect(screen.getByTestId('signin-progress').textContent).toBe(
          'Check Commons on your phone',
        );

        // A full minute of wall clock with no new fact changes nothing.
        act(() => {
          jest.advanceTimersByTime(60_000);
        });
        expect(screen.getByTestId('signin-progress').textContent).toBe(
          'Check Commons on your phone',
        );

        // A real signal (the approver reported `openedAt`) is what moves it.
        snapshot = requestSnapshot({
          route: 'await-push',
          openedAt: '2026-07-27T10:00:00.000Z',
          pushSentAt: '2026-07-27T09:59:00.000Z',
          progress: 'opened-in-commons',
        });
        act(() => notify?.());
        expect(screen.getByTestId('signin-progress').textContent).toBe('Opened in Commons');
      } finally {
        jest.useRealTimers();
      }
    });

    it('reveals the fallback affordance without a tap when the chosen route failed', () => {
      snapshot = requestSnapshot({ route: 'open-commons', routeFailed: true });
      render(<OxyAuthChooser />);

      // No "Having trouble?" gate any more — the alternatives ARE the content.
      expect(screen.queryByRole('button', { name: 'Having trouble?' })).toBeNull();
      expect(screen.getByTestId('scan-qr-link')).toBeTruthy();
      expect(screen.getByTestId('passkey-signin-link')).toBeTruthy();
      expect(screen.getByTestId('get-commons-link')).toBeTruthy();
    });

    it('keeps the passkey path reachable after disclosure, on a first-party Oxy origin', async () => {
      snapshot = requestSnapshot({ route: 'qr' });
      render(<OxyAuthChooser />);

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('passkey-signin-link'));

      await waitFor(() => expect(signInWithPasskey).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(closeAccountDialog).not.toHaveBeenCalled()); // onComplete is not wired without a host
    });

    it('routes the disclosed passkey link through the auth.oxy.so hub on a non-Oxy origin', () => {
      isOxyRpOriginMock.mockReturnValue(false);
      snapshot = requestSnapshot({ route: 'qr' });
      render(<OxyAuthChooser />);

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('passkey-signin-link'));

      expect(controller.startPasskeyHubSignIn).toHaveBeenCalledTimes(1);
      expect(signInWithPasskey).not.toHaveBeenCalled();
    });

    it('toasts the ceremony error (never inline) when the direct passkey sign-in fails', async () => {
      signInWithPasskey.mockRejectedValueOnce(new Error('The passkey request was cancelled.'));
      snapshot = requestSnapshot({ route: 'qr' });
      render(<OxyAuthChooser />);

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('passkey-signin-link'));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('The passkey request was cancelled.'),
      );
      expect(screen.queryByText('The passkey request was cancelled.')).toBeNull();
    });

    it('leads with "Get Commons" — the genuine primary route — when Commons is not installed', () => {
      isWebBrowserMock.mockReturnValue(false);
      isOxyRpOriginMock.mockReturnValue(false);
      snapshot = requestSnapshot({ route: 'qr' }, { commonsAvailability: 'unavailable' });
      render(<OxyAuthChooser />);

      expect(screen.getByTestId('get-commons-button')).toBeTruthy();
      // A same-device QR would be a dead end, so it is demoted behind the
      // disclosure rather than shown next to the acquisition CTA.
      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.queryByTestId('show-qr-anyway-link')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('show-qr-anyway-link'));

      expect(screen.getByTestId('qrcode')).toBeTruthy();
    });

    it('toasts a sign-in device-flow failure instead of rendering inline error copy', async () => {
      snapshot = requestSnapshot({
        phase: 'error',
        authorizeCode: null,
        qrPayload: null,
        expiresAt: null,
        error: 'Sign-in was cancelled.',
        progress: 'idle',
      });

      render(<OxyAuthChooser />);

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sign-in was cancelled.'));
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Sign-in was cancelled.')).toBeNull();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      // A failed request has no working primary route, so the alternatives are
      // already revealed rather than parked behind the disclosure.
      expect(screen.queryByRole('button', { name: 'Having trouble?' })).toBeNull();
      expect(screen.getByTestId('passkey-signin-link')).toBeTruthy();
    });

    it('toasts the SAME sign-in error only once even if the controller re-notifies (deduped)', async () => {
      // Capture the controller listener the chooser registers so we can replay a
      // notification carrying the same error — it must NOT re-toast.
      let notify: (() => void) | null = null;
      controller.subscribe.mockImplementationOnce((listener: () => void) => {
        notify = listener;
        return () => undefined;
      });
      snapshot = requestSnapshot({
        phase: 'error',
        authorizeCode: null,
        qrPayload: null,
        expiresAt: null,
        error: 'Sign-in was cancelled.',
        progress: 'idle',
      });

      render(<OxyAuthChooser />);
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));

      // Re-notify with the identical error phase/message — deduped, no second toast.
      act(() => notify?.());
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('signup view', () => {
    it('offers passkey account creation on a first-party Oxy origin, gated on username availability', async () => {
      snapshot = makeSnapshot({ view: 'signup' });
      render(<OxyAuthChooser />);

      const button = screen.getByTestId('signup-create-button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);

      fireEvent.change(screen.getByTestId('signup-username-input'), { target: { value: 'newuser' } });
      await waitFor(() => expect(checkUsernameAvailability).toHaveBeenCalledWith('newuser'), { timeout: 1000 });

      await waitFor(() => expect((screen.getByTestId('signup-create-button') as HTMLButtonElement).disabled).toBe(false));

      fireEvent.click(screen.getByTestId('signup-create-button'));
      await waitFor(() => expect(registerWithPasskey).toHaveBeenCalledWith({ username: 'newuser' }));
    });

    it('toasts (never inline) when the username-availability check fails', async () => {
      checkUsernameAvailability.mockRejectedValueOnce(new Error('network'));
      snapshot = makeSnapshot({ view: 'signup' });
      render(<OxyAuthChooser />);

      fireEvent.change(screen.getByTestId('signup-username-input'), { target: { value: 'newuser' } });

      await waitFor(
        () => expect(toast.error).toHaveBeenCalledWith('Could not check availability'),
        { timeout: 1000 },
      );
      // The availability indicator (checking/available/taken) stays inline; only
      // the network ERROR moves to a toast — no inline error text is painted.
      expect(screen.queryByText('Could not check availability')).toBeNull();
    });

    it('toasts when passkey account creation fails (after the username resolves available)', async () => {
      registerWithPasskey.mockRejectedValueOnce(new Error('Passkey attestation rejected.'));
      snapshot = makeSnapshot({ view: 'signup' });
      render(<OxyAuthChooser />);

      fireEvent.change(screen.getByTestId('signup-username-input'), { target: { value: 'newuser' } });
      await waitFor(
        () => expect((screen.getByTestId('signup-create-button') as HTMLButtonElement).disabled).toBe(false),
        { timeout: 1000 },
      );

      fireEvent.click(screen.getByTestId('signup-create-button'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Passkey attestation rejected.'));
    });

    it('offers the auth.oxy.so hub popup (b2) on a non-Oxy web origin, instead of the direct passkey form', () => {
      isOxyRpOriginMock.mockReturnValue(false);
      snapshot = makeSnapshot({ view: 'signup' });
      render(<OxyAuthChooser />);

      expect(screen.queryByTestId('signup-username-input')).toBeNull();
      const button = screen.getByRole('button', { name: 'Continue in a new window' });
      fireEvent.click(button);
      expect(controller.startPasskeyHubSignIn).toHaveBeenCalledTimes(1);
    });

    it('offers Commons identity creation on native', () => {
      isWebBrowserMock.mockReturnValue(false);
      isOxyRpOriginMock.mockReturnValue(false);
      snapshot = makeSnapshot({ view: 'signup' });
      render(<OxyAuthChooser />);

      expect(screen.getByRole('button', { name: /Create your identity in Commons|Get Commons/ })).toBeTruthy();
    });
  });
});
