import { DOMAIN_NAME_MAX_LENGTH, normalizeDomainName } from '../client';

describe('normalizeDomainName', () => {
  it('lower-cases and trims a hostname', () => {
    expect(normalizeDomainName(' Example.COM ')).toBe('example.com');
    expect(normalizeDomainName('a.b-c.example.co.uk')).toBe('a.b-c.example.co.uk');
    expect(normalizeDomainName('x1.io')).toBe('x1.io');
  });

  it.each([
    '',
    'localhost',
    'https://example.com',
    'example.com/',
    'my site.com',
    '-x.com',
    'x-.com',
    'x..com',
    '.x.com',
    'x.com.',
    `${'a'.repeat(64)}.com`,
  ])('refuses %p', (typed) => {
    expect(normalizeDomainName(typed)).toBeNull();
  });

  it('bounds the whole name and each label', () => {
    const label = 'a'.repeat(63);
    expect(normalizeDomainName(`${label}.com`)).toBe(`${label}.com`);
    const long = `${[label, label, label, label].join('.')}.com`;
    expect(long.length).toBeGreaterThan(DOMAIN_NAME_MAX_LENGTH);
    expect(normalizeDomainName(long)).toBeNull();
  });
});
