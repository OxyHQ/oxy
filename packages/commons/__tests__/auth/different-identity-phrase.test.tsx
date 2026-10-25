import { act, fireEvent, render, screen } from '@testing-library/react';
import { IdentityMayExistError } from '@/hooks/identity/identityErrors';
import { __getMockRouter } from '@/__mocks__/expo-router';

const MARKER_KEY = `04${'ab'.repeat(64)}`;
const mockImportIdentity = jest.fn();
let mockError: string | null = null;
const mockSetAuthError = jest.fn((message: string | null) => {
  mockError = message;
});

jest.mock('@/hooks/useIdentity', () => ({
  useIdentity: () => ({ importIdentity: mockImportIdentity }),
}));
jest.mock('@/contexts/auth-flow-context', () => ({
  useAuthFlowContext: () => ({ error: mockError, setAuthError: mockSetAuthError }),
}));
jest.mock('@/utils/auth/networkUtils', () => ({ checkIfOffline: async () => false }));
jest.mock('@/hooks/identity/identityStore', () => ({
  useIdentityStore: () => jest.fn(),
  persistOnboardingFlow: jest.fn(async () => undefined),
}));
jest.mock('@oxy.so/core/crypto', () => {
  class IdentityAlreadyExistsError extends Error {}
  class IdentityUnavailableError extends Error {}
  return {
    RecoveryPhraseService: { validatePhrase: () => true },
    IdentityAlreadyExistsError,
    IdentityUnavailableError,
  };
});
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
  }),
}));
jest.mock('@/components/auth/ImportPhraseStep', () => ({
  ImportPhraseStep: ({ onImport, error }: { onImport: () => void; error: string | null }) => {
    const R = jest.requireActual<typeof import('react')>('react');
    return R.createElement(
      'div',
      null,
      R.createElement('button', { onClick: onImport }, 'import'),
      error ? R.createElement('p', { role: 'alert' }, error) : null,
    );
  },
}));

import ImportIdentityPhraseScreen from '@/app/(auth)/import-identity/index';

describe('a phrase for a different identity, in the lost-identity state', () => {
  it('is refused with an explanation naming the identity this phone held', async () => {
    mockImportIdentity.mockRejectedValue(new IdentityMayExistError(MARKER_KEY));
    const router = __getMockRouter();
    router.replace.mockClear();

    const { rerender } = render(<ImportIdentityPhraseScreen />);
    await act(async () => {
      fireEvent.click(screen.getByText('import'));
    });

    expect(mockSetAuthError).toHaveBeenLastCalledWith(
      expect.stringContaining('recovery.differentIdentity'),
    );
    expect(mockError).toContain(MARKER_KEY.slice(0, 6));
    // Not bounced away: the words can be corrected here.
    expect(router.replace).not.toHaveBeenCalledWith('/(auth)/recover-identity');
    rerender(<ImportIdentityPhraseScreen />);
    expect(screen.getByRole('alert').textContent).toContain('recovery.differentIdentity');
  });
});
