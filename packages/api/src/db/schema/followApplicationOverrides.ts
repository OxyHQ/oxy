/**
 * `follow_application_overrides` — "not here", without unfollowing.
 *
 * A user follows someone globally and wants them out of one application's feed:
 * disabled in Syra, still followed everywhere else. That is a private
 * consumption preference, so it lives beside the relationship rather than
 * inside it.
 *
 * ## Absence means inherit
 *
 * No row is the normal case, and it means the global relationship applies. A
 * row is only written when the user has said something specific about one
 * application, which keeps the table proportional to the exceptions rather than
 * to the follow graph — with a thousand applications and a million follows, a
 * row per pair would be a hundred billion rows describing a decision nobody
 * made.
 *
 * ## What it must never do
 *
 * Disabling here does not touch the global relationship, does not move follower
 * counts, and does not notify the followed target. The person on the other end
 * is not told which of someone's apps they appear in — that is the user's
 * business, and telling them would turn a private preference into a social
 * signal.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { followRelationships } from './followRelationships';

export const FOLLOW_OVERRIDE_MODES = ['enabled', 'disabled'] as const;

export type FollowOverrideMode = (typeof FOLLOW_OVERRIDE_MODES)[number];

export const followApplicationOverrides = pgTable(
  'follow_application_overrides',
  {
    id: generatedId(),
    /** `CASCADE` — an override for a relationship that is gone means nothing. */
    relationshipId: text()
      .notNull()
      .references(() => followRelationships.id, { onDelete: 'cascade' }),
    /**
     * `CASCADE` — an override naming a deleted application is unreadable, and
     * unlike the relationship's provenance it carries nothing the user would
     * miss: the relationship itself is untouched either way.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * `enabled` is not redundant with absence. Absence is "I never said", and
     * `enabled` is "I said yes here" — which matters if an application ever
     * defaults its own consumption to off, and which lets restoring inheritance
     * be a DELETE rather than a value nobody can tell from the default.
     */
    mode: text({ enum: FOLLOW_OVERRIDE_MODES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // `inherit` is deliberately NOT admissible. It is a real mode in the API
    // and the client, and it means having no row here at all — admitting it
    // would give one state two representations.
    check('follow_application_overrides_mode_check', sql`${t.mode} in ('enabled', 'disabled')`),
    unique('follow_application_overrides_relationship_application_key').on(
      t.relationshipId,
      t.applicationId
    ),
    // The read every feed does: "which of this user's follows are off in me".
    // Leading on the application because that is the constant in that query.
    index('follow_application_overrides_application_idx').on(t.applicationId, t.mode),
  ]
);
