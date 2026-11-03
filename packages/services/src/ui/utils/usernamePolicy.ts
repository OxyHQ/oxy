/**
 * The username policy, in the words of the person typing.
 *
 * Every field that takes a username (signing up, editing yours, creating an
 * account you manage) asks the ONE policy in `@oxy.so/contracts/client` and
 * says WHICH rule the candidate broke, localized. The policy's own messages are
 * English and catch-all; shown raw, or not checked at all, a name like
 * `hash saah` reached the server, was refused with a 400, and the person read
 * "Something went wrong".
 */

import type { AccountKind } from '@oxy.so/core';
import {
  BOT_USERNAME_INVALID_MESSAGE,
  NUMERIC_USERNAME_MESSAGE,
  RESERVED_USERNAME_MESSAGE,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  usernameCheckForAccountKind,
} from '@oxy.so/contracts/client';
import type { Translate } from '../hooks/useI18n';

export type UsernameDraftResult = { ok: true; username: string } | { ok: false; error: string };

/**
 * Hold a typed username to the policy for `kind` (`bot` handles end in `bot`).
 * On success `username` is the trimmed handle to send; on failure `error` is
 * the localized reason, specific to the rule that failed.
 */
export function checkUsernameDraft(
  value: string,
  t: Translate,
  kind?: AccountKind | null,
): UsernameDraftResult {
  const username = value.trim();
  if (!username) return { ok: false, error: t('usernamePolicy.required') };
  const checked = usernameCheckForAccountKind(kind)(username, []);
  if (checked.ok) return { ok: true, username: checked.value };
  return { ok: false, error: describeUsernameIssue(username, checked.issue.message, t) };
}

function describeUsernameIssue(username: string, message: string, t: Translate): string {
  switch (message) {
    case NUMERIC_USERNAME_MESSAGE:
      return t('usernamePolicy.onlyNumbers');
    case RESERVED_USERNAME_MESSAGE:
      return t('usernamePolicy.reserved');
    case BOT_USERNAME_INVALID_MESSAGE:
      return t('usernamePolicy.mustEndInBot');
    default:
      // `USERNAME_INVALID_MESSAGE` covers length and shape alike; the length is
      // read here so the reason names the rule that actually failed.
      if (username.length < USERNAME_MIN_LENGTH)
        return t('usernamePolicy.tooShort', { min: USERNAME_MIN_LENGTH });
      if (username.length > USERNAME_MAX_LENGTH)
        return t('usernamePolicy.tooLong', { max: USERNAME_MAX_LENGTH });
      if (/\s/.test(username)) return t('usernamePolicy.noSpaces');
      return t('usernamePolicy.characters');
  }
}
