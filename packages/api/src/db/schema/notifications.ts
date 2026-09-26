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
 * The fourth, `app`, names nothing Oxy can resolve at all: `entity_id` is an
 * opaque id in the NOTIFYING application's own namespace (Oxy Move's migration
 * job). It exists for `system` notifications only — an Oxy service telling a
 * user about their own account — and a CHECK refuses it on any other type, so
 * an actor's like or follow can never point into an app's private id space.
 *
 * Both PARTICIPANT columns do get real foreign keys, and they are the ones that
 * matter: a notification from or to a deleted account is noise, and `CASCADE`
 * removes it without a cleanup job.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, boolean, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import {
  OXY_NOTIFICATION_ENTITY_TYPES,
  OXY_NOTIFICATION_TYPES,
  OXY_NOTIFICATION_URL_MAX,
  OXY_SYSTEM_NOTIFICATION_MESSAGE_MAX,
  OXY_SYSTEM_NOTIFICATION_TITLE_MAX,
} from '@oxy.so/contracts';
import { users } from './users';

/**
 * What happened. Mongo's `type` enum, plus `system`: a message from an Oxy
 * service about the recipient's own account (Oxy Move's "your migration
 * finished"), where the actor is the recipient and the entity is their profile.
 * The tuple is owned by `@oxy.so/contracts` so the SDK and the CHECK cannot drift.
 */
export const NOTIFICATION_TYPES = OXY_NOTIFICATION_TYPES;

/**
 * What `entity_id` points at: Mongo's `entityType` enum, plus `app` — an OPAQUE
 * id in the notifying application's own namespace (Oxy Move's job id), never
 * resolved by Oxy. `app` is valid only on a `system` notification (CHECK
 * below): an actor's like/reply/follow always names a real post or profile.
 * The tuple is owned by `@oxy.so/contracts`.
 */
export const NOTIFICATION_ENTITY_TYPES = OXY_NOTIFICATION_ENTITY_TYPES;

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
    /**
     * The text of a `system` notification — and ONLY of one. Every other type
     * is rendered by the client from `type` + entity, so it stores none (the
     * CHECKs below make that structural rather than a convention).
     */
    title: text(),
    message: text(),
    /** Optional deep link of a `system` notification: https, or a registered app scheme. */
    url: text(),
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
    // Text iff `system`: a system notification without words is empty on every
    // client, and text on any other type would be a second rendering path.
    check(
      'notifications_system_text_check',
      sql`(${t.type} = 'system') = (${t.title} is not null and ${t.message} is not null)`
    ),
    check('notifications_app_entity_system_only_check', sql`${t.entityType} <> 'app' or ${t.type} = 'system'`),
    check('notifications_url_system_only_check', sql`${t.url} is null or ${t.type} = 'system'`),
    check(
      'notifications_title_length_check',
      sql`${t.title} is null or char_length(${t.title}) between 1 and ${sql.raw(String(OXY_SYSTEM_NOTIFICATION_TITLE_MAX))}`
    ),
    check(
      'notifications_message_length_check',
      sql`${t.message} is null or char_length(${t.message}) between 1 and ${sql.raw(String(OXY_SYSTEM_NOTIFICATION_MESSAGE_MAX))}`
    ),
    check(
      'notifications_url_length_check',
      sql`${t.url} is null or char_length(${t.url}) between 1 and ${sql.raw(String(OXY_NOTIFICATION_URL_MAX))}`
    ),
  ]
);
