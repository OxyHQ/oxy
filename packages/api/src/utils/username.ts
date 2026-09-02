/**
 * Username CANONICALIZATION — what a submitted handle becomes before it is
 * judged.
 *
 * This file no longer decides what is legal. That is one rule, in one place:
 * `usernameSchema` in `@oxyhq/contracts`, imported by every write path here and
 * by every client. This module answers the other question — what string the
 * policy is applied TO — and the two are deliberately separate:
 * canonicalization is about the same name written two ways, policy is about
 * which names exist.
 *
 * The predecessor of this file declared its own pattern and listed two of the
 * three others it knew about; there were six.
 * `packages/contracts/src/__tests__/usernamePolicySingleSource.test.ts` is what
 * now makes a seventh impossible to add quietly.
 */

import { normalizeInlineText } from '@oxyhq/core';

/**
 * Canonicalize a submitted username before it is validated, compared, or stored.
 *
 * Uses the canonical single-line normalizer: NFC + whitespace collapse + trim.
 * Interior whitespace is NOT silently removed — it collapses to a space, which
 * `usernameSchema` then rejects. Silently squashing `"al ice"` into `"alice"`
 * would hand the user an account under a name they never chose.
 *
 * NFC is the part `usernameSchema` cannot do for itself: a decomposed sequence
 * and its precomposed form are the same name to a reader, and only one of them
 * should ever reach the unique index.
 */
export function normalizeUsername(raw: string): string {
  return normalizeInlineText(raw);
}
