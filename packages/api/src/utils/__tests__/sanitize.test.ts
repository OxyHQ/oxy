import {
  sanitizeHtml,
  sanitizePlainText,
  sanitizeString,
  sanitizeObject,
  sanitizeProfileUpdate,
  sanitizeSearchQuery,
  decodeHtmlEntities,
} from '../sanitize';

describe('sanitize utilities', () => {
  describe('sanitizeHtml', () => {
    it('escapes ampersands', () => {
      expect(sanitizeHtml('a & b')).toBe('a &amp; b');
    });

    it('escapes angle brackets', () => {
      expect(sanitizeHtml('<script>alert(1)</script>')).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;',
      );
    });

    it('escapes double quotes', () => {
      expect(sanitizeHtml('"hello"')).toBe('&quot;hello&quot;');
    });

    it('escapes single quotes', () => {
      expect(sanitizeHtml("it's")).toBe('it&#x27;s');
    });

    it('handles strings with no special characters', () => {
      expect(sanitizeHtml('plain text')).toBe('plain text');
    });

    it('handles empty string', () => {
      expect(sanitizeHtml('')).toBe('');
    });

    it('escapes all special characters together', () => {
      expect(sanitizeHtml('<a href="x" onclick=\'y\'>&')).toBe(
        '&lt;a href=&quot;x&quot; onclick=&#x27;y&#x27;&gt;&amp;',
      );
    });
  });

  describe('sanitizeString', () => {
    it('sanitizes strings', () => {
      expect(sanitizeString('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    });

    it('returns non-strings as-is', () => {
      expect(sanitizeString(42)).toBe(42);
      expect(sanitizeString(null)).toBe(null);
      expect(sanitizeString(undefined)).toBe(undefined);
    });
  });

  describe('sanitizePlainText', () => {
    it('decodes the hex apostrophe entity (the federated-bio double-escape bug)', () => {
      expect(sanitizePlainText('I don&#x27;t')).toBe("I don't");
    });

    it('decodes the named ampersand entity', () => {
      expect(sanitizePlainText('Arthur &amp; Thomas')).toBe('Arthur & Thomas');
    });

    it('strips tags so no <script> survives', () => {
      const result = sanitizePlainText("<script>alert('x')</script>hi");
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
      expect(result).toBe("alert('x')hi");
    });

    it('removes encoded markup by decoding first, then stripping', () => {
      // &lt;script&gt; decodes to a real tag, which is then stripped — no
      // executable markup can survive into storage.
      const result = sanitizePlainText('&lt;script&gt;evil()&lt;/script&gt;ok');
      expect(result).not.toContain('<script>');
      expect(result).toBe('evil()ok');
    });

    it('passes plain text through unchanged', () => {
      expect(sanitizePlainText('Just a normal bio')).toBe('Just a normal bio');
    });

    it('trims surrounding whitespace but preserves internal newlines', () => {
      expect(sanitizePlainText('  line one\nline two  ')).toBe('line one\nline two');
    });

    it('preserves the author paragraphs of a bio (one blank line between them)', () => {
      expect(sanitizePlainText('Para one\n\nPara two')).toBe('Para one\n\nPara two');
    });

    it('collapses blank lines that are made of SPACES, not just of newlines', () => {
      // The behaviour change: a bare `\n{3,}` collapse never matched here,
      // because the spaces break the run of newlines — so the extra blank lines
      // survived into an RN `Text` (`white-space: pre-wrap`) and the reader saw
      // them. Stripping each line's trailing whitespace FIRST is what makes the
      // collapse work.
      expect(sanitizePlainText('Para one\n   \n   \nPara two')).toBe('Para one\n\nPara two');
    });

    it('strips the trailing whitespace at the end of a line', () => {
      expect(sanitizePlainText('line one   \nline two')).toBe('line one\nline two');
    });

    it('strips the leading indentation of a line (source-markup artifact)', () => {
      // Once the runs of horizontal whitespace collapse, an indent is no longer
      // an indent — only a stray leading space the source markup left behind.
      expect(sanitizePlainText('Hola\n    \n\n      Mundo')).toBe('Hola\n\nMundo');
    });

    it('collapses a single tab and a non-breaking space to a plain space', () => {
      // The old inline collapse only fired on runs of TWO OR MORE horizontal
      // whitespace characters, so a lone tab / NBSP was stored verbatim.
      expect(sanitizePlainText('a\tb')).toBe('a b');
      expect(sanitizePlainText('a\u00A0b')).toBe('a b');
    });

    it('unifies CRLF line endings', () => {
      expect(sanitizePlainText('line one\r\nline two')).toBe('line one\nline two');
    });

    it('caps runs of blank lines at one', () => {
      expect(sanitizePlainText('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    it('is idempotent (running twice yields the same result)', () => {
      const inputs = [
        'I don&#x27;t',
        'Arthur &amp; Thomas',
        "<script>alert('x')</script>hi",
        'Just a normal bio',
      ];
      for (const input of inputs) {
        const once = sanitizePlainText(input);
        expect(sanitizePlainText(once)).toBe(once);
      }
    });

    it('returns empty/falsy input unchanged', () => {
      expect(sanitizePlainText('')).toBe('');
    });
  });

  describe('sanitizeObject', () => {
    it('strips tags from all string values (text rendering)', () => {
      const result = sanitizeObject({ name: '<b>Joe</b>', age: 30 });
      expect(result.name).toBe('Joe');
      expect(result.age).toBe(30);
    });

    it('decodes entities instead of escaping them', () => {
      const result = sanitizeObject({ note: 'don&#x27;t & won&#x27;t' });
      expect(result.note).toBe("don't & won't");
    });

    it('skips fields in skipFields list', () => {
      const result = sanitizeObject({ password: '<script>', bio: '<b>hi</b>' }, ['password']);
      expect(result.password).toBe('<script>');
      expect(result.bio).toBe('hi');
    });
  });

  describe('sanitizeProfileUpdate', () => {
    it('strips tags from text fields without entity-escaping them', () => {
      const result = sanitizeProfileUpdate({
        bio: '<script>alert(1)</script>',
        username: 'test<user>',
      });
      expect(result.bio).toBe('alert(1)');
      expect(result.username).toBe('test');
    });

    it('does NOT escape apostrophes/ampersands in text fields (renders as text)', () => {
      // A profile edit with an apostrophe in a free-text field must store the
      // literal character, NOT `&#x27;` — clients render these fields as text.
      const result = sanitizeProfileUpdate({
        description: "Live in O'Brien's town",
        bio: 'Arthur & Thomas',
        address: "12 O'Connell St",
      });
      expect(result.description).toBe("Live in O'Brien's town");
      expect(result.bio).toBe('Arthur & Thomas');
      expect(result.address).toBe("12 O'Connell St");
    });

    it('skips avatar, email, password, links, linksMetadata, locations', () => {
      const result = sanitizeProfileUpdate({
        avatar: 'file-id-123',
        email: 'test@test.com',
        password: '<secret>',
        links: ['http://example.com'],
        linksMetadata: [{ url: 'http://example.com' }],
        locations: [{ name: '<b>NYC</b>' }],
      });
      expect(result.avatar).toBe('file-id-123');
      expect(result.email).toBe('test@test.com');
      expect(result.password).toBe('<secret>');
    });

    it('does NOT escape the name field — names are validated to a strict char policy upstream', () => {
      // Display names are letters/spaces/apostrophe only and can never contain
      // an XSS vector, so escaping here would corrupt the inert apostrophe.
      const result = sanitizeProfileUpdate({
        name: { first: "O'Brien", last: 'Doe' },
      });
      expect((result.name as { first: string }).first).toBe("O'Brien");
      expect((result.name as { last: string }).last).toBe('Doe');
    });
  });

  describe('decodeHtmlEntities', () => {
    it('decodes the hex apostrophe entity', () => {
      expect(decodeHtmlEntities('O&#x27;Brien')).toBe("O'Brien");
    });

    it('decodes the numeric apostrophe entity', () => {
      expect(decodeHtmlEntities('O&#39;Brien')).toBe("O'Brien");
    });

    it('decodes named entities', () => {
      expect(decodeHtmlEntities('A &amp; B &lt;x&gt; &quot;q&quot; &apos;a&apos;')).toBe(
        'A & B <x> "q" \'a\'',
      );
    });

    it('round-trips with sanitizeHtml', () => {
      const raw = '<a href="x">O\'Neil & co</a>';
      expect(decodeHtmlEntities(sanitizeHtml(raw))).toBe(raw);
    });

    it('returns empty/falsy input unchanged', () => {
      expect(decodeHtmlEntities('')).toBe('');
    });
  });

  describe('sanitizeSearchQuery', () => {
    it('trims whitespace', () => {
      expect(sanitizeSearchQuery('  hello  ')).toBe('hello');
    });

    it('limits length', () => {
      const long = 'a'.repeat(200);
      expect(sanitizeSearchQuery(long)).toHaveLength(100);
    });

    it('accepts custom max length', () => {
      expect(sanitizeSearchQuery('abcdef', 3)).toBe('abc');
    });

    it('escapes regex metacharacters', () => {
      expect(sanitizeSearchQuery('a+b*c?')).toBe('a\\+b\\*c\\?');
    });

    it('preserves apostrophes and ampersands for name search', () => {
      expect(sanitizeSearchQuery("O'Brien & co")).toBe("O'Brien & co");
    });
  });
});
