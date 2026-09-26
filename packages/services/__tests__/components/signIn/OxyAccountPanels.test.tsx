/**
 * The account screens built on the sign-in shell:
 *
 *  - `OxySignUpPanel` — username → email → code → signed in (every platform);
 *  - `OxyDeleteAccountPanel` — typed username → a code by email (+ the
 *    authenticator's) → deleted and signed out;
 *  - `OxyPasswordPanel` — set or change the password, confirmed by email code
 *    or the current password;
 *  - `OxyAuthenticatorPanel` — set up (QR, first code, backup codes shown
 *    once), new backup codes, turn off.
 *
 * `oxyServices` is a double, so these assert what each step SENDS and when a
 * session is committed.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Clipboard, Linking } from 'react-native';
import type { LoginSessionResult, SignInMethods } from '@oxy.so/contracts';

const SESSION: LoginSessionResult = {
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-1',
  deviceSecret: 'secret-1',
  user: { id: 'user-1', username: 'ada' },
};
const TICKET = 'T'.repeat(43);
const BACKUP_CODES = Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}`);
const apiError = (code: string, status = 401) => Object.assign(new Error(code), { code, status });

const oxyServices = {
  checkUsernameAvailability: jest.fn(async (_username: string) => ({ available: true, message: '' })),
  startEmailVerification: jest.fn(async (_request: unknown) => ({ verificationId: 'v-1', expiresAt: 1_900_000_000_000 })),
  confirmEmailVerification: jest.fn(async (_id: string, _code: string) => ({
    ticket: TICKET,
    expiresAt: 1_900_000_000_000,
    username: null as string | null,
  })),
  signUp: jest.fn(async (_request: unknown): Promise<LoginSessionResult> => SESSION),
  requestReauthEmailCode: jest.fn(async (_action: string) => ({ verificationId: 'r-1', expiresAt: 1_900_000_000_000 })),
  deleteAccountWithEmailCode: jest.fn(async (_confirmText: string, _reauth: unknown) => ({ message: 'deleted' })),
  setPassword: jest.fn(async (_request: unknown) => ({ success: true as const })),
  enrollTotp: jest.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Oxy:ada?secret=JBSWY3DPEHPK3PXP' })),
  confirmTotp: jest.fn(async (_code: string, _reauth: unknown) => BACKUP_CODES),
  regenerateTotpBackupCodes: jest.fn(async (_reauth: unknown) => BACKUP_CODES),
  disableTotp: jest.fn(async (_reauth: unknown) => ({ success: true as const })),
};
const handleWebSession = jest.fn(async (_session: unknown) => undefined);
const logout = jest.fn(async () => undefined);
let user: { id: string; username: string; publicKey?: string } | null = { id: 'user-1', username: 'ada' };
let methods: SignInMethods = { hasEmail: true, hasPassword: false, totpEnabled: false, backupCodesRemaining: 0 };
let snapshot = { commonsAvailability: 'unknown' };
const dialogController = {};

jest.mock('../../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({ oxyServices, handleWebSession, logout, user, accountDialogController: dialogController }),
  useOptionalOxy: () => null,
}));

jest.mock('../../../src/ui/hooks/accountDialogSnapshot', () => ({
  __esModule: true,
  useAccountDialogSnapshot: () => snapshot,
}));

jest.mock('../../../src/ui/hooks/queries/useAuthMethods', () => ({
  __esModule: true,
  useSignInMethods: () => ({ data: methods }),
}));

const invalidateQueries = jest.fn();
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

// eslint-disable-next-line import/first
import { OxySignUpPanel } from '../../../src/ui/components/signIn/OxySignUpPanel';
// eslint-disable-next-line import/first
import { clearSignInFlows } from '../../../src/ui/components/signIn/signInFlowStore';
// eslint-disable-next-line import/first
import { OxyDeleteAccountPanel } from '../../../src/ui/components/signIn/OxyDeleteAccountPanel';
// eslint-disable-next-line import/first
import { OxyPasswordPanel } from '../../../src/ui/components/signIn/OxyPasswordPanel';
// eslint-disable-next-line import/first
import { OxyAuthenticatorPanel } from '../../../src/ui/components/signIn/OxyAuthenticatorPanel';

const type = (testID: string, value: string) => fireEvent.change(screen.getByTestId(testID), { target: { value } });
const press = (testID: string) => fireEvent.click(screen.getByTestId(testID));
const alertText = () => screen.getByRole('alert').textContent;

beforeEach(() => {
  jest.clearAllMocks();
  user = { id: 'user-1', username: 'ada' };
  methods = { hasEmail: true, hasPassword: false, totpEnabled: false, backupCodesRemaining: 0 };
  snapshot = { commonsAvailability: 'unknown' };
  isWebBrowserMock.mockReturnValue(true);
});

describe('creating an account', () => {
  it('walks username → email → code, and signs in with the confirmed email', async () => {
    const onSignedIn = jest.fn();
    render(<OxySignUpPanel onSignedIn={onSignedIn} onSignIn={jest.fn()} />);

    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    expect(oxyServices.checkUsernameAvailability).toHaveBeenCalledWith('ada');
    expect(screen.getByText("You can add a password or an authenticator app later, in your account's security settings.")).toBeTruthy();

    type('signup-email', ' Ada@Example.com ');
    press('signup-email-continue');
    await screen.findByTestId('email-code');
    expect(oxyServices.startEmailVerification).toHaveBeenCalledWith({ purpose: 'signup', email: 'ada@example.com' });
    expect(screen.getByText('We sent a 6-digit code to ada@example.com.')).toBeTruthy();

    // Six digits submit by themselves.
    type('email-code', '123456');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.confirmEmailVerification).toHaveBeenCalledWith('v-1', '123456');
    expect(oxyServices.signUp).toHaveBeenCalledWith({ username: 'ada', email: 'ada@example.com', emailTicket: TICKET });
    expect(handleWebSession).toHaveBeenCalledWith(SESSION);
  });

  it('stops at a taken username', async () => {
    oxyServices.checkUsernameAvailability.mockResolvedValueOnce({ available: false, message: '' });
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);

    type('signup-username', 'ada');
    press('signup-username-continue');
    await waitFor(() => expect(alertText()).toBe('That username is taken.'));
    expect(screen.queryByTestId('signup-email')).toBeNull();
  });

  it('goes back to the username when it was taken meanwhile', async () => {
    oxyServices.signUp.mockRejectedValueOnce(apiError('USERNAME_TAKEN', 409));
    const onSignedIn = jest.fn();
    render(<OxySignUpPanel onSignedIn={onSignedIn} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    type('signup-email', 'ada@example.com');
    press('signup-email-continue');
    await screen.findByTestId('email-code');
    type('email-code', '123456');

    await screen.findByTestId('signup-username');
    expect(alertText()).toBe('That username is taken.');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('says a wrong code is wrong and stays on it', async () => {
    oxyServices.confirmEmailVerification.mockRejectedValueOnce(apiError('EMAIL_CODE_INVALID'));
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    type('signup-email', 'ada@example.com');
    press('signup-email-continue');
    await screen.findByTestId('email-code');
    type('email-code', '000000');

    await waitFor(() => expect(alertText()).toBe("That code isn't right, or it has expired."));
    expect(oxyServices.signUp).not.toHaveBeenCalled();
  });

  it('refuses an address that is not one', () => {
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    return screen.findByTestId('signup-email').then(() => {
      type('signup-email', 'not-an-email');
      press('signup-email-continue');
      expect(alertText()).toBe('Enter a valid email address.');
      expect(oxyServices.startEmailVerification).not.toHaveBeenCalled();
    });
  });

  it('offers Commons instead: its store page on the web', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    press('signup-commons-instead');
    await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
    expect(openURL.mock.calls[0][0]).not.toBe('oxycommons://create-identity');
    openURL.mockRestore();
  });

  it('offers Commons instead: straight into it on native when it is installed', async () => {
    isWebBrowserMock.mockReturnValue(false);
    snapshot = { commonsAvailability: 'available' };
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    press('signup-commons-instead');
    await waitFor(() => expect(openURL).toHaveBeenCalledWith('oxycommons://create-identity'));
    openURL.mockRestore();
  });

  it('goes back to signing in', () => {
    const onSignIn = jest.fn();
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={onSignIn} />);
    press('back-to-sign-in');
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('creating an account in the dialog', () => {
  it('keeps its step across a remount of the screen, and not on a page', async () => {
    clearSignInFlows(dialogController);
    const first = render(<OxySignUpPanel host="dialog" onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    type('signup-email', 'ada@example.com');
    first.unmount();

    const second = render(<OxySignUpPanel host="dialog" onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    expect((screen.getByTestId('signup-email') as HTMLInputElement).value).toBe('ada@example.com');
    second.unmount();

    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    expect(screen.getByTestId('signup-username')).toBeTruthy();
    clearSignInFlows(dialogController);
  });
});

describe('deleting an account without a key', () => {
  it('needs the typed username, then a code by email; then deletes and signs out', async () => {
    const onDeleted = jest.fn();
    render(<OxyDeleteAccountPanel onDeleted={onDeleted} />);

    // Nothing is sent before the username is typed.
    press('reauth-send-code');
    expect(alertText()).toBe('Type "ada" to confirm');
    expect(oxyServices.requestReauthEmailCode).not.toHaveBeenCalled();

    type('delete-account-confirm', 'ada');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    expect(oxyServices.requestReauthEmailCode).toHaveBeenCalledWith('delete_account');

    type('reauth-code', '123456');
    press('reauth-submit');
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(oxyServices.deleteAccountWithEmailCode).toHaveBeenCalledWith('ada', {
      emailCode: { verificationId: 'r-1', code: '123456' },
    });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Your account is deleted.')).toBeTruthy();
  });

  it('asks for the authenticator code too when the account has one', async () => {
    methods = { ...methods, totpEnabled: true, backupCodesRemaining: 10 };
    render(<OxyDeleteAccountPanel />);
    type('delete-account-confirm', 'ada');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    type('reauth-code', '123456');

    press('reauth-submit');
    expect(alertText()).toBe('Enter the code from your authenticator app too.');
    expect(oxyServices.deleteAccountWithEmailCode).not.toHaveBeenCalled();

    type('reauth-totp', '654321');
    press('reauth-submit');
    await waitFor(() =>
      expect(oxyServices.deleteAccountWithEmailCode).toHaveBeenCalledWith('ada', {
        emailCode: { verificationId: 'r-1', code: '123456' },
        totpCode: '654321',
      }),
    );
  });

  it('never offers the password: deleting takes an emailed code', () => {
    methods = { ...methods, hasPassword: true };
    render(<OxyDeleteAccountPanel />);
    expect(screen.queryByTestId('reauth-password')).toBeNull();
    expect(screen.queryByTestId('reauth-switch-method')).toBeNull();
  });

  it('keeps the account when the code is wrong', async () => {
    oxyServices.deleteAccountWithEmailCode.mockRejectedValueOnce(apiError('REAUTH_INVALID'));
    render(<OxyDeleteAccountPanel />);
    type('delete-account-confirm', 'ada');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    type('reauth-code', '000000');
    press('reauth-submit');

    await waitFor(() => expect(alertText()).toBe("That didn't work. Check what you typed and try again."));
    expect(logout).not.toHaveBeenCalled();
  });

  it('sends a keyed account to Commons instead', () => {
    user = { id: 'user-1', username: 'ada', publicKey: '04ab' };
    render(<OxyDeleteAccountPanel />);
    expect(screen.getByText('Delete your account in Oxy Commons')).toBeTruthy();
    expect(screen.queryByTestId('reauth-send-code')).toBeNull();
  });
});

describe('the password', () => {
  it('sets a first one, confirmed with a code by email', async () => {
    const onDone = jest.fn();
    render(<OxyPasswordPanel onDone={onDone} />);
    expect(screen.getByText('Set a password')).toBeTruthy();
    expect(screen.queryByTestId('reauth-switch-method')).toBeNull();

    type('password-new', 'a long enough password');
    type('password-repeat', 'a long enough password');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    expect(oxyServices.requestReauthEmailCode).toHaveBeenCalledWith('change_password');
    type('reauth-code', '123456');
    press('reauth-submit');

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(oxyServices.setPassword).toHaveBeenCalledWith({
      newPassword: 'a long enough password',
      reauth: { emailCode: { verificationId: 'r-1', code: '123456' } },
      revokeOtherSessions: false,
    });
  });

  it('changes it with the current one, and can sign out everywhere else', async () => {
    methods = { ...methods, hasPassword: true };
    render(<OxyPasswordPanel />);
    expect(screen.getByText('Change your password')).toBeTruthy();

    type('password-new', 'a brand new password');
    type('password-repeat', 'a brand new password');
    fireEvent.click(screen.getByTestId('password-sign-out-others'));
    type('reauth-password', 'the old password');
    press('reauth-submit');

    await waitFor(() =>
      expect(oxyServices.setPassword).toHaveBeenCalledWith({
        newPassword: 'a brand new password',
        reauth: { password: 'the old password' },
        revokeOtherSessions: true,
      }),
    );
  });

  it('refuses a short one or two that differ, before sending anything', () => {
    render(<OxyPasswordPanel />);
    type('password-new', 'short');
    type('password-repeat', 'short');
    press('reauth-send-code');
    expect(alertText()).toBe('Use at least 10 characters.');

    type('password-new', 'a long enough password');
    type('password-repeat', 'a different long one');
    press('reauth-send-code');
    expect(alertText()).toBe("The passwords don't match.");
    expect(oxyServices.requestReauthEmailCode).not.toHaveBeenCalled();
  });
});

describe('the authenticator app', () => {
  it('sets it up: QR and key, the first code, then the backup codes once', async () => {
    const copy = jest.spyOn(Clipboard, 'setString').mockImplementation(() => undefined);
    render(<OxyAuthenticatorPanel />);

    press('totp-set-up');
    expect((await screen.findByTestId('qrcode')).textContent).toBe('otpauth://totp/Oxy:ada?secret=JBSWY3DPEHPK3PXP');
    expect(screen.getByTestId('totp-secret').textContent).toBe('JBSW Y3DP EHPK 3PXP');

    type('totp-enroll-code', '123456');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    expect(oxyServices.requestReauthEmailCode).toHaveBeenCalledWith('totp');
    type('reauth-code', '111111');
    press('reauth-submit');

    const codes = await screen.findByTestId('totp-backup-codes');
    expect(oxyServices.confirmTotp).toHaveBeenCalledWith('123456', { emailCode: { verificationId: 'r-1', code: '111111' } });
    expect(codes.textContent).toContain(BACKUP_CODES[0]);
    expect(invalidateQueries).toHaveBeenCalled();

    press('totp-copy-codes');
    await waitFor(() => expect(copy).toHaveBeenCalledWith(BACKUP_CODES.join('\n')));
    copy.mockRestore();
  });

  it('refuses a first code that is not 6 digits', async () => {
    render(<OxyAuthenticatorPanel />);
    press('totp-set-up');
    await screen.findByTestId('totp-enroll-code');
    press('reauth-send-code');
    expect(alertText()).toBe("That code isn't right. Try the current one.");
  });

  it('when on: new backup codes and turning it off, each with the app\'s code', async () => {
    methods = { ...methods, hasPassword: true, totpEnabled: true, backupCodesRemaining: 7 };
    const view = render(<OxyAuthenticatorPanel />);
    expect(screen.getByTestId('totp-remaining').textContent).toBe('7 backup codes left');

    press('totp-regenerate');
    type('reauth-password', 'pw');
    type('reauth-totp', '222222');
    press('reauth-submit');
    await screen.findByTestId('totp-backup-codes');
    expect(oxyServices.regenerateTotpBackupCodes).toHaveBeenCalledWith({ password: 'pw', totpCode: '222222' });
    view.unmount();

    const onDone = jest.fn();
    render(<OxyAuthenticatorPanel onDone={onDone} />);
    press('totp-disable');
    type('reauth-password', 'pw');
    type('reauth-totp', 'abcde-fgh23');
    press('reauth-submit');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(oxyServices.disableTotp).toHaveBeenCalledWith({ password: 'pw', totpCode: 'abcde-fgh23' });
  });
});
