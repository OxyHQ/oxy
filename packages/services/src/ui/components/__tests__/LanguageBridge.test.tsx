import React from 'react';
import { render } from '@testing-library/react';
import { LanguageBridge } from '../LanguageBridge';

/**
 * `OxyProvider`'s `language` prop, realized: the one place Oxy's resolved
 * language reaches a host app's own i18n library. `useOxy` is mocked here —
 * it is the SDK's own well-tested context — so these tests exercise exactly
 * what this component adds: coercion to the caller's catalog, and calling
 * back only when the RESOLVED locale actually changes.
 */

let mockCurrentLanguage = 'en-US';
jest.mock('../../context/OxyContext', () => ({
  useOxy: () => ({ currentLanguage: mockCurrentLanguage }),
}));

const HOST_CATALOG = ['en-US', 'es-ES', 'fr-FR'] as const;

beforeEach(() => {
  mockCurrentLanguage = 'en-US';
});

it('resolves and reports the account language on mount', () => {
  mockCurrentLanguage = 'es-ES';
  const onChange = jest.fn();
  render(<LanguageBridge supportedLocales={HOST_CATALOG} fallbackLocale="en-US" onChange={onChange} />);

  expect(onChange).toHaveBeenCalledWith('es-ES');
});

it('coerces a locale the host never shipped a catalog for, by base language', () => {
  mockCurrentLanguage = 'es-MX';
  const onChange = jest.fn();
  render(<LanguageBridge supportedLocales={HOST_CATALOG} fallbackLocale="en-US" onChange={onChange} />);

  expect(onChange).toHaveBeenCalledWith('es-ES');
});

it('falls back to the caller default when nothing matches, even by base', () => {
  mockCurrentLanguage = 'ja-JP';
  const onChange = jest.fn();
  render(<LanguageBridge supportedLocales={HOST_CATALOG} fallbackLocale="en-US" onChange={onChange} />);

  expect(onChange).toHaveBeenCalledWith('en-US');
});

it('calls back again only when the RESOLVED locale changes', () => {
  const onChange = jest.fn();
  const { rerender } = render(
    <LanguageBridge supportedLocales={HOST_CATALOG} fallbackLocale="en-US" onChange={onChange} />,
  );
  expect(onChange).toHaveBeenCalledTimes(1);

  // Same resolved locale, brand-new callback identity (the common case for an
  // inline arrow function) — must not re-fire.
  rerender(<LanguageBridge supportedLocales={HOST_CATALOG} fallbackLocale="en-US" onChange={() => {}} />);
  expect(onChange).toHaveBeenCalledTimes(1);

  mockCurrentLanguage = 'fr-FR';
  rerender(<LanguageBridge supportedLocales={HOST_CATALOG} fallbackLocale="en-US" onChange={onChange} />);
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenLastCalledWith('fr-FR');
});

it('reports a rejected onChange to onError instead of throwing', async () => {
  const failure = new Error('catalog failed to load');
  const onChange = jest.fn().mockRejectedValue(failure);
  const onError = jest.fn();
  render(
    <LanguageBridge
      supportedLocales={HOST_CATALOG}
      fallbackLocale="en-US"
      onChange={onChange}
      onError={onError}
    />,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onError).toHaveBeenCalledWith(failure, 'en-US');
});
