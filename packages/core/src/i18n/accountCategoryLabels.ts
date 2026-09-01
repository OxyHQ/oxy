import type { AccountCategoryId } from '@oxyhq/contracts';
import enUS from './locales/en-US.json';
import { translate } from './index';

/**
 * Every account category's English name, keyed by its stable id.
 *
 * **The annotation is the point.** The vocabulary lives in `@oxyhq/contracts`
 * and the names live in `locales/en-US.json`, so they are two lists that must
 * agree and nothing but a type can make them. Declaring the JSON node as a
 * TOTAL `Record<AccountCategoryId, string>` turns "somebody added a category at
 * Oxy and nobody wrote its English" into a `TS2741` naming the missing id, at
 * build time, instead of a picker row that paints `accounts.accountCategory.<id>`
 * at a user trying to choose one.
 *
 * That failure is not hypothetical. The screen previously wrote `t(key) || id`,
 * whose author believed an unnamed id would degrade to its raw slug. It cannot:
 * {@link translate} echoes the KEY when it resolves nothing, and a non-empty
 * string is never falsy, so the `|| id` arm was unreachable and the output was
 * the dotted key. A runtime fallback that cannot run is worse than none,
 * because it reads as protection.
 *
 * Totality is over `ACCOUNT_CATEGORY_IDS`, which RETAINS withdrawn ids, so an
 * account still carrying a retired category keeps rendering its name while no
 * picker offers it again. Retired and unknown are different cases: only an id
 * outside the union is unnameable, which is why this is keyed by
 * `AccountCategoryId` and not by `string`.
 */
/**
 * Module-scoped, NOT re-exported from the package index: the annotation is the
 * whole job, and it does that job without being public API. It carries no
 * `Object.freeze` and no `Readonly<>` for the same reason — those existed only
 * to make an exported reference safe from a consumer's stray write, and there
 * is no such consumer. Exported from the MODULE so its own test can name it.
 */
export const EN_ACCOUNT_CATEGORY_LABELS: Record<AccountCategoryId, string> =
  enUS.accounts.accountCategory;

export function accountCategoryLabel(
  locale: string | undefined,
  id: AccountCategoryId,
): string {
  return translate(locale, `accounts.accountCategory.${id}`);
}
