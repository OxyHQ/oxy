/**
 * Adding a previous recovery phrase (oxy ADR 0061 D7 as amended 2026-11-06):
 * the phrase is kept as a PREVIOUS key only when Oxy's key history names the
 * key it derives as one of this account's retired roots; the current phrase and
 * a stranger's phrase are refused, and nothing is kept for them.
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
    KeyboardAwareScrollViewWrapper: Box,
    StackHeader: ({ title, subtitle }: { title: string; subtitle?: string }) =>
      R.createElement('div', null, title, subtitle),
    ImportantBanner: Box,
    SettingsListItem: ({ title }: { title: string }) => R.createElement('div', null, title),
  };
});
jest.mock('@oxy.so/bloom/settings-list', () => {
  const R = require('react');
  return {
    SettingsListGroup: ({ children }: { children?: React.ReactNode }) =>
      R.createElement('div', null, children),
  };
});
jest.mock('@oxy.so/bloom/admonition', () => {
  const R = require('react');
  return {
    Admonition: ({ children }: { children?: React.ReactNode }) =>
      R.createElement('div', null, children),
  };
});
jest.mock('@/constants/icons', () => ({ Icons: { history: () => null } }));
jest.mock('@/components/auth/PhraseInputGrid', () => {
  const R = require('react');
  return {
    PhraseInputGrid: ({ onPaste }: { onPaste: (text: string) => void }) =>
      R.createElement('textarea', {
        'data-testid': 'phrase',
        onChange: (event: { target: { value: string } }) => onPaste(event.target.value),
      }),
  };
});

const PREVIOUS = { privateKey: '33'.repeat(32), publicKey: `04${'cc'.repeat(64)}` };
const mockFromPhrase = jest.fn(async () => PREVIOUS);
const mockRetire = jest.fn(async () => undefined);
const mockList = jest.fn(async () => [] as { publicKey: string; retiredAt: number }[]);
jest.mock('@oxy.so/core/crypto', () => ({
  KeyManager: {
    getPublicKey: jest.fn(async () => `04${'dd'.repeat(64)}`),
    canonicalPublicKey: (key: string) => key.toLowerCase(),
    shortenPublicKey: (key: string) => key.slice(0, 8),
  },
  listRetiredIdentityKeys: () => mockList(),
  syncRetiredKeys: jest.fn(async () => 0),
  retireIdentityKey: (...args: unknown[]) => mockRetire(...(args as [])),
  retiredKeyFromPhrase: (...args: unknown[]) => mockFromPhrase(...(args as [])),
}));

import { __setOxyState } from '@oxy.so/services';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import PreviousKeysScreen from '@/app/(tabs)/(settings)/previous-keys';

const PHRASE = Array.from({ length: 12 }, () => 'abandon').join(' ');
const keyHistory = jest.fn();

function renderScreen() {
  return render(
    <LocaleProvider>
      <PreviousKeysScreen />
    </LocaleProvider>,
  );
}

async function enterAndSubmit(getByTestId: (id: string) => HTMLElement) {
  fireEvent.change(getByTestId('phrase'), { target: { value: PHRASE } });
  await waitFor(() =>
    expect((getByTestId('previous-key-add') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(getByTestId('previous-key-add'));
}

beforeEach(() => {
  jest.clearAllMocks();
  __setOxyState({
    oxyServices: { identity: { keyHistory }, session: { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
  });
});

it('keeps a phrase whose key the account retired, as a previous key', async () => {
  keyHistory.mockResolvedValue({
    publicKey: `04${'dd'.repeat(64)}`,
    retired: [{ publicKey: PREVIOUS.publicKey, retiredAt: '2026-11-01T00:00:00.000Z' }],
  });
  const { getByTestId } = renderScreen();
  await enterAndSubmit(getByTestId);
  await waitFor(() =>
    expect(mockRetire).toHaveBeenCalledWith(PREVIOUS, {
      ownerAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    }),
  );
});

it('refuses the current phrase and keeps nothing', async () => {
  keyHistory.mockResolvedValue({ publicKey: PREVIOUS.publicKey, retired: [] });
  const { getByTestId, container } = renderScreen();
  await enterAndSubmit(getByTestId);
  await waitFor(() => expect(container.textContent).toContain('current recovery phrase'));
  expect(mockRetire).not.toHaveBeenCalled();
});

it("refuses a phrase that was never this account's", async () => {
  keyHistory.mockResolvedValue({
    publicKey: `04${'dd'.repeat(64)}`,
    retired: [{ publicKey: `04${'ee'.repeat(64)}`, retiredAt: '2026-11-01T00:00:00.000Z' }],
  });
  const { getByTestId, container } = renderScreen();
  await enterAndSubmit(getByTestId);
  await waitFor(() => expect(container.textContent).toContain("isn't one of this account's"));
  expect(mockRetire).not.toHaveBeenCalled();
});
