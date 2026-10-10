import React from 'react';
import { render } from '@testing-library/react';
import { LocaleProvider, useBloomLocale } from '@oxy.so/bloom/locale';
import { BloomLocaleBridge } from '../BloomLocaleBridge';

/**
 * Bloom's own words follow Oxy's language unless the app already set Bloom's
 * locale: the nearest provider wins, in both directions.
 */

let mockCurrentLanguage = 'es-ES';
jest.mock('../../context/OxyContext', () => ({
  useOxy: () => ({ currentLanguage: mockCurrentLanguage }),
}));

function Probe() {
  return <span data-testid="locale">{useBloomLocale() ?? 'runtime'}</span>;
}

beforeEach(() => {
  mockCurrentLanguage = 'es-ES';
});

it("gives Bloom the account's language", () => {
  const { getByTestId } = render(
    <BloomLocaleBridge>
      <Probe />
    </BloomLocaleBridge>,
  );
  expect(getByTestId('locale').textContent).toBe('es-ES');
});

it('follows a language change', () => {
  const { getByTestId, rerender } = render(
    <BloomLocaleBridge>
      <Probe />
    </BloomLocaleBridge>,
  );
  mockCurrentLanguage = 'fr-FR';
  rerender(
    <BloomLocaleBridge>
      <Probe />
    </BloomLocaleBridge>,
  );
  expect(getByTestId('locale').textContent).toBe('fr-FR');
});

it('keeps a locale the app set above OxyProvider', () => {
  const { getByTestId } = render(
    <LocaleProvider locale="de-DE">
      <BloomLocaleBridge>
        <Probe />
      </BloomLocaleBridge>
    </LocaleProvider>,
  );
  expect(getByTestId('locale').textContent).toBe('de-DE');
});

it('yields to a provider the app mounts inside it', () => {
  const { getByTestId } = render(
    <BloomLocaleBridge>
      <LocaleProvider locale="ja-JP">
        <Probe />
      </LocaleProvider>
    </BloomLocaleBridge>,
  );
  expect(getByTestId('locale').textContent).toBe('ja-JP');
});
