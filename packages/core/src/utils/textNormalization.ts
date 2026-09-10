/**
 * Canonical text normalization for the Oxy ecosystem.
 *
 * WHY THIS EXISTS
 * ---------------
 * Third-party text (federated actor display names, spoiler/CW text, image alt
 * text, bios, `<title>` / `og:site_name` of scraped remote pages, …) arrives
 * with the whitespace the remote author's markup happened to contain. A real
 * bug: a remote page served
 *
 *     <title>
 *       Mi título
 *     </title>
 *
 * and the extracted string — newlines and indentation included — was stored
 * verbatim. Clients render text with React Native Web `Text`, which maps to
 * CSS `white-space: pre-wrap`: unlike HTML, newlines and repeated spaces are
 * NOT collapsed at render time, so the user saw a blank line and a six-space
 * indent inside the link preview.
 *
 * Storage-time normalization is therefore the ONLY place this can be fixed:
 * every renderer downstream is faithful by design.
 *
 * WHICH HELPER DO I USE?
 * ----------------------
 *  - {@link normalizeInlineText} — the value is conceptually ONE LINE, and a
 *    line break in it is always an accident of the source markup: page titles,
 *    `siteName`, display names, image `alt`, handles, profile field labels.
 *    Every line break becomes a space.
 *
 *  - {@link normalizeMultilineText} — the value is a BODY whose line breaks are
 *    the author's own paragraphs and must survive: post text, bios/summaries.
 *    Line breaks are preserved (capped at one blank line); only the surrounding
 *    whitespace noise is cleaned.
 *
 * Using the multiline helper on a title would keep the newlines and reproduce
 * the original bug; using the inline helper on a post body would flatten the
 * author's paragraphs into a single run-on line. Pick deliberately.
 *
 * Neither helper truncates, strips markup, or enforces a character policy —
 * those are separate, product-specific concerns (see `isValidDisplayName` for
 * the display-name character policy). These functions do exactly one thing:
 * normalize whitespace and Unicode form.
 */

/** Any run of whitespace, including tabs, line breaks and Unicode spaces. */
const ANY_WHITESPACE_RUN = /\s+/g;

/**
 * Every line-break form, unified to `\n` before the multiline passes run:
 * CRLF (Windows), a lone CR (classic Mac / stray `\r`), and the Unicode LINE
 * SEPARATOR (U+2028) / PARAGRAPH SEPARATOR (U+2029), which are mandatory breaks
 * in Unicode and a well-known hazard in JSON/JS payloads. CRLF must be matched
 * before the lone `\r` alternative or it would yield two breaks. The separators
 * are matched by their code-point ESCAPES (`\u2028` = LINE SEPARATOR, `\u2029` =
 * PARAGRAPH SEPARATOR) rather than by their Unicode Line_Separator /
 * Paragraph_Separator property escapes: React Native's Hermes engine ships with
 * Unicode property escapes compiled OUT and rejects those subcategory property
 * names with "Invalid RegExp: Invalid property name", whereas the `\uXXXX`
 * escapes are exactly equivalent (each property covers exactly its one code
 * point), engine-portable, and drop the now-unneeded `u` flag. (A literal
 * U+2028/U+2029 is itself a LineTerminator and cannot appear in a regex literal.)
 */
const LINE_BREAK_FORMS = /\r\n|\r|\u2028|\u2029/g;

/**
 * A run of HORIZONTAL whitespace: any whitespace that is not a line break.
 * `[^\S\n]` is "whitespace, minus `\n`" — it covers the tab, the vertical tab,
 * the form feed and every Unicode space separator (NBSP U+00A0, the U+2000
 * block, the ideographic space U+3000, the zero-width no-break space U+FEFF).
 * Applied AFTER {@link LINE_BREAK_FORMS}, so no line break can hide in it.
 */
const HORIZONTAL_WHITESPACE_RUN = /[^\S\n]+/g;

/**
 * Horizontal whitespace at the END of a line — the blank-line spoiler: it is
 * what makes an "empty" line non-empty and hides it from {@link EXCESS_BLANK_LINES}.
 */
const TRAILING_HORIZONTAL_WHITESPACE = / +\n/g;

/**
 * Horizontal whitespace at the START of a line: source-markup indentation. HTML
 * collapses it by spec, so it is invisible where the text came from and carries
 * no meaning — it only becomes visible once a client renders the value with
 * `white-space: pre-wrap`.
 */
const LEADING_HORIZONTAL_WHITESPACE = /\n +/g;

/** Three or more line breaks: more than one blank line between paragraphs. */
const EXCESS_BLANK_LINES = /\n{3,}/g;

/**
 * Normalize a SINGLE-LINE text value such as a page title or `siteName`,
 * display names, image alt text, handles, profile field labels.
 *
 * A line break in such a value is never meaningful — it is an artifact of the
 * markup the value was extracted from (`<title>\n  Título\n</title>`) — and it
 * survives into the UI because RN Web renders `Text` with `white-space:
 * pre-wrap`. So ALL whitespace, line breaks included, collapses to one space.
 *
 *   1. NFC-normalize, so visually identical strings store and compare
 *      identically (a decomposed `e`+◌́ recomposes into `é`).
 *   2. Collapse every run of whitespace — spaces, tabs, `\n`, `\r`, and Unicode
 *      spaces such as NBSP — to a single plain space.
 *   3. Trim both ends.
 *
 * Length is NOT capped: a maximum length is a product rule of the specific
 * field (see `MAX_DISPLAY_NAME_LENGTH`), not a property of text normalization.
 * Markup is NOT stripped: run the caller's sanitizer first if the source can
 * contain HTML.
 *
 * A value that is empty or whitespace-only returns `''`. Callers decide whether
 * that means "omit the field" (`|| undefined`) or "store an empty string".
 *
 * Idempotent: `f(f(x)) === f(x)`.
 */
export function normalizeInlineText(value: string): string {
  return value.normalize('NFC').replace(ANY_WHITESPACE_RUN, ' ').trim();
}

/**
 * Normalize a MULTILINE text BODY: post text, bios, summaries — anywhere the
 * line breaks are the author's paragraphs and must be preserved.
 *
 * Cleans the whitespace noise around those paragraphs without destroying them:
 *
 *   1. NFC-normalize (same rationale as {@link normalizeInlineText}).
 *   2. Unify every line-break form (CRLF, lone CR, U+2028, U+2029) to `\n`.
 *   3. Collapse runs of HORIZONTAL whitespace (spaces, tabs, NBSP and friends)
 *      to a single space. Line breaks are untouched.
 *   4. Strip the horizontal whitespace at BOTH ends of every line.
 *   5. Collapse three or more line breaks to exactly one blank line (`\n\n`).
 *   6. Trim both ends of the value.
 *
 * STEP 4 MUST PRECEDE STEP 5 — this is the whole point of the function. A
 * "blank" line that actually contains spaces (`"a\n   \n   \nb"`) breaks the
 * run of `\n` characters, so a bare `\n{3,}` collapse (step 5 alone) never sees
 * it and the extra blank lines survive into the UI. That is exactly the bug in
 * federated post bodies. Trimming each line first turns those lines into real,
 * empty lines, which step 5 then collapses.
 *
 * Every line is trimmed on BOTH sides, so a leading indent is removed outright
 * rather than reduced to one space. Step 3 has already destroyed whatever indent
 * the author wrote (`"      Mundo"` → `" Mundo"`), so a surviving space would not
 * be the author's intent — it would be an arbitrary remnant of exactly the
 * source-markup indentation this function exists to erase, and `pre-wrap` renders
 * it. Indentation is invisible in HTML by spec; it must be invisible here too.
 *
 * A value that is empty or whitespace-only returns `''`.
 *
 * Idempotent: `f(f(x)) === f(x)`.
 */
export function normalizeMultilineText(value: string): string {
  return value
    .normalize('NFC')
    .replace(LINE_BREAK_FORMS, '\n')
    .replace(HORIZONTAL_WHITESPACE_RUN, ' ')
    .replace(TRAILING_HORIZONTAL_WHITESPACE, '\n')
    .replace(LEADING_HORIZONTAL_WHITESPACE, '\n')
    .replace(EXCESS_BLANK_LINES, '\n\n')
    .trim();
}
