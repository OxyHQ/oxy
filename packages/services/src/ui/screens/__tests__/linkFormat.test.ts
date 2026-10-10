import { getLinkTitle, getLinkDescription, linksToListItems } from '../linkFormat';

describe('linkFormat', () => {
  describe('getLinkTitle', () => {
    it.each([
      ['https://example.com', 'example.com'],
      ['http://example.com/', 'example.com'],
      ['https://example.com/path/', 'example.com/path'],
      ['example.com', 'example.com'],
    ])('strips protocol and trailing slash: %p → %p', (input, expected) => {
      expect(getLinkTitle(input)).toBe(expected);
    });
  });

  describe('getLinkDescription', () => {
    it('prefixes the url with "Link to "', () => {
      expect(getLinkDescription('https://example.com')).toBe('Link to https://example.com');
    });
  });

  describe('linksToListItems', () => {
    it('maps a normal string array, preserving valid-link rendering', () => {
      const result = linksToListItems(['https://example.com/', 'http://oxy.so']);
      expect(result).toEqual([
        {
          id: 'link-0',
          url: 'https://example.com/',
          title: 'example.com',
          description: 'Link to https://example.com/',
        },
        {
          id: 'link-1',
          url: 'http://oxy.so',
          title: 'oxy.so',
          description: 'Link to http://oxy.so',
        },
      ]);
    });

    it.each([
      [null, 'null'],
      [undefined, 'undefined'],
      [42, 'a number'],
      [{ href: 'x' }, 'an object'],
      [['nested'], 'an array'],
    ])('does not throw on a non-string element (%s)', (bad) => {
      // Regression: `links.map(getLinkTitle)` called `.replace` on a
      // non-string element and crashed the editor. The coercion guard must
      // yield a string url/title/description instead.
      const run = () => linksToListItems([bad]);
      expect(run).not.toThrow();
      const [item] = run();
      expect(typeof item.url).toBe('string');
      expect(typeof item.title).toBe('string');
      expect(typeof item.description).toBe('string');
    });

    it('coerces null / undefined to an empty-string url', () => {
      const result = linksToListItems([null, undefined]);
      expect(result[0].url).toBe('');
      expect(result[0].title).toBe('');
      expect(result[1].url).toBe('');
    });

    it('returns an empty array for an empty input', () => {
      expect(linksToListItems([])).toEqual([]);
    });
  });
});
