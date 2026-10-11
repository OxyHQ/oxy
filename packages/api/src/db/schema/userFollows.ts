/**
 * `user_follows` — the social graph: account A follows account B.
 *
 * Ported from `models/Follow.ts`, and the single most consequential decision in
 * this batch, because every follow-graph read in the package sits on it: the
 * recommendation engine, mutuals, follows-of-follows, the two paginated list
 * endpoints, and `graphExclusion.ts`.
 *
 * ## Why ONE typed table rather than a polymorphic one
 *
 * The original `Follow` model was polymorphic: `followType: 'user' | 'hashtag' |
 * 'topic'` plus a `followedId` whose target depended on that type. The two
 * candidate designs were (a) one table with a `follow_type` discriminator and NO
 * foreign key on `followed_id`, or (b) a typed table per target with real
 * foreign keys. This is (b), narrowed to the one target that exists.
 *
 * Four facts decided it, all verified rather than assumed:
 *
 * 1. **The polymorphism was never real.** `refPath: 'followType'` resolves the
 *    model name from the field's VALUE — `'user'`, `'topic'` — while the
 *    registered models are `'User'` and `'Topic'`. Every `populate('followedId')`
 *    against this schema throws. The declaration described an intent the code
 *    could not execute, so there is nothing working to preserve.
 *
 * 2. **Nothing has ever written a non-`user` edge.** Every write path —
 *    `Follow.create` (`user.service.ts:1131`), `Follow.insertMany` (`:1344`) —
 *    hard-codes `FollowType.USER`, and every one of the ~40 reads filters
 *    `followType: FollowType.USER`. `git log -S FollowType.HASHTAG` and
 *    `-S FollowType.TOPIC` across all history return nothing: the two other
 *    enum values have never been referenced by any code in this repository.
 *    A discriminator column whose value is a constant is not a discriminator.
 *
 * 3. **`hashtag` has no table to reference, and never could.** A hashtag is a
 *    string, not a row. Option (a) would have made `followed_id` the ONE
 *    unconstrained id column in the social graph in order to accommodate a
 *    target that does not exist — spending the migration's main win on nothing.
 *
 * 4. **The FK is worth more here than anywhere else in the schema.** With both
 *    sides referencing `users` with `ON DELETE CASCADE`, an edge pointing at a
 *    deleted account is unrepresentable, and the hand-rolled graph purge on
 *    account deletion (`user.service.ts:1633`, a `deleteMany` with an `$or`
 *    over both directions) becomes the database's job, enforced.
 *
 * `topic_follows` is deliberately NOT created alongside this table. `topics`
 * exists, so the FK would be declarable — but nothing follows a topic, and a
 * table with no writer and no reader is exactly the "cosas innecesarias" the
 * migration contract forbids. Adding it later is purely additive and costs this
 * table nothing: a new module, a new FK to `topics.id`, no reshaping here.
 *
 * ## What the backfill must do — and must NOT do
 *
 * The collection→table map gets `follows` → `user_follows` with an explicit
 * filter of `followType = 'user'` that **asserts** rather than selects: the
 * backfill must COUNT rows whose `followType` is anything else and FAIL naming
 * them, not silently skip them. Skipping is how a relational link gets lost
 * quietly; failing is how the one scenario this design does not cover announces
 * itself. Given fact (2) the count is expected to be zero.
 *
 * ## What the call-site port must change
 *
 * - `followType` disappears from every filter. There is nothing to discriminate.
 * - `followerUserId` → `follower_id`. The old name served the polymorphic case
 *   (only the FOLLOWER was known to be a user); in a typed table both sides are,
 *   and the pair reads symmetrically.
 * - **Ids are `text` and are passed as strings, always.** A stored id type that
 *   could be either an object or its string form needs a normalizer at every
 *   read and silently matches nothing where one is forgotten. Neither failure is
 *   expressible against a `text` column with a foreign key.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const userFollows = pgTable(
  'user_follows',
  {
    id: generatedId(),
    /** Who follows. A deleted account follows nobody. */
    followerId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who is followed. An edge into a deleted account points at nothing. */
    followedId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // `(follower_id, followed_id)` unique. It is both the idempotency guard that
    // makes `followUser` safe under a concurrent double-submit and — as a
    // leading prefix — the FOLLOWING-direction access path.
    unique('user_follows_follower_id_followed_id_key').on(t.followerId, t.followedId),

    // The FOLLOWERS direction, ordered. Added after a measurement (49,991 keys
    // examined collapsing to 5,000 on a 5,000-follower target):
    // `getUserFollowers` pages this exact shape, and `id` mirrors the
    // `(createdAt, _id)` tiebreak the sort uses so pagination stays
    // deterministic.
    index('user_follows_followed_id_created_at_id_idx').on(t.followedId, t.createdAt.desc(), t.id),

    // `(created_at desc, id)`. It serves the bounded recent-edge window
    // `buildPopularFallback` scans before grouping by followed account
    // (`routes/profiles.ts:931-938`).
    index('user_follows_created_at_id_idx').on(t.createdAt.desc(), t.id),

    // NOT added: `(follower_id, created_at desc, id)` for the FOLLOWING list's
    // ordering. The unique above already bounds that read to one account's own
    // fan-out, so the sort is over a small set rather than the table. If a
    // profile with an enormous following list makes it measurable, that index
    // is the fix — against a measurement, not by symmetry with the followers
    // direction, whose index was added because without it the scan was O(all
    // follows).

    // `followUser` rejects a self-follow in application code
    // (`user.service.ts`). A CHECK makes it unrepresentable, which is
    // the same move `users_parent_account_id_not_self_check` makes for the
    // account tree.
    check('user_follows_not_self_check', sql`${t.followerId} <> ${t.followedId}`),
  ],
);
