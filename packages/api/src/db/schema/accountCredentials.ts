/**
 * `account_credentials` — a service credential owned by an ACCOUNT rather than
 * an application.
 *
 * Ported from `models/AccountCredential.ts`. A `bot`-kind account is a
 * programmatic principal that authenticates AS ITSELF, so the only valid type is
 * `service` — there is no `public`/`confidential` OAuth client here, which is
 * what distinguishes this table from `application_credentials` rather than
 * making it a copy of it. The rotation-grace semantics are shared
 * (`utils/credentialUsability.ts`), so `expires_at` is NOT a TTL here either:
 * the deprecated row is the audit trail and must outlive its own deadline.
 *
 * The two tables are deliberately NOT merged behind one nullable-owner table: a
 * credential belongs to exactly one of an application or an account, and a
 * single table would have to express that with a CHECK plus two nullable foreign
 * keys, trading a real NOT NULL constraint for a weaker one.
 */

import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { APPLICATION_SCOPES } from '../../utils/applicationScopes';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * The only credential type an account may hold. A one-value set still gets a
 * CHECK: it is what stops `confidential` — meaningful on the sibling table —
 * from being written here by a backfill or a `psql` session.
 *
 * This tuple is the SINGLE declaration — the Mongoose model that carried the
 * other copy is gone. It renders the CHECK below, and
 * `check-drizzle-snapshot-sync` holds that rendering against the migration the
 * database was actually built from, so editing it without regenerating a
 * migration fails CI.
 */
export const ACCOUNT_CREDENTIAL_TYPES = ['service'] as const;

/** Which deployment the credential is issued for. */
export const ACCOUNT_CREDENTIAL_ENVIRONMENTS = ['development', 'staging', 'production'] as const;

/** Lifecycle. `deprecated` is the 7-day rotation grace; `revoked` is immediate. */
export const ACCOUNT_CREDENTIAL_STATUSES = ['active', 'deprecated', 'revoked'] as const;

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const accountCredentials = pgTable(
  'account_credentials',
  {
    id: generatedId(),
    /** `CASCADE` — a credential of a deleted account must not authenticate. */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Public identifier (`oxy_dk_…`). Case-SENSITIVE — the suffix is base64url. */
    publicKey: text().notNull(),
    /** SHA-256 of the raw secret, returned to the caller exactly once. */
    secretHash: text(),
    type: text({ enum: ACCOUNT_CREDENTIAL_TYPES }).notNull().default('service'),
    environment: text({ enum: ACCOUNT_CREDENTIAL_ENVIRONMENTS }).notNull(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text({ enum: ACCOUNT_CREDENTIAL_STATUSES }).notNull().default('active'),
    lastUsedAt: timestamptz(),
    /** End of the rotation grace window. NOT a TTL — see the header. */
    expiresAt: timestamptz(),
    /**
     * The credential this one superseded at rotation — a SELF reference,
     * declared at table level with an explicit name (below) because drizzle's
     * derived name for it is 72 characters and Postgres silently truncates an
     * identifier at 63.
     */
    rotatedFromCredentialId: text(),
    /** Attribution, not ownership — see `applications.created_by_user_id`. */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The self-reference from the rotation chain — see the column.
    foreignKey({
      columns: [t.rotatedFromCredentialId],
      foreignColumns: [t.id],
      name: 'account_credentials_rotated_from_fk',
    }).onDelete('set null'),
    unique('account_credentials_public_key_key').on(t.publicKey),
    // "This account's credentials, live ones first". Mongo's standalone
    // `{accountId}` is dropped — a btree serves any leading prefix.
    index('account_credentials_account_id_status_idx').on(t.accountId, t.status),
    check(
      'account_credentials_type_check',
      sql`${t.type} in (${sql.raw(inList(ACCOUNT_CREDENTIAL_TYPES))})`
    ),
    check(
      'account_credentials_environment_check',
      sql`${t.environment} in (${sql.raw(inList(ACCOUNT_CREDENTIAL_ENVIRONMENTS))})`
    ),
    check(
      'account_credentials_status_check',
      sql`${t.status} in (${sql.raw(inList(ACCOUNT_CREDENTIAL_STATUSES))})`
    ),
    check(
      'account_credentials_scopes_check',
      sql`${t.scopes} <@ ${sql.raw(textArrayLiteral(APPLICATION_SCOPES))}`
    ),
    check(
      'account_credentials_rotated_from_not_self_check',
      sql`${t.rotatedFromCredentialId} <> ${t.id}`
    ),
  ]
);
