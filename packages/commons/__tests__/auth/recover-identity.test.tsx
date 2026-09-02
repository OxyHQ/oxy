import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeyManager } from '@oxyhq/core';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import * as identityStore from '@/hooks/identity/identityStore';
import { __getMockRouter } from '@/__mocks__/expo-router';

interface AlertAction {
  text: string;
  onPress?: () => void;
}

const mockAlert = jest.fn();
const mockToastError = jest.fn();

jest.mock('@oxyhq/bloom', () => ({
  alert: (...args: unknown[]) => mockAlert(...args),
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

jest.mock('@/components/ui', () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) =>
    React.createElement('button', { onClick: onPress }, children),
}));

jest.mock('@/components/ui/centered-state', () => ({
  CenteredState: ({
    title,
    body,
    action,
  }: {
    title?: string;
    body?: string;
    action?: React.ReactNode;
  }) => React.createElement('div', null, title, body, action),
}));

jest.mock('@/hooks/useOnboardingStatus', () => {
  const actual = jest.requireActual('@/hooks/useOnboardingStatus');
  return {
    ...actual,
    useOnboardingStatus: () => ({ status: 'recovery', onboardingFlow: null }),
  };
});

// Imported after the UI and state-machine mocks so the screen binds to them.
// eslint-disable-next-line import/first
import RecoverIdentityScreen from '@/app/(auth)/recover-identity';

function renderScreen(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <RecoverIdentityScreen />
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe('RecoverIdentityScreen', () => {
  const router = __getMockRouter();
  let recoverySpy: jest.SpyInstance;
  let deleteSpy: jest.SpyInstance;
  let completeSpy: jest.SpyInstance;
  let flowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    router.replace.mockClear();
    recoverySpy = jest
      .spyOn(KeyManager, 'attemptIdentityRecovery')
      .mockResolvedValue({ recovered: false, reason: 'not_found' });
    deleteSpy = jest.spyOn(KeyManager, 'deleteIdentity').mockResolvedValue(undefined);
    completeSpy = jest
      .spyOn(identityStore, 'persistOnboardingComplete')
      .mockResolvedValue(undefined);
    flowSpy = jest.spyOn(identityStore, 'persistOnboardingFlow').mockResolvedValue(undefined);
  });

  afterEach(() => {
    recoverySpy.mockRestore();
    deleteSpy.mockRestore();
    completeSpy.mockRestore();
    flowSpy.mockRestore();
  });

  it('force-purges a lost identity and all onboarding caches after explicit confirmation', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const removeSpy = jest.spyOn(client, 'removeQueries');
    const { findByText } = renderScreen(client);

    fireEvent.click(await findByText('Start over'));
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const actions = mockAlert.mock.calls[0]?.[2] as AlertAction[];
    actions.find(({ text }) => text === 'Erase and start over')?.onPress?.();

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(true, true, true));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)'));
    expect(completeSpy).toHaveBeenCalledWith(false);
    expect(flowSpy).toHaveBeenCalledWith(null);
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['recover-identity', 'marker'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['onboarding', 'identity'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['onboarding', 'complete'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['onboarding', 'flow'] });
  });

  it('shows a visible error when the local purge fails', async () => {
    deleteSpy.mockRejectedValueOnce(new Error('secure storage locked'));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const { findByText } = renderScreen(client);

    fireEvent.click(await findByText('Start over'));
    const actions = mockAlert.mock.calls[0]?.[2] as AlertAction[];
    actions.find(({ text }) => text === 'Erase and start over')?.onPress?.();

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "We couldn't clear the identity from this device. Unlock it and try again.",
      ),
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});
