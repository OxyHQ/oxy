import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { AccountLanguageBoundary } from '../AccountLanguageBoundary';

let mockCurrentLanguage = 'en-US';
let mockCanUsePrivateApi = true;
const mockUser = { id: 'account', publicKey: '', username: 'ada', name: {} };
let mockQuery: {
  value?: typeof mockUser & { languages?: string[] };
  updatedAt: number;
  status: 'success' | 'error';
  fetchStatus?: 'fetching' | 'paused' | 'idle';
};
jest.mock('../../context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    canUsePrivateApi: mockCanUsePrivateApi,
    user: mockUser,
    currentLanguage: mockCurrentLanguage,
    isLanguageReady: true,
    isAuthResolved: true,
  }),
}));
jest.mock('../../hooks/queries/useAccountQueries', () => ({ useCurrentUser: () => mockQuery }));

it('waits for the owner preference query and its runtime projection before painting the account app', async () => {
  mockQuery = { value: mockUser, updatedAt: 0, status: 'success' };
  const onChange = jest.fn();
  const config = { supportedLocales: ['en-US', 'es-ES'], fallbackLocale: 'en-US', onChange };
  const screen = render(
    <AccountLanguageBoundary language={config}>
      <span>App</span>
    </AccountLanguageBoundary>,
  );
  expect(screen.queryByText('App')).toBeNull();
  mockQuery = { value: { ...mockUser, languages: ['es-ES'] }, updatedAt: 123, status: 'success' };
  screen.rerender(
    <AccountLanguageBoundary language={config}>
      <span>App</span>
    </AccountLanguageBoundary>,
  );
  expect(screen.queryByText('App')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  mockCurrentLanguage = 'es-ES';
  screen.rerender(
    <AccountLanguageBoundary language={config}>
      <span>App</span>
    </AccountLanguageBoundary>,
  );
  await waitFor(() => expect(screen.getByText('App')).toBeTruthy());
  expect(onChange.mock.calls).toEqual([['es-ES']]);
});

it.each(['paused', 'disabled', 'error'] as const)(
  'renders the resolved fallback when the account query is %s, then adopts its preference without remounting',
  async (unavailable) => {
    mockCurrentLanguage = 'en-US';
    mockCanUsePrivateApi = unavailable !== 'disabled';
    mockQuery = {
      value: mockUser,
      updatedAt: 0,
      status: unavailable === 'error' ? 'error' : 'success',
      fetchStatus: unavailable === 'paused' ? 'paused' : 'idle',
    };
    const onChange = jest.fn();
    const config = { supportedLocales: ['en-US', 'es-ES'], fallbackLocale: 'en-US', onChange };
    const view = () => (
      <AccountLanguageBoundary language={config}>
        <input aria-label="Draft" defaultValue="Kept" />
      </AccountLanguageBoundary>
    );
    const screen = render(view());
    await waitFor(() => expect(screen.getByLabelText('Draft')).toBeTruthy());
    const draft = screen.getByLabelText('Draft');
    expect(onChange.mock.calls).toEqual([['en-US']]);
    mockCanUsePrivateApi = true;
    mockQuery = {
      value: { ...mockUser, languages: ['es-ES'] },
      updatedAt: 123,
      status: 'success',
      fetchStatus: 'idle',
    };
    mockCurrentLanguage = 'es-ES';
    screen.rerender(view());
    await waitFor(() => expect(onChange.mock.calls).toEqual([['en-US'], ['es-ES']]));
    expect(screen.getByLabelText('Draft')).toBe(draft);
  },
);
