/**
 * `OxyAuthChooser` — the account switcher + sign-in/sign-up chooser
 * (extracted from `OxyAccountDialog`, no Dialog chrome).
 *
 * These tests isolate the RN binding over the headless `AccountDialogController`
 * (mocked): the chooser renders the correct view from `snapshot.view`, activates
 * a `principal acting as account` pair through `controller.activateContext`, and
 * auto-starts "Sign in with Oxy" on web when the sign-in entry is reached. The
 * controller's own state machine is unit-tested in `@oxy.so/core`.
 *
 * The switcher's rows come from the device DIRECTORY (ADR 0002), so the fixtures
 * here put the SAME organization under TWO people wherever the grouping matters:
 * that is the shape the flat list could not hold, and the one where "select the
 * row for this account" and "select the row for this person's route to this
 * account" stop being the same instruction.
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
import { Linking } from 'react-native';
import { surfaces, toast } from '@oxy.so/bloom';
import type { DeviceDirectory } from '@oxy.so/contracts';
import type { AccountDialogSnapshot, SignInFlowState, User } from '@oxy.so/core';
import { resolveActiveContext } from '@oxy.so/core';

const makeUser = (id: string, displayName: string): User =>
  ({ id, username: id, name: { displayName } } as unknown as User);

interface ContextSpec {
  id: string;
  accountId: string;
  displayName: string;
  available?: boolean;
  /** The account's own Bloom preset, as the directory carries it (issue #961). */
  color?: string;
}

interface PrincipalSpec {
  id: string;
  userId: string;
  displayName: string;
  contexts: ContextSpec[];
}

/** A device directory built from a compact spec, with the wire shape verbatim. */
const makeDirectory = (
  principals: PrincipalSpec[],
  activeContextId: string | null,
): DeviceDirectory => ({
  deviceId: 'device-1',
  revision: 3,
  activeContextId,
  updatedAt: 1_720_000_000_000,
  principals: principals.map((principal, index) => ({
    id: principal.id,
    userId: principal.userId,
    authuser: index,
    user: { id: principal.userId, username: principal.userId, name: { displayName: principal.displayName } },
    contexts: principal.contexts.map((context) => ({
      id: context.id,
      accountId: context.accountId,
      kind: context.accountId === principal.userId ? ('personal' as const) : ('organization' as const),
      relationship: context.accountId === principal.userId ? ('self' as const) : ('owner' as const),
      account: {
        id: context.accountId,
        username: context.accountId,
        name: { displayName: context.displayName },
        color: context.color ?? null,
      },
      onDevice: true,
      available: context.available ?? true,
      active: context.id === activeContextId,
      lastUsedAt: null,
    })),
  })),
});

/** The one-person, one-account device — the ordinary case. */
const soloDirectory = (activeContextId: string | null = 'ctx-alice'): DeviceDirectory =>
  makeDirectory(
    [{ id: 'p-alice', userId: 'a', displayName: 'Alice', contexts: [{ id: 'ctx-alice', accountId: 'a', displayName: 'Alice' }] }],
    activeContextId,
  );

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
  failure: null,
  attempt: 0,
  inline: false,
};

/**
 * A distinct attempt identity per fixture. A failure is toasted once PER
 * ATTEMPT, per controller — and the controller double outlives each test — so a
 * fixture that reused an attempt would be deduped against an earlier test.
 */
let nextAttempt = 1;
const freshAttempt = (): number => nextAttempt++;

const makeSnapshot = (over?: Partial<AccountDialogSnapshot>): AccountDialogSnapshot => {
  const directory = over?.directory ?? null;
  return {
    view: 'accounts',
    backView: null,
    hasSession: true,
    directory,
    // Derived here rather than hand-set, so a fixture can never claim an active
    // context the directory it ships does not hold.
    activeContext: resolveActiveContext(directory),
    loading: false,
    error: null,
    activatingContextId: null,
    removingContextId: null,
    removingPrincipalId: null,
    signIn: IDLE_SIGN_IN,
    commonsAvailability: 'unknown',
    ...over,
    ...(over?.directory !== undefined ? { activeContext: resolveActiveContext(over.directory) } : {}),
  };
};

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
  activateContext: jest.fn(async (_contextId: string) => true),
  // The controller's real rule, over this double's own parts, so the tests
  // below drive the chooser through the same decisions the controller makes.
  chooseContext: jest.fn(async (contextId: string) => {
    if (controller.isDeviceMutationInFlight()) return 'busy' as const;
    if (!snapshot.hasSession) {
      await controller.signInWithOxy();
      return 'signing-in' as const;
    }
    if (contextId === snapshot.activeContext?.contextId) return 'current' as const;
    return (await controller.activateContext(contextId)) ? ('switched' as const) : ('failed' as const);
  }),
  signOutContext: jest.fn(async () => true),
  signOutPrincipal: jest.fn(async () => true),
  add: jest.fn(),
  startSignup: jest.fn(),
  showQr: jest.fn(),
  retrySignIn: jest.fn(),
  isDeviceMutationInFlight: jest.fn(() => false),
  runDeviceMutation: jest.fn(async (operation: () => Promise<unknown>) => ({
    ran: true as const,
    value: await operation(),
  })),
  signInWithOxy: jest.fn(),
  setView: jest.fn(),
  cancelSignIn: jest.fn(),
};

const openAvatarPicker = jest.fn();
const continueOnAuth = jest.fn(async (_screen: string) => ({ status: 'redirecting' as const }));
const closeAccountDialog = jest.fn();
const showBottomSheet = jest.fn();
const logout = jest.fn(async (): Promise<{ status: 'signed-out' } | { status: 'failed'; error: unknown }> => ({
  status: 'signed-out',
}));
const invalidateQueries = jest.fn();

/** `null` reproduces `sessionMode: 'identity'`, where no controller is built. */
let mockController: typeof controller | null = controller;

/**
 * The signed-in account, as `useOxy()` reports it.
 *
 * The hero renders from THIS and not from a directory row: it is the one account
 * this client holds a full profile for, so it keeps its real email and accent
 * while the rows below it show only what the directory carries.
 */
let mockUser: User | null = makeUser('a', 'Alice');

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    accountDialogController: mockController,
    isAccountDialogOpen: true,
    closeAccountDialog,
    showBottomSheet,
    logout,
    logoutAll: jest.fn(async () => undefined),
    openAvatarPicker,
    continueOnAuth,
    user: mockUser,
    oxyServices: { getFileDownloadUrl: (id: string) => `https://cdn/${id}` },
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
  const { translate } = jest.requireActual('@oxy.so/core');
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

// The two environment gate probes, toggled per test.
const isWebBrowserMock = jest.fn(() => true);
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => isWebBrowserMock(),
}));

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
    // `clearAllMocks` clears recorded calls but does NOT drain a queued
    // `mockImplementationOnce`. The failed-activation test queues one; if its
    // click does not reach `activateContext` the one-shot survives into the NEXT
    // test, which then takes the failure branch and never runs the success side
    // effects. Restore the default implementations explicitly so no test
    // inherits another test's one-shot.
    mockUser = makeUser('a', 'Alice');
    controller.activateContext.mockReset();
    controller.activateContext.mockImplementation(async () => true);
    controller.signOutContext.mockReset();
    controller.signOutContext.mockImplementation(async () => true);
    controller.signOutPrincipal.mockReset();
    controller.signOutPrincipal.mockImplementation(async () => true);
    controller.isDeviceMutationInFlight.mockReturnValue(false);
    logout.mockResolvedValue({ status: 'signed-out' });
    surfaces.confirm.mockReset();
    surfaces.confirm.mockResolvedValue(true);
    isWebBrowserMock.mockReturnValue(true);
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
      directory: makeDirectory(
        [
          {
            id: 'p-alice',
            userId: 'a',
            displayName: 'Alice',
            contexts: [{ id: 'ctx-alice', accountId: 'a', displayName: 'Alice' }],
          },
          {
            id: 'p-bob',
            userId: 'b',
            displayName: 'Bob',
            contexts: [{ id: 'ctx-bob', accountId: 'b', displayName: 'Bob' }],
          },
        ],
        'ctx-alice',
      ),
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

  it('never renders the account menu without a signed-in account — the sign-in entry stands in', () => {
    // OxyHQ/oxy#1375: signed out, the sheet showed "Switch account … Sign out".
    // Whatever the controller's view says, no account means no account menu.
    mockUser = null;
    snapshot = makeSnapshot({ view: 'accounts' });
    isWebBrowserMock.mockReturnValue(false);

    render(<OxyAuthChooser />);

    expect(screen.queryByRole('button', { name: 'Switch account' })).toBeNull();
    expect(screen.queryByText('Sign out')).toBeNull();
    expect(screen.getByTestId('continue-with-oxy')).toBeTruthy();
  });

  it('routes manage and add-account to registered consumer hooks', () => {
    const onNavigateManage = jest.fn();
    const onAddAccount = jest.fn();
    registerAccountDialogConsumerHooks({ onNavigateManage, onAddAccount });

    snapshot = makeSnapshot({
      directory: makeDirectory(
        [
          {
            id: 'p-alice',
            userId: 'a',
            displayName: 'Alice',
            contexts: [{ id: 'ctx-alice', accountId: 'a', displayName: 'Alice' }],
          },
          {
            id: 'p-bob',
            userId: 'b',
            displayName: 'Bob',
            contexts: [{ id: 'ctx-bob', accountId: 'b', displayName: 'Bob' }],
          },
        ],
        'ctx-alice',
      ),
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

  it('renders app-owned menu items from registered consumer hooks', () => {
    const onCustom = jest.fn();
    registerAccountDialogConsumerHooks({
      menuItems: [{ key: 'inbox-settings', label: 'Inbox settings', onPress: onCustom }],
    });

    snapshot = makeSnapshot({
      directory: soloDirectory(),
    });

    render(<OxyAuthChooser />);

    fireEvent.click(screen.getByText('Inbox settings'));
    expect(onCustom).toHaveBeenCalledTimes(1);
  });

  it('toasts a failed activation instead of rendering an inline banner', async () => {
    snapshot = makeSnapshot({
      directory: makeDirectory(
        [
          {
            id: 'p-alice',
            userId: 'a',
            displayName: 'Alice',
            contexts: [{ id: 'ctx-alice', accountId: 'a', displayName: 'Alice' }],
          },
          {
            id: 'p-bob',
            userId: 'b',
            displayName: 'Bob',
            contexts: [{ id: 'ctx-bob', accountId: 'b', displayName: 'Bob' }],
          },
        ],
        'ctx-alice',
      ),
    });
    // `activateContext` never throws — it resolves `false` for a failed switch
    // (and records the reason on the snapshot, which the chooser never paints).
    controller.activateContext.mockImplementationOnce(async () => {
      snapshot = makeSnapshot({ ...snapshot, error: 'Context not on this device' });
      return false;
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
    expect(screen.queryByText('Context not on this device')).toBeNull();
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

  describe('grouped by person (ADR 0002)', () => {
    /**
     * `The Oxy Collective` reachable through Nate (who owns it) AND through
     * Alice (a member), plus Nate's own account. This is the device the flat
     * list could not describe: one organization, two routes, two humans.
     */
    const sharedDeviceDirectory = (activeContextId: string | null = 'ctx-nate') =>
      makeDirectory(
        [
          {
            id: 'p-nate',
            userId: 'nate',
            displayName: 'Nate',
            contexts: [
              { id: 'ctx-nate', accountId: 'nate', displayName: 'Nate' },
              { id: 'ctx-nate-org', accountId: 'org', displayName: 'The Oxy Collective' },
            ],
          },
          {
            id: 'p-alice',
            userId: 'alice',
            displayName: 'Alice',
            contexts: [
              { id: 'ctx-alice', accountId: 'alice', displayName: 'Alice' },
              { id: 'ctx-alice-org', accountId: 'org', displayName: 'The Oxy Collective' },
            ],
          },
        ],
        activeContextId,
      );

    const openSwitcher = () => {
      render(<OxyAuthChooser />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    };

    it('renders the shared organization TWICE, under each person who reaches it', () => {
      snapshot = makeSnapshot({ directory: sharedDeviceDirectory() });

      openSwitcher();

      // Two rows for one account. A list keyed by account id has exactly one
      // slot for `org` and would silently drop whichever route it enumerated
      // second — along with the fact that they are different sessions with
      // different audit actors.
      expect(screen.getAllByRole('button', { name: 'The Oxy Collective' })).toHaveLength(2);
      // And each is named by the person who can operate it.
      expect(screen.getAllByText('Nate').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    });

    it('activates the route the pressed row belongs to, not the other person’s', async () => {
      snapshot = makeSnapshot({ directory: sharedDeviceDirectory() });

      openSwitcher();
      // The SECOND `org` row is Alice's — the directory enumerates Nate first.
      fireEvent.click(screen.getAllByRole('button', { name: 'The Oxy Collective' })[1]);

      await waitFor(() =>
        expect(controller.activateContext).toHaveBeenCalledWith('ctx-alice-org'),
      );
      expect(controller.activateContext).not.toHaveBeenCalledWith('ctx-nate-org');
    });

    it('does NOT name the operator when every person holds one account', () => {
      // Two people, one personal account each: every row already IS a person, so
      // a header would print each name twice and say nothing.
      snapshot = makeSnapshot({
        directory: makeDirectory(
          [
            { id: 'p-alice', userId: 'a', displayName: 'Alice', contexts: [{ id: 'ctx-a', accountId: 'a', displayName: 'Alice' }] },
            { id: 'p-bob', userId: 'b', displayName: 'Bob', contexts: [{ id: 'ctx-b', accountId: 'b', displayName: 'Bob' }] },
          ],
          'ctx-a',
        ),
      });

      openSwitcher();

      // Once as the row. The hero renders the greeting, never a bare name.
      expect(screen.getAllByText('Alice')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Sign Alice out of this device' })).toBeNull();
    });

    it('names the operator — and offers per-person sign-out — once somebody holds two', () => {
      snapshot = makeSnapshot({ directory: sharedDeviceDirectory() });

      openSwitcher();

      // Every group gets a header, including single-context ones: an
      // inconsistent list is harder to read than a slightly redundant one.
      expect(screen.getByRole('button', { name: 'Sign Nate out of this device' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sign Alice out of this device' })).toBeTruthy();
    });

    it('offers a row the server marked unavailable, disabled rather than hidden', async () => {
      snapshot = makeSnapshot({
        directory: makeDirectory(
          [
            {
              id: 'p-nate',
              userId: 'nate',
              displayName: 'Nate',
              contexts: [
                { id: 'ctx-nate', accountId: 'nate', displayName: 'Nate' },
                // A revoked membership. The server returns it rather than
                // omitting it, so the UI can explain the row instead of having
                // it silently vanish.
                { id: 'ctx-nate-org', accountId: 'org', displayName: 'The Oxy Collective', available: false },
              ],
            },
          ],
          'ctx-nate',
        ),
      });

      openSwitcher();

      const row = screen.getByRole('button', { name: 'The Oxy Collective' }) as HTMLButtonElement;
      expect(row.disabled).toBe(true);
      expect(screen.getByText('Unavailable right now')).toBeTruthy();
      fireEvent.click(row);
      await Promise.resolve();
      // `available` alone decides this. `onDevice` is true here — the delegated
      // session is perfectly alive — and offering the row on that ground would
      // be offering a button the server answers 403 to and then heals away.
      expect(controller.activateContext).not.toHaveBeenCalled();
    });
  });

  describe('the two removals are not the same removal', () => {
    const nateAndAlice = (activeContextId: string | null = 'ctx-nate') =>
      makeDirectory(
        [
          {
            id: 'p-nate',
            userId: 'nate',
            displayName: 'Nate',
            contexts: [
              { id: 'ctx-nate', accountId: 'nate', displayName: 'Nate' },
              { id: 'ctx-nate-org', accountId: 'org', displayName: 'The Oxy Collective' },
            ],
          },
          {
            id: 'p-alice',
            userId: 'alice',
            displayName: 'Alice',
            contexts: [
              { id: 'ctx-alice', accountId: 'alice', displayName: 'Alice' },
              { id: 'ctx-alice-org', accountId: 'org', displayName: 'The Oxy Collective' },
            ],
          },
        ],
        activeContextId,
      );

    const openSwitcher = () => {
      render(<OxyAuthChooser />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    };

    it('removes ONE pair through signOutContext, naming the person in the confirmation', async () => {
      snapshot = makeSnapshot({ directory: nateAndAlice() });

      openSwitcher();
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove The Oxy Collective from Alice' }),
      );

      await waitFor(() =>
        expect(controller.signOutContext).toHaveBeenCalledWith('ctx-alice-org'),
      );
      // Never the principal endpoint, and never Nate's route to the same
      // organization — that is a different session with a different actor.
      expect(controller.signOutPrincipal).not.toHaveBeenCalled();
      expect(controller.signOutContext).not.toHaveBeenCalledWith('ctx-nate-org');
      expect(surfaces.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('Alice'),
          destructive: true,
        }),
      );
    });

    it('removes ONE PERSON through signOutPrincipal, never by looping their contexts', async () => {
      snapshot = makeSnapshot({ directory: nateAndAlice() });

      openSwitcher();
      fireEvent.click(screen.getByRole('button', { name: 'Sign Alice out of this device' }));

      await waitFor(() => expect(controller.signOutPrincipal).toHaveBeenCalledWith('p-alice'));
      expect(controller.signOutPrincipal).toHaveBeenCalledTimes(1);
      // Pointing this at the context endpoint would drop one pair and leave the
      // person on the device — the exact conflation the two calls exist to stop.
      expect(controller.signOutContext).not.toHaveBeenCalled();
    });

    it('does nothing when the confirmation is declined', async () => {
      surfaces.confirm.mockResolvedValue(false);
      snapshot = makeSnapshot({ directory: nateAndAlice() });

      openSwitcher();
      fireEvent.click(screen.getByRole('button', { name: 'Sign Alice out of this device' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove The Oxy Collective from Alice' }),
      );

      await waitFor(() => expect(surfaces.confirm).toHaveBeenCalledTimes(2));
      expect(controller.signOutPrincipal).not.toHaveBeenCalled();
      expect(controller.signOutContext).not.toHaveBeenCalled();
    });

    it('toasts a refused removal instead of pretending it worked', async () => {
      controller.signOutContext.mockResolvedValue(false);
      snapshot = makeSnapshot({ directory: nateAndAlice() });

      openSwitcher();
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove The Oxy Collective from Alice' }),
      );

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'There was a problem removing that account. Please try again.',
        ),
      );
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  it('activates the CONTEXT id, not the account id, when a non-active row is tapped', async () => {
    snapshot = makeSnapshot({
      directory: makeDirectory(
        [
          {
            id: 'p-alice',
            userId: 'a',
            displayName: 'Alice',
            contexts: [{ id: 'ctx-alice', accountId: 'a', displayName: 'Alice' }],
          },
          {
            id: 'p-bob',
            userId: 'b',
            displayName: 'Bob',
            contexts: [{ id: 'ctx-bob', accountId: 'b', displayName: 'Bob' }],
          },
        ],
        'ctx-alice',
      ),
    });

    render(<OxyAuthChooser />);
    // Expand the switcher first — the account rows are collapsed by default.
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));

    // `ctx-bob`, never `b`: the row names a `principal acting as account` pair,
    // and on a shared device an account id cannot say which person's route it is.
    await waitFor(() => expect(controller.activateContext).toHaveBeenCalledWith('ctx-bob'));
    expect(controller.activateContext).not.toHaveBeenCalledWith('b');
    // `invalidateQueries` runs AFTER `await controller.activateContext(...)`
    // resolves, so it needs its own wait rather than the next line.
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
    // A successful switch fires no error toast.
    expect(toast.error).not.toHaveBeenCalled();
  });

  describe('the account operations report what actually happened', () => {
    const twoPeople = () =>
      makeDirectory(
        [
          { id: 'p-alice', userId: 'a', displayName: 'Alice', contexts: [{ id: 'ctx-alice', accountId: 'a', displayName: 'Alice' }] },
          { id: 'p-bob', userId: 'b', displayName: 'Bob', contexts: [{ id: 'ctx-bob', accountId: 'b', displayName: 'Bob' }] },
        ],
        'ctx-alice',
      );

    it('treats a switch whose directory re-read failed as the switch it was: caches reset, dialog closes, no error', async () => {
      snapshot = makeSnapshot({ directory: twoPeople() });
      // The switch went through; only the re-read after it failed — which also
      // lands on `snapshot.error`. That is the directory's problem, not the switch's.
      controller.activateContext.mockImplementationOnce(async () => {
        snapshot = makeSnapshot({ ...snapshot, error: 'directory boom' });
        return true;
      });

      render(<OxyAuthChooser onComplete={closeAccountDialog} />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
      fireEvent.click(screen.getByRole('button', { name: 'Bob' }));

      // Without the reset, Bob's screens would render from Alice's cached queries.
      await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
      expect(closeAccountDialog).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('drops a switch press while another device operation is in flight — neither run nor reported', async () => {
      snapshot = makeSnapshot({ directory: twoPeople() });
      controller.isDeviceMutationInFlight.mockReturnValue(true);

      render(<OxyAuthChooser />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
      fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
      await Promise.resolve();

      expect(controller.activateContext).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('closes after a sign-out only once the sign-out is confirmed', async () => {
      snapshot = makeSnapshot({ directory: soloDirectory() });
      render(<OxyAuthChooser onComplete={closeAccountDialog} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      await waitFor(() => expect(closeAccountDialog).toHaveBeenCalled());
      // Under the controller's gate, so it cannot race a switch or run twice.
      expect(controller.runDeviceMutation).toHaveBeenCalledTimes(1);
      expect(logout).toHaveBeenCalledTimes(1);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('keeps the dialog open and says so when the sign-out did not go through', async () => {
      logout.mockResolvedValue({ status: 'failed', error: new Error('offline') });
      snapshot = makeSnapshot({ directory: soloDirectory() });
      render(<OxyAuthChooser onComplete={closeAccountDialog} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('There was a problem signing you out. Please try again.'),
      );
      // Closing here would read as "signed out" while the device still holds the session.
      expect(closeAccountDialog).not.toHaveBeenCalled();
    });

    it('does nothing for a sign-out press the gate refused', async () => {
      controller.runDeviceMutation.mockResolvedValueOnce({ ran: false } as never);
      snapshot = makeSnapshot({ directory: soloDirectory() });
      render(<OxyAuthChooser onComplete={closeAccountDialog} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(controller.runDeviceMutation).toHaveBeenCalled());
      await Promise.resolve();

      expect(logout).not.toHaveBeenCalled();
      expect(closeAccountDialog).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('has no identity row: a web account has no identity to open (ADR 0029 D3)', () => {
      snapshot = makeSnapshot({ directory: soloDirectory() });
      render(<OxyAuthChooser />);
      expect(screen.queryByRole('button', { name: 'Your identity' })).toBeNull();
    });

    it('reports a menu link the OS could not open, instead of a press that does nothing', async () => {
      const openURL = jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('no handler'));
      snapshot = makeSnapshot({ directory: soloDirectory() });
      render(<OxyAuthChooser />);

      fireEvent.click(screen.getByRole('button', { name: 'Oxy settings' }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Couldn't open that link. Please try again."),
      );
      openURL.mockRestore();
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

    it('sends the disclosed passkey link to auth.oxy.so, in this tab', () => {
      snapshot = requestSnapshot({ route: 'qr' });
      render(<OxyAuthChooser />);

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('passkey-signin-link'));

      expect(continueOnAuth).toHaveBeenCalledWith('signin');
    });

    it('leads with "Get Commons" — the genuine primary route — when Commons is not installed', () => {
      isWebBrowserMock.mockReturnValue(false);
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

    it('toasts a sign-in device-flow failure, localized from its reason, instead of rendering inline error copy', async () => {
      snapshot = requestSnapshot({
        phase: 'error',
        authorizeCode: null,
        qrPayload: null,
        expiresAt: null,
        error: 'Authorization was denied.',
        failure: 'denied',
        attempt: freshAttempt(),
        progress: 'idle',
      });

      render(<OxyAuthChooser />);

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sign-in was declined in Commons.'));
      expect(toast.error).toHaveBeenCalledTimes(1);
      // Neither the copy nor the controller's raw, English diagnostic is painted.
      expect(screen.queryByText('Sign-in was declined in Commons.')).toBeNull();
      expect(screen.queryByText('Authorization was denied.')).toBeNull();
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
        error: 'Session expired. Please try again.',
        failure: 'expired',
        attempt: freshAttempt(),
        progress: 'idle',
      });

      const { unmount } = render(<OxyAuthChooser />);
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));

      // Re-notify with the identical failure — deduped, no second toast.
      act(() => notify?.());
      expect(toast.error).toHaveBeenCalledTimes(1);

      // Remounting on the same failed attempt is not a second failure either.
      unmount();
      render(<OxyAuthChooser />);
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it('toasts a NEW attempt that fails with the same message again', async () => {
      let notify: (() => void) | null = null;
      controller.subscribe.mockImplementationOnce((listener: () => void) => {
        notify = listener;
        return () => undefined;
      });
      const failed = (attempt: number) =>
        requestSnapshot({
          phase: 'error',
          authorizeCode: null,
          qrPayload: null,
          expiresAt: null,
          error: 'network down',
          failure: 'network',
          attempt,
          progress: 'idle',
        });
      snapshot = failed(freshAttempt());
      render(<OxyAuthChooser />);
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));

      snapshot = failed(freshAttempt());
      act(() => notify?.());

      expect(toast.error).toHaveBeenCalledTimes(2);
      expect(toast.error).toHaveBeenLastCalledWith(
        "Couldn't reach Oxy. Check your connection and try again.",
      );
    });

    it('"Try again" repeats the attempt the user chose, rather than always showing a QR', () => {
      snapshot = requestSnapshot({
        phase: 'error',
        authorizeCode: null,
        qrPayload: null,
        expiresAt: null,
        failure: 'network',
        attempt: freshAttempt(),
        progress: 'idle',
      });
      render(<OxyAuthChooser />);

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(controller.retrySignIn).toHaveBeenCalledTimes(1);
      expect(controller.showQr).not.toHaveBeenCalled();
    });
  });

  describe('signup view', () => {
    it("on web, offers one action: create the account in auth.oxy.so's window", () => {
      snapshot = makeSnapshot({ view: 'signup' });
      render(<OxyAuthChooser />);

      expect(screen.queryByTestId('signup-username-input')).toBeNull();
      fireEvent.click(screen.getByTestId('signup-open-identity'));
      expect(continueOnAuth).toHaveBeenCalledWith('signup');
    });

    it('offers Commons identity creation on native', () => {
      isWebBrowserMock.mockReturnValue(false);
      snapshot = makeSnapshot({ view: 'signup' });
      render(<OxyAuthChooser />);

      expect(screen.getByRole('button', { name: /Create your identity in Commons|Get Commons/ })).toBeTruthy();
    });
  });
});
