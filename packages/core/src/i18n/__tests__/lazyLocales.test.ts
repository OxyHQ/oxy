import { getLocalesVersion, isLocaleLoaded, loadLocale, subscribeLocales, translate } from '..';

describe('lazy locale dictionaries', () => {
  it('serves English until a dictionary loads, then announces it', async () => {
    expect(isLocaleLoaded('en-US')).toBe(true);
    expect(isLocaleLoaded('fr-CA')).toBe(false);

    const heard = jest.fn();
    const unsubscribe = subscribeLocales(heard);
    const before = getLocalesVersion();

    const english = translate('en-US', 'common.unnamed');
    // Not loaded yet: English, and the load starts.
    expect(translate('fr-CA', 'common.unnamed')).toBe(english);

    await expect(loadLocale('fr-CA')).resolves.toBe(true);
    expect(isLocaleLoaded('fr-FR')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getLocalesVersion()).toBe(before + 1);
    unsubscribe();
  });

  it('resolves an unknown language to English without loading anything', async () => {
    await expect(loadLocale('xx-YY')).resolves.toBe(true);
    expect(translate('xx-YY', 'common.unnamed')).toBe(translate('en-US', 'common.unnamed'));
  });
});
