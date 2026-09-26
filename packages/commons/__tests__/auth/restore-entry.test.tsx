import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import * as identityStore from '@/hooks/identity/identityStore';
import { __getMockRouter } from '@/__mocks__/expo-router';

// The entrance splash screens lean on Skia-backed text animations and the
// Bloom Button; none of that is relevant to the restore-affordance behaviour
// under test, so replace them with inert stand-ins to keep the render stable.
jest.mock('@/components/staggered-text', () => ({
  StaggeredText: () => null,
}));
jest.mock('@/components/staggered-text/rotating-text', () => ({
  RotatingTextAnimation: () => null,
}));
jest.mock('@/components/ui', () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    React.createElement('button', { onClick: onPress, disabled }, children),
}));
jest.mock('expo-checkbox', () => ({
  Checkbox: () => null,
}));

// Force the auth index guard to fall through to the marketing splash (the only
// state where the restore link is rendered) by pinning a "fresh device" verdict.
jest.mock('@/hooks/useOnboardingStatus', () => {
  const actual = jest.requireActual('@/hooks/useOnboardingStatus');
  return {
    ...actual,
    useOnboardingStatus: () => ({
      status: 'none',
      hasIdentity: false,
      onboardingFlow: null,
    }),
  };
});

import WelcomeScreen from '@/app/(auth)/welcome';
import AuthIndexScreen from '@/app/(auth)/index';

describe('restore-with-recovery-phrase entry points', () => {
  let persistSpy: jest.SpyInstance;
  const router = __getMockRouter();

  beforeEach(() => {
    router.push.mockClear();
    router.replace.mockClear();
    persistSpy = jest
      .spyOn(identityStore, 'persistOnboardingFlow')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    persistSpy.mockRestore();
  });

  it('welcome screen offers a restore action that targets import-identity', () => {
    const { getByLabelText } = render(
      <LocaleProvider>
        <WelcomeScreen />
      </LocaleProvider>,
    );

    const restore = getByLabelText('I already have an account');
    fireEvent.click(restore);

    expect(persistSpy).toHaveBeenCalledWith('import');
    expect(router.replace).toHaveBeenCalledWith('/(auth)/import-identity');
  });

  it('hello splash offers a restore link that targets import-identity', () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    const { getByLabelText } = render(
      <QueryClientProvider client={client}>
        <LocaleProvider>
          <AuthIndexScreen />
        </LocaleProvider>
      </QueryClientProvider>,
    );

    const restore = getByLabelText('Restore with recovery phrase');
    fireEvent.click(restore);

    expect(persistSpy).toHaveBeenCalledWith('import');
    expect(router.push).toHaveBeenCalledWith('/(auth)/import-identity');
  });
});
