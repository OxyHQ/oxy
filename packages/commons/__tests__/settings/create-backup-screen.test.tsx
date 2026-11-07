/**
 * Backup & recovery's encrypted backup (owner's decision, 2026-11-07): a
 * backup the PERSON deleted stays deleted. The screen says so, says that
 * previous keys are then recoverable only with their own recovery phrases,
 * and "Create" is the person's explicit opt-in (`optIn: true`), the only way
 * a backup is uploaded again.
 */
import type React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('@oxy.so/bloom/surfaces', () => ({ alert: jest.fn() }));
jest.mock('@/components/ui', () => {
  const R = require('react');
  const Box = ({ children, title }: { children?: React.ReactNode; title?: string }) =>
    R.createElement('div', null, title, children);
  return {
    KeyboardAwareScrollViewWrapper: Box,
    StackHeader: ({ title, subtitle }: { title: string; subtitle?: string }) =>
      R.createElement('div', null, title, subtitle),
    ImportantBanner: Box,
  };
});
jest.mock('@oxy.so/bloom/admonition', () => {
  const R = require('react');
  return {
    Admonition: ({ children }: { children?: React.ReactNode }) =>
      R.createElement('div', null, children),
  };
});
jest.mock('@/constants/icons', () => ({ AppIcon: () => null }));
jest.mock('@/hooks/useRelativeTime', () => ({ useRelativeTime: () => () => 'just now' }));
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: jest.fn(async () => ({ success: true })),
}));
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

const CURRENT = `04${'dd'.repeat(64)}`;
jest.mock('@oxy.so/core/crypto', () => ({
  KeyManager: {
    getIdentityStatus: jest.fn(async () => ({
      state: 'present',
      publicKey: `04${'dd'.repeat(64)}`,
    })),
  },
  RecoveryPhraseService: {
    validatePhrase: () => true,
    derivePublicKeyFromPhrase: jest.fn(async () => `04${'dd'.repeat(64)}`),
  },
}));

import { __setOxyState } from '@oxy.so/services';
import { alert } from '@oxy.so/bloom/surfaces';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import CreateBackupScreen from '@/app/(tabs)/(settings)/create-backup';

const PHRASE = Array.from({ length: 12 }, () => 'abandon').join(' ');
const status = jest.fn();
const create = jest.fn(async () => ({ exists: true, publicKeyHint: CURRENT.slice(0, 16) }));
const remove = jest.fn(async () => ({ success: true }));

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <LocaleProvider>
        <CreateBackupScreen />
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  __setOxyState({
    oxyServices: {
      identity: { backup: { status, create, delete: remove } },
      session: { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
    },
  });
});

it('says the person deleted their backup, and that only phrases recover previous keys', async () => {
  status.mockResolvedValue({ exists: false, optedOut: true });
  const { findByTestId, container } = renderScreen();
  await findByTestId('backup-no-backup-phrase-only');
  expect(container.textContent).toContain('You deleted your encrypted backup');
  expect(container.textContent).toContain('not even when you rotate your key');
  expect(container.textContent).toContain("can be recovered only with that key's recovery phrase");
});

it('"Create" is the explicit opt-in that ends the deletion', async () => {
  status.mockResolvedValue({ exists: false, optedOut: true });
  const { findByTestId, getByText } = renderScreen();
  await findByTestId('backup-no-backup-phrase-only');
  fireEvent.change(await findByTestId('phrase'), { target: { value: PHRASE } });
  fireEvent.click(getByText('Create encrypted backup'));
  await waitFor(() => expect(create).toHaveBeenCalledWith(PHRASE, { optIn: true }));
});

it('a stored backup shows no phrase-only notice; deleting it says it was deleted', async () => {
  status.mockResolvedValue({ exists: true, publicKeyHint: CURRENT.slice(0, 16) });
  const { findByText, queryByTestId, findByTestId, container } = renderScreen();
  fireEvent.click(await findByText('Delete backup'));
  expect(queryByTestId('backup-no-backup-phrase-only')).toBeNull();
  const [, body, buttons] = (alert as jest.Mock).mock.calls[0];
  expect(body).toContain('only with their own recovery phrases');
  buttons[1].onPress();
  await findByTestId('backup-no-backup-phrase-only');
  expect(remove).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('You deleted your encrypted backup');
});
