import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from '@oxy.so/bloom/toast';
import LanguageSelectorScreen from '../../src/ui/screens/LanguageSelectorScreen';

const mutateAsync = jest.fn();
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    user: { id: 'owner', languages: ['en-US'] },
    isAuthenticated: true,
    currentLanguage: 'en-US',
    currentLanguages: ['en-US'],
    setLanguages: jest.fn(),
  }),
}));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({ useSurfaceHeader: () => undefined }));
jest.mock('../../src/ui/hooks/mutations/useAccountMutations', () => ({
  useUpdateProfile: () => ({ mutateAsync, isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test('reports an unconfirmed server response instead of announcing a successful language change', async () => {
  mutateAsync.mockResolvedValueOnce({ id: 'owner' });
  render(<LanguageSelectorScreen />);
  fireEvent.click(screen.getByRole('button', { name: 'Spanish (Spain)', exact: true }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('language.saveFailed'));
  expect(screen.queryByText('language.saveFailed')).toBeNull();
  expect(mutateAsync).toHaveBeenCalledWith({ languages: ['en-US', 'es-ES'] });
  expect(toast.success).not.toHaveBeenCalled();
});

test('announces success only after the server confirms the entire ordered selection', async () => {
  mutateAsync.mockResolvedValueOnce({ id: 'owner', languages: ['en-US', 'es-ES'] });
  render(<LanguageSelectorScreen />);
  fireEvent.click(screen.getByRole('button', { name: 'Spanish (Spain)', exact: true }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(screen.queryByText('language.saveFailed')).toBeNull();
});
