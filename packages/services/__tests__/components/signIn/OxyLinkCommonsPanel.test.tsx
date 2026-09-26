/**
 * `OxyLinkCommonsPanel` — auth.oxy.so's `/link-commons` (ADR 0029 D3): the QR,
 * the code both devices show once Commons signs, and the passkey that links.
 * `oxyServices` is a double and the WebAuthn ceremony is mocked at the client.
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
  getIdentityLinkAssertionOptions: jest.fn(async (_linkId: string, _challenge: string) => ({ challenge: 'opts' })),
  completeIdentityLink: jest.fn(async (_linkId: string, _assertion: unknown) => ({ success: true as const })),
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

const runAuthenticationCeremony = jest.fn(async (_options: unknown) => ({ id: 'cred-1' }));
jest.mock('../../../src/webauthn/passkeyClient', () => ({
  __esModule: true,
  isPasskeySupported: () => true,
  runRegistrationCeremony: jest.fn(),
  runAuthenticationCeremony: (options: unknown) => runAuthenticationCeremony(options),
}));

// eslint-disable-next-line import/first
import { IDENTITY_LINK_POLL_MS, OxyLinkCommonsPanel } from '../../../src/ui/components/signIn/OxyLinkCommonsPanel';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  user = { id: 'user-1', username: 'ada' };
});
afterEach(() => jest.useRealTimers());

describe('linking Commons on auth.oxy.so', () => {
  it('shows the QR, then the code Commons shows, then links with the passkey', async () => {
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
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(oxyServices.getIdentityLinkAssertionOptions).toHaveBeenCalledWith(LINK.linkId, LINK.challenge);
    expect(runAuthenticationCeremony).toHaveBeenCalledWith({ challenge: 'opts' });
    expect(oxyServices.completeIdentityLink).toHaveBeenCalledWith(LINK.linkId, { id: 'cred-1' });
    expect(screen.getByText('Commons is linked')).toBeTruthy();
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
