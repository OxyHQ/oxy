import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react';
import {
  __resetOxyState,
  __setOxyState,
  __setOnlineStatus,
} from '@/__mocks__/oxy-services';
import { __resetAsyncStorage } from '@/__mocks__/async-storage';
import { LocaleProvider } from '@/lib/i18n/locale-context';

// The gate reads the onboarding verdict for its defensive no-identity branch.
// Drive it directly rather than standing up React Query + KeyManager.
const mockOnboarding: { status: string; identityPresent: boolean } = {
  status: 'complete',
  identityPresent: true,
};
jest.mock('@/hooks/useOnboardingStatus', () => ({
  ...jest.requireActual('@/hooks/useOnboardingStatus'),
  useOnboardingStatus: () => mockOnboarding,
}));

// The gate's Retry drives the vault's identity sync (register-if-needed + key
// sign-in). Stub it so the retry is observable without a keychain or a server;
// `isSyncing` is the same shared-store flag the real hook publishes.
const syncIdentityMock = jest.fn<Promise<unknown>, []>();
const mockSyncState: { isSynced: boolean; isSyncing: boolean } = {
  isSynced: true,
  isSyncing: false,
};
jest.mock('@/hooks/identity/useSyncIdentity', () => ({
  useSyncIdentity: () => ({
    syncIdentity: syncIdentityMock,
    isIdentitySynced: jest.fn(async () => true),
    identitySyncState: mockSyncState,
  }),
}));

import { SessionGate } from '@/components/ui/session-gate';

function renderGate() {
  return render(
    <LocaleProvider>
      <SessionGate>
        <Text>PRIVATE CONTENT</Text>
      </SessionGate>
    </LocaleProvider>,
  );
}

describe('SessionGate', () => {
  beforeEach(() => {
    __resetAsyncStorage();
    __resetOxyState();
    __setOnlineStatus(true);
    syncIdentityMock.mockReset();
    syncIdentityMock.mockResolvedValue({ id: 'me' });
    mockSyncState.isSyncing = false;
    mockOnboarding.status = 'complete';
    mockOnboarding.identityPresent = true;
  });

  it('shows a bounded loading state while the cold boot is still resolving', () => {
    __setOxyState({ isAuthResolved: false, user: null });
    const { container } = renderGate();

    expect(container.textContent).toContain('Connecting your identity');
    expect(container.textContent).not.toContain('PRIVATE CONTENT');
  });

  it('renders the children once a live session is up', () => {
    __setOxyState({ isAuthResolved: true, user: { id: 'me' } });
    const { container } = renderGate();

    expect(container.textContent).toContain('PRIVATE CONTENT');
  });

  it('shows a calm offline notice (no action) when resolved with no session and offline', () => {
    __setOxyState({ isAuthResolved: true, user: null });
    __setOnlineStatus(false);
    const { container, queryByText } = renderGate();

    expect(container.textContent).toContain("You're offline");
    expect(container.textContent).not.toContain('PRIVATE CONTENT');
    expect(queryByText('Retry')).toBeNull();
  });

  it('shows the connecting state — never a sign-in prompt — while a reconnect is in flight', () => {
    __setOxyState({ isAuthResolved: true, user: null });
    mockSyncState.isSyncing = true;
    const { container } = renderGate();

    expect(container.textContent).toContain('Connecting your identity');
    expect(container.textContent).not.toContain('PRIVATE CONTENT');
    // Commons IS the identity: the vault must never ask its owner to sign in.
    expect(container.textContent?.toLowerCase()).not.toContain('sign in');
  });

  it('reports the definitive verdict — never a sign-in prompt — when the boot concluded with no session', () => {
    __setOxyState({ isAuthResolved: true, user: null });
    const { container } = renderGate();

    expect(container.textContent).toContain("Couldn't connect");
    expect(container.textContent).not.toContain('PRIVATE CONTENT');
    expect(container.textContent?.toLowerCase()).not.toContain('sign in');
  });

  it('offers a Retry that re-runs the vault identity sync', () => {
    __setOxyState({ isAuthResolved: true, user: null });
    const { getByText } = renderGate();

    expect(syncIdentityMock).not.toHaveBeenCalled();

    fireEvent.click(getByText('Retry'));

    expect(syncIdentityMock).toHaveBeenCalledTimes(1);
  });

  it('never rethrows a failed Retry into the render tree', async () => {
    __setOxyState({ isAuthResolved: true, user: null });
    syncIdentityMock.mockRejectedValue(new Error('boom'));
    const { container, getByText } = renderGate();

    fireEvent.click(getByText('Retry'));

    await waitFor(() => expect(syncIdentityMock).toHaveBeenCalledTimes(1));
    expect(container.textContent).toContain("Couldn't connect");
  });

  it('routes to onboarding — never sign-in — when the local identity is absent', () => {
    __setOxyState({ isAuthResolved: true, user: null });
    mockOnboarding.status = 'none';
    mockOnboarding.identityPresent = false;
    const { container } = renderGate();

    // The expo-router mock renders a <Redirect href> marker.
    expect(container.innerHTML).toContain('/(auth)');
    expect(container.textContent).not.toContain('PRIVATE CONTENT');
    expect(container.textContent?.toLowerCase()).not.toContain('sign in');
  });

  it('waits (never redirects) while the local identity probe is still resolving', () => {
    __setOxyState({ isAuthResolved: true, user: null });
    mockOnboarding.status = 'checking';
    mockOnboarding.identityPresent = false;
    const { container } = renderGate();

    expect(container.textContent).toContain('Connecting your identity');
    expect(container.innerHTML).not.toContain('/(auth)');
  });
});
