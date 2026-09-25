/**
 * `federated_account_moves` — the audit record and idempotency key of every
 * ActivityPub `Move` Oxy verified and applied (`POST /federation/move`).
 *
 * A remote account moved TO a local Oxy account: the local account had proven
 * ownership of the remote one (a live `user_linked_accounts` alias), and a fresh
 * fetch of the remote actor named the local actor as `movedTo`. Applying it
 * repoints local followers (`followCommand.service.ts`), carries inbound blocks
 * over, and records `canonical_user_redirects` old → target.
 *
 * `activity_id` is UNIQUE: the same Move delivered twice (a retry, a second
 * inbox, a relay) applies once and answers with the first result. The counts
 * are what that application did, kept for the audit trail.
 *
 * `old_user_id` is `SET NULL` and nullable: a Move may arrive for an actor Oxy
 * never mirrored (nothing to repoint), and the audit row must survive the
 * shadow user being purged later. `target_user_id` CASCADEs with the account.
 */

import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

export const federatedAccountMoves = pgTable(
  'federated_account_moves',
  {
    id: generatedId(),
    /** The Move activity's `id`, as delivered. */
    activityId: text().notNull(),
    oldActorUri: text().notNull(),
    targetActorUri: text().notNull(),
    /** The federated shadow user of the old actor, when Oxy had one. */
    oldUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** The local account the followers moved to. */
    targetUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The application that relayed the Move (the inbox that received it). */
    requestedByApplicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    followersMoved: integer().notNull().default(0),
    alreadyFollowing: integer().notNull().default(0),
    skippedBlocked: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('federated_account_moves_activity_id_key').on(t.activityId),
    index('federated_account_moves_target_user_id_idx').on(t.targetUserId),
    index('federated_account_moves_old_user_id_idx').on(t.oldUserId),
    check(
      'federated_account_moves_counts_check',
      sql`${t.followersMoved} >= 0 and ${t.alreadyFollowing} >= 0 and ${t.skippedBlocked} >= 0`,
    ),
  ],
);
