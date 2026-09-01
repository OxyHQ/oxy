/**
 * `notifications` — one in-app notification: an actor did something to an entity
 * that the recipient is told about.
 *
 * Ported from `models/Notification.ts`.
 *
 * ## `entity_id` carries no foreign key, and that is permanent
 *
 * `entityId` is a bare ObjectId with NO `ref` in Mongoose, discriminated by
 * `entityType`. Two of the three types (`post`, `reply`) name rows in MENTION's
 * database, not this one — there is nothing local to reference. The third
 * (`profile`) names a `users` row, but a foreign key cannot be conditional on a
 * sibling column's value, and splitting the table three ways to gain one
 * constraint would fragment the recipient's single chronological feed for no
 * reader's benefit. It is therefore listed in
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY` rather than left unclassified.
 *
 * Both PARTICIPANT columns do get real foreign keys, and they are the ones that
 * matter: a notification from or to a deleted account is noise, and `CASCADE`
 * removes it without a cleanup job.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, boolean, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** What happened. Mongo's `type` enum, unchanged. */
export const NOTIFICATION_TYPES = [
  'like',
  'reply',
  'mention',
  'follow',
  'repost',
  'quote',
  'welcome',
] as const;

/** What `entity_id` points at. Mongo's `entityType` enum, unchanged. */
export const NOTIFICATION_ENTITY_TYPES = ['post', 'reply', 'profile'] as const;

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const notifications = pgTable(
  'notifications',
  {
    id: generatedId(),
    /** Who is being told. Their deletion takes the notification with it. */
    recipientId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who did it. A notification attributed to a deleted account says nothing. */
    actorId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text({ enum: NOTIFICATION_TYPES }).notNull(),
    /** Discriminated by `entity_type`; see the header for why it carries no FK. */
    entityId: text().notNull(),
    entityType: text({ enum: NOTIFICATION_ENTITY_TYPES }).notNull(),
    read: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongo's duplicate guard: the same actor doing the same thing to the same
    // entity notifies the recipient once, however many times it is emitted.
    unique('notifications_recipient_id_actor_id_type_entity_id_key').on(
      t.recipientId,
      t.actorId,
      t.type,
      t.entityId
    ),
    // The feed read: this recipient's notifications, newest first.
    index('notifications_recipient_id_created_at_idx').on(
      t.recipientId,
      t.createdAt.desc()
    ),

    check('notifications_type_check', sql`${t.type} in (${sql.raw(inList(NOTIFICATION_TYPES))})`),
    check(
      'notifications_entity_type_check',
      sql`${t.entityType} in (${sql.raw(inList(NOTIFICATION_ENTITY_TYPES))})`
    ),
  ]
);
