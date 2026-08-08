/**
 * `user_ancestors` — one edge of an account's materialized root→parent path.
 *
 * Ported from the `ancestors` array embedded in `models/User.ts`, where it is
 * built as `[...parent.ancestors, parent._id]` (`account.service.ts:109`) — so
 * the array is ordered ROOT FIRST and `depth` reproduces that order exactly:
 * `depth = 0` is the tree root, the highest `depth` is the immediate parent.
 *
 * ## Why a junction table and not `ltree`
 *
 * `ltree` is the textbook answer for a materialized path and it is unusable
 * here for a hard reason, not a stylistic one: an `ltree` label may contain only
 * `[A-Za-z0-9_]`, and post-cutover ids are uuid v7, which contain hyphens. The
 * path would have to be re-encoded on every read and write, which is a
 * transformation layer over the ids the whole migration exists to keep verbatim.
 * (`ltree` is also an extension, with the same install-ordering objection
 * `CONVENTIONS.md` raised against `citext`.)
 *
 * A junction table also gets what the array could not: a real foreign key per
 * edge. Mongo's `ancestors` was a list of ids nothing checked, so a deleted
 * account stayed in every descendant's path forever.
 *
 * ## What the foreign keys can and cannot guarantee
 *
 * `CASCADE` on `ancestor_id` removes a deleted account's edges from every path
 * it appeared in — which is the DANGLING-reference guarantee, and it is new.
 * It is NOT a correct re-parenting: if B is deleted from the path `[A, B, C]`,
 * C's children are re-rooted at C (their `parent_account_id` was already
 * `SET NULL` at B), so A stops being their ancestor too — and no `ON DELETE`
 * action can compute that. Recomputing a materialized path is application work;
 * `account.service.ts` already owns it for the account-MOVE case.
 *
 * **Finding for the call-site port:** the GDPR delete path
 * (`routes/users.ts:1517`) does not call that rewrite today. Under Mongo the
 * result was a silently stale path; under Postgres it is a stale path with no
 * dangling ids. Deletion must re-parent descendants BEFORE deleting.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Maximum tree depth, guarding against pathological nesting. The SINGLE
 * declaration — the Mongoose copy is gone. It renders the `depth` CHECK below,
 * and `account.service.ts` refuses a deeper move before the write; both are
 * covered (`__tests__/account.service.test.ts` for the service,
 * `check-drizzle-snapshot-sync` for the constraint).
 */
export const MAX_ACCOUNT_DEPTH = 8;

export const userAncestors = pgTable(
  'user_ancestors',
  {
    /** The descendant whose path this edge belongs to. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Zero-based position in the root→parent path. `0` is the tree root. */
    depth: integer().notNull(),
    /** The ancestor at that position. */
    ancestorId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    // The path is addressed as (descendant, position) and there is exactly one
    // ancestor at each position — so the natural key IS the primary key, and no
    // surrogate id is invented for a row nothing references.
    primaryKey({ columns: [t.userId, t.depth], name: 'user_ancestors_pkey' }),
    // The reason the path is materialized at all: "every account under X",
    // answered without walking the tree. Mongo's multikey `{ancestors: 1}`.
    index('user_ancestors_ancestor_id_idx').on(t.ancestorId),
    check(
      'user_ancestors_depth_check',
      sql`${t.depth} >= 0 and ${t.depth} < ${sql.raw(String(MAX_ACCOUNT_DEPTH))}`
    ),
    // An account is not its own ancestor. The one-hop case of the cycle check in
    // `account.service.ts`, and the shape a bad write actually produces.
    check('user_ancestors_not_self_check', sql`${t.ancestorId} <> ${t.userId}`),
  ]
);
