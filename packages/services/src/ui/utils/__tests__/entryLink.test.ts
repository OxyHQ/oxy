import { readEntryLink, readCampaignAttribution } from '../entryLink';

it.each([
  ['https://mention.earth/?lang=es', 'es-ES'],
  ['mention://compose?lang=fr-BE', 'fr-FR'],
  ['https://mention.earth/?lang=zz', undefined],
  ['https://mention.earth/?lang=en&lang=es', undefined],
  ['not a url', undefined],
])('resolves supported entry locale %s', (url, expected) => {
  expect(readEntryLink(url).language).toBe(expected);
});

it('captures only campaign fields without retaining the URL, a referrer or unrelated private query data', () => {
  expect(
    readEntryLink(
      'https://mention.earth/write?utm_source=meta&utm_campaign=Spain&fbclid=click&email=private@example.test',
    ),
  ).toEqual({
    language: undefined,
    campaignAttribution: { utmSource: 'meta', utmCampaign: 'Spain', fbclid: 'click' },
  });
});

it('drops empty, duplicate, overlong and control-character campaign values', () => {
  const url = `mention://?utm_source=one&utm_source=two&utm_medium=&utm_campaign=${'x'.repeat(257)}&utm_content=bad%00value`;
  expect(readEntryLink(url).campaignAttribution).toBeUndefined();
  expect(
    readCampaignAttribution({ fbclid: 'x'.repeat(1025), utmSource: ' meta ', private: 'secret' }),
  ).toEqual({ utmSource: 'meta' });
});
