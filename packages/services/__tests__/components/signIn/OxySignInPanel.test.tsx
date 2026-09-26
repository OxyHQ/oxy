/**
 * `OxySignInPanel` / `OxyAccountPicker` — THE sign-in screen, the one the
 * account dialog renders (`host="dialog"`) and auth.oxy.so renders as a page
 * (`host="page"`): an email or username, then the code or link from the email,
 * the password, and the authenticator — all in place.
 *
 * The headless `AccountDialogController` and `oxyServices` are doubles.
 * Layout (the `md:` split, which of the QR and "Continue with Oxy" shows) is
 * NativeWind and not observable in jsdom, so these tests assert what each
 * platform OFFERS and what each action DOES.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Linking } from 'react-native';
import { toast } from '@oxy.so/bloom';
import type { DeviceDirectory, LoginSessionResult } from '@oxy.so/contracts';
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

const SESSION: LoginSessionResult = {
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-1',
  deviceSecret: 'secret-1',
  user: { id: 'user-1', username: 'ada' },
};
const REQUEST = { requestId: 'req-1', requestSecret: 'S'.repeat(43), expiresAt: 1_900_000_000_000 };
const CHALLENGE = { secondFactorRequired: true as const, challengeId: 'C'.repeat(43), expiresAt: 1_900_000_000_000 };
const PENDING = { status: 'pending' as const, expiresAt: 1_900_000_000_000 };
const apiError = (code: string, status = 401, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { code, status, ...(details ? { details } : {}) });

const oxyServices = {
  getFileDownloadUrl: (id: string) => `https://cdn/${id}`,
  startEmailSignIn: jest.fn(async (_identifier: string): Promise<Record<string, unknown>> => REQUEST),
  confirmEmailSignIn: jest.fn(async (_request: unknown): Promise<unknown> => SESSION),
  collectEmailSignIn: jest.fn(async (_request: unknown): Promise<unknown> => PENDING),
  signInWithPassword: jest.fn(async (_request: unknown): Promise<unknown> => SESSION),
  completeSecondFactor: jest.fn(async (_request: unknown): Promise<unknown> => SESSION),
};
const handleWebSession = jest.fn(async (_session: unknown) => undefined);
const openAccountDialog = jest.fn();
const invalidateQueries = jest.fn();

jest.mock('../../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    accountDialogController: controller,
    openAccountDialog,
    oxyServices,
    handleWebSession,
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

// eslint-disable-next-line import/first
import {
  EMAIL_RESEND_COOLDOWN_SECONDS,
  EMAIL_SIGNIN_POLL_MS,
  OxySignInPanel,
} from '../../../src/ui/components/signIn/OxySignInPanel';
// eslint-disable-next-line import/first
import { clearSignInFlows } from '../../../src/ui/components/signIn/signInFlowStore';
// eslint-disable-next-line import/first
import { InlineCommonsQr } from '../../../src/ui/components/signIn/InlineCommonsQr';

const onSignedIn = jest.fn();
const onCreateAccount = jest.fn();
const renderPanel = (props: Partial<React.ComponentProps<typeof OxySignInPanel>> = {}) =>
  render(<OxySignInPanel onSignedIn={onSignedIn} onCreateAccount={onCreateAccount} {...props} />);

const type = (testID: string, value: string) => fireEvent.change(screen.getByTestId(testID), { target: { value } });
const press = (testID: string) => fireEvent.click(screen.getByTestId(testID));
const alertText = () => screen.getByRole('alert').textContent;

/** Identifier → "Check your email". */
const reachCheckEmail = async (identifier = 'ada@example.com') => {
  type('signin-identifier', identifier);
  press('signin-identifier-continue');
  await screen.findByTestId('signin-code');
};

beforeEach(() => {
  jest.clearAllMocks();
  clearSignInFlows(controller);
  listeners = [];
  snapshot = makeSnapshot();
  isWebBrowserMock.mockReturnValue(true);
  oxyServices.startEmailSignIn.mockImplementation(async () => REQUEST);
  oxyServices.confirmEmailSignIn.mockImplementation(async () => SESSION);
  oxyServices.collectEmailSignIn.mockImplementation(async () => PENDING);
  oxyServices.signInWithPassword.mockImplementation(async () => SESSION);
  oxyServices.completeSecondFactor.mockImplementation(async () => SESSION);
  handleWebSession.mockImplementation(async () => undefined);
  controller.chooseContext.mockImplementation(async () => 'signing-in');
});


describe('the entry — an email or username, and the Commons way in', () => {
  it('on the web: the QR, "Continue with Oxy" below `md`, the email field and its Continue', () => {
    renderPanel();

    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.getByTestId('inline-commons-qr')).toBeTruthy();
    expect(screen.getByTestId('continue-with-oxy')).toBeTruthy();
    expect(screen.getByText('or continue with')).toBeTruthy();
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
    expect(screen.getByTestId('signin-identifier-continue')).toBeTruthy();
    expect(screen.getByTestId('create-account-link')).toBeTruthy();
    expect(screen.getByText('Terms of Service')).toBeTruthy();
    // No passkey, no window, no recovery page.
    expect(screen.queryByTestId('passkey-sign-in')).toBeNull();
    expect(screen.queryByTestId('recover-link')).toBeNull();
  });

  it('is the same in an app\'s dialog: sign-in happens here, "Continue with Oxy" runs here', () => {
    renderPanel({ host: 'dialog' });
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
    fireEvent.click(screen.getByTestId('continue-with-oxy'));
    expect(controller.signInWithOxy).toHaveBeenCalledTimes(1);
    expect(openAccountDialog).not.toHaveBeenCalled();
  });

  it('on native: "Continue with Oxy", then the email field — no QR', () => {
    isWebBrowserMock.mockReturnValue(false);
    renderPanel({ host: 'dialog' });

    expect(screen.queryByTestId('inline-commons-qr')).toBeNull();
    expect(screen.getByTestId('continue-with-oxy')).toBeTruthy();
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
    fireEvent.click(screen.getByTestId('continue-with-oxy'));
    expect(controller.signInWithOxy).toHaveBeenCalledTimes(1);
  });

  it('on native without Commons: "Get Commons", and still the email field', async () => {
    isWebBrowserMock.mockReturnValue(false);
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    snapshot = makeSnapshot({ commonsAvailability: 'unavailable' });
    renderPanel({ host: 'dialog' });

    expect(screen.queryByTestId('continue-with-oxy')).toBeNull();
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
    fireEvent.click(screen.getByTestId('get-commons-button'));
    await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
    openURL.mockRestore();
  });

  it('asks for an email or username instead of sending nothing', () => {
    renderPanel();
    press('signin-identifier-continue');
    expect(oxyServices.startEmailSignIn).not.toHaveBeenCalled();
    expect(alertText()).toBe('Enter your email or username.');
  });

  it('pre-fills a login hint and skips the account picker', () => {
    snapshot = makeSnapshot({ directory: directory('ctx-alice') });
    renderPanel({ loginHint: 'alice' });

    expect((screen.getByTestId('signin-identifier') as HTMLInputElement).value).toBe('alice');
    expect(screen.queryByText('Choose an account')).toBeNull();
  });

  it('leads to account creation from "Create account"', () => {
    renderPanel();
    press('create-account-link');
    expect(onCreateAccount).toHaveBeenCalledTimes(1);
  });
});

describe('"Check your email" — the code or the link', () => {
  it('sends the email and says where it went, without saying whether the account exists', async () => {
    renderPanel();
    await reachCheckEmail(' ada ');

    expect(oxyServices.startEmailSignIn).toHaveBeenCalledWith('ada');
    expect(screen.getByText('Check your email')).toBeTruthy();
    expect(screen.getByText('If an account matches ada, we sent it a code and a sign-in link.')).toBeTruthy();
    // The QR belongs to the entry only; the photo carousel stays.
    expect(screen.queryByTestId('inline-commons-qr')).toBeNull();
    expect(screen.getByTestId('auth-media-carousel')).toBeTruthy();
  });

  it('signs in once the 6-digit code is typed — no press needed', async () => {
    renderPanel();
    await reachCheckEmail();
    type('signin-code', '123456');

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.confirmEmailSignIn).toHaveBeenCalledWith({
      requestId: REQUEST.requestId,
      requestSecret: REQUEST.requestSecret,
      code: '123456',
    });
    expect(handleWebSession).toHaveBeenCalledWith(SESSION);
  });

  it('takes the 10-character long code in the same field, with or without its dash, any case', async () => {
    renderPanel();
    await reachCheckEmail();

    // Being typed with its dash: never mistaken for 6 digits.
    type('signin-code', '23456-');
    expect(oxyServices.confirmEmailSignIn).not.toHaveBeenCalled();
    type('signin-code', '23456-abcde');

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.confirmEmailSignIn).toHaveBeenCalledWith(expect.objectContaining({ code: '23456-ABCDE' }));
  });

  it('takes a pasted long code without its dash', async () => {
    renderPanel();
    await reachCheckEmail();
    type('signin-code', 'k7m2pq9xrt');

    await waitFor(() => expect(oxyServices.confirmEmailSignIn).toHaveBeenCalledWith(expect.objectContaining({ code: 'K7M2PQ9XRT' })));
  });

  it('says a wrong code is wrong, clears it, and stays', async () => {
    oxyServices.confirmEmailSignIn.mockRejectedValueOnce(apiError('EMAIL_CODE_INVALID'));
    renderPanel();
    await reachCheckEmail();
    type('signin-code', '000000');

    await waitFor(() => expect(alertText()).toBe("That code isn't right, or it has expired."));
    expect((screen.getByTestId('signin-code') as HTMLInputElement).value).toBe('');
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(handleWebSession).not.toHaveBeenCalled();
  });

  it('signs in when the email\'s link is opened in this browser (the collect poll)', async () => {
    jest.useFakeTimers();
    try {
      renderPanel({ host: 'dialog' });
      await reachCheckEmail();

      await act(async () => {
        jest.advanceTimersByTime(EMAIL_SIGNIN_POLL_MS);
      });
      expect(oxyServices.collectEmailSignIn).toHaveBeenCalledWith({
        requestId: REQUEST.requestId,
        requestSecret: REQUEST.requestSecret,
      });
      expect(onSignedIn).not.toHaveBeenCalled();

      oxyServices.collectEmailSignIn.mockResolvedValueOnce(SESSION);
      await act(async () => {
        jest.advanceTimersByTime(EMAIL_SIGNIN_POLL_MS);
      });
      expect(handleWebSession).toHaveBeenCalledWith(SESSION);
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('commits a session the link handed over even when the dialog re-renders meanwhile', async () => {
    jest.useFakeTimers();
    try {
      let handOver: (value: unknown) => void = () => undefined;
      const view = renderPanel({ host: 'dialog' });
      await reachCheckEmail();
      oxyServices.collectEmailSignIn.mockImplementationOnce(
        () => new Promise((resolve) => {
          handOver = resolve;
        }),
      );
      await act(async () => {
        jest.advanceTimersByTime(EMAIL_SIGNIN_POLL_MS);
      });
      // The parent re-renders with a new callback while the collect is in flight.
      const nextOnSignedIn = jest.fn();
      view.rerender(<OxySignInPanel host="dialog" onSignedIn={nextOnSignedIn} onCreateAccount={onCreateAccount} />);
      await act(async () => {
        handOver(SESSION);
      });

      expect(handleWebSession).toHaveBeenCalledWith(SESSION);
      expect(nextOnSignedIn).toHaveBeenCalledTimes(1);
      expect(oxyServices.collectEmailSignIn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops asking once the step goes away', async () => {
    jest.useFakeTimers();
    try {
      const view = renderPanel();
      await reachCheckEmail();
      view.unmount();
      await act(async () => {
        jest.advanceTimersByTime(EMAIL_SIGNIN_POLL_MS * 3);
      });
      expect(oxyServices.collectEmailSignIn).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('holds "Send a new email" for its cooldown, then sends a new one', async () => {
    jest.useFakeTimers();
    try {
      renderPanel();
      await reachCheckEmail();

      const resend = screen.getByTestId('signin-resend') as HTMLButtonElement;
      expect(resend.disabled).toBe(true);
      expect(screen.getByText(`Send a new email in ${EMAIL_RESEND_COOLDOWN_SECONDS}s`)).toBeTruthy();

      for (let i = 0; i < EMAIL_RESEND_COOLDOWN_SECONDS; i += 1) {
        // biome-ignore lint/nursery/noAwaitInLoop: one tick per second, in order
        await act(async () => {
          jest.advanceTimersByTime(1000);
        });
      }
      expect((screen.getByTestId('signin-resend') as HTMLButtonElement).disabled).toBe(false);
      oxyServices.startEmailSignIn.mockResolvedValueOnce({ ...REQUEST, requestId: 'req-2' });
      press('signin-resend');
      await waitFor(() => expect(screen.getByTestId('signin-notice').textContent).toBe('We sent a new email.'));
      expect(oxyServices.startEmailSignIn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts down after a 429 and holds the code until it may retry', async () => {
    oxyServices.confirmEmailSignIn.mockRejectedValueOnce(apiError('SIGNIN_LOCKED', 429, { retryAfterSeconds: 42 }));
    renderPanel();
    await reachCheckEmail();
    type('signin-code', '111111');

    await waitFor(() => expect(alertText()).toBe('Too many attempts. Try again in 42s.'));
    expect((screen.getByTestId('signin-code-continue') as HTMLButtonElement).disabled).toBe(true);
  });

  it('goes back to the entry with "Use a different account"', async () => {
    renderPanel();
    await reachCheckEmail();
    press('signin-different-account');
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
  });

  it('says so when this device asked for too many emails', async () => {
    oxyServices.startEmailSignIn.mockResolvedValueOnce({ ...REQUEST, retryLater: true });
    renderPanel();
    type('signin-identifier', 'ada');
    press('signin-identifier-continue');

    await waitFor(() => expect(alertText()).toBe('We sent several emails already. Wait a few minutes and try again.'));
    expect(screen.queryByTestId('signin-code')).toBeNull();
  });
});

describe('in the dialog, the step outlives a remount of the screen', () => {
  // Bloom's responsive surface renders a bottom sheet below `md` and a centered
  // card from `md`: crossing the breakpoint remounts the screen inside. The
  // person must stay on their step — the e2e found them back at "Sign in" with
  // their emailed code already spent.
  it('keeps "Two-step verification" and its challenge across a remount', async () => {
    oxyServices.confirmEmailSignIn.mockResolvedValueOnce(CHALLENGE);
    const first = renderPanel({ host: 'dialog' });
    await reachCheckEmail('ada');
    type('signin-code', '123456');
    await screen.findByTestId('signin-second-factor');
    first.unmount();

    renderPanel({ host: 'dialog' });
    expect(screen.getByText('Two-step verification')).toBeTruthy();
    type('signin-second-factor', '654321');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.completeSecondFactor).toHaveBeenCalledWith({ challengeId: CHALLENGE.challengeId, code: '654321' });
  });

  it('keeps "Check your email", its request (the link poll resumes) and the resend cooldown', async () => {
    jest.useFakeTimers();
    try {
      const first = renderPanel({ host: 'dialog' });
      await reachCheckEmail('ada');
      first.unmount();

      renderPanel({ host: 'dialog' });
      expect(screen.getByText('If an account matches ada, we sent it a code and a sign-in link.')).toBeTruthy();
      expect((screen.getByTestId('signin-resend') as HTMLButtonElement).disabled).toBe(true);
      oxyServices.collectEmailSignIn.mockResolvedValueOnce(SESSION);
      await act(async () => {
        jest.advanceTimersByTime(EMAIL_SIGNIN_POLL_MS);
      });
      expect(oxyServices.collectEmailSignIn).toHaveBeenCalledWith({ requestId: REQUEST.requestId, requestSecret: REQUEST.requestSecret });
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts over once the dialog closed, and after a sign-in', async () => {
    const first = renderPanel({ host: 'dialog' });
    await reachCheckEmail('ada');
    first.unmount();
    clearSignInFlows(controller); // what `OxyContext` does when the dialog closes
    const second = renderPanel({ host: 'dialog' });
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
    await reachCheckEmail('ada');
    type('signin-code', '123456');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    second.unmount();

    renderPanel({ host: 'dialog' });
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
  });

  it('a page of its own does not keep it', async () => {
    const first = renderPanel({ host: 'page' });
    await reachCheckEmail('ada');
    first.unmount();
    renderPanel({ host: 'page' });
    expect(screen.getByTestId('signin-identifier')).toBeTruthy();
  });
});

describe('the password, instead of the email', () => {
  it('signs in with the password for the same identifier', async () => {
    renderPanel();
    await reachCheckEmail('ada');
    press('signin-use-password');
    type('signin-password', 'correct horse battery');
    press('signin-password-continue');

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.signInWithPassword).toHaveBeenCalledWith({ identifier: 'ada', password: 'correct horse battery' });
    expect(handleWebSession).toHaveBeenCalledWith(SESSION);
  });

  it('answers a wrong password without saying which half was wrong', async () => {
    oxyServices.signInWithPassword.mockRejectedValueOnce(apiError('SIGNIN_INVALID_CREDENTIALS'));
    renderPanel();
    await reachCheckEmail('ada');
    press('signin-use-password');
    type('signin-password', 'nope');
    press('signin-password-continue');

    await waitFor(() => expect(alertText()).toBe("That username, email or password isn't right."));
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('"Forgot it?" sends the email and goes back to the code', async () => {
    renderPanel();
    await reachCheckEmail('ada');
    press('signin-use-password');
    press('signin-password-forgot');

    await screen.findByTestId('signin-code');
    expect(oxyServices.startEmailSignIn).toHaveBeenCalledTimes(2);
    expect(oxyServices.startEmailSignIn).toHaveBeenLastCalledWith('ada');
  });
});

describe('the authenticator — the second step', () => {
  it('asks for the app\'s code after the email code, and signs in with it', async () => {
    oxyServices.confirmEmailSignIn.mockResolvedValueOnce(CHALLENGE);
    renderPanel();
    await reachCheckEmail();
    type('signin-code', '123456');

    await screen.findByTestId('signin-second-factor');
    expect(screen.getByText('Two-step verification')).toBeTruthy();
    expect(handleWebSession).not.toHaveBeenCalled();

    type('signin-second-factor', '654321');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.completeSecondFactor).toHaveBeenCalledWith({ challengeId: CHALLENGE.challengeId, code: '654321' });
    expect(handleWebSession).toHaveBeenCalledWith(SESSION);
  });

  it('asks after the password too', async () => {
    oxyServices.signInWithPassword.mockResolvedValueOnce(CHALLENGE);
    renderPanel();
    await reachCheckEmail('ada');
    press('signin-use-password');
    type('signin-password', 'correct horse battery');
    press('signin-password-continue');

    await screen.findByTestId('signin-second-factor');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('asks after the link too', async () => {
    jest.useFakeTimers();
    try {
      oxyServices.collectEmailSignIn.mockResolvedValueOnce(CHALLENGE);
      renderPanel();
      await reachCheckEmail();
      await act(async () => {
        jest.advanceTimersByTime(EMAIL_SIGNIN_POLL_MS);
      });
      expect(screen.getByTestId('signin-second-factor')).toBeTruthy();
      expect(handleWebSession).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('takes a backup code instead', async () => {
    oxyServices.confirmEmailSignIn.mockResolvedValueOnce(CHALLENGE);
    renderPanel();
    await reachCheckEmail();
    type('signin-code', '123456');
    await screen.findByTestId('signin-second-factor');

    press('signin-toggle-backup');
    expect(screen.getByText('Enter one of your backup codes. Each one works once.')).toBeTruthy();
    type('signin-second-factor', 'abcde-fgh23');
    press('signin-second-factor-continue');

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.completeSecondFactor).toHaveBeenCalledWith({ challengeId: CHALLENGE.challengeId, code: 'abcde-fgh23' });
  });

  it('says a wrong authenticator code is wrong', async () => {
    oxyServices.confirmEmailSignIn.mockResolvedValueOnce(CHALLENGE);
    oxyServices.completeSecondFactor.mockRejectedValueOnce(apiError('SECOND_FACTOR_INVALID'));
    renderPanel();
    await reachCheckEmail();
    type('signin-code', '123456');
    await screen.findByTestId('signin-second-factor');
    type('signin-second-factor', '000000');

    await waitFor(() => expect(alertText()).toBe("That code isn't right. Try the current one."));
    expect(onSignedIn).not.toHaveBeenCalled();
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

  it('a pair that cannot be activated falls back to signing in as it explicitly', async () => {
    controller.chooseContext.mockResolvedValueOnce('failed');
    snapshot = makeSnapshot({ directory: directory('ctx-alice'), hasSession: true });
    renderPanel({ host: 'page' });

    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    await waitFor(() => expect((screen.getByTestId('signin-identifier') as HTMLInputElement).value).toBe('alice'));
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
