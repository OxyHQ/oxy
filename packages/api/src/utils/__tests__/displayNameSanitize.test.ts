import { isValidDisplayName } from '@oxyhq/core';
import {
  MAX_DISPLAY_NAME_LENGTH,
  cleanDisplayName,
} from '../displayNameSanitize';

// Every non-ASCII fixture is spelled out with explicit \u escapes so its exact
// code points (and thus NFC/combining behaviour) are unambiguous regardless of
// how this source file is Unicode-normalized on disk.
const RENEE = 'Renée'; // "Renee" with precomposed e-acute (U+00E9)
const RAMEE = 'Axe vert de La Ramée'; // "...Ramee" with precomposed e-acute
const MUNOZ = 'Renée Muñoz'; // "Renee Munoz" with e-acute + n-tilde
const CYRILLIC = 'Владимир'; // Vladimir (Cyrillic)
const CJK = '山田太郎'; // CJK name
const PENGUIN = '\u{1f427}'; // penguin emoji
const ASTERISM = '⁂'; // asterism, General_Category Po
const EARTH_GROUND = '⏚'; // earth-ground symbol, General_Category So

// Orphaned-combining-mark fixtures. Lengths are asserted in the tests below.
const TIBETAN_MARK = '༘'; // Tibetan astrological sign, General_Category Mn (combining)
const STAR_OPERATOR = '⋆'; // star operator, General_Category Sm (symbol)
const ORPHAN_PAIR = `${TIBETAN_MARK}${STAR_OPERATOR}`; // the real prod example (U+0F18 U+22C6)
// "Renee" written decomposed: base 'e' + combining acute U+0301 -> NFC e-acute.
const RENEE_DECOMPOSED = 'Renée';
// Devanagari with a virama (U+094D, Mn) and a vowel sign (U+0947, Mn).
const DEVANAGARI = 'नमस्ते';
// Thai consonant KO KAI + SARA I (U+0E34, Mn), a real combining vowel mark.
const THAI = 'กิ';
// Arabic letters interleaved with harakat (U+064F damma, U+064E fatha; Mn).
const ARABIC_MARKS = 'مُحَمَد';
const HEART = '❤'; // heavy black heart, General_Category So (symbol)
const VS16 = '️'; // VARIATION SELECTOR-16, General_Category Mn (combining)
// Batak letter (U+1BC5) — General_Category Lo (`\p{L}`), so it passed the old
// all-scripts policy, but Batak is a Limited-Use script not on the allowlist.
const BATAK = 'ᯅ'; // ᯅ
// Extra allowlisted scripts for real-name coverage.
const GREEK = 'Αριστοτέλης';
const ARMENIAN = 'Արամ';
const GEORGIAN = 'დავით';
const CHEROKEE = 'ᏔᎳ';
const KHMER = 'សុខ';

describe('displayNameSanitize', () => {
  describe('cleanDisplayName — user-reported examples', () => {
    it.each([
      [`Dabid ${ASTERISM}`, 'Dabid'],
      [`${RAMEE} ${EARTH_GROUND}`, RAMEE],
      ['Laura :bongoCat:', 'Laura'],
      [`nixCraft ${PENGUIN}`, 'nixCraft'],
      [`Miguel de Icaza ${BATAK}`, 'Miguel de Icaza'],
    ])('cleans %p → %p', (input, expected) => {
      expect(cleanDisplayName(input)).toBe(expected);
    });

    it('returns empty string for an emoji-only name', () => {
      expect(cleanDisplayName(PENGUIN)).toBe('');
    });

    it('strips a non-allowlisted (Batak) letter that is nonetheless \\p{L}', () => {
      // U+1BC5 is General_Category Lo, so the old `\p{L}` policy kept it; the
      // curated script allowlist excludes Batak, so it is now stripped.
      expect(BATAK).toHaveLength(1);
      expect(cleanDisplayName(BATAK)).toBe('');
    });
  });

  describe('cleanDisplayName — orphaned combining marks', () => {
    it('cleans the real prod example U+0F18 U+22C6 (Mn + Sm) to empty', () => {
      // U+0F18 is a combining mark allowed by the \p{M}-friendly policy, but it
      // is base-less here, so it must be stripped along with the U+22C6 symbol.
      expect(ORPHAN_PAIR).toHaveLength(2);
      expect(cleanDisplayName(ORPHAN_PAIR)).toBe('');
    });

    it('cleans a lone combining mark (U+0F18) to empty', () => {
      expect(TIBETAN_MARK).toHaveLength(1);
      expect(cleanDisplayName(TIBETAN_MARK)).toBe('');
    });

    it('strips a leading orphaned mark but keeps the following letters', () => {
      expect(cleanDisplayName(`${TIBETAN_MARK}Anna`)).toBe('Anna');
    });

    it('strips the trailing VS16 left after an emoji base is removed', () => {
      // "Mark Holmwood " + heart (U+2764) + VS16 (U+FE0F). The heart is a symbol
      // -> stripped to a space; the variation selector is a combining mark that
      // is now orphaned -> must also be removed, with no stray trailing space.
      const input = `Mark Holmwood ${HEART}${VS16}`;
      const result = cleanDisplayName(input);
      expect(result).toBe('Mark Holmwood');
      expect(result.endsWith(' ')).toBe(false);
      expect(result).not.toContain(VS16);
    });
  });

  describe('cleanDisplayName — allowed characters', () => {
    it('keeps Latin accents and n-tilde', () => {
      expect(cleanDisplayName(MUNOZ)).toBe(MUNOZ);
    });

    it('keeps Cyrillic letters', () => {
      expect(cleanDisplayName(CYRILLIC)).toBe(CYRILLIC);
    });

    it('keeps CJK letters', () => {
      expect(cleanDisplayName(CJK)).toBe(CJK);
    });

    it("keeps the straight apostrophe in O'Brien", () => {
      expect(cleanDisplayName("O'Brien")).toBe("O'Brien");
    });

    it('keeps a precomposed accented name (Renee) unchanged', () => {
      expect(cleanDisplayName(RENEE)).toBe(RENEE);
    });

    it('recomposes a decomposed accent and keeps the mark on its base letter', () => {
      // The combining acute is attached to a base 'e', so the negative
      // lookbehind protects it; NFC then recomposes it into a precomposed char.
      expect(RENEE_DECOMPOSED).toHaveLength(6); // R e n e <combining acute> e
      const result = cleanDisplayName(RENEE_DECOMPOSED);
      expect(result).toBe(RENEE);
      expect(result.normalize('NFC')).toBe(result);
    });

    it('preserves Devanagari combining marks attached to base letters', () => {
      expect(cleanDisplayName(DEVANAGARI)).toBe(DEVANAGARI);
    });

    it('preserves a Thai combining vowel mark on its base letter', () => {
      expect(cleanDisplayName(THAI)).toBe(THAI);
    });

    it('preserves Arabic harakat attached to base letters', () => {
      expect(cleanDisplayName(ARABIC_MARKS)).toBe(ARABIC_MARKS);
    });

    it.each([
      [GREEK, 'Greek'],
      [ARMENIAN, 'Armenian'],
      [GEORGIAN, 'Georgian'],
      [CHEROKEE, 'Cherokee'],
      [KHMER, 'Khmer'],
    ])('keeps allowlisted-script name %p (%s) unchanged', (name) => {
      expect(cleanDisplayName(name)).toBe(name);
    });
  });

  describe('cleanDisplayName — stripping', () => {
    it('strips digits', () => {
      expect(cleanDisplayName('Agent007')).toBe('Agent');
    });

    it('strips hyphens', () => {
      expect(cleanDisplayName('Jean-Luc')).toBe('Jean Luc');
    });

    it('strips dots', () => {
      expect(cleanDisplayName('J.R.R. Tolkien')).toBe('J R R Tolkien');
    });

    it('strips punctuation and symbols', () => {
      expect(cleanDisplayName('!?@#$%^&*()')).toBe('');
    });

    it('removes a shortcode entirely (not just its colons)', () => {
      // The shortcode strip MUST run before the char strip, otherwise the bare
      // word would survive.
      expect(cleanDisplayName('hi :bongoCat: there')).toBe('hi there');
    });

    it('collapses internal whitespace and trims the ends', () => {
      expect(cleanDisplayName('  Ada   Lovelace  ')).toBe('Ada Lovelace');
    });

    it('collapses a long run of spaces (the native profile-edit case)', () => {
      // `isValidDisplayName` accepts this — a space IS a legal display-name
      // character — so the whitespace collapse is the only thing standing between
      // the user and a name stored with a 20-space gap in it.
      expect(cleanDisplayName(`Ana${' '.repeat(20)}Gómez`)).toBe('Ana Gómez');
    });

    it('collapses a non-breaking space to a plain space', () => {
      // NBSP is `\p{Zs}`, so the character policy keeps it; the canonical inline
      // normalizer is what turns it into a plain space.
      expect(cleanDisplayName('Ada\u00A0Lovelace')).toBe('Ada Lovelace');
    });

    it.each([
      ['Ada\tLovelace', 'tab'],
      ['Ada\nLovelace', 'newline'],
      ['Ada\rLovelace', 'carriage return'],
      ['Ada\n\tLovelace', 'mixed control whitespace'],
    ])('collapses control whitespace (%s) to a single space', (input) => {
      // `\p{Zs}` no longer admits tab/newline/CR, so they are replaced with a
      // space in the char-strip step and then collapsed by the whitespace pass —
      // the net output is identical to a plain-space input.
      expect(cleanDisplayName(input)).toBe('Ada Lovelace');
    });
  });

  describe('cleanDisplayName — normalization', () => {
    it('NFC-normalizes decomposed sequences', () => {
      // "Cafe" + combining acute U+0301 (NFD) -> precomposed "Cafe-acute" (NFC).
      const decomposed = 'Café';
      expect(decomposed).toHaveLength(5);
      const expected = 'Café'; // precomposed e-acute
      const result = cleanDisplayName(decomposed);
      expect(result).toBe(expected);
      expect(result).toHaveLength(4);
      expect(result.normalize('NFC')).toBe(result);
    });
  });

  describe('cleanDisplayName — length cap', () => {
    it(`caps the result to ${MAX_DISPLAY_NAME_LENGTH} characters`, () => {
      const long = 'a'.repeat(200);
      expect(cleanDisplayName(long)).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
    });

    it('trims a trailing space left by the slice boundary', () => {
      // 80th char is a space → slice then trim removes it.
      const input = `${'a'.repeat(79)} bbbb`;
      const result = cleanDisplayName(input);
      expect(result).toBe('a'.repeat(79));
      expect(result.endsWith(' ')).toBe(false);
    });
  });

  describe('cleanDisplayName — scripts ∩ L regression (non-ASCII policy leaks)', () => {
    it.each([
      ['Muhammad\u0665', 'Muhammad', 'Arabic-Indic digit stripped from Latin name'],
      ['\u0928\u093E\u092E\u0966', '\u0928\u093E\u092E', 'Devanagari digit stripped'],
      ['\u0645\u064F\u062D\u064E\u0645\u062F\u061C', '\u0645\u064F\u062D\u064E\u0645\u062F', 'U+061C ARABIC LETTER MARK stripped'],
      ['\u09AC\u09BE\u0982\u09B2\u09BE\u09F3', '\u09AC\u09BE\u0982\u09B2\u09BE', 'Bengali rupee sign stripped'],
    ])('cleans %p → %p (%s)', (input, expected) => {
      expect(cleanDisplayName(input)).toBe(expected);
    });
  });

  // `卐` U+5350 and `卍` U+534D are CJK Unified Ideographs (GC=Lo, scx=Han), so
  // the script allowlist admits them exactly like any real Han letter and no
  // script- or category-level rule could drop them without also rejecting every
  // Chinese, Japanese and Korean name. They are subtracted from the allowlist by
  // an explicit code-point denylist in @oxyhq/core, which this module inherits
  // through DISPLAY_NAME_DISALLOWED_SOURCE — there is no separate pattern here,
  // which is why the strip path and the core reject gate cannot drift.
  describe('cleanDisplayName — symbol-letter denylist', () => {
    // The glyphs below are visually confusable with each other and with ordinary
    // ideographs, so pin them to their code points before relying on them.
    it('the fixtures below really are U+5350 and U+534D', () => {
      expect('卐'.codePointAt(0)).toBe(0x5350);
      expect('卍'.codePointAt(0)).toBe(0x534d);
    });

    it.each([
      ['卐', '', 'U+5350 alone'],
      ['卍', '', 'U+534D alone'],
      ['卐 Glowniggers 卐', 'Glowniggers', 'the production display name, decoration stripped'],
      ['卐卍', '', 'both, adjacent'],
      ['山田卍太郎', '山田 太郎', 'embedded mid-name → replaced with a space'],
      ['Ada 卍 Lovelace', 'Ada Lovelace', 'stripped and surrounding whitespace collapsed'],
    ])('cleans %p → %p (%s)', (input, expected) => {
      expect(cleanDisplayName(input)).toBe(expected);
    });

    it.each([
      ['山田太郎', 'Han (Japanese)'],
      ['김철수', 'Hangul (Korean)'],
      ['王小明', 'Han (Chinese)'],
      // The four immediate neighbours of the denied pair: the subtraction must
      // punch out exactly two code points, not a range around them.
      ['卌', 'U+534C, immediately below U+534D'],
      ['华', 'U+534E, immediately above U+534D (as in 中华)'],
      ['协', 'U+534F, immediately below U+5350'],
      ['卑', 'U+5351, immediately above U+5350'],
    ])('leaves %p untouched (%s)', (input) => {
      expect(cleanDisplayName(input)).toBe(input);
    });

    it('rejects the denied code points at the write gate too', () => {
      expect(isValidDisplayName('卐')).toBe(false);
      expect(isValidDisplayName('卍')).toBe(false);
      // Same policy source, so the gate and the strip path agree by construction.
      expect(isValidDisplayName('山田太郎')).toBe(true);
    });
  });

  // Four punctuation code points JOIN two letters inside one real name (all are
  // General_Category P, so `scripts ∩ L` stripped them by default and stripping
  // SPLIT the name in two). They are re-admitted, but ONLY between two letters:
  // the same characters are also used as ornament, and those must keep being
  // trimmed. Both halves are tested because the conditional IS the rule.
  describe('cleanDisplayName — name separators', () => {
    it('the fixtures below really are U+00B7 U+05BE U+0F0B U+30FB', () => {
      expect('·'.codePointAt(0)).toBe(0x00b7);
      expect('־'.codePointAt(0)).toBe(0x05be);
      expect('་'.codePointAt(0)).toBe(0x0f0b);
      expect('・'.codePointAt(0)).toBe(0x30fb);
    });

    // The production values from the backfill DRY_RUN that this rule exists for.
    it.each([
      ['Codeur·euses en Liberté', 'U+00B7 French inclusive writing'],
      ['Codeur·euses', 'U+00B7 bare'],
      ['Pouet·te', 'U+00B7 short form'],
      ['お坐・エガード', 'U+30FB Japanese name separator'],
      ['אייר אברמסקי־קרוננברג', 'U+05BE Hebrew maqaf compound surname'],
      ['འོད་ཟེར', 'U+0F0B Tibetan intersyllabic tsheg'],
      ['ཀི་ཁ', 'U+0F0B after a Tibetan vowel sign (combining mark) on the base letter'],
      ['مُ·م', 'U+00B7 after Arabic damma (combining mark) on the base letter'],
    ])('leaves letter-flanked %p untouched (%s)', (input) => {
      expect(cleanDisplayName(input)).toBe(input);
      // The gate agrees, from the same policy source.
      expect(isValidDisplayName(input)).toBe(true);
    });

    it.each([
      ['Roberto ·', 'Roberto', 'trailing ornament'],
      ['Michał rysiek Woźniak ·', 'Michał rysiek Woźniak', 'trailing ornament'],
      ['·Roberto', 'Roberto', 'leading'],
      ['a··b', 'a b', 'doubled — both stripped, tokens stay apart'],
      ['·', '', 'alone'],
      ['お坐・', 'お坐', 'trailing katakana middle dot'],
      ['・エガード', 'エガード', 'leading katakana middle dot'],
      ['a ·b', 'a b', 'space on the left'],
      ['a· b', 'a b', 'space on the right'],
    ])('strips unflanked %p → %p (%s)', (input, expected) => {
      expect(cleanDisplayName(input)).toBe(expected);
      expect(isValidDisplayName(input)).toBe(false);
    });

    // Step order: a character stripped in step 3 vacates the position next to a
    // separator, which must then read as unflanked.
    it('strips a separator left unflanked by an earlier strip', () => {
      expect(cleanDisplayName('a\u{1f427}·b')).toBe('a b');
    });

    it('does not reopen the ASCII hyphen', () => {
      expect(cleanDisplayName('Jean-Luc')).toBe('Jean Luc');
      expect(isValidDisplayName('Jean-Luc')).toBe(false);
    });

    it.each([
      ['卐 Glowniggers 卐', 'Glowniggers', 'denied symbol letters still stripped'],
      ['Agent007', 'Agent', 'digits still stripped'],
      ['山田太郎', '山田太郎', 'ordinary Han untouched'],
      ['김철수', '김철수', 'Hangul untouched'],
      ["Renée O'Brien", "Renée O'Brien", 'accent + apostrophe untouched'],
    ])('regression: %p → %p (%s)', (input, expected) => {
      expect(cleanDisplayName(input)).toBe(expected);
    });
  });

  describe('cleanDisplayName — XSS safety', () => {
    it.each([
      '<script>alert(1)</script>',
      'a & b',
      'O"Neil',
      '<img src=x onerror=y>',
      `Dabid ${ASTERISM} & "friends" <hi>`,
    ])('never emits <, >, &, or " for input %p', (input) => {
      const result = cleanDisplayName(input);
      expect(result).not.toMatch(/[<>&"]/);
    });
  });

  describe('isValidDisplayName', () => {
    it.each([
      `${RENEE} O'Brien`,
      CYRILLIC,
      CJK,
      'Ada Lovelace',
      '',
      RENEE,
      RENEE_DECOMPOSED,
      DEVANAGARI,
      THAI,
      ARABIC_MARKS,
      GREEK,
      ARMENIAN,
      GEORGIAN,
      CHEROKEE,
      KHMER,
    ])('returns true for clean name %p', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });

    it.each([
      `Dabid ${ASTERISM}`,
      `${RAMEE} ${EARTH_GROUND}`,
      'Laura :bongoCat:',
      `nixCraft ${PENGUIN}`,
      ORPHAN_PAIR,
      TIBETAN_MARK,
      `${TIBETAN_MARK}Anna`,
      BATAK,
      `Miguel de Icaza ${BATAK}`,
    ])('returns false for dirty name %p', (name) => {
      expect(isValidDisplayName(name)).toBe(false);
    });

    it('returns false for digits', () => {
      expect(isValidDisplayName('Agent007')).toBe(false);
    });

    it('returns false for hyphens and dots', () => {
      expect(isValidDisplayName('Jean-Luc')).toBe(false);
      expect(isValidDisplayName('J.R.')).toBe(false);
    });

    it.each([
      ['Ada\tLovelace', 'tab'],
      ['Ada\nLovelace', 'newline'],
      ['Ada\rLovelace', 'carriage return'],
      ['Line break', 'line separator U+2028'],
    ])('returns false for control whitespace (%s)', (name) => {
      // Regression: `\s` used to admit these, so a layout-breaking / multi-line
      // spoofing name passed the native 400-gate. `\p{Zs}` rejects them.
      expect(isValidDisplayName(name)).toBe(false);
    });

    it.each([
      ['Ada Lovelace', 'ASCII space'],
      ['Ada Lovelace', 'non-breaking space'],
      ['山田　太郎', 'ideographic space'],
    ])('returns true for space separators (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });
  });
});
