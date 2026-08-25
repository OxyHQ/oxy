import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isRequiredString,
  isRequiredNumber,
  isRequiredBoolean,
  isValidArray,
  isValidObject,
  isValidEmail,
  isValidPassword,
  isValidDisplayName,
  DISPLAY_NAME_ALLOWED_SCRIPTS,
  DISPLAY_NAME_DISALLOWED_SOURCE,
  DISPLAY_NAME_ORPHANED_MARK_SOURCE,
  DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE,
  isValidUUID,
  isValidDate,
  isValidFileSize,
  isValidFileType,
  sanitizeString,
  sanitizeHTML,
  validateAndSanitizeUserInput
} from '../validationUtils';
// Imported from the generated module rather than re-exported through
// `validationUtils`: the broad letters class is an internal operand of the
// orphaned-mark lookbehind, and the denylist is a generation-time operand
// already subtracted from the allowlist — neither is part of the policy's
// public runtime surface.
import {
  DISPLAY_NAME_DENIED_SYMBOL_LETTERS_RANGES,
  DISPLAY_NAME_LETTERS_RANGES,
  DISPLAY_NAME_NAME_SEPARATORS_RANGES,
} from '../displayNamePolicyRanges.generated';

describe('Validation Utils', () => {
  describe('isRequiredString', () => {
    it('should return true for valid non-empty strings', () => {
      expect(isRequiredString('hello')).toBe(true);
      expect(isRequiredString('  hello  ')).toBe(true); // trims whitespace
    });

    it('should return false for invalid or empty strings', () => {
      expect(isRequiredString('')).toBe(false);
      expect(isRequiredString('   ')).toBe(false); // only whitespace
      expect(isRequiredString(null)).toBe(false);
      expect(isRequiredString(undefined)).toBe(false);
      expect(isRequiredString(123)).toBe(false);
    });
  });

  describe('isRequiredNumber', () => {
    it('should return true for valid numbers', () => {
      expect(isRequiredNumber(123)).toBe(true);
      expect(isRequiredNumber(0)).toBe(true);
      expect(isRequiredNumber(-456)).toBe(true);
      expect(isRequiredNumber(3.14)).toBe(true);
    });

    it('should return false for invalid numbers', () => {
      expect(isRequiredNumber(Number.NaN)).toBe(false);
      expect(isRequiredNumber('123')).toBe(false);
      expect(isRequiredNumber(null)).toBe(false);
      expect(isRequiredNumber(undefined)).toBe(false);
    });
  });

  describe('isRequiredBoolean', () => {
    it('should return true for boolean values', () => {
      expect(isRequiredBoolean(true)).toBe(true);
      expect(isRequiredBoolean(false)).toBe(true);
    });

    it('should return false for non-boolean values', () => {
      expect(isRequiredBoolean('true')).toBe(false);
      expect(isRequiredBoolean(1)).toBe(false);
      expect(isRequiredBoolean(0)).toBe(false);
      expect(isRequiredBoolean(null)).toBe(false);
      expect(isRequiredBoolean(undefined)).toBe(false);
    });
  });

  describe('isValidArray', () => {
    it('should return true for arrays', () => {
      expect(isValidArray([])).toBe(true);
      expect(isValidArray([1, 2, 3])).toBe(true);
      expect(isValidArray(['a', 'b'])).toBe(true);
    });

    it('should return false for non-arrays', () => {
      expect(isValidArray({})).toBe(false);
      expect(isValidArray('[]')).toBe(false);
      expect(isValidArray(null)).toBe(false);
      expect(isValidArray(undefined)).toBe(false);
    });
  });

  describe('isValidObject', () => {
    it('should return true for plain objects', () => {
      expect(isValidObject({})).toBe(true);
      expect(isValidObject({ key: 'value' })).toBe(true);
    });

    it('should return false for non-objects', () => {
      expect(isValidObject([])).toBe(false);
      expect(isValidObject(null)).toBe(false);
      expect(isValidObject(undefined)).toBe(false);
      expect(isValidObject('object')).toBe(false);
      expect(isValidObject(123)).toBe(false);
    });
  });

  describe('isValidEmail', () => {
    it('should return true for valid email addresses', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name+tag@domain.co.uk')).toBe(true);
      expect(isValidEmail('simple@test.io')).toBe(true);
    });

    it('should return false for invalid email addresses', () => {
      expect(isValidEmail('invalid-email')).toBe(false);
      expect(isValidEmail('test@')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
      expect(isValidEmail('test.domain.com')).toBe(false);
      expect(isValidEmail('')).toBe(false);
    });
  });

  /**
   * `isValidUsername` and `USERNAME_REGEX` were REMOVED from this module: they
   * were a second username policy, looser than the one the server enforced, so
   * the SDK could call a name valid and the API 400 it. The rule now lives once,
   * in `@oxyhq/contracts`, and its own suite covers it. What survives here is the
   * one thing this module still does with a username — sanitise-then-validate,
   * asserted below to answer from that single policy.
   */

  describe('isValidPassword', () => {
    it('should return true for valid passwords', () => {
      expect(isValidPassword('password123')).toBe(true);
      expect(isValidPassword('mySecurePass')).toBe(true);
      expect(isValidPassword('12345678')).toBe(true);
    });

    it('should return false for invalid passwords', () => {
      expect(isValidPassword('')).toBe(false);
      expect(isValidPassword('short')).toBe(false); // too short
      expect(isValidPassword('1234567')).toBe(false); // too short
    });
  });

  describe('isValidDisplayName', () => {
    it('should return true for clean names (letters, spaces, apostrophe)', () => {
      expect(isValidDisplayName("Renée O'Brien")).toBe(true);
      expect(isValidDisplayName('Ada Lovelace')).toBe(true);
      expect(isValidDisplayName('山田太郎')).toBe(true);
      expect(isValidDisplayName('')).toBe(true); // empty is valid; non-empty enforced elsewhere
    });

    it.each([
      ['Владимир', 'Cyrillic'],
      ['مُحَمَد', 'Arabic with harakat'],
      ['נתן', 'Hebrew'],
      ['नमस्ते', 'Devanagari'],
      ['김철수', 'Hangul'],
      ['Αριστοτέλης', 'Greek'],
      ['Արամ', 'Armenian'],
      ['დავით', 'Georgian'],
      ['สมชาย', 'Thai'],
      ['ᏔᎳ', 'Cherokee'],
      ['ᠮᠣᠩᠭᠣᠯ', 'Mongolian'],
    ])('should return true for allowlisted-script real name %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });

    it('should return false for emoji, symbols, digits, and punctuation', () => {
      expect(isValidDisplayName('nixCraft \u{1f427}')).toBe(false); // penguin emoji
      expect(isValidDisplayName('Agent007')).toBe(false);
      expect(isValidDisplayName('Jean-Luc')).toBe(false);
      expect(isValidDisplayName('J.R.')).toBe(false);
    });

    it.each([
      ['ᯅ', 'Batak U+1BC5 (Limited-Use script)'],
      ['ᚠ', 'Runic'],
      ['Miguel de Icaza ᯅ', 'a Latin name with a trailing Batak letter'],
    ])('should return false for non-allowlisted-script letter %p (%s)', (name) => {
      // These characters are General_Category Lo (letters), so the old
      // all-scripts policy accepted them; the curated script allowlist rejects
      // decorative / limited-use scripts a real name never uses.
      expect(isValidDisplayName(name)).toBe(false);
    });

    it('should return false for control whitespace (tab/newline/CR)', () => {
      // Space separators only (General_Category Zs) rejects layout-breaking /
      // multi-line spoofing whitespace that \s would have admitted.
      expect(isValidDisplayName('Ada\tLovelace')).toBe(false);
      expect(isValidDisplayName('Ada\nLovelace')).toBe(false);
      expect(isValidDisplayName('Ada\rLovelace')).toBe(false);
    });

    it('should return true for Unicode space separators', () => {
      expect(isValidDisplayName('Ada Lovelace')).toBe(true); // NBSP
      expect(isValidDisplayName('山田　太郎')).toBe(true); // ideographic space
    });
  });

  // Hermes (React Native) has Unicode property escapes compiled OUT: any such
  // escape (Script_Extensions "scx=…" or General_Category classes) in a `u`-flag
  // regex throws "Invalid RegExp: Invalid property name" at module load and
  // crashes every Oxy RN/Expo app at boot. The display-name policy therefore
  // ships explicit code-point RANGES instead. This block guards that invariant
  // AND proves the range regexes behave identically.
  describe('display-name policy is property-escape-free (Hermes safety)', () => {
    const PROPERTY_ESCAPE = /\\[pP]\{/;

    it('exposes runtime regex sources that contain NO Unicode property escape', () => {
      expect(PROPERTY_ESCAPE.test(DISPLAY_NAME_ALLOWED_SCRIPTS)).toBe(false);
      expect(PROPERTY_ESCAPE.test(DISPLAY_NAME_DISALLOWED_SOURCE)).toBe(false);
      expect(PROPERTY_ESCAPE.test(DISPLAY_NAME_ORPHANED_MARK_SOURCE)).toBe(false);
      expect(PROPERTY_ESCAPE.test(DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE)).toBe(false);
    });

    it('only uses code-point escapes (\\x / \\u) in the class bodies', () => {
      // regexpu-core lowers the property escapes to `\x…` / `\u…` / `\u{…}`
      // code-point escapes. Every backslash-escape in the runtime sources must
      // be one of those forms — never a property escape.
      const escapeLeads = new Set<string>();
      for (const src of [
        DISPLAY_NAME_DISALLOWED_SOURCE,
        DISPLAY_NAME_ORPHANED_MARK_SOURCE,
        DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE,
      ]) {
        for (const [, lead] of src.matchAll(/\\(.)/g)) {
          escapeLeads.add(lead);
        }
      }
      expect([...escapeLeads].sort()).toEqual(['u', 'x']);
    });

    it('the shipped (non-test) policy source files contain NO property escape', () => {
      const utilsDir = join(__dirname, '..');
      for (const file of [
        'validationUtils.ts',
        'displayNamePolicyRanges.generated.ts',
        'textNormalization.ts',
      ]) {
        const contents = readFileSync(join(utilsDir, file), 'utf8');
        expect(PROPERTY_ESCAPE.test(contents)).toBe(false);
      }
    });

    // Build the actual regexes exactly as production does (range-only sources +
    // `u` flag + lookbehind — the shape Hermes must accept) and assert the full
    // policy behaves as before across scripts, marks, and rejections.
    const disallowed = new RegExp(DISPLAY_NAME_DISALLOWED_SOURCE, 'u');
    const orphaned = new RegExp(DISPLAY_NAME_ORPHANED_MARK_SOURCE, 'u');
    const passesPolicy = (raw: string) =>
      !disallowed.test(raw) && !orphaned.test(raw.normalize('NFC'));

    it('constructs the `u`-flag regexes without throwing', () => {
      expect(() => new RegExp(DISPLAY_NAME_DISALLOWED_SOURCE, 'u')).not.toThrow();
      expect(() => new RegExp(DISPLAY_NAME_ORPHANED_MARK_SOURCE, 'u')).not.toThrow();
      // Global variants are what @oxyhq/api compiles for the strip path.
      expect(() => new RegExp(DISPLAY_NAME_DISALLOWED_SOURCE, 'gu')).not.toThrow();
      expect(() => new RegExp(DISPLAY_NAME_ORPHANED_MARK_SOURCE, 'gu')).not.toThrow();
    });

    it.each([
      ["Renée O'Brien", 'Latin with decomposed accent + apostrophe'],
      ['Ada Lovelace', 'ASCII Latin'],
      ['山田太郎', 'Han'],
      ['田中\u{20000}', 'Han incl. astral CJK Extension B'],
      ['Владимир', 'Cyrillic'],
      ['مُحَمَد', 'Arabic with harakat (combining marks on base letters)'],
      ['נתן', 'Hebrew'],
      ['नमस्ते', 'Devanagari'],
      ['김철수', 'Hangul'],
      ['Αριστοτέλης', 'Greek'],
      ['ᏔᎳ', 'Cherokee'],
      ['ᠮᠣᠩᠭᠣᠯ', 'Mongolian'],
    ])('range regexes ACCEPT allowlisted %p (%s)', (name) => {
      expect(passesPolicy(name)).toBe(true);
      // Parity with the public predicate.
      expect(isValidDisplayName(name)).toBe(true);
    });

    it.each([
      ['nixCraft \u{1f427}', 'emoji (astral)'],
      ['Agent007', 'digit'],
      ['Jean-Luc', 'hyphen'],
      ['J.R.', 'dot'],
      ['ᯅ', 'Batak (non-allowlisted script)'],
      ['ᚠ', 'Runic (non-allowlisted script)'],
      ['Ada\tLovelace', 'tab (control whitespace)'],
      ['Ada\nLovelace', 'newline (control whitespace)'],
      ['Ada\rLovelace', 'carriage return (control whitespace)'],
    ])('range regexes REJECT %p (%s)', (name) => {
      expect(passesPolicy(name)).toBe(false);
      expect(isValidDisplayName(name)).toBe(false);
    });

    it('rejects an orphaned combining mark not riding a base letter', () => {
      expect(passesPolicy('༘⋆')).toBe(false); // lone Tibetan mark + star
      expect(orphaned.test('༘')).toBe(true); // bare mark at string start
      // A decomposed accent recomposes under NFC and rides its base letter.
      expect(orphaned.test('é'.normalize('NFC'))).toBe(false);
    });
  });

  // A Unicode script is not only its letters: `scx=X` also carries script X's
  // own digits, punctuation and symbols. The allowlist is therefore generated as
  // `scripts ∩ General_Category L`. Before that intersection existed the class
  // admitted 1831 non-letter code points, so the documented policy ("digits,
  // hyphens, dots, symbols are removed") held for ASCII input only — a federated
  // actor could keep Arabic-Indic digits, a Bengali currency sign, or the U+061C
  // bidi control in their display name. This block is the regression guard.
  describe('display-name allowlist admits ONLY letters', () => {
    const allowed = new RegExp(`[${DISPLAY_NAME_ALLOWED_SCRIPTS}]`, 'u');
    // Built from the same generated ranges the policy ships, so this assertion
    // stays property-escape-free and cannot drift from the runtime regex.
    const letter = new RegExp(`[${DISPLAY_NAME_LETTERS_RANGES}]`, 'u');

    // Scanning the FULL code-point space, not a sample: one leaked invisible
    // control is a spoofing vector, and a sample cannot prove its absence.
    const leaks: number[] = [];
    let admitted = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
      const ch = String.fromCodePoint(cp);
      if (!allowed.test(ch)) continue;
      admitted++;
      if (!letter.test(ch)) leaks.push(cp);
    }

    it('admits no non-letter code point anywhere in Unicode', () => {
      const named = leaks
        .slice(0, 16)
        .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      expect({ count: leaks.length, sample: named }).toEqual({ count: 0, sample: [] });
    });

    // Vacuity floor: an allowlist that collapsed to (near) nothing would satisfy
    // the assertion above while silently rejecting every real name.
    it('still admits the expected bulk of letters', () => {
      expect(admitted).toBeGreaterThan(100_000);
    });

    it.each([
      ['٥', 'Arabic-Indic digit (scx=Arabic, GC=Nd)'],
      ['०', 'Devanagari digit (scx=Devanagari, GC=Nd)'],
      ['۞', 'Arabic ornament (scx=Arabic, GC=So)'],
      ['৳', 'Bengali rupee sign (scx=Bengali, GC=Sc)'],
      ['।', 'Devanagari danda (scx=Devanagari, GC=Po)'],
      ['،', 'Arabic comma (scx=Arabic, GC=Po)'],
      ['؜', 'ARABIC LETTER MARK - invisible bidi control (scx=Arabic, GC=Cf)'],
      ['᠎', 'MONGOLIAN VOWEL SEPARATOR - invisible (scx=Mongolian, GC=Cf)'],
    ])('rejects %p, a non-letter from an allowlisted script (%s)', (ch) => {
      expect(isValidDisplayName(ch)).toBe(false);
    });

    // The intersection narrows the allowlist, so every previously-accepted real
    // name must still pass — these are the ones whose scripts own the code
    // points removed above.
    it.each([
      ['مُحَمَد', 'Arabic letters + harakat survive'],
      ['नमस्ते', 'Devanagari'],
      ['ᠰᠣᠩᠭᠣᠯ', 'Mongolian'],
      ['বাংলা', 'Bengali'],
    ])('still accepts %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });
  });

  // A character policy classifies FORM, never MEANING. `卐` U+5350 and `卍`
  // U+534D are CJK Unified Ideographs (GC=Lo, scx=Han) — to Unicode they are the
  // same kind of thing as `山` in `山田太郎`, so no script- or category-level rule
  // can reject them without also rejecting every real Chinese, Japanese and
  // Korean name. They are therefore subtracted from the allowlist by an explicit
  // code-point denylist at generation time. This block is the regression guard,
  // and asserts the division of labour: the denylist covers ONLY what the
  // intersection cannot.
  describe('display-name denylist — letters that function as symbols', () => {
    // The glyphs below are visually confusable with each other and with ordinary
    // ideographs, so pin them to their code points before relying on them.
    it('the fixtures below really are U+5350 and U+534D', () => {
      expect('卐'.codePointAt(0)).toBe(0x5350);
      expect('卍'.codePointAt(0)).toBe(0x534d);
    });

    it.each([
      ['卐', 'U+5350 right-facing swastika (GC=Lo, scx=Han)'],
      ['卍', 'U+534D left-facing swastika (GC=Lo, scx=Han)'],
      ['卐 Glowniggers 卐', 'the production display name that motivated the denylist'],
      ['卍 卐', 'both, alone'],
      ['山田卍太郎', 'embedded mid-name, between real Han letters'],
    ])('rejects %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(false);
    });

    // The whole point of a per-code-point denylist instead of a script rule.
    it.each([
      ['山田太郎', 'Han (Japanese)'],
      ['김철수', 'Hangul (Korean)'],
      ['王小明', 'Han (Chinese)'],
      ['田中\u{20000}', 'Han incl. astral CJK Extension B'],
      // The four immediate neighbours of the denied pair: the subtraction must
      // punch out exactly two code points, not a range around them.
      ['卌', 'U+534C, immediately below U+534D'],
      ['华', 'U+534E, immediately above U+534D (as in 中华)'],
      ['协', 'U+534F, immediately below U+5350'],
      ['卑', 'U+5351, immediately above U+5350'],
    ])('still accepts %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });

    // Enumerate what is ACTUALLY denied from the generated class rather than
    // trusting the literals above, so a future entry that is added to the list
    // but not enforced by the emitted allowlist fails here.
    const denied = new RegExp(`[${DISPLAY_NAME_DENIED_SYMBOL_LETTERS_RANGES}]`, 'u');
    const deniedCodePoints: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
      if (denied.test(String.fromCodePoint(cp))) deniedCodePoints.push(cp);
    }

    it('denies exactly the two swastika ideographs', () => {
      expect(deniedCodePoints).toEqual([0x534d, 0x5350]);
    });

    it('rejects every code point on the denylist', () => {
      const accepted = deniedCodePoints.filter((cp) =>
        isValidDisplayName(String.fromCodePoint(cp))
      );
      expect(
        accepted.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
      ).toEqual([]);
      // Vacuity floor: an empty denylist would satisfy the assertion above while
      // enforcing nothing.
      expect(deniedCodePoints.length).toBeGreaterThanOrEqual(2);
    });

    // Hermes safety for the new class (see the property-escape block above).
    it('the denylist ranges contain NO Unicode property escape', () => {
      expect(/\\[pP]\{/.test(DISPLAY_NAME_DENIED_SYMBOL_LETTERS_RANGES)).toBe(false);
      expect(() => new RegExp(`[${DISPLAY_NAME_DENIED_SYMBOL_LETTERS_RANGES}]`, 'u')).not.toThrow();
    });

    // Division of labour: the Tibetan svasti signs look like the entries above
    // but are GC=So, so the `scripts ∩ General_Category L` intersection already
    // excludes them. They are rejected — and deliberately NOT on the denylist,
    // where they would be dead weight that reads as load-bearing. The generator
    // fails the build if such a redundant entry is added.
    it.each([
      ['࿕', 'U+0FD5 RIGHT-FACING SVASTI SIGN'],
      ['࿖', 'U+0FD6 LEFT-FACING SVASTI SIGN'],
      ['࿗', 'U+0FD7 RIGHT-FACING SVASTI SIGN WITH DOTS'],
      ['࿘', 'U+0FD8 LEFT-FACING SVASTI SIGN WITH DOTS'],
    ])('rejects %p (%s) via the intersection, not the denylist', (ch) => {
      expect(isValidDisplayName(ch)).toBe(false);
      expect(denied.test(ch)).toBe(false);
    });
  });

  // Four punctuation code points JOIN two letters inside one real name. All are
  // General_Category P, so `scripts ∩ L` strips them by default and stripping
  // SPLITS the name (`Codeur·euses` → `Codeur euses`). They are re-admitted, but
  // ONLY between two letters — the same characters are also used as ornament
  // (a trailing `Roberto ·`), which must keep being trimmed. The conditional is
  // the whole rule, so it is tested from both sides.
  describe('display-name name separators — allowed only between letters', () => {
    // Visually confusable with each other and with ASCII punctuation.
    it('the fixtures below really are U+00B7 U+05BE U+0F0B U+30FB', () => {
      expect('·'.codePointAt(0)).toBe(0x00b7);
      expect('־'.codePointAt(0)).toBe(0x05be);
      expect('་'.codePointAt(0)).toBe(0x0f0b);
      expect('・'.codePointAt(0)).toBe(0x30fb);
    });

    it.each([
      ['Codeur·euses en Liberté', 'U+00B7 French inclusive writing (production value)'],
      ['Codeur·euses', 'U+00B7 bare'],
      ['Pouet·te', 'U+00B7 short form'],
      ['お坐・エガード', 'U+30FB Japanese name separator (production value)'],
      ['אייר אברמסקי־קרוננברג', 'U+05BE Hebrew maqaf compound surname (production value)'],
      ['འོད་ཟེར', 'U+0F0B Tibetan intersyllabic tsheg (production value)'],
    ])('accepts letter-flanked %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });

    // A base letter can carry a combining mark, and that mark sits between the
    // letter and the separator. If the flanking test only looked for a letter,
    // these would be misread as unflanked and the separator stripped. Both
    // fixtures use marks that do NOT recompose under NFC, so the mark really
    // reaches the flanking test instead of being folded into a precomposed
    // letter — the Tibetan one is the ordinary shape of Tibetan text.
    it.each([
      ['ཀི་ཁ', 'Tibetan letter + vowel sign U+0F72 + tsheg + letter'],
      ['مُ·م', 'Arabic letter + damma U+064F + middle dot + letter'],
    ])('accepts %p where a combining mark precedes the separator (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });

    it.each([
      ['Roberto ·', 'trailing ornament (production value)'],
      ['Michał rysiek Woźniak ·', 'trailing ornament (production value)'],
      ['·Roberto', 'leading'],
      ['a··b', 'doubled — neither is letter-flanked on both sides'],
      ['·', 'alone'],
      ['お坐・', 'trailing katakana middle dot'],
      ['・エガード', 'leading katakana middle dot'],
      ['a ·b', 'space on the left'],
      ['a· b', 'space on the right'],
    ])('rejects unflanked %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(false);
    });

    // Enumerate what is ACTUALLY admitted from the generated class rather than
    // trusting the literals above, and exercise both sides of the rule for each.
    const separator = new RegExp(`[${DISPLAY_NAME_NAME_SEPARATORS_RANGES}]`, 'u');
    const separatorCodePoints: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
      if (separator.test(String.fromCodePoint(cp))) separatorCodePoints.push(cp);
    }

    it('admits exactly the four name separators', () => {
      expect(separatorCodePoints).toEqual([0x00b7, 0x05be, 0x0f0b, 0x30fb]);
    });

    it('every separator is valid between letters and invalid unflanked', () => {
      const wrongWhenFlanked: string[] = [];
      const wrongWhenUnflanked: string[] = [];
      for (const cp of separatorCodePoints) {
        const ch = String.fromCodePoint(cp);
        const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
        if (!isValidDisplayName(`a${ch}b`)) wrongWhenFlanked.push(label);
        if (isValidDisplayName(`a ${ch}`)) wrongWhenUnflanked.push(label);
      }
      expect({ wrongWhenFlanked, wrongWhenUnflanked }).toEqual({
        wrongWhenFlanked: [],
        wrongWhenUnflanked: [],
      });
      // Vacuity floor: an empty separator class would satisfy both loops above.
      expect(separatorCodePoints.length).toBe(4);
    });

    // The ASCII hyphen decision is untouched: U+05BE is General_Category Pd like
    // U+002D, but admitting one says nothing about the other.
    it('does not admit the ASCII hyphen', () => {
      expect(separator.test('-')).toBe(false);
      expect(isValidDisplayName('Jean-Luc')).toBe(false);
      expect(isValidDisplayName('a-b')).toBe(false);
    });

    // Hermes safety for the new pattern (see the property-escape block above).
    it('the unflanked-separator source contains NO Unicode property escape', () => {
      expect(/\\[pP]\{/.test(DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE)).toBe(false);
      expect(/\\[pP]\{/.test(DISPLAY_NAME_NAME_SEPARATORS_RANGES)).toBe(false);
      expect(() => new RegExp(DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE, 'u')).not.toThrow();
      // Global variant is what @oxyhq/api compiles for the strip path.
      expect(() => new RegExp(DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE, 'gu')).not.toThrow();
    });

    // Nothing the policy already rejected may become valid.
    it.each([
      ['卐', 'denied symbol letter'],
      ['卍', 'denied symbol letter'],
      ['Agent007', 'digit'],
      ['J.R.', 'dot'],
      ['ᯅ', 'non-allowlisted script'],
      ['nixCraft \u{1f427}', 'emoji'],
    ])('still rejects %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(false);
    });

    it.each([
      ['山田太郎', 'Han'],
      ['김철수', 'Hangul'],
      ["Renée O'Brien", 'Latin with accent + apostrophe'],
    ])('still accepts %p (%s)', (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    });
  });

  describe('isValidUUID', () => {
    it('should return true for valid UUIDs', () => {
      expect(isValidUUID('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should return false for invalid UUIDs', () => {
      expect(isValidUUID('invalid-uuid')).toBe(false);
      expect(isValidUUID('123-456-789')).toBe(false);
      expect(isValidUUID('')).toBe(false);
    });
  });

  describe('isValidDate', () => {
    it('should return true for valid date strings', () => {
      expect(isValidDate('2024-01-01')).toBe(true);
      expect(isValidDate('2024-12-31T23:59:59.999Z')).toBe(true);
      expect(isValidDate('January 1, 2024')).toBe(true);
    });

    it('should return false for invalid date strings', () => {
      expect(isValidDate('invalid-date')).toBe(false);
      expect(isValidDate('2024-13-01')).toBe(false); // invalid month
      expect(isValidDate('')).toBe(false);
    });
  });

  describe('isValidFileSize', () => {
    const maxSize = 1024 * 1024; // 1MB

    it('should return true for valid file sizes', () => {
      expect(isValidFileSize(1024, maxSize)).toBe(true);
      expect(isValidFileSize(maxSize, maxSize)).toBe(true);
      expect(isValidFileSize(1, maxSize)).toBe(true);
    });

    it('should return false for invalid file sizes', () => {
      expect(isValidFileSize(0, maxSize)).toBe(false);
      expect(isValidFileSize(-1, maxSize)).toBe(false);
      expect(isValidFileSize(maxSize + 1, maxSize)).toBe(false);
    });
  });

  describe('isValidFileType', () => {
    const allowedTypes = ['jpg', 'png', 'gif', 'pdf'];

    it('should return true for allowed file types', () => {
      expect(isValidFileType('image.jpg', allowedTypes)).toBe(true);
      expect(isValidFileType('document.PDF', allowedTypes)).toBe(true); // case insensitive
      expect(isValidFileType('photo.png', allowedTypes)).toBe(true);
    });

    it('should return false for disallowed file types', () => {
      expect(isValidFileType('script.js', allowedTypes)).toBe(false);
      expect(isValidFileType('data.txt', allowedTypes)).toBe(false);
      expect(isValidFileType('noextension', allowedTypes)).toBe(false);
    });
  });

  describe('sanitizeString', () => {
    it('should trim whitespace and remove dangerous characters', () => {
      expect(sanitizeString('  hello  ')).toBe('hello');
      expect(sanitizeString('hello<script>alert("xss")</script>world')).toBe('helloalert("xss")world');
      expect(sanitizeString('normal text')).toBe('normal text');
    });
  });

  describe('sanitizeHTML', () => {
    it('should escape HTML characters', () => {
      expect(sanitizeHTML('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(sanitizeHTML('Hello & Goodbye')).toBe('Hello &amp; Goodbye');
      expect(sanitizeHTML("It's a test")).toBe('It&#x27;s a test');
    });
  });

  describe('validateAndSanitizeUserInput', () => {
    it('should validate and sanitize email input', () => {
      expect(validateAndSanitizeUserInput('  test@example.com  ', 'email')).toBe('test@example.com');
      expect(validateAndSanitizeUserInput('invalid-email', 'email')).toBeNull();
      expect(validateAndSanitizeUserInput(123, 'email')).toBeNull();
    });

    it('should validate and sanitize username input', () => {
      expect(validateAndSanitizeUserInput('  testuser  ', 'username')).toBe('testuser');
      expect(validateAndSanitizeUserInput('ab', 'username')).toBeNull(); // too short
      expect(validateAndSanitizeUserInput(123, 'username')).toBeNull();
      // Answers from the one policy in `@oxyhq/contracts`, not from a rule of its
      // own: a dot and an edge separator are rejected here because they are
      // rejected there.
      expect(validateAndSanitizeUserInput('my-bot', 'username')).toBe('my-bot');
      expect(validateAndSanitizeUserInput('my.bot', 'username')).toBeNull();
      expect(validateAndSanitizeUserInput('-mybot', 'username')).toBeNull();
    });

    it('should validate and sanitize string input', () => {
      expect(validateAndSanitizeUserInput('  hello world  ', 'string')).toBe('hello world');
      expect(validateAndSanitizeUserInput('', 'string')).toBeNull();
      expect(validateAndSanitizeUserInput(123, 'string')).toBeNull();
    });
  });
});
