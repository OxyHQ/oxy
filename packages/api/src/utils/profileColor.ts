/**
 * The `users.color` WRITE policy.
 *
 * `color` is a named preset KEY (`USER_COLOR_PRESETS`), not a hex value — a
 * consumer resolves the key to a palette, so what gets stored has to be a name
 * the catalogue contains. Two surfaces can write the column: `PUT /users/me`, a
 * person editing their own profile, and the account graph's create/update, an
 * administrator editing a MANAGED account's profile. The rule is declared once
 * here for the reason `assertValidAccountName` states in `account.service.ts` —
 * a policy enforced on one of two write paths holds only for whichever path the
 * caller happens to pick.
 *
 * ## Fail closed on WRITE, tolerate on READ
 *
 * Nothing here is reachable from a read, deliberately. A color stored before the
 * named presets existed (the column still admits a legacy hex, see
 * `users_color_check`) must keep serving: `publicUserProjection` passes the
 * column through untouched and every DTO carries whatever the row holds.
 * Validating on the way out would turn a cosmetic field into a broken profile,
 * years after the write that is actually at fault.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { USER_COLOR_PRESETS, users, type UserColorPreset } from '../db/schema/users';
import { BadRequestError } from './error';
import { isPremiumSubscriptionPlan, resolveUserSubscriptionPlan } from './subscriptionPlan';

/**
 * Presets that are not simply available.
 *
 * `oxy` is Oxy's own brand. It is IN `USER_COLOR_PRESETS` — the database has to
 * admit it, or the account whose brand it is could not hold it — and gated here
 * instead.
 *
 * `satisfies` ties the list to the catalogue, so dropping a preset from
 * `USER_COLOR_PRESETS` fails this file's typecheck rather than leaving a gate
 * standing over a value nothing can hold any more.
 */
const RESERVED_COLOR_PRESETS = ['oxy'] as const satisfies readonly UserColorPreset[];

/**
 * The canonical stored form of a color: trimmed and lower-cased.
 *
 * Every check below runs against THIS value rather than the caller's, which is
 * what closes the bypass where ` oxy ` or `OXY` would skip the gate and still
 * persist as the gated preset.
 */
export function normalizeUserColor(value: string): string {
  return value.trim().toLowerCase();
}

/** Is `color` a preset the catalogue still contains? */
export function isUserColorPreset(color: string): color is UserColorPreset {
  return (USER_COLOR_PRESETS as readonly string[]).includes(color);
}

/** Is `color` one of the presets that has to be earned rather than picked? */
function isReservedColorPreset(color: string): boolean {
  return (RESERVED_COLOR_PRESETS as readonly string[]).includes(color);
}

async function storedUsername(accountId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  return row?.username ?? null;
}

/**
 * Refuse a reserved preset the subject has no claim to.
 *
 * The rule is the one `updateUserProfile` has always enforced on a person's own
 * profile, stated for any subject: the account whose HANDLE is the brand may
 * wear it, and so may a premium subscriber.
 *
 * ## The subject is the account being COLOURED, never the administrator
 *
 * A bot created by a premium subscriber is not itself a subscriber. Letting the
 * operator's plan travel down the tree is precisely the back door this closes —
 * `PATCH /accounts/:id` is a second write path onto this column, and it had no
 * gate at all, so an entitlement nobody held was one request away.
 *
 * `accountId` is `null` on the create path: a row that does not exist yet holds
 * no subscription, so only the handle branch can pass there — the same answer a
 * lookup would give. A caller that has already loaded the row passes `username`
 * so this does not read it twice; one that has not leaves it `null`, and it is
 * read here only when the color is reserved, which is almost never.
 */
export async function assertColorNotReserved(
  color: string,
  subject: { accountId: string | null; username: string | null }
): Promise<void> {
  if (!isReservedColorPreset(color)) return;

  const handle =
    subject.username ?? (subject.accountId ? await storedUsername(subject.accountId) : null);
  if (handle && normalizeUserColor(handle) === color) return;

  if (subject.accountId) {
    const plan = await resolveUserSubscriptionPlan(subject.accountId);
    if (isPremiumSubscriptionPlan(plan)) return;
  }
  throw new BadRequestError(`The ${color} color is exclusive to premium subscribers`);
}
