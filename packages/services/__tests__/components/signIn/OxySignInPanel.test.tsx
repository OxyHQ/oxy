/**
 * `OxySignInPanel` / `OxySignUpPanel` / `OxyAccountPicker` — THE sign-in screens,
 * the ones the account dialog renders (`host="dialog"`) and auth.oxy.so renders
 * as a page (`host="page"`).
 *
 * The headless `AccountDialogController` is a double; the passkey ceremony is
 * `useOxy().signInWithPasskey`. Layout (the `md:` split, which of the QR and
 * "Continue with Oxy" shows) is NativeWind and not observable in jsdom, so these
 * tests assert what each platform OFFERS and what each action DOES.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Linking } from 'react-native';
import { toast } from '@oxy.so/bloom';
import type { DeviceDirectory } from '@oxy.so/contracts';
import type { AccountDialogSnapshot, SignInFlowState } from '@oxy.so/core';
import { resolveActiveContext } from '@oxy.so/core';

const IDLE_SIGN_IN: SignInFlowState = {
  phase: 'idle',
  authorizeCode: null,
  qrPayload: null,
  expiresAt: null,
  error: null,
  failure: null,
  route: null,
  routeFailed: false,
  pushSentAt: null,
  openedAt: null,
  progress: 'idle',
  attempt: 0,
  inline: false,
};

const directory = (activeContextId: string | null): DeviceDirectory => ({
  deviceId: 'device-1',
  revision: 1,
  activeContextId,
  updatedAt: 1_720_000_000_000,
  principals: [
    {
      id: 'p-alice',
      userId: 'alice',
      authuser: 0,
      user: { id: 'alice', username: 'alice', name: { displayName: 'Alice' } },
      contexts: [
        {
          id: 'ctx-alice',
          accountId: 'alice',
          kind: 'personal',
          relationship: 'self',
          account: { id: 'alice', username: 'alice', name: { displayName: 'Alice' }, color: null },
          onDevice: true,
          available: true,
          active: activeContextId === 'ctx-alice',
          lastUsedAt: null,
        },
      ],
    },
  ],
});

const makeSnapshot = (over: Partial<AccountDialogSnapshot> = {}): AccountDialogSnapshot => {
  const dir = over.directory ?? null;
  return {
    view: 'signin',
    backView: null,
    hasSession: false,
    directory: dir,
    activeContext: resolveActiveContext(dir),
    loading: false,
    error: null,
    activatingContextId: null,
    removingContextId: null,
    removingPrincipalId: null,
    signIn: IDLE_SIGN_IN,
    commonsAvailability: 'unknown',
    ...over,
  };
};

let snapshot = makeSnapshot();
let listeners: Array<() => void> = [];
const emit = (next: AccountDialogSnapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

const controller = {
  subscribe: jest.fn((listener: () => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }),
  getSnapshot: () => snapshot,
  chooseContext: jest.fn(async (_contextId: string): Promise<string> => 'signing-in'),
  activateContext: jest.fn(async () => true),
  signOutContext: jest.fn(async () => true),
  signOutPrincipal: jest.fn(async () => true),
  signInWithOxy: jest.fn(async () => undefined),
  showQr: jest.fn(async () => undefined),
  startInlineQr: jest.fn(async () => undefined),
  cancelSignIn: jest.fn(),
};

const signInWithPasskey = jest.fn(async (_opts?: { username?: string }) => undefined);
const openAccountDialog = jest.fn();
const continueOnAuth = jest.fn(async (_screen: string) => ({ status: 'redirecting' as const }));
const invalidateQueries = jest.fn();

jest.mock('../../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    accountDialogController: controller,
    openAccountDialog,
    signInWithPasskey,
    continueOnAuth,
    oxyServices: { getFileDownloadUrl: (id: string) => `https://cdn/${id}` },
  }),
  useOptionalOxy: () => null,
}));

jest.mock('../../../src/ui/hooks/useI18n', () => {
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
  default: ({ value }: { value: string }) => require('react').createElement('span', { 'data-testid': 'qrcode' }, value),
}));

const isWebBrowserMock = jest.fn(() => true);
jest.mock('../../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => isWebBrowserMock(),
}));

const isOxyRpOriginMock = jest.fn(() => true);
jest.mock('@oxy.so/core', () => {
  const actual = jest.requireActual('@oxy.so/core');
  return { __esModule: true, ...actual, isOxyRpOrigin: () => isOxyRpOriginMock() };
});

// eslint-disable-next-line import/first
import { OxySignInPanel } from '../../../src/ui/components/signIn/OxySignInPanel';
// eslint-disable-next-line import/first
import { OxySignUpPanel } from '../../../src/ui/components/signIn/OxySignUpPanel';
// eslint-disable-next-line import/first
import { InlineCommonsQr } from '../../../src/ui/components/signIn/InlineCommonsQr';

const onSignedIn = jest.fn();
const onCreateAccount = jest.fn();
const renderPanel = (props: Partial<React.ComponentProps<typeof OxySignInPanel>> = {}) =>
  render(<OxySignInPanel onSignedIn={onSignedIn} onCreateAccount={onCreateAccount} {...props} />);

const typeUsername = (value: string) => fireEvent.change(screen.getByTestId('username'), { target: { value } });

beforeEach(() => {
  jest.clearAllMocks();
  listeners = [];
  snapshot = makeSnapshot();
  isWebBrowserMock.mockReturnValue(true);
  isOxyRpOriginMock.mockReturnValue(true);
  signInWithPasskey.mockImplementation(async () => undefined);
  controller.chooseContext.mockImplementation(async () => 'signing-in');
});

describe('on an oxy.so origin — the passkey runs right here', () => {
  it('offers the username, its Continue, then "or continue with" a passkey', () => {
    renderPanel();

    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.getByTestId('username')).toBeTruthy();
    expect(screen.getByTestId('username-continue')).toBeTruthy();
    expect(screen.getByText('or continue with')).toBeTruthy();
    expect(screen.getByTestId('passkey-sign-in')).toBeTruthy();
    // The Commons way in: the QR from `md`, "Continue with Oxy" below it.
    expect(screen.getByTestId('inline-commons-qr')).toBeTruthy();
    expect(screen.getByTestId('continue-with-oxy')).toBeTruthy();
    expect(screen.getByText('Terms of Service')).toBeTruthy();
  });

  // Username-first is what takes a hardware security key: the server scopes
  // the ceremony to that account's credentials, resident or not.
  it('signs in username-first and reports it', async () => {
    renderPanel();
    typeUsername(' alice ');
    fireEvent.click(screen.getByTestId('username-continue'));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(signInWithPasskey).toHaveBeenCalledWith({ username: 'alice' });
  });

  it('asks for a username instead of running a ceremony for nobody', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('username-continue'));

    expect(signInWithPasskey).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Please enter your username.');
  });

  it('signs in with a discoverable passkey — no username', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('passkey-sign-in'));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(signInWithPasskey).toHaveBeenCalledWith({ username: undefined });
  });

  it('reports a dismissed prompt inline and as a toast, and signs nobody in', async () => {
    signInWithPasskey.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'NotAllowedError' }));
    renderPanel();
    fireEvent.click(screen.getByTestId('passkey-sign-in'));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe("Passkey prompt dismissed. Try again when you're ready."),
    );
    expect(toast.error).toHaveBeenCalled();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('holds every method for the countdown after a 429', async () => {
    signInWithPasskey.mockRejectedValueOnce({ status: 429 });
    renderPanel();
    typeUsername('alice');
    fireEvent.click(screen.getByTestId('username-continue'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Too many attempts. Try again in 60s.'));
    expect((screen.getByTestId('username-continue') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('passkey-sign-in') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pre-fills a login hint and skips the account picker', () => {
    snapshot = makeSnapshot({ directory: directory('ctx-alice') });
    renderPanel({ loginHint: 'alice' });

    expect((screen.getByTestId('username') as HTMLInputElement).value).toBe('alice');
    expect(screen.queryByText('Choose an account')).toBeNull();
  });

  it('leads to account creation from "Create account"', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('create-account-link'));
    expect(onCreateAccount).toHaveBeenCalledTimes(1);
  });
});

describe('on any other web origin — auth.oxy.so, in this tab', () => {
  beforeEach(() => isOxyRpOriginMock.mockReturnValue(false));

  it('offers no username here: the passkey is asserted on auth.oxy.so, never in a popup', () => {
    renderPanel({ host: 'dialog' });

    expect(screen.queryByTestId('username')).toBeNull();
    fireEvent.click(screen.getByTestId('passkey-sign-in'));
    expect(continueOnAuth).toHaveBeenCalledWith('signin');
    expect(signInWithPasskey).not.toHaveBeenCalled();
    expect(openAccountDialog).not.toHaveBeenCalled();
  });
});

describe('recovering an account', () => {
  it('on the web, recovers on auth.oxy.so by default, in this tab', () => {
    renderPanel({ host: 'dialog' });
    fireEvent.click(screen.getByTestId('recover-link'));
    expect(continueOnAuth).toHaveBeenCalledWith('recover');
  });

  it('on a page, hands recovery to the host', () => {
    const onRecover = jest.fn();
    renderPanel({ host: 'page', onRecover });
    fireEvent.click(screen.getByTestId('recover-link'));
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(continueOnAuth).not.toHaveBeenCalled();
  });

  it('on native, leaves recovery to Commons', () => {
    isWebBrowserMock.mockReturnValue(false);
    renderPanel({ host: 'dialog' });
    expect(screen.queryByTestId('recover-link')).toBeNull();
  });
});

describe('on native — Commons carries the identity', () => {
  beforeEach(() => isWebBrowserMock.mockReturnValue(false));

  it('continues with Oxy as the one solid action, with another device under it', () => {
    renderPanel({ host: 'dialog' });

    expect(screen.queryByTestId('username')).toBeNull();
    expect(screen.queryByTestId('passkey-sign-in')).toBeNull();
    expect(screen.queryByTestId('inline-commons-qr')).toBeNull();
    fireEvent.click(screen.getByTestId('continue-with-oxy'));
    expect(controller.signInWithOxy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('scan-qr'));
    expect(controller.showQr).toHaveBeenCalledTimes(1);
  });

  it('leads with getting Commons when it is not installed', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    snapshot = makeSnapshot({ commonsAvailability: 'unavailable' });
    renderPanel({ host: 'dialog' });

    expect(screen.queryByTestId('continue-with-oxy')).toBeNull();
    fireEvent.click(screen.getByTestId('get-commons-button'));
    await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
    openURL.mockRestore();
  });
});

describe('a returning device — the account picker', () => {
  it('in the dialog, signed out: the device account reads "Continue as @handle" and signs in as it', async () => {
    snapshot = makeSnapshot({ directory: directory('ctx-alice'), hasSession: false });
    renderPanel({ host: 'dialog' });

    expect(screen.getByText('Choose an account')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue as @alice' }));

    await waitFor(() => expect(controller.chooseContext).toHaveBeenCalledWith('ctx-alice'));
    // The request runs in the dialog, which the controller closes when it lands.
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('in the dialog, signed in: no picker — the rows are the accounts it would add — and "Add another account"', () => {
    snapshot = makeSnapshot({ view: 'add', directory: directory('ctx-alice'), hasSession: true });
    renderPanel({ host: 'dialog' });

    expect(screen.queryByText('Choose an account')).toBeNull();
    expect(screen.getByText('Add another account')).toBeTruthy();
  });

  it('in the dialog, signed out, titles the entry "Sign in" even though the device lists an account (#1375)', () => {
    snapshot = makeSnapshot({ directory: directory('ctx-alice'), hasSession: false });
    renderPanel({ host: 'dialog' });

    fireEvent.click(screen.getByTestId('use-another-account'));
    expect(screen.getByText('Sign in')).toBeTruthy();
  });

  it('on a page, the account already active here continues at once', async () => {
    controller.chooseContext.mockResolvedValueOnce('current');
    snapshot = makeSnapshot({ directory: directory('ctx-alice'), hasSession: true });
    renderPanel({ host: 'page', appName: 'Console' });

    expect(screen.getByText('to continue to Console')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it('on a page, a switch resets every account-scoped query before continuing', async () => {
    controller.chooseContext.mockResolvedValueOnce('switched');
    snapshot = makeSnapshot({ directory: directory('ctx-alice'), hasSession: true });
    renderPanel({ host: 'page' });

    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('on a page, a pair that cannot be activated falls back to signing in as it explicitly', async () => {
    controller.chooseContext.mockResolvedValueOnce('failed');
    snapshot = makeSnapshot({ directory: directory('ctx-alice'), hasSession: true });
    renderPanel({ host: 'page' });

    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    await waitFor(() => expect((screen.getByTestId('username') as HTMLInputElement).value).toBe('alice'));
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe('on a page, a request the controller runs finishes the page’s sign-in', () => {
  it('reports a completion that started after the page mounted', () => {
    snapshot = makeSnapshot({ signIn: { ...IDLE_SIGN_IN, attempt: 3 } });
    renderPanel({ host: 'page' });
    expect(onSignedIn).not.toHaveBeenCalled();

    act(() => emit(makeSnapshot({ signIn: { ...IDLE_SIGN_IN, phase: 'completed', attempt: 4 } })));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('ignores a completion already on the controller when the page mounted', () => {
    snapshot = makeSnapshot({ signIn: { ...IDLE_SIGN_IN, phase: 'completed', attempt: 3 } });
    renderPanel({ host: 'page' });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('leaves the dialog’s completions to the controller, which closes it', () => {
    renderPanel({ host: 'dialog' });
    act(() => emit(makeSnapshot({ signIn: { ...IDLE_SIGN_IN, phase: 'completed', attempt: 9 } })));
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe('InlineCommonsQr — the embedded QR', () => {
  /**
   * `onLayout` is the one signal the block is on screen. The RN stub renders a
   * plain `<div>` and forwards no layout, so the handler is reached on the
   * stub `View`'s own fiber, one above that node.
   */
  const layOut = (width: number) =>
    act(() => {
      const node = screen.getByTestId('inline-commons-qr') as unknown as Record<string, { return?: { memoizedProps?: { onLayout?: (e: unknown) => void } } }>;
      const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber'));
      node[fiberKey as string].return?.memoizedProps?.onLayout?.({
        nativeEvent: { layout: { width, height: width, x: 0, y: 0 } },
      });
    });

  it('asks for a code only once it is laid out on screen, never while hidden', () => {
    render(<InlineCommonsQr controller={controller as never} />);
    expect(controller.startInlineQr).not.toHaveBeenCalled();

    layOut(0);
    expect(controller.startInlineQr).not.toHaveBeenCalled();
    layOut(128);
    expect(controller.startInlineQr).toHaveBeenCalledTimes(1);
  });

  it('draws the code it was given', () => {
    snapshot = makeSnapshot({
      signIn: { ...IDLE_SIGN_IN, phase: 'waiting', inline: true, qrPayload: 'oxycommons://approve?code=C', route: 'qr' },
    });
    render(<InlineCommonsQr controller={controller as never} />);
    expect(screen.getByTestId('qrcode').textContent).toBe('oxycommons://approve?code=C');
  });

  it('replaces an expired code by itself', () => {
    snapshot = makeSnapshot({ signIn: { ...IDLE_SIGN_IN, phase: 'error', failure: 'expired', inline: true, attempt: 2 } });
    render(<InlineCommonsQr controller={controller as never} />);
    expect(controller.startInlineQr).toHaveBeenCalledTimes(1);
  });

  it('withdraws its own live request on the way out, and leaves anyone else’s alone', () => {
    snapshot = makeSnapshot({ signIn: { ...IDLE_SIGN_IN, phase: 'waiting', inline: true } });
    const first = render(<InlineCommonsQr controller={controller as never} />);
    layOut(128);
    first.unmount();
    expect(controller.cancelSignIn).toHaveBeenCalledTimes(1);

    controller.cancelSignIn.mockClear();
    snapshot = makeSnapshot({ signIn: { ...IDLE_SIGN_IN, phase: 'waiting', inline: false } });
    const second = render(<InlineCommonsQr controller={controller as never} />);
    layOut(128);
    second.unmount();
    expect(controller.cancelSignIn).not.toHaveBeenCalled();
  });
});

describe('OxySignUpPanel', () => {
  it('on the web, creates the account on auth.oxy.so, in this tab', () => {
    render(<OxySignUpPanel onSignIn={jest.fn()} />);
    fireEvent.click(screen.getByTestId('signup-open-identity'));
    expect(continueOnAuth).toHaveBeenCalledWith('signup');
  });

  it('on native, creates the identity in Commons when it is installed', async () => {
    isWebBrowserMock.mockReturnValue(false);
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    snapshot = makeSnapshot({ commonsAvailability: 'available' });
    render(<OxySignUpPanel onSignIn={jest.fn()} />);

    fireEvent.click(screen.getByTestId('signup-commons'));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith('oxycommons://create-identity'));
    openURL.mockRestore();
  });

  it('goes back to signing in', () => {
    const onSignIn = jest.fn();
    render(<OxySignUpPanel onSignIn={onSignIn} />);
    fireEvent.click(screen.getByTestId('back-to-sign-in'));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});
