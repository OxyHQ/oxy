/**
 * `OxyLinkCommonsPanel` — in the account's settings: the QR, the code both
 * devices show once Commons signs, and a code by email (+ the authenticator's)
 * that links. `oxyServices` is a double.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { deriveIdentityLinkCode } from '@oxy.so/core';

const LINK = {
  linkId: 'ab'.repeat(16),
  challenge: 'cd'.repeat(32),
  expiresAt: Date.now() + 5 * 60 * 1000,
  qrPayload: `oxycommons://link?id=${'ab'.repeat(16)}&c=${'cd'.repeat(32)}`,
};
const KEY = `04${'1f'.repeat(64)}`;

const oxyServices = {
  createIdentityLink: jest.fn(async () => LINK),
  getIdentityLink: jest.fn(async (_linkId: string) => ({
    status: 'pending' as string,
    userId: 'user-1',
    username: 'ada',
    publicKey: null as string | null,
    audience: 'oxy-api/identity',
    expiresAt: LINK.expiresAt,
  })),
  requestReauthEmailCode: jest.fn(async (_action: string) => ({ verificationId: 'r-1', expiresAt: 1_900_000_000_000 })),
  completeIdentityLinkWithEmailCode: jest.fn(async (_linkId: string, _reauth: unknown) => ({ success: true as const })),
  cancelIdentityLink: jest.fn(async (_linkId: string) => undefined),
};
let user: { id: string; username: string; publicKey?: string } = { id: 'user-1', username: 'ada' };

jest.mock('../../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({ oxyServices, user }),
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

jest.mock('react-native-qrcode-svg', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => require('react').createElement('span', { 'data-testid': 'qrcode' }, value),
}));

let totpEnabled = false;
jest.mock('../../../src/ui/hooks/queries/useAuthMethods', () => ({
  __esModule: true,
  useSignInMethods: () => ({ data: { hasEmail: true, hasPassword: false, totpEnabled, backupCodesRemaining: 0 } }),
}));

// eslint-disable-next-line import/first
import { IDENTITY_LINK_POLL_MS, OxyLinkCommonsPanel } from '../../../src/ui/components/signIn/OxyLinkCommonsPanel';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  user = { id: 'user-1', username: 'ada' };
  totpEnabled = false;
});
afterEach(() => jest.useRealTimers());

const signCommons = async () => {
  oxyServices.getIdentityLink.mockResolvedValueOnce({
    status: 'signed',
    userId: 'user-1',
    username: 'ada',
    publicKey: KEY,
    audience: 'oxy-api/identity',
    expiresAt: LINK.expiresAt,
  });
  await act(async () => {
    jest.advanceTimersByTime(IDENTITY_LINK_POLL_MS);
  });
};

describe('linking Commons from the account settings', () => {
  it('shows the QR, then the code Commons shows, then links with a code by email', async () => {
    const onLinked = jest.fn();
    render(<OxyLinkCommonsPanel onLinked={onLinked} />);

    expect((await screen.findByTestId('qrcode')).textContent).toBe(LINK.qrPayload);

    oxyServices.getIdentityLink.mockResolvedValueOnce({
      status: 'signed',
      userId: 'user-1',
      username: 'ada',
      publicKey: KEY,
      audience: 'oxy-api/identity',
      expiresAt: LINK.expiresAt,
    });
    await act(async () => {
      jest.advanceTimersByTime(IDENTITY_LINK_POLL_MS);
    });

    const code = deriveIdentityLinkCode(LINK.linkId, KEY);
    expect((await screen.findByTestId('link-commons-code')).textContent).toBe(`${code.slice(0, 3)} ${code.slice(3)}`);

    fireEvent.click(screen.getByTestId('link-commons-confirm'));
    fireEvent.click(await screen.findByTestId('reauth-send-code'));
    fireEvent.change(await screen.findByTestId('reauth-code'), { target: { value: '123456' } });
    expect(oxyServices.requestReauthEmailCode).toHaveBeenCalledWith('link_commons');
    fireEvent.click(screen.getByTestId('reauth-submit'));

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(oxyServices.completeIdentityLinkWithEmailCode).toHaveBeenCalledWith(LINK.linkId, {
      emailCode: { verificationId: 'r-1', code: '123456' },
    });
    expect(screen.getByText('Commons is linked')).toBeTruthy();
  });

  it('asks for the authenticator code too when the account has one', async () => {
    totpEnabled = true;
    render(<OxyLinkCommonsPanel />);
    await screen.findByTestId('qrcode');
    await signCommons();
    fireEvent.click(await screen.findByTestId('link-commons-confirm'));
    fireEvent.click(await screen.findByTestId('reauth-send-code'));
    fireEvent.change(await screen.findByTestId('reauth-code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByTestId('reauth-totp'), { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('reauth-submit'));

    await waitFor(() =>
      expect(oxyServices.completeIdentityLinkWithEmailCode).toHaveBeenCalledWith(LINK.linkId, {
        emailCode: { verificationId: 'r-1', code: '123456' },
        totpCode: '654321',
      }),
    );
  });

  it('withdraws the request when the person cancels at the confirmation', async () => {
    render(<OxyLinkCommonsPanel />);
    await screen.findByTestId('qrcode');
    await signCommons();
    fireEvent.click(await screen.findByTestId('link-commons-confirm'));
    fireEvent.click(await screen.findByTestId('reauth-cancel'));
    expect(oxyServices.cancelIdentityLink).toHaveBeenCalledWith(LINK.linkId);
    expect(oxyServices.completeIdentityLinkWithEmailCode).not.toHaveBeenCalled();
  });

  it('withdraws the request when the person cancels at the QR', async () => {
    render(<OxyLinkCommonsPanel />);
    await screen.findByTestId('qrcode');
    fireEvent.click(screen.getByTestId('link-commons-cancel'));
    expect(oxyServices.cancelIdentityLink).toHaveBeenCalledWith(LINK.linkId);
    expect(screen.getByTestId('link-commons-renew')).toBeTruthy();
  });

  it('opens nothing for an account that already uses Commons', () => {
    user = { id: 'user-1', username: 'ada', publicKey: KEY };
    render(<OxyLinkCommonsPanel />);
    expect(screen.getByText('This account already uses Commons.')).toBeTruthy();
    expect(oxyServices.createIdentityLink).not.toHaveBeenCalled();
  });
});
