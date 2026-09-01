/**
 * `OxyAccountDialogScreen` — the account dialog body around `OxyAuthChooser`.
 *
 * `OxyAuthChooser` (mocked here — its own behavior is unit-tested in
 * `OxyAuthChooser.test.tsx`) owns every view's actual content. This screen no
 * longer renders its own header: it declares the per-view title/subtitle + a
 * per-view back through the SHARED Dialog nav header via `useSurfaceHeader`. So
 * these tests assert the header CONFIG the screen contributes per `snapshot.view`
 * (not rendered DOM — the nav bar is the Dialog's, covered by Bloom).
 */

import { render } from '@testing-library/react';
import type { AccountDialogSnapshot } from '@oxyhq/core';
import type { SurfaceHeaderContent } from '../../src/ui/hooks/useSurfaceHeader';

const makeSnapshot = (over?: Partial<AccountDialogSnapshot>): AccountDialogSnapshot => ({
  view: 'accounts',
  accounts: [],
  activeAccountId: null,
  loading: false,
  error: null,
  switchingAccountId: null,
  signIn: {
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
  },
  commonsAvailability: 'unknown',
  ...over,
});

let snapshot = makeSnapshot();
const setView = jest.fn();
const cancelSignIn = jest.fn();
const controller = {
  subscribe: (_l: () => void) => () => undefined,
  getSnapshot: () => snapshot,
  setView,
  cancelSignIn,
};

const closeAccountDialog = jest.fn();

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    accountDialogController: controller,
    isAccountDialogOpen: true,
    closeAccountDialog,
  }),
}));

jest.mock('../../src/ui/hooks/useI18n', () => ({
  __esModule: true,
  useI18n: () => ({ t: () => '', locale: 'en' }),
}));

// Capture the header config the screen contributes to the Dialog nav header.
const mockUseSurfaceHeader = jest.fn();
jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({
  __esModule: true,
  useSurfaceHeader: (content: SurfaceHeaderContent | null | undefined) =>
    mockUseSurfaceHeader(content),
}));

jest.mock('../../src/ui/components/OxyAuthChooser', () => ({
  __esModule: true,
  default: () => null,
}));

// eslint-disable-next-line import/first
import OxyAccountDialogScreen from '../../src/ui/components/OxyAccountDialogScreen';

/** The most recent header config the screen contributed. */
const lastHeader = (): SurfaceHeaderContent | null | undefined =>
  mockUseSurfaceHeader.mock.calls.at(-1)?.[0];

describe('OxyAccountDialogScreen — shared nav header', () => {
  beforeEach(() => {
    snapshot = makeSnapshot();
    jest.clearAllMocks();
  });

  it('brands the accounts view with the Oxy wordmark instead of a title, and no back', () => {
    render(<OxyAccountDialogScreen />);

    // The account MENU is branded, not titled: a `titleContent` node owns the
    // nav bar centre and Bloom then suppresses the large in-content title.
    expect(lastHeader()?.titleContent).toBeTruthy();
    expect(lastHeader()?.title).toBeUndefined();
    expect(lastHeader()?.subtitle).toBeUndefined();
    expect(lastHeader()?.onBack).toBeUndefined();
  });

  it('keeps the wordmark even with an account signed in — the HERO names the account, not the bar', () => {
    snapshot = makeSnapshot({
      activeAccountId: 'a',
      accounts: [
        {
          accountId: 'a',
          sessionId: 's-a',
          userId: 'u-a',
          displayName: 'Alice',
          username: 'alice',
          email: 'alice@oxy.so',
          avatarUrl: null,
          color: null,
          isCurrent: true,
          isActive: true,
        },
      ],
    });
    render(<OxyAccountDialogScreen />);

    expect(lastHeader()?.titleContent).toBeTruthy();
    expect(lastHeader()?.title).toBeUndefined();
  });

  it('keeps the informative title (and drops the wordmark) on the other views', () => {
    snapshot = makeSnapshot({ view: 'qr' });
    render(<OxyAccountDialogScreen />);

    expect(lastHeader()?.titleContent).toBeUndefined();
    expect(lastHeader()?.title).toBe('Sign in with Oxy');
  });

  it('contributes the create-account title in the signup view', () => {
    snapshot = makeSnapshot({ view: 'signup' });
    render(<OxyAccountDialogScreen />);

    expect(lastHeader()?.title).toBe('Create your account');
  });

  it('contributes a back handler in the qr view', () => {
    snapshot = makeSnapshot({ view: 'qr' });
    render(<OxyAccountDialogScreen />);

    expect(typeof lastHeader()?.onBack).toBe('function');
  });

  it('contributes a back handler in the signup view', () => {
    snapshot = makeSnapshot({ view: 'signup' });
    render(<OxyAccountDialogScreen />);

    expect(typeof lastHeader()?.onBack).toBe('function');
  });

  it('the back handler returns to the accounts view', () => {
    snapshot = makeSnapshot({ view: 'qr' });
    render(<OxyAccountDialogScreen />);

    lastHeader()?.onBack?.();
    expect(setView).toHaveBeenCalledWith('accounts');
  });

  it('the back handler withdraws an active sign-in request before returning to accounts', () => {
    snapshot = makeSnapshot({
      view: 'qr',
      signIn: {
        phase: 'waiting',
        authorizeCode: 'AUTH-CODE',
        qrPayload: 'oxycommons://approve?code=AUTH-CODE',
        expiresAt: Date.now() + 300_000,
        error: null,
        route: 'qr',
        routeFailed: false,
        pushSentAt: null,
        openedAt: null,
        progress: 'waiting',
      },
    });
    render(<OxyAccountDialogScreen />);

    lastHeader()?.onBack?.();
    expect(cancelSignIn).toHaveBeenCalled();
    expect(setView).toHaveBeenCalledWith('accounts');
  });

  it('contributes no back handler in the sign-in entry with no accounts yet', () => {
    snapshot = makeSnapshot({ view: 'add', accounts: [] });
    render(<OxyAccountDialogScreen />);

    expect(lastHeader()?.onBack).toBeUndefined();
  });
});
