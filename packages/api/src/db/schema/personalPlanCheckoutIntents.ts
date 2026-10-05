import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { createdAt } from '@oxy.so/db';
import { users } from './users';
/** Durable checkout reservation, never an entitlement or financial award. */
export const personalPlanCheckoutIntents = pgTable('personal_plan_checkout_intents', {
  id: text().primaryKey(), subjectAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  mode: text().notNull(), environment: text().notNull(), idempotencyHash: text().notNull(), requestHash: text().notNull(),
  offerId: text().notNull(), offerVersion: integer().notNull(), providerAccountRef: text().notNull(),
  priceId: text().notNull(), selection: jsonb().notNull(),
  state: text({ enum: ['reserved', 'pending', 'fulfilled', 'closed'] }).notNull(),
  closedReason: text(), providerSessionId: text(), checkoutUrl: text(), fulfilledSourceId: text(), createdAt: createdAt(),
}, t => [
  uniqueIndex('personal_checkout_request_key').on(t.subjectAccountId, t.mode, t.environment, t.idempotencyHash),
  uniqueIndex('personal_checkout_pending_subject').on(t.subjectAccountId, t.mode, t.environment).where(sql`${t.state} in ('reserved', 'pending')`),
  check('personal_checkout_namespace', sql`(${t.mode} = 'live' and ${t.environment} = 'production') or (${t.mode} = 'test' and ${t.environment} in ('test', 'staging', 'development'))`),
  check('personal_checkout_state', sql`${t.state} in ('reserved', 'pending', 'fulfilled', 'closed')`),
]);
