import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { externalIdentityActors } from './externalIdentities';

/** Minimal first-party account proof, never HTML or browser/session metadata. */
export const externalIdentityMetaProofs = pgTable('external_identity_meta_proofs', {
  instagramActorUri: text().notNull().references(() => externalIdentityActors.actorUri, { onDelete: 'cascade' }),
  threadsActorUri: text().notNull().references(() => externalIdentityActors.actorUri, { onDelete: 'cascade' }),
  instagramAcct: text().notNull(),
  threadsAcct: text().notNull(),
  instagramPk: text().notNull(),
  instagramGraphId: text().notNull(),
  threadsWebPk: text().notNull(),
  instagramProfileUrl: text().notNull(),
  threadsProfileUrl: text().notNull(),
  policyVersion: text().notNull(),
  instagramDocumentHash: text().notNull(),
  threadsDocumentHash: text().notNull(),
  evidenceDigest: text().notNull(),
  state: text({ enum: ['verified', 'pending', 'revoked'] }).notNull().default('pending'),
  method: text().notNull().default('meta-public-profile-v1'),
  verifiedAt: timestamp({ withTimezone: true }).notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  revokedAt: timestamp({ withTimezone: true }),
  revocationReason: text(),
}, table => [
  primaryKey({ columns: [table.instagramActorUri, table.threadsActorUri] }),
  index('external_identity_meta_proofs_instagram_acct_idx').on(table.instagramAcct),
  index('external_identity_meta_proofs_threads_acct_idx').on(table.threadsAcct),
  check('external_identity_meta_proofs_state_check', sql`${table.state} in ('verified', 'pending', 'revoked')`),
  check('external_identity_meta_proofs_method_check', sql`${table.method} = 'meta-public-profile-v1'`),
  check('external_identity_meta_proofs_bounds_check', sql`length(${table.instagramActorUri}) <= 2048 and length(${table.threadsActorUri}) <= 2048
    and length(${table.instagramAcct}) <= 320 and length(${table.threadsAcct}) <= 320
    and ${table.instagramPk} ~ '^[0-9]{1,32}$' and ${table.instagramGraphId} ~ '^[0-9]{1,32}$' and ${table.threadsWebPk} ~ '^[0-9]{1,32}$'
    and length(${table.instagramProfileUrl}) <= 2048 and length(${table.threadsProfileUrl}) <= 2048
    and ${table.policyVersion} = 'meta-profile-badges-2026-09-13-v1'
    and ${table.instagramDocumentHash} ~ '^[a-f0-9]{64}$' and ${table.threadsDocumentHash} ~ '^[a-f0-9]{64}$'
    and ${table.evidenceDigest} ~ '^[a-f0-9]{64}$' and length(${table.revocationReason}) <= 80
    and ${table.expiresAt} > ${table.verifiedAt} and ${table.expiresAt} <= ${table.verifiedAt} + interval '24 hours'`),
]);
