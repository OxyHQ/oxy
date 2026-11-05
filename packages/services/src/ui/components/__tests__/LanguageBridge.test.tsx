import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { LanguageBridge } from '../LanguageBridge';

let mockCurrentLanguage = 'en-US';
let mockLanguageReady = true;
let mockAuthResolved = true;
jest.mock('../../context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    currentLanguage: mockCurrentLanguage,
    isLanguageReady: mockLanguageReady,
    isAuthResolved: mockAuthResolved,
  }),
}));
const HOST_CATALOG = ['en-US', 'es-ES', 'fr-FR'] as const;
beforeEach(() => {
  mockCurrentLanguage = 'en-US';
  mockLanguageReady = true;
  mockAuthResolved = true;
});

it.each([
  ['es-ES', 'es-ES'],
  ['es-MX', 'es-ES'],
  ['ja-JP', 'en-US'],
])('resolves %s to the host catalog %s', async (locale, expected) => {
  mockCurrentLanguage = locale;
  const onChange = jest.fn();
  render(
    <LanguageBridge config={{ supportedLocales: HOST_CATALOG, fallbackLocale: 'en-US', onChange }}>
      <span>App</span>
    </LanguageBridge>,
  );
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expected));
});

it('does not paint any app text before saved preferences, account restoration and catalog loading finish', async () => {
  mockLanguageReady = false;
  mockAuthResolved = false;
  let finishCatalog: (() => void) | undefined;
  const onChange = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCatalog = resolve;
      }),
  );
  const config = { supportedLocales: HOST_CATALOG, fallbackLocale: 'en-US', onChange };
  const children = <span>Translated app</span>;
  const screen = render(<LanguageBridge config={config}>{children}</LanguageBridge>);
  expect(screen.queryByText('Translated app')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  mockLanguageReady = true;
  mockCurrentLanguage = 'es-ES';
  screen.rerender(<LanguageBridge config={config}>{children}</LanguageBridge>);
  expect(onChange).not.toHaveBeenCalled();
  mockAuthResolved = true;
  screen.rerender(<LanguageBridge config={config}>{children}</LanguageBridge>);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('es-ES'));
  expect(screen.queryByText('Translated app')).toBeNull();
  await act(async () => finishCatalog?.());
  expect(screen.getByText('Translated app')).toBeTruthy();
});

it('keeps route state mounted across a language change and ignores callback identity changes', async () => {
  let mounts = 0;
  function Page() {
    React.useEffect(() => {
      mounts += 1;
    }, []);
    return <span>App</span>;
  }
  const onChange = jest.fn();
  const config = { supportedLocales: HOST_CATALOG, fallbackLocale: 'en-US', onChange };
  const screen = render(
    <LanguageBridge config={config}>
      <Page />
    </LanguageBridge>,
  );
  await waitFor(() => expect(mounts).toBe(1));
  screen.rerender(
    <LanguageBridge config={{ ...config, onChange: jest.fn() }}>
      <Page />
    </LanguageBridge>,
  );
  expect(onChange).toHaveBeenCalledTimes(1);
  mockCurrentLanguage = 'fr-FR';
  screen.rerender(
    <LanguageBridge config={config}>
      <Page />
    </LanguageBridge>,
  );
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('fr-FR'));
  expect(mounts).toBe(1);
});

it('reports a failed catalog and initializes the fallback before showing children', async () => {
  mockCurrentLanguage = 'es-ES';
  const failure = new Error('catalog unavailable');
  const onChange = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
  const onError = jest.fn();
  const screen = render(
    <LanguageBridge
      config={{ supportedLocales: HOST_CATALOG, fallbackLocale: 'en-US', onChange, onError }}
    >
      <span>App</span>
    </LanguageBridge>,
  );
  await waitFor(() => expect(screen.getByText('App')).toBeTruthy());
  expect(onError).toHaveBeenCalledWith(failure, 'es-ES');
  expect(onChange.mock.calls.map(([locale]) => locale)).toEqual(['es-ES', 'en-US']);
});
