import {
  MAX_LINK_DESCRIPTION_LENGTH,
  MAX_LINK_TITLE_LENGTH,
  MAX_LOCATION_TEXT_LENGTH,
  normalizeDisplayValue,
  normalizeLinks,
  normalizeLinksMetadata,
  normalizeLocations,
} from '../profileTextNormalization';

/**
 * The exact shape of the reported bug: a remote page served its title across
 * indented source lines, and the extracted string kept the newline and the
 * indentation.
 */
const INDENTED_REMOTE_TITLE = '\n      Mi título — Ejemplo\n    ';

describe('profileTextNormalization', () => {
  describe('normalizeDisplayValue', () => {
    it('collapses an indented multi-line remote title to one line', () => {
      expect(normalizeDisplayValue(INDENTED_REMOTE_TITLE, MAX_LINK_TITLE_LENGTH)).toBe(
        'Mi título — Ejemplo',
      );
    });

    it('caps the length and trims a cut that lands on a space', () => {
      const value = `${'a'.repeat(MAX_LINK_TITLE_LENGTH - 1)} tail`;
      const result = normalizeDisplayValue(value, MAX_LINK_TITLE_LENGTH);
      expect(result).toHaveLength(MAX_LINK_TITLE_LENGTH - 1);
      expect(result).toBe('a'.repeat(MAX_LINK_TITLE_LENGTH - 1));
    });

    it('is idempotent', () => {
      const once = normalizeDisplayValue(INDENTED_REMOTE_TITLE, MAX_LINK_TITLE_LENGTH);
      expect(normalizeDisplayValue(once, MAX_LINK_TITLE_LENGTH)).toBe(once);
    });
  });

  describe('normalizeLinksMetadata', () => {
    it('normalizes an indented remote <title> and description', () => {
      const result = normalizeLinksMetadata([
        {
          url: 'https://example.com/post ',
          title: INDENTED_REMOTE_TITLE,
          description: 'Line one\n  line two',
          image: 'file-id',
        },
      ]);

      expect(result).toEqual([
        {
          url: 'https://example.com/post',
          title: 'Mi título — Ejemplo',
          description: 'Line one line two',
          image: 'file-id',
        },
      ]);
    });

    it('collapses runs of spaces and tabs inside a title', () => {
      const result = normalizeLinksMetadata([
        { url: 'https://example.com', title: 'A\t\tspaced    title' },
      ]) as Array<{ title: string }>;
      expect(result[0].title).toBe('A spaced title');
    });

    it('caps an unbounded remote description', () => {
      const result = normalizeLinksMetadata([
        { url: 'https://example.com', description: 'x'.repeat(MAX_LINK_DESCRIPTION_LENGTH + 500) },
      ]) as Array<{ description: string }>;
      expect(result[0].description).toHaveLength(MAX_LINK_DESCRIPTION_LENGTH);
    });

    it('preserves unknown keys on an entry', () => {
      const result = normalizeLinksMetadata([
        { url: 'https://example.com', title: 'T', id: 'link-1' },
      ]);
      expect(result).toEqual([{ url: 'https://example.com', title: 'T', id: 'link-1' }]);
    });

    it('drops entries with no usable URL and non-object entries', () => {
      const result = normalizeLinksMetadata([
        { url: '   ', title: 'No URL' },
        'not-an-object',
        { url: 'https://example.com', title: 'Kept' },
      ]);
      expect(result).toEqual([{ url: 'https://example.com', title: 'Kept' }]);
    });

    it('returns a non-array input untouched so the caller validates the shape', () => {
      expect(normalizeLinksMetadata('nope')).toBe('nope');
      expect(normalizeLinksMetadata(undefined)).toBeUndefined();
    });
  });

  describe('normalizeLocations', () => {
    it('normalizes the place name, label and every address leaf', () => {
      const result = normalizeLocations([
        {
          id: 'loc-1',
          name: '  Plaça   de\nCatalunya ',
          label: 'Home  office',
          type: 'home',
          address: {
            city: ' Barcelona ',
            formattedAddress: 'Plaça de Catalunya,\n  Barcelona,   Spain',
          },
          coordinates: { lat: 41.3, lon: 2.1 },
        },
      ]);

      expect(result).toEqual([
        {
          id: 'loc-1',
          name: 'Plaça de Catalunya',
          label: 'Home office',
          type: 'home',
          address: {
            city: 'Barcelona',
            formattedAddress: 'Plaça de Catalunya, Barcelona, Spain',
          },
          coordinates: { lat: 41.3, lon: 2.1 },
        },
      ]);
    });

    it('caps an over-long place name', () => {
      const result = normalizeLocations([
        { id: 'loc-1', name: 'n'.repeat(MAX_LOCATION_TEXT_LENGTH + 50) },
      ]) as Array<{ name: string }>;
      expect(result[0].name).toHaveLength(MAX_LOCATION_TEXT_LENGTH);
    });

    it('leaves non-text fields untouched and drops non-object entries', () => {
      const result = normalizeLocations([{ id: 'loc-1', name: 'X' }, 42]);
      expect(result).toEqual([{ id: 'loc-1', name: 'X' }]);
    });
  });

  describe('normalizeLinks', () => {
    it('trims each URL and drops empty / non-string entries', () => {
      expect(normalizeLinks([' https://a.example ', '', '   ', 7, 'https://b.example'])).toEqual([
        'https://a.example',
        'https://b.example',
      ]);
    });

    it('returns a non-array input untouched', () => {
      expect(normalizeLinks(null)).toBeNull();
    });
  });
});
