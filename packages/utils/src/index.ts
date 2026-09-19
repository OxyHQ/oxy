/**
 * `@oxy.so/utils` — dependency-free helpers shared across Oxy services.
 *
 * ## What belongs here
 *
 * A helper earns a place only if it is (a) copied byte-identically into three
 * or more REPOS, (b) pure and dependency-free, and (c) something no repo could
 * reasonably want a different version of. All three, not any of them.
 *
 * That last clause does most of the work. An audit of eight Oxy repos found
 * plenty of duplication that fails it and is deliberately NOT here:
 *
 * - **Query-param coercion.** Three repos wrote a helper and all three chose
 *   contradictory semantics for a repeated parameter — absent (Mention), last
 *   wins (oxy), first wins (Homiio) — and each documents its choice as the fix
 *   for a real incident. One shared `queryString()` would have to overrule two
 *   of them.
 * - **Retry and backoff.** Five repos, six policies. A retry budget is a
 *   product decision about a specific dependency, not a utility.
 * - **Compact number and duration formatting.** Four repos, four different
 *   outputs (`"1.2K"` vs `"482.8k"`). Unifying them is a design change.
 * - **`sleep` / `delay`.** Four repos, and six of seven copies are the version
 *   that leaks a timer on cancellation. Sharing would enshrine the bug; the one
 *   good copy is `AbortSignal`-aware and belongs with the HTTP client.
 *
 * The ecosystem also has a binding precedent for leaving small things
 * duplicated: ADR 0022 keeps per-app i18n rather than sharing one catalogue,
 * because the shared version would carry the wrong weight. A utility that has
 * to be configured into agreement is that case.
 *
 * ## Exports are NOMINAL
 *
 * Following `@oxy.so/core`'s rule: no `export *`, no barrels. If a symbol does
 * not appear below it is not part of the public API. Subpaths (`./sql`,
 * `./paging`, `./text`) exist because two consumers' bundle gates refuse
 * root-barrel imports — Metro does not tree-shake, so a frontend importing one
 * function must be able to reach it without dragging the rest in.
 */

export {
  escapeLikePattern,
  likeContains,
  likeStartsWith,
  likeEndsWith,
} from './sql.js';

export {
  resolvePageLimit,
  resolvePageOffset,
  resolvePageNumber,
  offsetForPage,
  type PageLimitBounds,
} from './paging.js';

export { escapeRegExp, clamp, chunk } from './text.js';
