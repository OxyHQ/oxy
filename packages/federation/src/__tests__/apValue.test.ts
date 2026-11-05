import {
  apDate,
  apImageUrl,
  apIri,
  apIriList,
  apList,
  apMediaTypeBase,
  isActivityPubMediaType,
} from '../index';

describe('apList', () => {
  it('reads a single value, a list and an absent value', () => {
    const tag = { type: 'Mention', href: 'https://a.example/users/b' };
    expect(apList(tag)).toEqual([tag]);
    expect(apList([tag, null])).toEqual([tag]);
    expect(apList(undefined)).toEqual([]);
    expect(apList(null)).toEqual([]);
  });
});

describe('apIri / apIriList', () => {
  it('reads an IRI string, an embedded object id and a Link href', () => {
    expect(apIri('https://a.example/u')).toBe('https://a.example/u');
    expect(apIri({ id: 'https://a.example/f', totalItems: 3 })).toBe('https://a.example/f');
    expect(apIri({ type: 'Link', href: 'https://a.example/l' })).toBe('https://a.example/l');
    expect(apIri(['https://a.example/u'])).toBeUndefined();
    expect(apIri('')).toBeUndefined();
  });

  it('lists every reference of a one-or-many property', () => {
    expect(apIriList('https://a.example/u')).toEqual(['https://a.example/u']);
    expect(apIriList(['https://a.example/u', { id: 'https://a.example/v' }, 7])).toEqual([
      'https://a.example/u',
      'https://a.example/v',
    ]);
  });
});

describe('apImageUrl', () => {
  it('reads every icon shape', () => {
    expect(apImageUrl('https://a.example/i.png')).toBe('https://a.example/i.png');
    expect(apImageUrl({ type: 'Image', url: 'https://a.example/i.png' })).toBe(
      'https://a.example/i.png',
    );
    expect(
      apImageUrl({ type: 'Image', url: { type: 'Link', href: 'https://a.example/l.png' } }),
    ).toBe('https://a.example/l.png');
    expect(
      apImageUrl([
        { type: 'Image', url: 'not a url' },
        { type: 'Image', url: [{ href: 'https://a.example/big.png' }] },
      ]),
    ).toBe('https://a.example/big.png');
    expect(apImageUrl({ type: 'Image' })).toBeUndefined();
  });
});

describe('apMediaTypeBase / isActivityPubMediaType', () => {
  it('compares the base type whatever the parameters', () => {
    expect(apMediaTypeBase('Application/LD+JSON;profile=x')).toBe('application/ld+json');
    expect(isActivityPubMediaType('application/activity+json')).toBe(true);
    expect(
      isActivityPubMediaType('application/ld+json;profile="https://www.w3.org/ns/activitystreams"'),
    ).toBe(true);
    expect(isActivityPubMediaType('text/html')).toBe(false);
    expect(isActivityPubMediaType(undefined)).toBe(false);
  });
});

describe('apDate', () => {
  it('reads every ISO 8601 offset spelling as the same instant', () => {
    const instant = '2024-01-01T12:00:00.000Z';
    for (const value of [
      '2024-01-01T12:00:00Z',
      '2024-01-01T12:00:00+00:00',
      '2024-01-01T12:00:00+0000',
      '2024-01-01T12:00:00+00',
      '2024-01-01 12:00:00Z',
      '2024-01-01T12:00:00',
      '2024-01-01T14:00:00+02',
    ]) {
      expect(apDate(value)?.toISOString()).toBe(instant);
    }
  });

  it('names no date for garbage, and passes a valid Date through', () => {
    expect(apDate('garbage')).toBeUndefined();
    expect(apDate('2024-13-01T00:00:00Z')).toBeUndefined();
    expect(apDate(42)).toBeUndefined();
    const date = new Date('2024-01-01T00:00:00Z');
    expect(apDate(date)).toBe(date);
  });
});
