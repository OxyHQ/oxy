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
import { Linking } from 'react-native';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
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
  auth: {
    checkUsername: jest.fn(async (_username: string) => ({ available: true, message: '' })),
    email: {
      startVerification: jest.fn(async (_request: unknown) => ({ verificationId: 'v-1', expiresAt: 1_900_000_000_000 })),
      confirmVerification: jest.fn(async (_id: string, _code: string) => ({
        ticket: TICKET,
        expiresAt: 1_900_000_000_000,
        username: null as string | null,
      })),
    },
    signUp: jest.fn(async (_request: unknown): Promise<LoginSessionResult> => SESSION),
    requestReauthCode: jest.fn(async (_action: string) => ({ verificationId: 'r-1', expiresAt: 1_900_000_000_000 })),
    password: {
      set: jest.fn(async (_request: unknown) => ({ success: true as const })),
    },
    totp: {
      enroll: jest.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Oxy:ada?secret=JBSWY3DPEHPK3PXP' })),
      confirm: jest.fn(async (_code: string, _reauth: unknown) => BACKUP_CODES),
      regenerateBackupCodes: jest.fn(async (_reauth: unknown) => BACKUP_CODES),
      disable: jest.fn(async (_reauth: unknown) => ({ success: true as const })),
    },
  },
  users: {
    deleteMe: jest.fn(async (_confirmText: string, _reauth: unknown) => ({ message: 'deleted' })),
  },
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

const copyText = jest.fn(async (_text: string) => undefined);
jest.mock('../../../src/ui/utils/clipboard', () => ({
  __esModule: true,
  copyText: (text: string) => copyText(text),
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

import { OxySignUpPanel } from '../../../src/ui/components/signIn/OxySignUpPanel';
import { clearSignInFlows } from '../../../src/ui/components/signIn/signInFlowStore';
import { OxyDeleteAccountPanel } from '../../../src/ui/components/signIn/OxyDeleteAccountPanel';
import { OxyPasswordPanel } from '../../../src/ui/components/signIn/OxyPasswordPanel';
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
  (surfaces.confirm as jest.Mock).mockResolvedValue(true);
});

describe('creating an account', () => {
  it('walks username → email → code, and signs in with the confirmed email', async () => {
    const onSignedIn = jest.fn();
    render(<OxySignUpPanel onSignedIn={onSignedIn} onSignIn={jest.fn()} />);

    // One bar across the three steps, named by where the person is.
    expect(screen.getByTestId('signup-progress').getAttribute('aria-label')).toBe('Step 1 of 3, Username');
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    expect(screen.getByTestId('signup-progress').textContent).toBe('Step 2 of 3');
    expect(oxyServices.auth.checkUsername).toHaveBeenCalledWith('ada');
    expect(screen.getByText("You can add a password or an authenticator app later, in your account's security settings.")).toBeTruthy();

    type('signup-email', ' Ada@Example.com ');
    press('signup-email-continue');
    await screen.findByTestId('email-code');
    expect(oxyServices.auth.email.startVerification).toHaveBeenCalledWith({ purpose: 'signup', email: 'ada@example.com' });
    expect(screen.getByText('We sent a 6-digit code to ada@example.com.')).toBeTruthy();

    // Six digits submit by themselves.
    type('email-code', '123456');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.auth.email.confirmVerification).toHaveBeenCalledWith('v-1', '123456');
    expect(oxyServices.auth.signUp).toHaveBeenCalledWith({ username: 'ada', email: 'ada@example.com', emailTicket: TICKET });
    expect(handleWebSession).toHaveBeenCalledWith(SESSION);
  });

  it('stops at a taken username', async () => {
    oxyServices.auth.checkUsername.mockResolvedValueOnce({ available: false, message: '' });
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);

    type('signup-username', 'ada');
    press('signup-username-continue');
    await waitFor(() => expect(alertText()).toBe('That username is taken.'));
    expect(screen.queryByTestId('signup-email')).toBeNull();
  });

  it('goes back to the username when it was taken meanwhile', async () => {
    oxyServices.auth.signUp.mockRejectedValueOnce(apiError('USERNAME_TAKEN', 409));
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
    oxyServices.auth.email.confirmVerification.mockRejectedValueOnce(apiError('EMAIL_CODE_INVALID'));
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    type('signup-email', 'ada@example.com');
    press('signup-email-continue');
    await screen.findByTestId('email-code');
    type('email-code', '000000');

    await waitFor(() => expect(alertText()).toBe("That code isn't right, or it has expired."));
    expect(oxyServices.auth.signUp).not.toHaveBeenCalled();
  });

  it('refuses an address that is not one', () => {
    render(<OxySignUpPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    return screen.findByTestId('signup-email').then(() => {
      type('signup-email', 'not-an-email');
      press('signup-email-continue');
      expect(alertText()).toBe('Enter a valid email address.');
      expect(oxyServices.auth.email.startVerification).not.toHaveBeenCalled();
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
    expect(oxyServices.auth.requestReauthCode).not.toHaveBeenCalled();

    type('delete-account-confirm', 'ada');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    expect(oxyServices.auth.requestReauthCode).toHaveBeenCalledWith('delete_account');

    type('reauth-code', '123456');
    press('reauth-submit');
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    // The last word before it is gone: a destructive confirm, after the proof.
    expect(surfaces.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete Account', confirmLabel: 'Delete Forever', destructive: true }),
    );
    expect(oxyServices.users.deleteMe).toHaveBeenCalledWith('ada', {
      reauth: { emailCode: { verificationId: 'r-1', code: '123456' } },
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
    expect(oxyServices.users.deleteMe).not.toHaveBeenCalled();

    type('reauth-totp', '654321');
    press('reauth-submit');
    await waitFor(() =>
      expect(oxyServices.users.deleteMe).toHaveBeenCalledWith('ada', {
        reauth: { emailCode: { verificationId: 'r-1', code: '123456' }, totpCode: '654321' },
      }),
    );
  });

  it('sends nothing when the final confirm is declined, and stays on the screen', async () => {
    (surfaces.confirm as jest.Mock).mockResolvedValueOnce(false);
    const onDeleted = jest.fn();
    render(<OxyDeleteAccountPanel onDeleted={onDeleted} />);
    type('delete-account-confirm', 'ada');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    type('reauth-code', '123456');
    press('reauth-submit');

    await waitFor(() => expect(surfaces.confirm).toHaveBeenCalledTimes(1));
    expect(oxyServices.users.deleteMe).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByTestId('reauth-code')).toBeTruthy();
  });

  it('warns in a notice, not a line of body copy', () => {
    render(<OxyDeleteAccountPanel />);
    const warning = screen.getByTestId('delete-account-warning').querySelector('[role="note"]');
    expect(warning?.getAttribute('data-admonition-type')).toBe('warning');
  });

  it('never offers the password: deleting takes an emailed code', () => {
    methods = { ...methods, hasPassword: true };
    render(<OxyDeleteAccountPanel />);
    expect(screen.queryByTestId('reauth-password')).toBeNull();
    expect(screen.queryByTestId('reauth-switch-method')).toBeNull();
  });

  it('keeps the account when the code is wrong', async () => {
    oxyServices.users.deleteMe.mockRejectedValueOnce(apiError('REAUTH_INVALID'));
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
    expect(screen.getByTestId('delete-account-keyed').textContent).toContain('delete it in Oxy Commons');
    expect(screen.queryByTestId('reauth-send-code')).toBeNull();
  });
});

describe('the password', () => {
  it('lets every password field be shown: new, repeat and the current one', () => {
    methods = { ...methods, hasPassword: true };
    render(<OxyPasswordPanel />);
    for (const id of ['password-new', 'password-repeat', 'reauth-password']) {
      const field = screen.getByTestId(id);
      expect([id, field.getAttribute('type'), field.getAttribute('data-revealable')]).toEqual([id, 'password', 'true']);
    }
  });

  it('names the sign-out-everywhere switch with its field label', () => {
    render(<OxyPasswordPanel />);
    const toggle = screen.getByTestId('password-sign-out-others');
    expect(toggle.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Sign out everywhere else');
  });

  it('sets a first one, confirmed with a code by email', async () => {
    const onDone = jest.fn();
    render(<OxyPasswordPanel onDone={onDone} />);
    expect(screen.getByText('Set a password')).toBeTruthy();
    expect(screen.queryByTestId('reauth-switch-method')).toBeNull();

    type('password-new', 'a long enough password');
    type('password-repeat', 'a long enough password');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    expect(oxyServices.auth.requestReauthCode).toHaveBeenCalledWith('change_password');
    type('reauth-code', '123456');
    press('reauth-submit');

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(oxyServices.auth.password.set).toHaveBeenCalledWith({
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
      expect(oxyServices.auth.password.set).toHaveBeenCalledWith({
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
    expect(oxyServices.auth.requestReauthCode).not.toHaveBeenCalled();
  });
});

describe('the authenticator app', () => {
  it('sets it up: QR and key, the first code, then the backup codes once', async () => {
    render(<OxyAuthenticatorPanel />);

    press('totp-set-up');
    expect((await screen.findByTestId('qrcode')).textContent).toBe('otpauth://totp/Oxy:ada?secret=JBSWY3DPEHPK3PXP');
    expect(screen.getByTestId('totp-progress').getAttribute('aria-label')).toBe('Step 1 of 2, Authenticator app');
    expect(screen.getByTestId('totp-secret').textContent).toBe('JBSW Y3DP EHPK 3PXP');

    type('totp-enroll-code', '123456');
    press('reauth-send-code');
    await screen.findByTestId('reauth-code');
    expect(oxyServices.auth.requestReauthCode).toHaveBeenCalledWith('totp');
    type('reauth-code', '111111');
    press('reauth-submit');

    const codes = await screen.findByTestId('totp-backup-codes');
    expect(oxyServices.auth.totp.confirm).toHaveBeenCalledWith('123456', { emailCode: { verificationId: 'r-1', code: '111111' } });
    expect(codes.querySelector('pre')?.textContent).toBe(BACKUP_CODES.join('\n'));
    expect(invalidateQueries).toHaveBeenCalled();
    expect(screen.getByTestId('totp-progress').getAttribute('aria-label')).toBe('Step 2 of 2, Save your backup codes');

    // The code block's own copy button, named in the account's language.
    const copy = screen.getByTestId('totp-backup-codes-copy');
    expect(copy.getAttribute('aria-label')).toBe('Copy codes');
    fireEvent.click(copy);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(BACKUP_CODES.join('\n')));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Backup codes copied.'));
  });

  it('says so when the clipboard refuses the codes', async () => {
    copyText.mockRejectedValueOnce(new Error('denied'));
    methods = { ...methods, hasPassword: true, totpEnabled: true, backupCodesRemaining: 7 };
    render(<OxyAuthenticatorPanel />);
    press('totp-regenerate');
    type('reauth-password', 'pw');
    type('reauth-totp', '222222');
    press('reauth-submit');
    await screen.findByTestId('totp-backup-codes');
    // New codes for an authenticator that is on: no set-up progress.
    expect(screen.queryByTestId('totp-progress')).toBeNull();
    fireEvent.click(screen.getByTestId('totp-backup-codes-copy'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard'));
    expect(toast.success).not.toHaveBeenCalledWith('Backup codes copied.');
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
    expect(oxyServices.auth.totp.regenerateBackupCodes).toHaveBeenCalledWith({ password: 'pw', totpCode: '222222' });
    view.unmount();

    const onDone = jest.fn();
    render(<OxyAuthenticatorPanel onDone={onDone} />);
    press('totp-disable');
    type('reauth-password', 'pw');
    // A backup code instead: ten characters in two groups of five, pasted with its dash.
    press('reauth-toggle-backup');
    expect(screen.getByTestId('reauth-totp').getAttribute('data-type')).toBe('alphanumeric');
    expect(screen.getByTestId('reauth-totp').getAttribute('data-length')).toBe('10');
    expect(screen.getByTestId('reauth-totp').getAttribute('data-group-every')).toBe('5');
    type('reauth-totp', 'abcde-fgh23');
    press('reauth-submit');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(oxyServices.auth.totp.disable).toHaveBeenCalledWith({ password: 'pw', totpCode: 'ABCDEFGH23' });
  });
});
