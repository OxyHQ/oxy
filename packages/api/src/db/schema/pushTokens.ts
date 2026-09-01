/**
 * `push_tokens` — one push-notification install: the pair (user, Expo push token).
 *
 * Ported from `models/PushToken.ts`. See that file for what `device_id` and
 * `application_id` scope, and why both are nullable.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** The platforms a push install can be registered for. */
export const PUSH_TOKEN_PLATFORMS = ['ios', 'android', 'web'] as const;

export const pushTokens = pgTable(
  'push_tokens',
  {
    id: generatedId(),
    /** A deleted account must stop receiving push notifications. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull(),
    platform: text({ enum: PUSH_TOKEN_PLATFORMS }).notNull(),
    /** Central device id of the install (same id space as `DeviceSession.deviceId`). */
    deviceId: text(),
    /**
     * The application whose install this is. NULL means "not scoped to any
     * application".
     *
     * `CASCADE`, not `SET NULL`, exactly as the deferred-FK ledger decided
     * before `applications` landed: NULL already MEANS something here, so
     * `SET NULL` would promote a dead app's install into the unscoped delivery
     * set instead of retiring it.
     */
    applicationId: text().references(() => applications.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('push_tokens_user_id_token_key').on(t.userId, t.token),
    // App-scoped delivery lookup: "this user's installs of these applications".
    index('push_tokens_user_id_application_id_idx').on(t.userId, t.applicationId),
    // Mongo also declared a standalone `{userId: 1}` index. Dropped: a btree
    // index serves any leading-column prefix, so the unique above already
    // answers every `where user_id = ?` read.
    check(
      'push_tokens_platform_check',
      sql`${t.platform} in ('ios', 'android', 'web')`
    ),
  ]
);
