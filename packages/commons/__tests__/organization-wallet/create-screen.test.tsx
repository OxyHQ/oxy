/**
 * Creating and replacing an organization's key in Commons (ADR 0061): the
 * phrase is shown before anything is sent, the replacement warns that coins stay
 * with the current key, and the key is kept on the phone only after Oxy took it.
 */
import type React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('@/components/ui', () => {
  const R = require('react');
  const Box = ({ children, title }: { children?: React.ReactNode; title?: string }) =>
    R.createElement('div', null, title, children);
  return {
    Screen: Box,
    StackHeader: ({ title, subtitle }: { title: string; subtitle?: string }) =>
      R.createElement('div', null, title, subtitle),
    ImportantBanner: Box,
    LoadingState: ({ title }: { title?: string }) => R.createElement('div', null, title),
    STATE_MIN_HEIGHT: 0,
  };
});
jest.mock('@/components/identity/RecoveryPhraseGrid', () => {
  const R = require('react');
  return {
    RecoveryPhraseGrid: ({ words }: { words: string[] }) =>
      R.createElement('ol', null, words.join(' ')),
  };
});
jest.mock('@/lib/biometricAuth', () => ({
  hasLocalConfirmation: jest.fn(async () => false),
  authenticate: jest.fn(async () => ({ success: true })),
}));
const mockWallet = { current: { status: 'none', deviceKey: null as string | null } };
const mockInvalidate = jest.fn(async () => undefined);
jest.mock('@/hooks/organization-wallet/useOrganizationWallets', () => ({
  useOrganizationWallet: () => ({
    isPending: false,
    data: {
      status: mockWallet.current.status,
      deviceKey: mockWallet.current.deviceKey,
      state: { accountId: 'org-1', publicKey: mockWallet.current.deviceKey, keys: [] },
    },
  }),
  useInvalidateOrganizationWallets: () => mockInvalidate,
}));
const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
const NEW_KEY = {
  mnemonic: PHRASE,
  privateKey: '11'.repeat(32),
  publicKey: `04${'aa'.repeat(64)}`,
};
const mockStore = jest.fn(async () => undefined);
const mockRetire = jest.fn(async () => undefined);
jest.mock('@oxy.so/core/crypto', () => ({
  generateOrganizationKey: jest.fn(async () => NEW_KEY),
  getOrganizationPrivateKey: jest.fn(async () => '22'.repeat(32)),
  retireIdentityKey: (...args: unknown[]) => mockRetire(...(args as [])),
  storeOrganizationKey: (...args: unknown[]) => mockStore(...(args as [])),
}));

import { __setOxyState } from '@oxy.so/services';
import { __setMockSearchParams } from 'expo-router';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import CreateOrganizationKeyScreen from '@/app/(tabs)/(settings)/organization-wallets/create';

const link = jest.fn(async () => ({ accountId: 'org-1', publicKey: NEW_KEY.publicKey, keys: [] }));

function renderScreen() {
  return render(
    <LocaleProvider>
      <CreateOrganizationKeyScreen />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  __setOxyState({ oxyServices: { 'accounts.identityKey.link': link } });
});

it('creates: phrase first, then Oxy, then the phone keeps the key', async () => {
  mockWallet.current = { status: 'none', deviceKey: null };
  __setMockSearchParams({ accountId: 'org-1', operation: 'create' });
  const { getByRole, getByTestId, container } = renderScreen();

  await waitFor(() => expect(getByTestId('org-key-reveal')).toBeTruthy());
  expect((getByTestId('org-key-continue') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(getByTestId('org-key-reveal'));
  expect(container.textContent).toContain('word23');
  fireEvent.click(getByRole('checkbox'));
  fireEvent.click(getByTestId('org-key-continue'));
  expect(link).not.toHaveBeenCalled();

  fireEvent.click(getByTestId('org-key-commit'));
  await waitFor(() =>
    expect(container.textContent).toContain("The organization's wallet is ready"),
  );
  expect(link).toHaveBeenCalledWith('org-1', {
    operation: 'create',
    key: { privateKey: NEW_KEY.privateKey, publicKey: NEW_KEY.publicKey },
  });
  expect(mockStore).toHaveBeenCalledWith('org-1', {
    privateKey: NEW_KEY.privateKey,
    publicKey: NEW_KEY.publicKey,
    mnemonic: PHRASE,
  });
  expect(mockInvalidate).toHaveBeenCalled();
});

it('replaces: only after the funds warning, signed by the current key this phone holds', async () => {
  const current = `04${'bb'.repeat(64)}`;
  mockWallet.current = { status: 'held', deviceKey: current };
  __setMockSearchParams({ accountId: 'org-1', operation: 'replace' });
  const { getAllByRole, getByTestId, container } = renderScreen();

  await waitFor(() => expect(getByTestId('org-key-reveal')).toBeTruthy());
  fireEvent.click(getByTestId('org-key-reveal'));
  fireEvent.click(getAllByRole('checkbox')[0]);
  fireEvent.click(getByTestId('org-key-continue'));
  expect(container.textContent).toContain('The current key stays with the funds');
  expect((getByTestId('org-key-commit') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(getAllByRole('checkbox')[0]);
  fireEvent.click(getByTestId('org-key-commit'));

  await waitFor(() => expect(link).toHaveBeenCalled());
  expect(link).toHaveBeenCalledWith('org-1', {
    operation: 'replace',
    key: { privateKey: NEW_KEY.privateKey, publicKey: NEW_KEY.publicKey },
    previousKey: { privateKey: '22'.repeat(32), publicKey: current },
  });
  // The replaced key is kept as a previous key BEFORE the change (ADR 0061 D7 as amended).
  expect(mockRetire).toHaveBeenCalledWith(
    { privateKey: '22'.repeat(32), publicKey: current },
    { accountId: 'org-1' },
  );
  expect(mockRetire.mock.invocationCallOrder[0]).toBeLessThan(link.mock.invocationCallOrder[0]);
});

it('does not replace when this phone cannot keep the current key', async () => {
  const current = `04${'bb'.repeat(64)}`;
  mockWallet.current = { status: 'held', deviceKey: current };
  mockRetire.mockRejectedValueOnce(new Error('keychain refused'));
  __setMockSearchParams({ accountId: 'org-1', operation: 'replace' });
  const { getAllByRole, getByTestId } = renderScreen();
  await waitFor(() => expect(getByTestId('org-key-reveal')).toBeTruthy());
  fireEvent.click(getByTestId('org-key-reveal'));
  fireEvent.click(getAllByRole('checkbox')[0]);
  fireEvent.click(getByTestId('org-key-continue'));
  fireEvent.click(getAllByRole('checkbox')[0]);
  fireEvent.click(getByTestId('org-key-commit'));
  await waitFor(() => expect(mockRetire).toHaveBeenCalled());
  await waitFor(() => expect(getByTestId('org-key-commit')).toBeTruthy());
  expect(link).not.toHaveBeenCalled();
  expect(mockStore).not.toHaveBeenCalled();
});

it('keeps nothing on the phone when Oxy refuses', async () => {
  mockWallet.current = { status: 'none', deviceKey: null };
  __setMockSearchParams({ accountId: 'org-1', operation: 'create' });
  link.mockRejectedValueOnce({ code: 'ORGANIZATION_KEY_FORBIDDEN', message: 'nope' });
  const { getByRole, getByTestId } = renderScreen();
  await waitFor(() => expect(getByTestId('org-key-reveal')).toBeTruthy());
  fireEvent.click(getByTestId('org-key-reveal'));
  fireEvent.click(getByRole('checkbox'));
  fireEvent.click(getByTestId('org-key-continue'));
  fireEvent.click(getByTestId('org-key-commit'));
  await waitFor(() => expect(link).toHaveBeenCalled());
  await waitFor(() => expect(getByTestId('org-key-commit')).toBeTruthy());
  expect(mockStore).not.toHaveBeenCalled();
});
