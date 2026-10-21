/**
 * The account-name policy, without Zod. Schema: `../accountName.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 *
 * An account's name follows ONE of two policies, chosen by its `kind` and by
 * nothing else — not by which route wrote it, nor by whether it is native or
 * federated:
 *
 *  - `person`: a human name. Letters of the allowlisted scripts, combining
 *    marks, spaces, the apostrophe and letter-flanked name separators; no
 *    digits. The character classes are generated data and live in
 *    `@oxy.so/core` (`isValidDisplayName`), which applies this table through
 *    `isValidAccountName`.
 *  - `title`: what an organization, project, bot, channel or community is called. Plain
 *    text — digits and punctuation are part of real titles ("Studio 54",
 *    "Blink-182") — without markup or control characters. Defined here, once.
 */

import type { AccountKind } from './accountGraph';
import { type Check, maxLength, minLength, refine, string, trim } from './check';

export type AccountNamePolicy = 'person' | 'title';

/**
 * The policy for each kind. A `Record` over the whole union, so adding a kind
 * fails this file's typecheck until someone decides how it is named.
 */
export const ACCOUNT_NAME_POLICY_BY_KIND = {
  personal: 'person',
  organization: 'title',
  project: 'title',
  bot: 'title',
  channel: 'title',
  community: 'title',
} as const satisfies Record<AccountKind, AccountNamePolicy>;

/** A missing kind is `personal`, the `users.kind` column default. */
export function accountNamePolicyForKind(kind: AccountKind | null | undefined): AccountNamePolicy {
  return ACCOUNT_NAME_POLICY_BY_KIND[kind ?? 'personal'];
}

/** Longest title, in UTF-16 code units after trimming. */
export const ACCOUNT_TITLE_MAX_LENGTH = 300;

/**
 * Source of the characters a title may not contain: `<`, `>`, the C0 controls
 * and DEL. A class of literal code points — no property escapes — so it
 * compiles on Hermes. The probe below rejects with it; the API compiles it with
 * `g` to strip untrusted titles, so the gate and the strip cannot disagree.
 */
export const ACCOUNT_TITLE_DISALLOWED_SOURCE = '[<>\\u0000-\\u001F\\u007F]';

const TITLE_DISALLOWED_PROBE = new RegExp(ACCOUNT_TITLE_DISALLOWED_SOURCE, 'u');

/** Whether `value` holds no character the title policy disallows. */
export function isPlainTextTitle(value: string): boolean {
  return !TITLE_DISALLOWED_PROBE.test(value);
}

/** The twin of `accountTitleSchema`. */
export const accountTitleCheck: Check<string> = refine(
  string(trim, minLength(1), maxLength(ACCOUNT_TITLE_MAX_LENGTH)),
  isPlainTextTitle,
  'Name must be plain text',
);
