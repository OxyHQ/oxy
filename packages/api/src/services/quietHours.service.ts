/**
 * Quiet hours (ADR 0068): the hours during which nothing is pushed to a
 * minor's devices, read in the account's own timezone.
 *
 * The window comes from the age band's protective defaults
 * (`protectionsFor` in `@oxy.so/contracts`); this reads the two facts it
 * depends on, the date of birth and the timezone, and answers a boolean. A
 * caller never receives either fact.
 *
 * It is for what can wait until morning: a new post, a new email. It is never
 * consulted for a push the person needs at once to keep their account safe (a
 * sign-in to approve, an account notice), which is why the push service does
 * not apply it by itself and each sender decides.
 */
import { inArray } from 'drizzle-orm';
import { ageBandOf, isWithinQuietHours, localTimeIn, protectionsFor } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';

/** The accounts among `accountIds` that are in their quiet hours at `at`. */
export async function accountsInQuietHours(
  accountIds: readonly string[],
  at: Date = new Date(),
): Promise<Set<string>> {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return new Set();
  const rows = await getDb()
    .select({
      id: users.id,
      dateOfBirth: users.dateOfBirth,
      timezone: users.preferenceTimezone,
    })
    .from(users)
    .where(inArray(users.id, unique));
  const quiet = new Set<string>();
  for (const row of rows) {
    if (!row.dateOfBirth) continue;
    const { quietHours } = protectionsFor(ageBandOf(row.dateOfBirth, at));
    if (isWithinQuietHours(quietHours, localTimeIn(row.timezone, at))) quiet.add(row.id);
  }
  return quiet;
}

/** Whether one account is in its quiet hours at `at`. */
export async function isInQuietHours(accountId: string, at: Date = new Date()): Promise<boolean> {
  return (await accountsInQuietHours([accountId], at)).has(accountId);
}
