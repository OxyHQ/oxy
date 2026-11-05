/**
 * Resuming the create flow after the app was closed mid-onboarding.
 *
 * It used to resume straight at the username step, so a user who closed the
 * app on the recovery-phrase screen (or before it) finished onboarding without
 * ever writing the phrase down. Now an unacknowledged phrase is shown again
 * first, from the slot it was stored in at creation.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { __getMockRouter } from '@/__mocks__/expo-router';
import { __setOxyState } from '@/__mocks__/oxy-services';

const recoveryPhraseRef: { current: string[] | null } = { current: null };
jest.mock('@/contexts/auth-flow-context', () => ({
  useAuthFlowContext: () => ({ setAuthError: jest.fn(), recoveryPhraseRef }),
}));
jest.mock('@/hooks/useOnboardingStatus', () => ({
  useOnboardingStatus: () => ({ status: 'in_progress', hasIdentity: true }),
}));
const syncIdentity = jest.fn(async () => undefined);
jest.mock('@/hooks/useIdentity', () => ({
  useIdentity: () => ({ createIdentity: jest.fn(), syncIdentity }),
}));
const acknowledged = jest.fn(async () => false);
jest.mock('@/hooks/identity/identityStore', () => ({
  getRecoveryPhraseAcknowledgedFromStorage: () => acknowledged(),
}));
const storedPhrase = jest.fn(async (): Promise<string | null> => null);
jest.mock('@oxy.so/core/crypto', () => ({
  IdentityAlreadyExistsError: class extends Error {},
  IdentityUnavailableError: class extends Error {},
  KeyManager: { getRecoveryMnemonicForCurrentIdentity: () => storedPhrase() },
}));
jest.mock('@/utils/auth/networkUtils', () => ({ checkIfOffline: async () => true }));
jest.mock('@/components/auth/CreatingStep', () => ({ CreatingStep: () => null }));
jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/hooks/useColors', () => ({ useColors: () => ({ background: '#000', text: '#fff' }) }));

import CreateIdentityScreen from '@/app/(auth)/create-identity/index';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('resuming the create flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recoveryPhraseRef.current = null;
    __setOxyState({
      isAuthenticated: true,
      oxyServices: { session: { accessToken: 'token' } } as never,
    });
  });

  it('shows the stored phrase again when it was never acknowledged', async () => {
    storedPhrase.mockResolvedValue(PHRASE);
    render(<CreateIdentityScreen />);
    await waitFor(() =>
      expect(__getMockRouter().replace).toHaveBeenCalledWith(
        '/(auth)/create-identity/recovery-phrase',
      ),
    );
    expect(recoveryPhraseRef.current).toEqual(PHRASE.split(' '));
  });

  it('goes on to the username step once the phrase was acknowledged', async () => {
    acknowledged.mockResolvedValueOnce(true);
    storedPhrase.mockResolvedValue(PHRASE);
    render(<CreateIdentityScreen />);
    await waitFor(() =>
      expect(__getMockRouter().replace).toHaveBeenCalledWith('/(auth)/create-identity/username'),
    );
    expect(recoveryPhraseRef.current).toBeNull();
  });

  it('goes on to the username step when no phrase is stored for this key', async () => {
    storedPhrase.mockResolvedValue(null);
    render(<CreateIdentityScreen />);
    await waitFor(() =>
      expect(__getMockRouter().replace).toHaveBeenCalledWith('/(auth)/create-identity/username'),
    );
  });
});
