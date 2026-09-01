/**
 * `update_channel_rollbacks` — one active `rollBackToEmbedded` directive.
 *
 * Ported from the `rollbacksToEmbedded` array embedded in
 * `models/UpdateChannel.ts`. When an entry matches a requesting client's
 * `(runtime_version, platform)` the manifest endpoint serves a signed
 * `rollBackToEmbedded` directive instead of an update, telling the client to
 * fall back to the bundle embedded in its binary. Nothing is deleted to roll
 * back — the directive is additive, and a fresh publish clears it.
 *
 * ## Why a child table and not `jsonb`
 *
 * The array is ADDRESSED BY INNER FIELD, which is the line `CONVENTIONS.md`
 * draws: `jsonb` is for genuinely shape-less data. Every write matches on
 * `(runtimeVersion, platform)` —
 * `$pull: { rollbacksToEmbedded: { runtimeVersion, platform } }` at
 * `publish.service.ts:242` and `:399`, followed by a `$push` at `:404` — and the
 * read scans for the same pair (`manifest.service.ts:117`). The shape is closed:
 * three fields, all required, one of them a two-value enum.
 *
 * The natural key `(channel_id, runtime_version, platform)` is therefore the
 * PRIMARY KEY, and that is a FIX, not just a translation. Mongo's pull-then-push
 * is a two-statement upsert with a crash window in the middle — an interruption
 * silently leaves the directive DELETED, and two concurrent rollbacks can leave
 * two entries for the same tuple, which `manifest.service.ts`'s `.find()` then
 * resolves arbitrarily. As a real row, "at most one active directive per
 * (channel, runtime, platform)" is enforced by the database and the write is one
 * idempotent statement.
 *
 * No surrogate id and no `created_at`: nothing references a directive by id, and
 * `commit_time` is set to `now()` at write time, so a birth column would record
 * the same instant twice.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { timestamptz } from '@oxyhq/db';
import { UPDATE_PLATFORMS, updateChannels } from './updateChannels';

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const updateChannelRollbacks = pgTable(
  'update_channel_rollbacks',
  {
    /** `CASCADE` — a directive for a channel that no longer exists serves nothing. */
    channelId: text()
      .notNull()
      .references(() => updateChannels.id, { onDelete: 'cascade' }),
    runtimeVersion: text().notNull(),
    platform: text({ enum: UPDATE_PLATFORMS }).notNull(),
    /**
     * The directive's `commitTime`. A client rolls back only when the update it
     * is currently running was created BEFORE this instant, so the value is part
     * of the served manifest and not merely bookkeeping.
     */
    commitTime: timestamptz().notNull(),
  },
  (t) => [
    // At most one active directive per (channel, runtime, platform) — the
    // guarantee the Mongo array could not make. See the header.
    primaryKey({
      columns: [t.channelId, t.runtimeVersion, t.platform],
      name: 'update_channel_rollbacks_pkey',
    }),
    check(
      'update_channel_rollbacks_platform_check',
      sql`${t.platform} in (${sql.raw(inList(UPDATE_PLATFORMS))})`
    ),
  ]
);
