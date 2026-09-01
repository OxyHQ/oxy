/**
 * `update_channels` — a release track for one application's Oxy Updates.
 *
 * Ported from `models/UpdateChannel.ts`. A channel is a named pointer devices
 * subscribe to with the `expo-channel-name` header; the update they receive is
 * the newest published `app_updates` row matching their
 * `(runtime_version, platform)`.
 *
 * The `rollbacksToEmbedded` array does NOT live here — see
 * `update_channel_rollbacks.ts` for why it is a child table rather than `jsonb`.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

/**
 * Platforms an Oxy Update targets. Narrower than `push_tokens.platform` — there
 * is no `web` OTA channel, because expo-updates has no web client.
 *
 * This tuple is the SINGLE declaration — the Mongoose model that carried the
 * other copy is gone. It renders the CHECK below, and
 * `check-drizzle-snapshot-sync` holds that rendering against the migration the
 * database was actually built from, so editing it without regenerating a
 * migration fails CI.
 */
export const UPDATE_PLATFORMS = ['ios', 'android'] as const;

export const updateChannels = pgTable(
  'update_channels',
  {
    id: generatedId(),
    /** `CASCADE` — a channel of an application that no longer exists serves nothing. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Channel name (`production`, `preview`, a CI-created `pr-123`). */
    name: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A channel name is unique within an application, reusable across apps. This
    // is what makes `ensureChannel`'s upsert (`publish.service.ts:236`) a real
    // upsert. Mongo's standalone `{applicationId}` is dropped: a btree serves
    // any leading prefix, which also covers cascading an application delete.
    unique('update_channels_application_id_name_key').on(t.applicationId, t.name),
  ]
);
