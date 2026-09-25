/**
 * A raw private key is full control of the account, so the import screen keeps
 * the window out of screenshots and recordings (OxyHQ/oxy#1375 item 16).
 */
import React from 'react';
import { render } from '@testing-library/react';

const mockPreventScreenCapture = jest.fn();
jest.mock('@/hooks/usePreventScreenCapture', () => ({
  usePreventScreenCapture: (active?: boolean) => mockPreventScreenCapture(active),
}));
jest.mock('@/components/ui', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    Button: ({ children }: { children?: React.ReactNode }) => R.createElement('button', null, children),
    KeyboardAwareScrollViewWrapper: ({ children }: { children?: React.ReactNode }) =>
      R.createElement('div', null, children),
  };
});
jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({ background: '#fff', text: '#000', card: '#fff', error: '#f00' }),
}));
jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/hooks/useIdentity', () => ({
  useIdentity: () => ({ importIdentityFromPrivateKey: jest.fn() }),
}));
jest.mock('@/hooks/identity/identityStore', () => ({
  useIdentityStore: (select: (state: { setRecoveryPhraseAcknowledged: () => void }) => unknown) =>
    select({ setRecoveryPhraseAcknowledged: jest.fn() }),
}));
jest.mock('@/utils/auth/networkUtils', () => ({ checkIfOffline: jest.fn(async () => false) }));

import ImportPrivateKeyScreen from '@/app/(auth)/import-identity/private-key';

describe('Import private key screen', () => {
  it('blocks screen capture while it is open', () => {
    render(<ImportPrivateKeyScreen />);
    expect(mockPreventScreenCapture).toHaveBeenCalled();
    expect(mockPreventScreenCapture.mock.calls.every(([active]) => active !== false)).toBe(true);
  });
});
