/**
 * `blocks` — user A has blocked user B.
 *
 * Ported from `models/Block.ts`.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxy.so/db';
import { users } from './users';

export const blocks = pgTable(
  'blocks',
  {
    id: generatedId(),
    /** The user who blocked. A deleted account cannot be blocking anyone. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The user who was blocked. A block on a deleted account enforces nothing. */
    blockedId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('blocks_user_id_blocked_id_key').on(t.userId, t.blockedId),
    // The REVERSE lookup ("who has blocked me") — `graphExclusion.ts:47` and
    // `user.service.ts:1661` both run it. The compound index above cannot serve
    // it (wrong leading field), so it needs its own.
    index('blocks_blocked_id_idx').on(t.blockedId),
  ],
);
