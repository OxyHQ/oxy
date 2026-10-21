/**
 * Account-name cleaning for untrusted input: the strip-side twin of
 * `@oxy.so/core`'s `isValidAccountName`. {@link cleanAccountName} picks the
 * policy from the account's `kind` (`ACCOUNT_NAME_POLICY_BY_KIND` in
 * `@oxy.so/contracts`); a person's name goes through {@link cleanDisplayName},
 * a title through {@link cleanAccountTitle}.
 *
 * Display-name (person) character policy.
 *
 * A clean display name is composed ONLY of:
 *   - letters from the curated ALLOWLIST of scripts real names use — NOT `\p{L}`
 *     (letters of ANY script), which admits decorative / historic / limited-use
 *     scripts whose characters are `\p{L}` yet never appear in a real name (e.g.
 *     `ᯅ` U+1BC5 Batak, Runic, Deseret, dingbat letters),
 *   - combining marks / accents (`\p{M}`, e.g. the acute accent in a decomposed
 *     "é"),
 *   - Unicode space separators (`\p{Zs}`: the ASCII space, NBSP, ideographic
 *     space, …) — but NOT control whitespace such as tab, newline, or carriage
 *     return, which would break layout or enable multi-line spoofing,
 *   - the straight apostrophe (`'`, e.g. "O'Brien"),
 *   - four name separators (`·` U+00B7, `־` U+05BE, `་` U+0F0B, `・` U+30FB) —
 *     but ONLY directly between two letters. `Codeur·euses`, `お坐・エガード`,
 *     `אברמסקי־קרוננברג` and `འོད་ཟེར` survive intact; the same characters used
 *     as ornament (`Roberto ·`) are still stripped. See
 *     {@link UNFLANKED_SEPARATOR_PATTERN}. The ASCII hyphen is NOT among them.
 *
 * Everything else is removed: emoji (🐧), symbols (⁂ ⏚), `:emoji:` shortcodes,
 * digits, hyphens, dots, control whitespace (tab/newline/CR), letters from
 * non-allowlisted scripts, and any other punctuation. This holds for NON-ASCII
 * input too — the allowlist is intersected with General_Category L, so an
 * allowlisted script's own digits (`٥`, `०`), symbols (`۞`, `৳`), punctuation
 * (`।`, `،`) and invisible controls (U+061C ARABIC LETTER MARK, U+180E) are
 * stripped just like their ASCII counterparts.
 *
 * A code point that is formally a letter but reads as a hate symbol (`卐`
 * U+5350, `卍` U+534D — both CJK Unified Ideographs, General_Category Lo,
 * Script_Extensions Han) is stripped like any other disallowed character. That
 * is NOT a rule of its own here: those code points are subtracted from the
 * allowlist at generation time in `@oxy.so/core`, so they are simply absent from
 * `DISPLAY_NAME_DISALLOWED_SOURCE`'s allowed set and this module removes them
 * without knowing they exist — which is exactly why the strip path and the core
 * reject gate cannot drift on them. A character policy cannot see MEANING, and
 * no script- or category-level rule could have excluded these two without also
 * rejecting every real Chinese, Japanese and Korean name.
 *
 * KNOWN LIMIT: a character policy still cannot see WORDS. A slur spelled in
 * ordinary allowlisted letters survives, because it is built from the same
 * characters every real name needs. That needs a word-level moderation layer,
 * NOT a change to the script allowlist or the denylist.
 *
 * The character policy is NOT re-derived here: the allowlist and its patterns
 * are the ONE source of truth in `@oxy.so/core` `validationUtils.ts`
 * (`DISPLAY_NAME_DISALLOWED_SOURCE`, `DISPLAY_NAME_ORPHANED_MARK_SOURCE`). This
 * module imports those sources and compiles the global-flag variants it needs to
 * STRIP, so the strip path here and the core reject path (`isValidDisplayName`)
 * can never drift.
 *
 * XSS reasoning
 * -------------
 * The allowed set never includes `<`, `>`, `&`, or `"`, so the output of
 * {@link cleanDisplayName} can never contain an HTML/XSS vector — there is
 * simply no character in the output that can open a tag, an entity, or an
 * attribute. The only special character that survives is the straight
 * apostrophe `'`, which is inert in text and JSON and is escaped by
 * React / React Native at render time. That is why federated write sites
 * replace `sanitizeHtml(...)` with `cleanDisplayName(...)` for the NAME field:
 * `sanitizeHtml` would turn `O'Brien` into `O&#x27;Brien` (which then renders
 * literally), whereas `cleanDisplayName` yields a clean, already-safe `O'Brien`.
 *
 * Whitespace/Unicode normalization is NOT implemented here: it is delegated to
 * the canonical `normalizeInlineText` from `@oxy.so/core`. This module owns only
 * the display-name PRODUCT rules (character policy, shortcode stripping, length
 * cap).
 */

import {
  ACCOUNT_TITLE_DISALLOWED_SOURCE,
  ACCOUNT_TITLE_MAX_LENGTH,
  accountNamePolicyForKind,
  type AccountKind,
} from '@oxy.so/contracts';
import {
  DISPLAY_NAME_DISALLOWED_SOURCE,
  DISPLAY_NAME_ORPHANED_MARK_SOURCE,
  DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeInlineText,
} from '@oxy.so/core';

/** Re-exported from `@oxy.so/core` — single source of truth for API + clients. */
export { MAX_DISPLAY_NAME_LENGTH };

/** Matches a `:shortcode:` emoji token (e.g. `:bongoCat:`, `:+1:`). */
const SHORTCODE_PATTERN = /:[A-Za-z0-9_+-]+:/g;

/**
 * Matches any character NOT allowed in a display name (global, Unicode),
 * compiled from the core allowlist source so it can never drift from the reject
 * gate. The whitespace class is `\p{Zs}` (space separators only), NOT `\s` — the
 * latter would admit tab/newline/carriage return, which break layout and enable
 * multi-line spoofing.
 */
const DISALLOWED_PATTERN = new RegExp(DISPLAY_NAME_DISALLOWED_SOURCE, 'gu');

/**
 * Matches a run of combining marks (`\p{M}`) that is NOT attached to a base
 * letter — i.e. the first mark of the run is preceded by something that is
 * neither a letter nor another mark (string start, whitespace, the apostrophe,
 * or a position vacated by a stripped character). The whole orphaned run is
 * removed. A mark preceded by `\p{L}` (a base letter, e.g. the decomposed
 * accent in "Renée") or by another `\p{M}` (a multi-mark cluster) is KEPT
 * because the negative lookbehind fails at its position. Compiled (global) from
 * the same core source as the reject gate.
 *
 * This catches lone Tibetan/diacritic marks (e.g. U+0F18 in `"༘⋆"`) and the
 * trailing variation selector (U+FE0F) left behind after an emoji base such as
 * U+2764 (❤) is stripped, both of which would otherwise survive the
 * `\p{M}`-friendly policy as meaningless garbage.
 */
const ORPHANED_MARK_PATTERN = new RegExp(DISPLAY_NAME_ORPHANED_MARK_SOURCE, 'gu');

/**
 * Matches a name separator (`·` U+00B7, `־` U+05BE, `་` U+0F0B, `・` U+30FB) that
 * is NOT directly between two letters. Those four are admitted by the character
 * class above because they JOIN two letters inside one real name
 * (`Codeur·euses`, `お坐・エガード`); this pattern is the other half of that rule
 * and removes the same characters when they are used as ornament instead
 * (`Roberto ·`). Compiled (global) from the same core source as the reject gate,
 * so the strip path and the gate cannot disagree about placement any more than
 * they can about the character set.
 *
 * A preceding combining mark counts as letter-like, so an accent between the base
 * letter and the separator does not make it look unflanked.
 */
const UNFLANKED_SEPARATOR_PATTERN = new RegExp(DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE, 'gu');

/** Every character the title policy disallows, compiled from the contract's source. */
const TITLE_DISALLOWED_PATTERN = new RegExp(ACCOUNT_TITLE_DISALLOWED_SOURCE, 'gu');

/** Cap `value` at `max` code units, trimming again in case the cut landed on a space. */
function capped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trim();
}

/**
 * Produce a clean display name from arbitrary (possibly federated/untrusted)
 * input. The transformation order is significant:
 *
 *   1. NFC-normalize so visually-identical strings compare/store identically
 *      (this also recomposes e.g. `e`+◌́ into a precomposed `é`, so legitimate
 *      decomposed accents never reach step 4 as standalone marks).
 *   2. Strip `:shortcode:` tokens FIRST — otherwise step 3 would only remove
 *      the surrounding colons and leave the bare word (`:bongoCat:` → `bongoCat`).
 *   3. Replace every disallowed character with a space.
 *   4. Remove orphaned combining marks — any `\p{M}` run not attached to a base
 *      letter (e.g. a lone Tibetan mark `U+0F18`, or a `U+FE0F` variation
 *      selector left after its emoji base was stripped in step 3). Marks that
 *      are still attached to a base letter are kept.
 *   5. Replace every name separator that is not letter-flanked with a space,
 *      keeping the ones that join two letters. This runs AFTER steps 3 and 4,
 *      and the order is load-bearing in both directions: step 3 can vacate the
 *      position next to a separator (`a☺·b` → `a ·b`, now genuinely unflanked),
 *      and step 4 can remove an orphaned mark that would otherwise have posed as
 *      the separator's left-hand flank. A space, not deletion, because these are
 *      separators — deleting would silently fuse two tokens the author kept
 *      apart (`a··b` → `a b`, never `ab`). Orphaned marks ARE deleted outright
 *      one step earlier, because a base-less accent is noise rather than a
 *      boundary.
 *   6. Collapse whitespace and trim — delegated to {@link normalizeInlineText}, the
 *      ecosystem's canonical single-line normalizer. A display name is a
 *      one-line value, so every whitespace run (including a `\n` smuggled in by
 *      a federated actor) becomes a single space. The explicit NFC pass in step 1
 *      is kept because the character policy in steps 3–5 must see the composed
 *      form; `normalizeInlineText` re-normalizing an already-NFC string is a no-op.
 *   7. Cap the length to {@link MAX_DISPLAY_NAME_LENGTH}, trimming again in case
 *      the slice landed on a boundary space.
 */
export function cleanDisplayName(raw: string): string {
  const collapsed = normalizeInlineText(
    String(raw)
      .normalize('NFC')
      .replace(SHORTCODE_PATTERN, ' ')
      .replace(DISALLOWED_PATTERN, ' ')
      .replace(ORPHANED_MARK_PATTERN, '')
      .replace(UNFLANKED_SEPARATOR_PATTERN, ' '),
  );
  return capped(collapsed, MAX_DISPLAY_NAME_LENGTH);
}

/**
 * Produce a clean title from arbitrary input: `:shortcode:` tokens (a remote
 * server's custom emoji, which render as nothing here) and every character the
 * title policy disallows become spaces, then the canonical single-line
 * normalizer collapses whitespace, and the result is capped. Digits and
 * punctuation are kept — they belong to titles. The output always satisfies
 * `isValidAccountName(output, kind)` for every non-personal kind, and holds no
 * `<` or `>`, so it carries no markup.
 */
export function cleanAccountTitle(raw: string): string {
  const collapsed = normalizeInlineText(
    String(raw)
      .normalize('NFC')
      .replace(SHORTCODE_PATTERN, ' ')
      .replace(TITLE_DISALLOWED_PATTERN, ' '),
  );
  return capped(collapsed, ACCOUNT_TITLE_MAX_LENGTH);
}

/** Clean an untrusted name for an account of `kind`, by that kind's policy. */
export function cleanAccountName(raw: string, kind: AccountKind | null | undefined): string {
  return accountNamePolicyForKind(kind) === 'person'
    ? cleanDisplayName(raw)
    : cleanAccountTitle(raw);
}

/**
 * The `users` name columns for ONE untrusted name string — what a federated
 * source or an automated account supplies — cleaned by `kind` and stored in the
 * shape that kind has on every path:
 *
 *  - a person's name in `nameFirst` (the column people search and the
 *    `first`/`last` readers see) and `nameDisplay`;
 *  - a title in `nameDisplay` alone, exactly where a native organization,
 *    project, bot or channel keeps it — a title is nobody's given name.
 *
 * `nameLast` is always cleared: one string never carries a family name.
 */
export function untrustedNameColumns(
  raw: string | null | undefined,
  kind: AccountKind | null | undefined,
): { nameFirst: string | null; nameLast: null; nameDisplay: string | null } {
  const name = cleanAccountName(raw ?? '', kind) || null;
  return {
    nameFirst: accountNamePolicyForKind(kind) === 'person' ? name : null,
    nameLast: null,
    nameDisplay: name,
  };
}
