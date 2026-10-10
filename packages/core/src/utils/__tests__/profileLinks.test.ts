import { normalizeProfileLinks, type ProfileLink } from '../profileLinks';

describe('normalizeProfileLinks', () => {
  describe('linksMetadata path (preferred)', () => {
    it('maps title + url and uses the entry id when present', () => {
      const result = normalizeProfileLinks([{ url: 'https://oxy.so', title: 'Oxy', id: 'abc' }]);
      expect(result).toEqual<ProfileLink[]>([{ id: 'abc', title: 'Oxy', url: 'https://oxy.so' }]);
    });

    it('falls back to the index when an entry has no id', () => {
      const result = normalizeProfileLinks([
        { url: 'https://a.example', title: 'A' },
        { url: 'https://b.example', title: 'B' },
      ]);
      expect(result).toEqual<ProfileLink[]>([
        { id: '0', title: 'A', url: 'https://a.example' },
        { id: '1', title: 'B', url: 'https://b.example' },
      ]);
    });

    it('omits title when absent', () => {
      const result = normalizeProfileLinks([{ url: 'https://no-title.example' }]);
      expect(result).toEqual<ProfileLink[]>([{ id: '0', url: 'https://no-title.example' }]);
      expect(result[0]).not.toHaveProperty('title');
    });

    it('carries through description and image when present', () => {
      const result = normalizeProfileLinks([
        {
          url: 'https://oxy.so',
          title: 'Oxy',
          description: 'The Oxy ecosystem',
          image: 'https://cdn.example/oxy.png',
          id: 'abc',
        },
      ]);
      expect(result).toEqual<ProfileLink[]>([
        {
          id: 'abc',
          title: 'Oxy',
          url: 'https://oxy.so',
          description: 'The Oxy ecosystem',
          image: 'https://cdn.example/oxy.png',
        },
      ]);
    });

    it('omits description and image when absent', () => {
      const result = normalizeProfileLinks([{ url: 'https://min.example', title: 'Min' }]);
      expect(result).toEqual<ProfileLink[]>([
        { id: '0', title: 'Min', url: 'https://min.example' },
      ]);
      expect(result[0]).not.toHaveProperty('description');
      expect(result[0]).not.toHaveProperty('image');
    });

    it('carries description and image independently of title', () => {
      const result = normalizeProfileLinks([
        { url: 'https://only-image.example', image: 'https://cdn.example/i.png' },
        { url: 'https://only-desc.example', description: 'Just a description' },
      ]);
      expect(result).toEqual<ProfileLink[]>([
        { id: '0', url: 'https://only-image.example', image: 'https://cdn.example/i.png' },
        { id: '1', url: 'https://only-desc.example', description: 'Just a description' },
      ]);
      expect(result[0]).not.toHaveProperty('title');
      expect(result[0]).not.toHaveProperty('description');
      expect(result[1]).not.toHaveProperty('title');
      expect(result[1]).not.toHaveProperty('image');
    });

    it('drops entries with missing or empty url and keeps stable index ids', () => {
      const result = normalizeProfileLinks([
        { url: 'https://keep.example', title: 'Keep', id: 'keep' },
        { url: '', title: 'Empty' },
        { url: '   ', title: 'Whitespace' },
        { url: 'https://second.example', title: 'Second' },
      ]);
      expect(result).toEqual<ProfileLink[]>([
        { id: 'keep', title: 'Keep', url: 'https://keep.example' },
        // index is preserved from the source array position (3), not re-numbered
        { id: '3', title: 'Second', url: 'https://second.example' },
      ]);
    });

    it('trims surrounding whitespace from urls', () => {
      const result = normalizeProfileLinks([{ url: '  https://trim.example  ' }]);
      expect(result).toEqual<ProfileLink[]>([{ id: '0', url: 'https://trim.example' }]);
    });

    it('does NOT add a scheme to bare urls', () => {
      const result = normalizeProfileLinks([{ url: 'oxy.so', title: 'Bare' }]);
      expect(result).toEqual<ProfileLink[]>([{ id: '0', title: 'Bare', url: 'oxy.so' }]);
    });
  });

  describe('legacy links path (no linksMetadata)', () => {
    it('maps strings to { id, url } without title/description/image', () => {
      const result = normalizeProfileLinks(undefined, ['https://a.example', 'https://b.example']);
      expect(result).toEqual<ProfileLink[]>([
        { id: '0', url: 'https://a.example' },
        { id: '1', url: 'https://b.example' },
      ]);
      expect(
        result.every(
          (link) => !('title' in link) && !('description' in link) && !('image' in link),
        ),
      ).toBe(true);
    });

    it('drops empty and whitespace-only strings, preserving source index ids', () => {
      const result = normalizeProfileLinks(undefined, [
        'https://keep.example',
        '',
        '   ',
        'https://second.example',
      ]);
      expect(result).toEqual<ProfileLink[]>([
        { id: '0', url: 'https://keep.example' },
        { id: '3', url: 'https://second.example' },
      ]);
    });
  });

  describe('fall-through and empty inputs', () => {
    it('returns [] when both inputs are absent', () => {
      expect(normalizeProfileLinks()).toEqual([]);
      expect(normalizeProfileLinks(undefined, undefined)).toEqual([]);
    });

    it('returns [] when both inputs are empty arrays', () => {
      expect(normalizeProfileLinks([], [])).toEqual([]);
    });

    it('falls through to legacy links when linksMetadata is empty', () => {
      const result = normalizeProfileLinks([], ['https://legacy.example']);
      expect(result).toEqual<ProfileLink[]>([{ id: '0', url: 'https://legacy.example' }]);
    });

    it('returns [] (does NOT fall back to links) when linksMetadata is non-empty but every entry is dropped', () => {
      const result = normalizeProfileLinks(
        [{ url: '' }, { url: '   ' }],
        ['https://legacy.example'],
      );
      expect(result).toEqual([]);
    });
  });

  it('is pure — does not mutate its inputs', () => {
    const linksMetadata = [{ url: 'https://oxy.so', title: 'Oxy', id: 'abc' }];
    const links = ['https://legacy.example'];
    const metadataSnapshot = JSON.stringify(linksMetadata);
    const linksSnapshot = JSON.stringify(links);

    normalizeProfileLinks(linksMetadata, links);

    expect(JSON.stringify(linksMetadata)).toBe(metadataSnapshot);
    expect(JSON.stringify(links)).toBe(linksSnapshot);
  });
});
