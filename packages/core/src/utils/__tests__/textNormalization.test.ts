import { normalizeInlineText, normalizeMultilineText } from '../textNormalization';

/**
 * Whitespace characters are built from their code points rather than pasted as
 * literals: an NBSP or a U+2028 in the source would be invisible to a reviewer
 * and trivially "fixed" by an editor, silently gutting the test it anchors.
 */
const NBSP = String.fromCharCode(0x00a0); // no-break space
const EN_QUAD = String.fromCharCode(0x2000); // U+2000 space block
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000); // CJK full-width space
const NARROW_NBSP = String.fromCharCode(0x202f);
const ZWNBSP = String.fromCharCode(0xfeff); // BOM when leading
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** "é" as a base letter plus a combining acute accent (NFD form). */
const DECOMPOSED_E_ACUTE = `e${String.fromCharCode(0x0301)}`;
/** The precomposed "é" (NFC form) the two above must normalize into. */
const COMPOSED_E_ACUTE = String.fromCharCode(0x00e9);

describe('normalizeInlineText', () => {
  it('flattens the indented multi-line <title> that caused the original bug', () => {
    expect(normalizeInlineText('\n      Mi título\n    ')).toBe('Mi título');
  });

  it('collapses every whitespace form to a single space', () => {
    expect(normalizeInlineText('a\tb\nc\r\nd  e')).toBe('a b c d e');
  });

  it('collapses Unicode spaces (NBSP, U+2000 block, ideographic, narrow NBSP)', () => {
    expect(normalizeInlineText(`a${NBSP}b${EN_QUAD}c${IDEOGRAPHIC_SPACE}d${NARROW_NBSP}e`)).toBe(
      'a b c d e',
    );
  });

  it('collapses the Unicode line and paragraph separators', () => {
    expect(normalizeInlineText(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`)).toBe('a b c');
  });

  it('strips a leading BOM / zero-width no-break space', () => {
    expect(normalizeInlineText(`${ZWNBSP}Título`)).toBe('Título');
  });

  it('handles CRLF line endings', () => {
    expect(normalizeInlineText('News\r\n\r\nToday')).toBe('News Today');
  });

  it('returns an empty string for empty and whitespace-only input', () => {
    expect(normalizeInlineText('')).toBe('');
    expect(normalizeInlineText('   ')).toBe('');
    expect(normalizeInlineText(`\n\t ${NBSP}\r\n`)).toBe('');
  });

  it('NFC-normalizes so decomposed accents are stored composed', () => {
    const normalized = normalizeInlineText(`Ren${DECOMPOSED_E_ACUTE}e`);
    expect(normalized).toBe(`Ren${COMPOSED_E_ACUTE}e`);
    expect(normalized).toHaveLength(5);
  });

  it('leaves already-clean text untouched', () => {
    expect(normalizeInlineText('Hacker News')).toBe('Hacker News');
    expect(normalizeInlineText('Título en español — con guion')).toBe(
      'Título en español — con guion',
    );
  });

  it('does not truncate long values (length caps are a product rule)', () => {
    const long = 'a'.repeat(500);
    expect(normalizeInlineText(long)).toHaveLength(500);
  });

  it("does not strip markup or punctuation (that is the sanitizer's job)", () => {
    expect(normalizeInlineText('  <b>Bold</b> & "quoted"  ')).toBe('<b>Bold</b> & "quoted"');
  });

  it('is idempotent', () => {
    const inputs = [
      '\n      Mi título\n    ',
      `a${NBSP}${NBSP}b`,
      'Hacker News',
      '',
      '   ',
      `Ren${DECOMPOSED_E_ACUTE}e`,
    ];
    for (const input of inputs) {
      const once = normalizeInlineText(input);
      expect(normalizeInlineText(once)).toBe(once);
    }
  });
});

describe('normalizeMultilineText', () => {
  it("preserves the author's paragraphs", () => {
    const body = 'First paragraph.\n\nSecond paragraph.\nSame paragraph, next line.';
    expect(normalizeMultilineText(body)).toBe(body);
  });

  it('collapses a blank line that contains spaces — the ordering bug', () => {
    // The "blank" lines hold spaces, so they break the run of \n characters: a
    // bare /\n{3,}/ collapse never sees them. Trailing horizontal whitespace
    // must be stripped FIRST.
    expect(normalizeMultilineText('a\n    \n    \nb')).toBe('a\n\nb');
  });

  it('collapses a blank line that contains tabs and NBSP', () => {
    expect(normalizeMultilineText(`a\n\t\n${NBSP}${NBSP}\nb`)).toBe('a\n\nb');
  });

  it('strips trailing horizontal whitespace from every line', () => {
    expect(normalizeMultilineText('one   \ntwo\t\nthree ')).toBe('one\ntwo\nthree');
  });

  it('collapses three or more newlines to a single blank line', () => {
    expect(normalizeMultilineText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('keeps exactly one blank line as-is', () => {
    expect(normalizeMultilineText('a\n\nb')).toBe('a\n\nb');
  });

  it('collapses runs of horizontal whitespace to one space, keeping newlines', () => {
    expect(normalizeMultilineText('hello    world\nsecond\t\tline')).toBe(
      'hello world\nsecond line',
    );
  });

  it('strips leading horizontal whitespace from every line', () => {
    expect(normalizeMultilineText('a\n b')).toBe('a\nb');
    expect(normalizeMultilineText('one\n\ttwo\n      three')).toBe('one\ntwo\nthree');
  });

  it('leaves no indent residue after a space-filled blank line', () => {
    // The blank line collapses AND the six-space indent goes away entirely —
    // collapsing it to a single space would leave a visible artifact under
    // `white-space: pre-wrap`.
    expect(normalizeMultilineText('Hola\n    \n\n      Mundo')).toBe('Hola\n\nMundo');
  });

  it('normalizes CRLF and lone CR to \\n', () => {
    expect(normalizeMultilineText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizeMultilineText('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
  });

  it('normalizes the Unicode line and paragraph separators to \\n', () => {
    expect(normalizeMultilineText(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`)).toBe('a\nb\nc');
  });

  it('collapses Unicode spaces without touching line structure', () => {
    expect(normalizeMultilineText(`a${NBSP}${NBSP}b\nc${IDEOGRAPHIC_SPACE}d`)).toBe('a b\nc d');
  });

  it('trims both ends, including leading and trailing blank lines', () => {
    expect(normalizeMultilineText('\n\n  Hello\n\nWorld  \n\n  ')).toBe('Hello\n\nWorld');
  });

  it('returns an empty string for empty and whitespace-only input', () => {
    expect(normalizeMultilineText('')).toBe('');
    expect(normalizeMultilineText('   ')).toBe('');
    expect(normalizeMultilineText(`\n\n \t${NBSP}\r\n  \n`)).toBe('');
  });

  it('NFC-normalizes so decomposed accents are stored composed', () => {
    expect(normalizeMultilineText(`Caf${DECOMPOSED_E_ACUTE}\n\nabierto`)).toBe(
      `Caf${COMPOSED_E_ACUTE}\n\nabierto`,
    );
  });

  it('leaves an already-clean body untouched', () => {
    const body = 'Line one\nLine two\n\nNew paragraph.';
    expect(normalizeMultilineText(body)).toBe(body);
  });

  it('cleans a realistic federated post body without losing its paragraphs', () => {
    const federated = '  Hola a todos.\r\n   \r\n\r\nEsto  es  una   prueba.\t\r\nFin.   ';
    expect(normalizeMultilineText(federated)).toBe('Hola a todos.\n\nEsto es una prueba.\nFin.');
  });

  it('is idempotent', () => {
    const inputs = [
      'a\n    \n    \nb',
      'a\r\n\r\n\r\nb',
      'First paragraph.\n\nSecond paragraph.',
      `a${NBSP}b`,
      'a\n b',
      'Hola\n    \n\n      Mundo',
      '',
      '   ',
      `Caf${DECOMPOSED_E_ACUTE}`,
    ];
    for (const input of inputs) {
      const once = normalizeMultilineText(input);
      expect(normalizeMultilineText(once)).toBe(once);
    }
  });
});

describe('choosing between the two helpers', () => {
  it('inline flattens what multiline preserves', () => {
    const body = 'Title\n\nSubtitle';
    expect(normalizeInlineText(body)).toBe('Title Subtitle');
    expect(normalizeMultilineText(body)).toBe('Title\n\nSubtitle');
  });
});
