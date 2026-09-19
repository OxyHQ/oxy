/**
 * SQL `LIKE` / `ILIKE` pattern building.
 *
 * ## Why this is shared, with the count
 *
 * An audit across the Oxy repos found this escape written TEN times in SIX
 * repos — `oxy` (×2), `Mention` (×3), `tnp` (×2), `Alia`, `Homiio`, and `Allo`
 * (SQLite) — six of them character-for-character identical, and **one test
 * between all six**. Three of the repos independently wrote an essay explaining
 * why the escaping matters, which is a fair signal that it is not obvious.
 *
 * It is the escaping, not the concatenation, that earns a shared home: a term
 * reaching `LIKE` unescaped is not a style problem. `%` is the multi-character
 * wildcard, so a search for `100%` matches EVERY row, and nothing in the
 * response says the filter was ignored — the endpoint looks like it worked and
 * returned everything. `_` is subtler still, because a term containing it
 * returns something plausible: `a_b` matches `axb` too.
 *
 * ## What this does NOT defend against
 *
 * Injection. The term is always passed as a BOUND PARAMETER, so no input can
 * reach the SQL; this only stops the caller's text being read as a pattern.
 * Saying so matters, because "escaping" invites the assumption that binding is
 * optional here. It is not.
 */

/**
 * Escape the three characters `LIKE` treats as special.
 *
 * One character class and one pass, not three chained `replace` calls: the
 * backslash has to be escaped in the SAME pass as `%` and `_`, or the pass that
 * adds a backslash has its output re-escaped by the next one. Homiio's copy
 * carries that reasoning and it is the reason this is written this way.
 *
 * `$&` (the whole match) rather than a callback — the two are equivalent, and
 * the literal is the one you can read without evaluating a function.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/** `%term%` — an unanchored substring match. */
export function likeContains(term: string): string {
  return `%${escapeLikePattern(term)}%`;
}

/**
 * `term%` — an anchored prefix match.
 *
 * The form a trigram index cannot serve and a `text_pattern_ops` b-tree can.
 * `pg_trgm` extracts trigrams only from a pattern's wildcard-free runs, so a
 * term shorter than three characters yields none and leaves
 * {@link likeContains} with no index to use at all — which is why a people or
 * list search usually wants this below that length rather than the substring
 * form. `text_pattern_ops` is required on the index for a non-C collation;
 * a plain b-tree cannot answer `LIKE 'ab%'`.
 */
export function likeStartsWith(term: string): string {
  return `${escapeLikePattern(term)}%`;
}

/** `%term` — an anchored suffix match. Index-servable by nothing; use sparingly. */
export function likeEndsWith(term: string): string {
  return `%${escapeLikePattern(term)}`;
}
