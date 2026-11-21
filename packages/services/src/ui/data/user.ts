/**
 * `User`: every person this SDK or an app reads, held once per account
 * (`@oxy.so/bloom-data`).
 *
 * An app's own entities refer to it (`refs: { user: User }` on a post, a
 * notification, a list row), so one copy of each person serves every surface:
 * a profile edit, a new avatar or a follow reaches every post that person
 * wrote, with no per-app identity overlay.
 *
 * A record joins the held one by the user-cache merge rules
 * (`data/userRecord.ts`):
 * - a sparse payload (a feed author, a search hit) never strips the counts,
 *   the `relationship` or the `createdAt` a profile read stored;
 * - a degraded one (the "Unknown user" placeholder an Oxy outage returns, an
 *   empty username, a `null` avatar) never replaces a resolved field;
 * - the copy with the later `updatedAt` (Oxy's `users.updated_at`) wins, and
 *   a copy without one counts as the oldest: a feed answer hydrated before a
 *   profile edit cannot put the old picture back, while what it carries that
 *   the held copy lacks still fills in.
 *
 * `relationship` is the viewer's: each account has its own store, so it is
 * never another viewer's, and a payload hydrated for no viewer (`anonymous`)
 * keeps the one held.
 *
 * Records embedded through an app's `refs` must already have the canonical
 * shape (`id`, structured `name`). Looser actor objects (`_id`, a string name)
 * go through `storeUsers`, which normalises them.
 */
import { currentStore, entity, withStore } from '@oxy.so/bloom-data';
import {
  type CacheableUser,
  type CachedUser,
  mergeUsers,
  normalizeIncoming,
  type UpsertCachedUserOptions,
} from './userRecord';

/** Bump when the stored user's shape changes: the account's stored users are then dropped. */
const USER_RECORD_VERSION = 1;

export const User = entity<CachedUser>('user', {
  id: (user) => user.id,
  viewerFields: ['relationship'],
  // The newer copy is merged over the older; an equal one replaces as before.
  combine: (incoming, held) =>
    updatedAtOf(incoming) < updatedAtOf(held)
      ? mergeUsers(incoming, held)
      : mergeUsers(held, incoming),
  persist: { version: USER_RECORD_VERSION },
});

type UserInput = CacheableUser | null | undefined;

/** When a copy was last changed at Oxy, in ms; a copy without `updatedAt` is the oldest. */
function updatedAtOf(user: CachedUser): number {
  const at = typeof user.updatedAt === 'string' ? Date.parse(user.updatedAt) : Number.NaN;
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * Stores users in `User`, in the store in scope (the active account's), merged
 * into what is held. `cleared` names the fields a write deliberately emptied
 * (one user only, see `UpsertCachedUserOptions`): for those an empty incoming
 * value drops the held one.
 */
export function storeUsers(
  users: UserInput | readonly UserInput[],
  options?: UpsertCachedUserOptions,
): void {
  const list = Array.isArray(users) ? users : [users];
  const records = list.flatMap((user: UserInput) => {
    const record = user ? normalizeIncoming(user) : null;
    return record ? [record] : [];
  });
  if (records.length === 0) return;
  const cleared = options?.cleared;
  if (!cleared?.length) {
    User.put(records);
    return;
  }
  for (const record of records) {
    const updated = User.update(record.id, (held) => mergeUsers(held, record, { cleared }));
    if (!updated) User.put(record);
  }
}

/**
 * A writer into `User` of the account in scope NOW. A read captures it before
 * it awaits, so an answer that lands after an account switch goes to the
 * account that asked (whose store is closed by then, so it is dropped), never
 * to the next one.
 */
export function userWriter(): (users: UserInput | readonly UserInput[]) => void {
  const store = currentStore();
  return (users) => withStore(store, () => storeUsers(users));
}
