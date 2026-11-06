import {
  clampLinkTitle,
  getLinkTitle,
  getLinkDescription,
  linkIdentity,
  linksToListItems,
  applyLinkFormResult,
  normalizeLinkInput,
} from '../linkFormat';

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

describe('normalizeLinkInput', () => {
  it('adds https to a bare host and keeps its path', () => {
    expect(normalizeLinkInput(' example.com/me ')).toEqual({ url: 'https://example.com/me' });
  });

  it('refuses plain http rather than upgrading it silently', () => {
    expect(normalizeLinkInput('http://example.com')).toEqual({ error: 'insecure' });
  });

  it('reports empty and unparseable input', () => {
    expect(normalizeLinkInput('   ')).toEqual({ error: 'empty' });
    expect(normalizeLinkInput('not a link')).toEqual({ error: 'invalid' });
  });
});

describe('linkIdentity', () => {
  it('treats www, a trailing slash and host case as the same page', () => {
    expect(linkIdentity('https://WWW.Example.com/me/')).toBe(
      linkIdentity('https://example.com/me'),
    );
  });

  it('keeps the query, which can name a different page', () => {
    expect(linkIdentity('https://example.com/a?x=1')).not.toBe(
      linkIdentity('https://example.com/a'),
    );
  });
});

describe('clampLinkTitle', () => {
  it('cuts to the title limit by characters, not UTF-16 units', () => {
    const emoji = '🙂'.repeat(50);
    expect(Array.from(clampLinkTitle(emoji))).toHaveLength(40);
  });
});

describe('applyLinkFormResult', () => {
  const item = (id: string, url: string, title = '') => ({
    id,
    url,
    title,
    description: `Link to ${url}`,
  });
  const existing = [item('a', 'https://a.test/'), item('b', 'https://b.test/')];
  const newId = () => 'new-1';

  it('appends a saved link, with its title and description', () => {
    const next = applyLinkFormResult(
      existing,
      null,
      { kind: 'save', url: 'https://c.test/', title: 'Site' },
      10,
      newId,
    );
    expect(next[2]).toEqual({
      id: 'new-1',
      url: 'https://c.test/',
      title: 'Site',
      description: 'Link to https://c.test/',
    });
  });

  it('replaces the link being edited and keeps its id', () => {
    const next = applyLinkFormResult(
      existing,
      1,
      { kind: 'save', url: 'https://b2.test/', title: '' },
      10,
      newId,
    );
    expect(next[1]).toMatchObject({ id: 'b', url: 'https://b2.test/', title: '' });
    expect(next).toHaveLength(2);
  });

  it('refuses a new link once the profile is full', () => {
    const next = applyLinkFormResult(
      existing,
      null,
      { kind: 'save', url: 'https://c.test/', title: '' },
      2,
      newId,
    );
    expect(next).toEqual(existing);
  });

  it('removes the link being edited, and nothing for a new one', () => {
    expect(applyLinkFormResult(existing, 0, { kind: 'remove' }, 10, newId)).toEqual([existing[1]]);
    expect(applyLinkFormResult(existing, null, { kind: 'remove' }, 10, newId)).toEqual(existing);
  });
});
