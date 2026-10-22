import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rotate = jest.fn();

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    oxyServices: { apps: { credentials: { rotate } } },
    isAuthenticated: true,
    isReady: true,
  }),
}));

jest.mock('@/hooks/use-account', () => ({
  useAccount: () => ({ currentAccount: { accountId: 'acct_1' } }),
}));

import { useRotateCredential } from '../use-applications';

describe('useRotateCredential', () => {
  it('refetches the credential list: a rotation mints a new credential and deprecates the old', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    rotate.mockResolvedValue({
      credential: { _id: 'cred_new', applicationId: 'app_1', name: 'key' },
      secret: null,
    });

    const { result } = renderHook(() => useRotateCredential(), { wrapper });
    await act(() => result.current.mutateAsync({ appId: 'app_1', credentialId: 'cred_old' }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['application-credentials', 'app_1'] });
  });
});
