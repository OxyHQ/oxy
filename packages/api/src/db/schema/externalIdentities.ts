import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxy.so/db';
import { users } from './users';

/** The source account is stable across federation transports. */
export const externalIdentities = pgTable('external_identities', {
  canonicalAcct: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  network: text().notNull(),
  stableId: text(),
  evidenceLinks: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [index('external_identities_user_id_idx').on(t.userId)]);

/** Actor URIs are never overwritten when another bridge discovers the account. */
export const externalIdentityActors = pgTable('external_identity_actors', {
  actorUri: text().primaryKey(),
  canonicalAcct: text().notNull().references(() => externalIdentities.canonicalAcct, { onDelete: 'cascade' }),
  transportAcct: text().notNull(),
  protocol: text().notNull(),
  evidenceLinks: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [index('external_identity_actors_canonical_acct_idx').on(t.canonicalAcct)]);

/** Keep old users and their foreign keys alive; resolve public reads through this map. */
export const canonicalUserRedirects = pgTable('canonical_user_redirects', {
  userId: text().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  canonicalUserId: text().notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: createdAt(),
}, t => [
  index('canonical_user_redirects_canonical_user_id_idx').on(t.canonicalUserId),
  check('canonical_user_redirects_not_self_check', sql`${t.userId} <> ${t.canonicalUserId}`),
]);

/** Source-authenticated claims remain auditable when a later refresh removes a link. */
export const externalIdentityClaims = pgTable('external_identity_claims', {
  actorUri: text().notNull().references(() => externalIdentityActors.actorUri, { onDelete: 'cascade' }),
  targetAcct: text().notNull(),
  sourceStableId: text(),
  targetStableId: text(),
  state: text({ enum: ['pending', 'linked', 'revoked'] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  primaryKey({ columns: [t.actorUri, t.targetAcct] }),
  check('external_identity_claims_state_check', sql`${t.state} in ('pending', 'linked', 'revoked')`),
]);
