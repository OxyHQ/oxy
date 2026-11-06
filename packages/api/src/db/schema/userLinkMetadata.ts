/**
 * `user_link_metadata` — one profile link, held as a reference to its Clarity
 * document.
 *
 * Clarity holds the URL and everything Clarity knows about the page (title,
 * description, image, favicon). This row keeps only the document id, the
 * owner's own title and the link's position in the profile.
 *
 * The URL, description and image columns predate that and are still present
 * while existing links are migrated to Clarity documents: the backfill resolves
 * each URL, writes `clarity_document_id`, and only then does a follow-up
 * migration drop the URL columns and make the id required.
 *
 * `position` preserves the order the owner chose, which is visible on the profile.
 */

import { pgTable, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const userLinkMetadata = pgTable(
  'user_link_metadata',
  {
    id: generatedId(),
    /** `CASCADE` — a link preview outlives nothing. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Zero-based position in the profile's link list. */
    position: integer().notNull(),
    /** The Clarity document this link points at. Null only on a row not yet migrated. */
    clarityDocumentId: text(),
    /** The owner's own title for the link, if they set one. */
    title: text(),
    /** Legacy, removed by the migration that follows the Clarity backfill. */
    url: text(),
    /** Legacy, removed by the migration that follows the Clarity backfill. */
    description: text(),
    /** Legacy, removed by the migration that follows the Clarity backfill. */
    image: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Leads with `user_id`, so it answers the only read there is ("this profile's
  // link previews, in order") and simultaneously makes two rows claiming one
  // position impossible.
  (t) => [uniqueIndex('user_link_metadata_user_id_position_key').on(t.userId, t.position)],
);
