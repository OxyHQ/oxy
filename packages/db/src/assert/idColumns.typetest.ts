/**
 * Compile-time-only regression check that `DeferredForeignKey.onDelete`
 * accepts every value drizzle's own `UpdateDeleteAction` permits —
 * in particular `'set default'`, which the narrower 4-value union this
 * field used before the fix (import it from `drizzle-orm/pg-core` instead
 * of hand-rolling the union) would have rejected as a type error. See
 * `database.typetest.ts` for why this file is `.typetest.ts`.
 */

import { pgTable, text } from 'drizzle-orm/pg-core';
import type { DeferredForeignKey } from './idColumns';

const posts = pgTable('posts', { id: text().primaryKey(), authorId: text() });

const _acceptsSetDefault: DeferredForeignKey = {
  table: posts,
  column: posts.authorId,
  parentTable: 'users',
  parentColumn: 'id',
  onDelete: 'set default',
  reason: 'compile-time proof that the widened union accepts this value',
};
void _acceptsSetDefault;
