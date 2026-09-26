/**
 * auth.oxy.so's account pages (ADR 0029 D3): `OxyCreateAccountPanel`
 * (username → recovery email → code → passkey), `OxyRecoverAccountPanel`
 * (username or email → code → new passkey) and `OxyDeleteAccountPanel`
 * (typed username → passkey assertion).
 *
 * `oxyServices` is a double and the WebAuthn ceremonies are mocked at the
 * platform client, so these assert what each step SENDS and when a session is
 * committed.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LoginSessionResult } from '@oxy.so/contracts';

const SESSION: LoginSessionResult = {
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-1',
  deviceSecret: 'secret-1',
  user: { id: 'user-1', username: 'ada' },
};
const TICKET = 'T'.repeat(43);

const oxyServices = {
  checkUsernameAvailability: jest.fn(async (_username: string) => ({ available: true, message: '' })),
  startEmailVerification: jest.fn(async (_request: unknown) => ({ verificationId: 'v-1', expiresAt: 1_900_000_000_000 })),
  confirmEmailVerification: jest.fn(async (_id: string, _code: string) => ({
    ticket: TICKET,
    expiresAt: 1_900_000_000_000,
    username: null as string | null,
  })),
  webauthnRegisterOptions: jest.fn(async (_request: unknown) => ({ challenge: 'reg' })),
  webauthnRegisterVerify: jest.fn(async (_response: unknown, _envelope: unknown): Promise<unknown> => SESSION),
  getAccountDeletionOptions: jest.fn(async () => ({ challenge: 'del' })),
  deleteAccountWithPasskey: jest.fn(async (_confirmText: string, _assertion: unknown) => ({ message: 'deleted' })),
};
const handleWebSession = jest.fn(async (_session: unknown) => undefined);
const logout = jest.fn(async () => undefined);
let user: { id: string; username: string; publicKey?: string } | null = { id: 'user-1', username: 'ada' };

jest.mock('../../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({ oxyServices, handleWebSession, logout, user }),
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

const runRegistrationCeremony = jest.fn(async (_options: unknown) => ({ id: 'cred-1' }));
const runAuthenticationCeremony = jest.fn(async (_options: unknown) => ({ id: 'cred-1', response: {} }));
jest.mock('../../../src/webauthn/passkeyClient', () => ({
  __esModule: true,
  isPasskeySupported: () => true,
  runRegistrationCeremony: (options: unknown) => runRegistrationCeremony(options),
  runAuthenticationCeremony: (options: unknown) => runAuthenticationCeremony(options),
}));

// eslint-disable-next-line import/first
import { OxyCreateAccountPanel } from '../../../src/ui/components/signIn/OxyCreateAccountPanel';
// eslint-disable-next-line import/first
import { OxyRecoverAccountPanel } from '../../../src/ui/components/signIn/OxyRecoverAccountPanel';
// eslint-disable-next-line import/first
import { OxyDeleteAccountPanel } from '../../../src/ui/components/signIn/OxyDeleteAccountPanel';

const type = (testID: string, value: string) => fireEvent.change(screen.getByTestId(testID), { target: { value } });
const press = (testID: string) => fireEvent.click(screen.getByTestId(testID));

beforeEach(() => {
  jest.clearAllMocks();
  user = { id: 'user-1', username: 'ada' };
});

describe('creating a passkey account', () => {
  it('walks username → email → code → passkey, and signs in with the confirmed email', async () => {
    const onSignedIn = jest.fn();
    render(<OxyCreateAccountPanel onSignedIn={onSignedIn} onSignIn={jest.fn()} />);

    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    expect(oxyServices.checkUsernameAvailability).toHaveBeenCalledWith('ada');

    type('signup-email', ' Ada@Example.com ');
    press('signup-email-continue');
    await screen.findByTestId('email-code');
    expect(oxyServices.startEmailVerification).toHaveBeenCalledWith({ purpose: 'signup', email: 'ada@example.com' });
    expect(screen.getByText('We sent a 6-digit code to ada@example.com.')).toBeTruthy();

    type('email-code', '123456');
    press('email-code-continue');
    await screen.findByTestId('signup-create-passkey');
    expect(oxyServices.confirmEmailVerification).toHaveBeenCalledWith('v-1', '123456');

    press('signup-create-passkey');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(oxyServices.webauthnRegisterOptions).toHaveBeenCalledWith({ username: 'ada' });
    expect(oxyServices.webauthnRegisterVerify).toHaveBeenCalledWith(
      { id: 'cred-1' },
      expect.objectContaining({ username: 'ada', email: 'ada@example.com', emailTicket: TICKET }),
    );
    expect(handleWebSession).toHaveBeenCalledWith(SESSION);
  });

  it('stops at a taken username', async () => {
    oxyServices.checkUsernameAvailability.mockResolvedValueOnce({ available: false, message: '' });
    render(<OxyCreateAccountPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);

    type('signup-username', 'ada');
    press('signup-username-continue');

    expect(await screen.findByText('That username is taken.')).toBeTruthy();
    expect(screen.queryByTestId('signup-email')).toBeNull();
  });

  it('refuses a malformed email before sending anything', async () => {
    render(<OxyCreateAccountPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');

    type('signup-email', 'not-an-email');
    press('signup-email-continue');

    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(oxyServices.startEmailVerification).not.toHaveBeenCalled();
  });

  it('says a wrong code is wrong, in words', async () => {
    oxyServices.confirmEmailVerification.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EMAIL_CODE_INVALID' }));
    render(<OxyCreateAccountPanel onSignedIn={jest.fn()} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    type('signup-email', 'ada@example.com');
    press('signup-email-continue');
    await screen.findByTestId('email-code');

    type('email-code', '000000');
    press('email-code-continue');

    expect(await screen.findByText("That code isn't right, or it has expired.")).toBeTruthy();
  });

  it('goes back to the email when the confirmation expired before the passkey', async () => {
    oxyServices.webauthnRegisterVerify.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EMAIL_TICKET_INVALID' }));
    const onSignedIn = jest.fn();
    render(<OxyCreateAccountPanel onSignedIn={onSignedIn} onSignIn={jest.fn()} />);
    type('signup-username', 'ada');
    press('signup-username-continue');
    await screen.findByTestId('signup-email');
    type('signup-email', 'ada@example.com');
    press('signup-email-continue');
    await screen.findByTestId('email-code');
    type('email-code', '123456');
    press('email-code-continue');
    await screen.findByTestId('signup-create-passkey');

    press('signup-create-passkey');

    expect(await screen.findByTestId('signup-email')).toBeTruthy();
    expect(screen.getByText('This took too long. Start again.')).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe('recovering a passkey account', () => {
  it('sends the code without saying whether the account exists, then adds a passkey and signs in', async () => {
    oxyServices.confirmEmailVerification.mockResolvedValueOnce({ ticket: TICKET, expiresAt: 1_900_000_000_000, username: 'ada' });
    const onRecovered = jest.fn();
    render(<OxyRecoverAccountPanel onRecovered={onRecovered} onSignIn={jest.fn()} />);
    expect(screen.getByText('Does your account use Commons? Recover it in Commons with your recovery phrase.')).toBeTruthy();

    type('recover-identifier', 'ada');
    press('recover-continue');
    await screen.findByTestId('email-code');
    expect(oxyServices.startEmailVerification).toHaveBeenCalledWith({ purpose: 'recovery', identifier: 'ada' });
    expect(screen.getByText('If this account has a recovery email, we sent a 6-digit code to it.')).toBeTruthy();

    type('email-code', '654321');
    press('email-code-continue');
    await screen.findByTestId('recover-create-passkey');
    expect(screen.getByText(/For @ada\./)).toBeTruthy();

    press('recover-create-passkey');
    await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1));
    expect(oxyServices.webauthnRegisterOptions).toHaveBeenCalledWith({ recoveryTicket: TICKET });
    expect(oxyServices.webauthnRegisterVerify).toHaveBeenCalledWith(
      { id: 'cred-1' },
      expect.objectContaining({ recoveryTicket: TICKET }),
    );
    expect(handleWebSession).toHaveBeenCalledWith(SESSION);
  });

  it('asks for a username or email instead of sending a code for nobody', async () => {
    render(<OxyRecoverAccountPanel onRecovered={jest.fn()} onSignIn={jest.fn()} />);
    press('recover-continue');
    expect(await screen.findByText('Enter your username or email.')).toBeTruthy();
    expect(oxyServices.startEmailVerification).not.toHaveBeenCalled();
  });
});

describe('deleting a passkey account', () => {
  it('deletes only after the typed username and a passkey assertion, then signs out', async () => {
    const onDeleted = jest.fn();
    render(<OxyDeleteAccountPanel onDeleted={onDeleted} />);

    type('delete-account-confirm', 'ada');
    press('delete-account-passkey');

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(runAuthenticationCeremony).toHaveBeenCalledWith({ challenge: 'del' });
    expect(oxyServices.deleteAccountWithPasskey).toHaveBeenCalledWith('ada', { id: 'cred-1', response: {} });
    expect(logout).toHaveBeenCalled();
    expect(await screen.findByText('Your account is deleted.')).toBeTruthy();
  });

  it('runs no ceremony for a mistyped username', () => {
    render(<OxyDeleteAccountPanel />);
    type('delete-account-confirm', 'ad');
    press('delete-account-passkey');
    expect(oxyServices.getAccountDeletionOptions).not.toHaveBeenCalled();
  });

  it('sends a Commons account to Commons', () => {
    user = { id: 'user-1', username: 'ada', publicKey: `04${'a'.repeat(128)}` };
    render(<OxyDeleteAccountPanel />);
    expect(screen.queryByTestId('delete-account-passkey')).toBeNull();
    expect(screen.getByText(/delete it in Oxy Commons/)).toBeTruthy();
  });
});
