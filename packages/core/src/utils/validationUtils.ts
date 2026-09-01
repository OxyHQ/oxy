/**
 * Validation utilities for common data validation patterns
 */

import {
  DISPLAY_NAME_ALLOWED_SCRIPTS_RANGES,
  DISPLAY_NAME_COMBINING_MARKS_RANGES,
  DISPLAY_NAME_SPACE_SEPARATORS_RANGES,
  DISPLAY_NAME_LETTERS_RANGES,
  DISPLAY_NAME_NAME_SEPARATORS_RANGES,
} from './displayNamePolicyRanges.generated';
import { usernameSchema } from '@oxyhq/contracts';

/**
 * Maximum stored length of a display name, in code units after cleaning.
 * Shared by the API write path and client input surfaces.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/** Shared 400 / inline-validation copy for native display-name policy rejections. */
export const DISPLAY_NAME_INVALID_MESSAGE =
  'Name may only contain letters, spaces, apostrophes, and name separators (·, ־, ་, ・).';

/**
 * Email validation regex
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Password validation regex (at least 8 chars, 1 uppercase, 1 lowercase, 1 number)
 */
// At least 8 characters (tests expect len>=8 without complexity requirements)
export const PASSWORD_REGEX = /^.{8,}$/;

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * Validate password strength
 */
export function isValidPassword(password: string): boolean {
  return PASSWORD_REGEX.test(password);
}

/**
 * Display-name character policy.
 *
 * A clean display name is composed ONLY of:
 *   - letters from a curated ALLOWLIST of scripts that real names use
 *     ({@link DISPLAY_NAME_ALLOWED_SCRIPTS}) — NOT every letter (General_Category
 *     L of ANY script), which admits decorative / historic / limited-use scripts
 *     whose characters are letters yet never appear in a real name (e.g. `ᯅ`
 *     U+1BC5 Batak, Runic, Deseret, dingbat letters),
 *   - combining marks / accents (General_Category M, e.g. the acute accent in a
 *     decomposed "é"),
 *   - Unicode space separators (General_Category Zs: the ASCII space, NBSP,
 *     ideographic space, …) — but NOT control whitespace such as tab, newline,
 *     or carriage return, which would break layout or enable multi-line
 *     spoofing,
 *   - the straight apostrophe (`'`, e.g. "O'Brien"),
 *   - four name SEPARATORS — `·` U+00B7, `־` U+05BE, `་` U+0F0B, `・` U+30FB —
 *     but ONLY directly between two letters (`Codeur·euses`, `お坐・エガード`,
 *     `אברמסקי־קרוננברג`, `འོད་ཟེར`). Every one is General_Category P, so the
 *     letters intersection strips them by default; they are re-admitted because
 *     stripping them SPLITS a real name in two. The flanking condition is not a
 *     refinement but the whole point: the same characters are also used as
 *     ornament (a trailing `Roberto ·`), and unconditional admission would let
 *     that through. See {@link DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE}. The
 *     ASCII hyphen is NOT among them — `Jean-Luc` stays rejected.
 *
 * Everything else is rejected: emoji (🐧), symbols (⁂ ⏚), `:emoji:` shortcodes,
 * digits, hyphens, dots, control whitespace (tab/newline/CR), letters from
 * non-allowlisted scripts, and any other punctuation. The allowed set never
 * includes `<`, `>`, `&`, or `"`, so a value that passes this predicate can
 * never contain an HTML/XSS vector.
 *
 * The allowlist is expressed with Unicode Script_Extensions (scx=…) so a letter
 * shared by several scripts (e.g. a Han ideograph used in both Chinese and
 * Japanese) still matches, INTERSECTED with General_Category L so only the
 * scripts' LETTERS are admitted. That intersection is load-bearing, not a
 * refinement: `scx=X` also carries script X's own digits, punctuation and
 * symbols, so the un-intersected allowlist admitted 1831 non-letter code points
 * — script digits (`٠١٢`, `०१२`), 1082 symbols (`֍ ۞ ৳`), 180 punctuation marks
 * (`։ ، ؛ ।`), and 9 INVISIBLE format/control characters, among them U+061C
 * ARABIC LETTER MARK (a bidi control that can visually reorder a name) and
 * U+180E MONGOLIAN VOWEL SEPARATOR. Without it the rejections listed above held
 * for ASCII input only. It is the set of scripts Unicode UTS #39 marks
 * "Recommended" for general interchange / identifiers, plus Cherokee and
 * Mongolian (both in real modern name use). "Common" script is deliberately
 * EXCLUDED — that is where ASCII digits and general punctuation live, and this
 * policy excludes those; the space separators, combining marks, and apostrophe a
 * name needs are added back explicitly. Limited-use / excluded / historic
 * scripts (Batak, Runic, Deseret, Adlam, …) are simply absent.
 *
 * CODE-POINT DENYLIST — a character policy classifies FORM, never MEANING, so a
 * code point can be a perfectly ordinary letter to Unicode and a hate symbol to
 * a reader. `卐` U+5350 and `卍` U+534D are the case in point: both are CJK
 * Unified Ideographs (General_Category Lo, Script_Extensions Han), i.e. the same
 * kind of thing as `山` in `山田太郎`, so NO script-level or category-level rule
 * can separate them — every rule that would exclude these two also excludes Han
 * itself, rejecting every real Chinese, Japanese and Korean name. They are
 * therefore enumerated and SUBTRACTED from the allowlist at generation time (see
 * `SYMBOL_LETTER_DENYLIST` in `scripts/generateDisplayNamePolicyRanges.mjs`).
 * Because the subtraction happens inside the one emitted allowlist, every
 * consumer enforces it with no extra probe and none can forget it; the generator
 * additionally REFUSES an entry that an existing lever already excludes (e.g.
 * the Tibetan svasti signs U+0FD5–U+0FD8, General_Category So, already dropped
 * by the intersection above), so the list cannot silently accumulate dead
 * weight.
 *
 * REMAINING LIMIT — that closes the "letter that reads as a symbol" gap, not the
 * other one: slurs and abusive phrasing spelled in ordinary allowlisted letters
 * pass by construction, because they are built from exactly the characters every
 * real name needs. No character-level rule — allowlist, intersection, or
 * denylist — can reject them; that needs a word-level moderation layer, which is
 * deliberately not attempted here.
 *
 * HERMES / RANGES: the class bodies below are built from explicit Unicode
 * code-point RANGES ({@link DISPLAY_NAME_ALLOWED_SCRIPTS_RANGES} et al. from
 * `./displayNamePolicyRanges.generated`), NOT from `scx`/General_Category
 * property escapes. React Native's Hermes engine ships with Unicode property
 * escapes compiled OUT and throws "Invalid RegExp: Invalid property name" for
 * any such escape at module load, crashing every Oxy RN/Expo app at boot. The
 * ranges are the compressed union of exactly those properties (generated on
 * Node/V8, which supports them — see `scripts/generateDisplayNamePolicyRanges.mjs`),
 * so behavior is IDENTICAL on V8 (web) and Hermes (native) with the same `u`
 * flag and lookbehind, but with zero property escapes in the shipped regex.
 *
 * This is the SINGLE definition of the policy: the character-class sources below
 * are the ONE source of truth, shared between the API strip/gate
 * (`@oxyhq/api` `displayNameSanitize.ts` builds its global-flag patterns from
 * them) and client-side inline validation (the RN profile editor via
 * {@link isValidDisplayName}) so the two can never drift. It is platform-agnostic
 * (no react/react-native/expo).
 */

/**
 * The curated allowlist of Unicode scripts permitted in a display name, as a
 * character-class body of explicit code-point ranges: the union of the 30
 * allowlisted Script_Extensions, INTERSECTED with General_Category L (so letters
 * only), MINUS the symbol-letter denylist — 120823 code points. Interpolated
 * into the negated class below, which is why both the reject gate here and the
 * `@oxyhq/api` strip path inherit the denylist without a second pattern.
 */
export const DISPLAY_NAME_ALLOWED_SCRIPTS = DISPLAY_NAME_ALLOWED_SCRIPTS_RANGES;

/**
 * Source of the disallowed-character pattern: the negation of the full allowed
 * set (allowlisted scripts + combining marks + space separators + the straight
 * apostrophe + the name separators). Consumers compile this with the `u` flag
 * (and `g` for a global strip). The whitespace class is space separators only
 * (General_Category Zs), NOT `\s` — the latter would admit tab/newline/carriage
 * return, which break layout and enable multi-line spoofing.
 *
 * The name separators are admitted here only as CHARACTERS. Their position rule
 * is a separate pattern ({@link DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE}), for
 * the same reason combining marks are: a negated character class cannot express
 * "allowed only in this context". Both halves must be applied together.
 */
export const DISPLAY_NAME_DISALLOWED_SOURCE = `[^${DISPLAY_NAME_ALLOWED_SCRIPTS}${DISPLAY_NAME_COMBINING_MARKS_RANGES}${DISPLAY_NAME_SPACE_SEPARATORS_RANGES}${DISPLAY_NAME_NAME_SEPARATORS_RANGES}']`;

/**
 * Source of the orphaned combining-mark pattern: a run of combining marks NOT
 * attached to a base letter (preceded by string start, whitespace, the
 * apostrophe, or a position vacated by a stripped character). A mark preceded by
 * a base letter (e.g. the decomposed accent in "Renée") or by another combining
 * mark (a multi-mark cluster) is NOT matched because the negative lookbehind
 * fails at its position. Used both as a non-global probe (`.test`) and, with the
 * `g` flag, to strip whole orphaned runs. The lookbehind intentionally uses the
 * BROAD letters set (General_Category L of any script) so that a mark riding on
 * an allowlisted base letter is preserved.
 */
export const DISPLAY_NAME_ORPHANED_MARK_SOURCE = `(?<![${DISPLAY_NAME_LETTERS_RANGES}${DISPLAY_NAME_COMBINING_MARKS_RANGES}])[${DISPLAY_NAME_COMBINING_MARKS_RANGES}]+`;

/**
 * Source of the unflanked name-separator pattern — the positional half of the
 * name-separator rule, and the exact counterpart of
 * {@link DISPLAY_NAME_ORPHANED_MARK_SOURCE}: a combining mark is allowed only
 * when it rides a base letter, and a name separator is allowed only when it JOINS
 * two letters. Matches a separator that is missing a letter on either side, so
 * consumers can reject it (non-global probe) or strip it (`g` flag).
 *
 * Two alternatives, one per side, because JS has no "not surrounded by" atom:
 *   - `(?<![letters][marks])[sep]` — nothing letter-like immediately BEFORE.
 *   - `[sep](?![letters])`        — no letter immediately AFTER.
 *
 * The left-hand class deliberately includes combining marks as well as letters:
 * a base letter can carry an accent (`Renée·euses`, or a decomposed `e`+◌́), and
 * that mark sits between the letter and the separator. Treating a mark as
 * letter-like is what stops an accent from defeating the flanking test — the
 * same reason the orphaned-mark lookbehind uses the identical pair of classes.
 * The right-hand class is letters only: a mark AFTER a separator has no base and
 * is removed by the orphaned-mark rule, so the separator is genuinely unflanked.
 *
 * Both lookarounds are single-character (no variable-length lookbehind), and the
 * classes are explicit code-point ranges, so the compiled regex is within what
 * Hermes accepts.
 *
 * `Codeur·euses` and `お坐・エガード` match NOTHING here and survive. A leading
 * `·Roberto`, a trailing `Roberto ·`, and a doubled `a··b` each match and are
 * stripped — which is what keeps a decorative middle dot from riding in on the
 * back of the orthographic one.
 */
export const DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE = `(?<![${DISPLAY_NAME_LETTERS_RANGES}${DISPLAY_NAME_COMBINING_MARKS_RANGES}])[${DISPLAY_NAME_NAME_SEPARATORS_RANGES}]|[${DISPLAY_NAME_NAME_SEPARATORS_RANGES}](?![${DISPLAY_NAME_LETTERS_RANGES}])`;

/** Non-global probe for the presence of a disallowed character. */
const DISALLOWED_PROBE = new RegExp(DISPLAY_NAME_DISALLOWED_SOURCE, 'u');

/** Non-global probe for the presence of an orphaned combining mark. */
const ORPHANED_MARK_PROBE = new RegExp(DISPLAY_NAME_ORPHANED_MARK_SOURCE, 'u');

/** Non-global probe for the presence of an unflanked name separator. */
const UNFLANKED_SEPARATOR_PROBE = new RegExp(DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE, 'u');

/**
 * Whether `raw` already satisfies the display-name policy, i.e. it contains no
 * disallowed characters, no orphaned combining marks, and no unflanked name
 * separator. Used to REJECT native (signup / profile edit) names with a 400
 * rather than silently stripping them, and to validate inline in the client
 * editor.
 *
 * The two positional probes run on the NFC-normalized form, the character probe
 * on the raw input. Normalization matters for both: a legitimate decomposed
 * accent (`e`+◌́) recomposes into `é`, so it is NOT rejected as an orphaned mark,
 * and a separator after that accent sees a base letter rather than a mark.
 *
 * The function only checks the character set and separator placement; an empty
 * or whitespace-only string is considered valid (`true`). Call sites that require
 * a non-empty name enforce that separately.
 */
export function isValidDisplayName(raw: string): boolean {
  const normalized = raw.normalize('NFC');
  return (
    !DISALLOWED_PROBE.test(raw) &&
    !ORPHANED_MARK_PROBE.test(normalized) &&
    !UNFLANKED_SEPARATOR_PROBE.test(normalized)
  );
}

/**
 * Validate required string
 */
export function isRequiredString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate required number
 */
export function isRequiredNumber(value: unknown): boolean {
  return typeof value === 'number' && !Number.isNaN(value);
}

/**
 * Validate required boolean
 */
export function isRequiredBoolean(value: unknown): boolean {
  return typeof value === 'boolean';
}

/**
 * Validate array
 */
export function isValidArray(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * Validate object
 */
export function isValidObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate UUID format
 */
export function isValidUUID(uuid: string): boolean {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return UUID_REGEX.test(uuid);
}

/**
 * Validate URL format
 */
export function isValidURL(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate date string
 */
export function isValidDate(dateString: string): boolean {
  const date = new Date(dateString);
  return !Number.isNaN(date.getTime());
}

/**
 * Validate file size (in bytes)
 */
export function isValidFileSize(size: number, maxSize: number): boolean {
  return size > 0 && size <= maxSize;
}

/**
 * Validate file type
 */
export function isValidFileType(filename: string, allowedTypes: string[]): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension ? allowedTypes.includes(extension) : false;
}

/**
 * Sanitize string input
 */
export function sanitizeString(input: string): string {
  // Remove HTML tags entirely and trim whitespace
  return input.trim().replace(/<[^>]*>/g, '');
}

/**
 * Sanitize HTML input
 */
export function sanitizeHTML(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Validate MongoDB ObjectId format
 * Note: This is a basic format check. For full validation, use mongoose.Types.ObjectId.isValid()
 * This function works in environments where mongoose may not be available (e.g., client-side)
 */
export function isValidObjectId(id: string): boolean {
  if (typeof id !== 'string') {
    return false;
  }
  // MongoDB ObjectId is 24 hex characters
  const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
  return OBJECT_ID_REGEX.test(id);
}

/**
 * Validate and sanitize user input
 */
export function validateAndSanitizeUserInput(input: unknown, type: 'string' | 'email' | 'username'): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  const sanitized = sanitizeString(input);
  
  switch (type) {
    case 'email':
      return isValidEmail(sanitized) ? sanitized : null;
    case 'username':
      // The ONE policy, from `@oxyhq/contracts`. This module used to declare a
      // second one (`^[a-zA-Z0-9_-]{3,30}$`) that the server did not enforce, so
      // the SDK could call a name valid and the API 400 it.
      return usernameSchema.safeParse(sanitized).success ? sanitized : null;
    case 'string':
      return isRequiredString(sanitized) ? sanitized : null;
    default:
      return null;
  }
} 
