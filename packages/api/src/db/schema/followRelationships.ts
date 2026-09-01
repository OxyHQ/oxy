/**
 * `follow_relationships` — the user's intent, owned by the user.
 *
 * One row per (follower, target). It is GLOBAL: following someone from Syra
 * makes them followed in Mention too, because the relationship is the user's
 * and not the application's. An application appears here only as provenance —
 * where the user was standing when they did it.
 *
 * ## What the state means
 *
 * `active` is a relationship that exists. `requested` is one waiting on the
 * other side — a locked account, or a remote actor that has not accepted yet.
 * `rejected` is a refusal that must be remembered rather than retried in a loop.
 *
 * Counts move on the transition into and out of `active`, once, globally. A
 * second application beginning to consume an existing relationship changes
 * nothing and notifies nobody.
 *
 * ## Provenance columns are not authority
 *
 * `origin_application_id` and `created_by_grant_id` record how the relationship
 * came to exist. Both are `SET NULL`: revoking a grant, or deleting the
 * application the user was using, must not delete relationships the user
 * created. That is the difference between provenance and ownership, and it is
 * the whole point of this table.
 *
 * ## Expiry
 *
 * `expires_at` is how a follow ends by itself — "follow for 72 hours" for an
 * event or a trial. NULL is a permanent follow, which is nearly all of them.
 *
 * The sweeper that acts on it MUST go through the same command service as an
 * explicit unfollow: emit `follow.removed`, tear down federation, move counts
 * once. An expiry that took a shortcut would leave the remote side believing
 * the relationship still exists, which is precisely the divergence the outbox
 * exists to prevent.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { appGrants } from './appGrants';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { followTargets } from './followTargets';
import { users } from './users';

/** Where a relationship came from. Audit, and the input to reconciliation. */
export const FOLLOW_SOURCES = ['app', 'federation_inbound', 'migration', 'system'] as const;

export const FOLLOW_RELATIONSHIP_STATES = ['requested', 'active', 'rejected'] as const;

export type FollowRelationshipState = (typeof FOLLOW_RELATIONSHIP_STATES)[number];

export const followRelationships = pgTable(
  'follow_relationships',
  {
    id: generatedId(),
    /** `CASCADE` — a deleted user's follows are meaningless. */
    followerUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `CASCADE` — a relationship to a target that no longer exists is unresolvable. */
    followTargetId: text()
      .notNull()
      .references(() => followTargets.id, { onDelete: 'cascade' }),
    state: text({ enum: FOLLOW_RELATIONSHIP_STATES }).notNull().default('active'),
    /** Where the user was when they did this. `SET NULL` — see the header. */
    originApplicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    /**
     * Which consent authorised it. `SET NULL` on revoke: withdrawing an app's
     * permission stops it acting again, and does not undo what the user already
     * chose.
     */
    createdByGrantId: text().references(() => appGrants.id, { onDelete: 'set null' }),
    source: text({ enum: FOLLOW_SOURCES }).notNull().default('app'),
    /**
     * When this follow ends by itself. NULL is permanent.
     *
     * Indexed so the sweeper reads only what is due instead of scanning the
     * table — a partial index, because the overwhelming majority are NULL.
     */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One relationship per (user, target). The command service relies on this to
    // make a repeated follow idempotent rather than a second row, which is what
    // keeps counts from drifting.
    unique('follow_relationships_follower_target_key').on(t.followerUserId, t.followTargetId),
    // Same tuples as the `as const` arrays above. The drizzle `enum` is a
    // compile-time claim only; this is what stops a repair script or a future
    // service from storing a state no consumer knows how to render.
    check('follow_relationships_state_check', sql`${t.state} in ('requested', 'active', 'rejected')`),
    check(
      'follow_relationships_source_check',
      sql`${t.source} in ('app', 'federation_inbound', 'migration', 'system')`
    ),
    // "Everything this user follows" — the central list, in its sort order.
    index('follow_relationships_follower_created_idx').on(t.followerUserId, t.createdAt),
    // The reverse direction: who follows this target. Whether that is EXPOSED is
    // a per-kind policy decision; the index exists because counts need it either
    // way.
    index('follow_relationships_target_idx').on(t.followTargetId),
    index('follow_relationships_origin_application_id_idx').on(t.originApplicationId),
    // Only rows that can expire. Postgres skips the rest entirely.
    index('follow_relationships_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ]
);
