import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { KeyManager, IdentityUnavailableError } from '@oxy.so/core';
import { LocaleProvider } from '@/lib/i18n/locale-context';

// The `@/components/ui` barrel reaches expo-haptics (untransformed ESM in
// node_modules) through ListRow; the screen never triggers haptics under test.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
}));

// Bloom's Button reaches its real (provider-bound) theme hook, which throws
// outside a BloomThemeProvider; the shared-UI primitives are irrelevant to the
// reveal state machine under test, so stand them in with plain DOM nodes.
jest.mock('@/components/ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    Screen: ({ children }: { children: React.ReactNode }) => R.createElement('div', null, children),
    StackHeader: ({ title, subtitle }: { title: string; subtitle?: string }) =>
      R.createElement('div', null, title, subtitle),
    Section: ({ children }: { children: React.ReactNode }) => R.createElement('div', null, children),
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => R.createElement('button', { onClick: onPress, disabled }, children),
    Callout: ({ children }: { children: React.ReactNode }) => R.createElement('div', null, children),
    CenteredState: ({
      title,
      body,
      action,
    }: {
      title?: string;
      body?: string;
      action?: React.ReactNode;
    }) => R.createElement('div', null, title, body, action),
  };
});

// No biometric hardware in the test env → the screen reveals directly (the
// device-only keychain read is the real gate). Kept as a jest.fn so a test can
// flip it to exercise the authenticate() branch if needed.
jest.mock('@/lib/biometricAuth', () => ({
  canUseBiometrics: jest.fn(async () => false),
  authenticate: jest.fn(async () => ({ success: true })),
  getErrorMessage: jest.fn(() => 'gate error'),
}));

import RecoveryPhraseScreen from '@/app/(tabs)/(settings)/recovery-phrase';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

function renderScreen() {
  return render(
    <LocaleProvider>
      <RecoveryPhraseScreen />
    </LocaleProvider>,
  );
}

describe('Settings → Recovery phrase re-reveal', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reveals the stored phrase words after tapping reveal', async () => {
    jest.spyOn(KeyManager, 'getRecoveryMnemonic').mockResolvedValue(PHRASE);
    const { getByText, container } = renderScreen();

    fireEvent.click(getByText('Reveal recovery phrase'));

    await waitFor(() => {
      expect(container.textContent).toContain('sausage');
    });
    // Every word of the phrase is rendered.
    for (const word of PHRASE.split(' ')) {
      expect(container.textContent).toContain(word);
    }
  });

  it('explains the not-stored case for pre-feature identities', async () => {
    jest.spyOn(KeyManager, 'getRecoveryMnemonic').mockResolvedValue(null);
    const { getByText, container } = renderScreen();

    fireEvent.click(getByText('Reveal recovery phrase'));

    await waitFor(() => {
      expect(container.textContent).toContain('Phrase not available on this device');
    });
    expect(container.textContent).not.toContain('sausage');
  });

  it('surfaces a retriable state when storage is locked', async () => {
    jest
      .spyOn(KeyManager, 'getRecoveryMnemonic')
      .mockRejectedValue(new IdentityUnavailableError('locked'));
    const { getByText, container } = renderScreen();

    fireEvent.click(getByText('Reveal recovery phrase'));

    await waitFor(() => {
      expect(container.textContent).toContain("Couldn't read your phrase");
    });
  });
});
