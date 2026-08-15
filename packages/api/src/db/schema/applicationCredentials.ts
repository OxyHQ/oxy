/**
 * `application_credentials` — an application's OAuth client / service credential.
 *
 * Ported from `models/ApplicationCredential.ts`. `public_key` IS the OAuth
 * `client_id`; `secret_hash` is the SHA-256 of a secret returned to the caller
 * exactly once at creation or rotation and never re-derivable.
 *
 * ## `expires_at` is NOT a TTL
 *
 * Rotation sets the superseded credential to `deprecated` with
 * `expires_at = now + 7 days` (`CREDENTIAL_ROTATION_GRACE_MS`), and
 * `isCredentialUsable()` (`utils/credentialUsability.ts`) accepts `active` OR
 * `deprecated`-within-grace. The row must OUTLIVE that deadline — it is the
 * audit trail linking a rotated secret to the one it replaced — so this table
 * deliberately has NO entry in `db/expiry.ts`. Mongo declared no TTL index here
 * either; the resemblance to one is the trap.
 */

import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { APPLICATION_SCOPES } from '../../utils/applicationScopes';
import { applications } from './applications';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * OAuth client type. `service` credentials mint service tokens; `public` clients
 * hold no secret at all.
 *
 * This tuple is the SINGLE declaration — the Mongoose model that carried the
 * other copy is gone. It renders the CHECK below, and
 * `check-drizzle-snapshot-sync` holds that rendering against the migration the
 * database was actually built from, so editing it without regenerating a
 * migration fails CI.
 */
export const APPLICATION_CREDENTIAL_TYPES = ['public', 'confidential', 'service'] as const;

/** Which deployment the credential is issued for. */
export const APPLICATION_CREDENTIAL_ENVIRONMENTS = [
  'development',
  'staging',
  'production',
] as const;

/** Lifecycle. `deprecated` is the 7-day rotation grace; `revoked` is immediate. */
export const APPLICATION_CREDENTIAL_STATUSES = ['active', 'deprecated', 'revoked'] as const;

export type ApplicationCredentialStatus = (typeof APPLICATION_CREDENTIAL_STATUSES)[number];

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const applicationCredentials = pgTable(
  'application_credentials',
  {
    id: generatedId(),
    /** `CASCADE` — a credential of an application that no longer exists must not authenticate. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /**
     * Public identifier (`oxy_dk_…`), doubling as the OAuth `client_id`.
     *
     * PUBLIC, and it must never become a credential (issue #972, workstream
     * 2.1). It ships inside mobile and browser bundles and `GET
     * /auth/oauth/client/:clientId` serves it unauthenticated, so anyone who
     * has used the application has a copy — a lane that accepted it as proof
     * would be authenticating the whole world. Identification only; the
     * `secretHash` below, or a token minted from it, is what proves anything.
     * Held by `routes/__tests__/publicIdentifierNotASecret.test.ts` and
     * `middleware/__tests__/publicIdentifierNotABearer.test.ts`.
     *
     * Unique CASE-SENSITIVELY, unlike the identifier indexes on `users`: the
     * suffix is base64url, where case is significant, so `lower()` here would
     * reject two legitimately distinct client ids as duplicates.
     */
    publicKey: text().notNull(),
    /** SHA-256 of the raw secret. Absent for a `public` client, which has none. */
    secretHash: text(),
    type: text({ enum: APPLICATION_CREDENTIAL_TYPES }).notNull(),
    environment: text({ enum: APPLICATION_CREDENTIAL_ENVIRONMENTS }).notNull(),
    /**
     * Scopes this credential may request. The service-token mint intersects
     * these with the owning application's scopes (`intersectScopes`), so a
     * credential can never exceed its app's authority.
     */
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text({ enum: APPLICATION_CREDENTIAL_STATUSES }).notNull().default('active'),
    lastUsedAt: timestamptz(),
    /** End of the rotation grace window. NOT a TTL — see the header. */
    expiresAt: timestamptz(),
    /**
     * The credential this one superseded at rotation — a SELF reference, and the
     * audit trail linking a new secret back to the old one.
     *
     * `SET NULL`: NULL already means "not minted by a rotation", and losing the
     * audit hop is strictly better than `CASCADE` deleting a live credential
     * because its long-dead predecessor was purged.
     *
     * The constraint is declared at table level with an explicit name (below)
     * rather than inline: drizzle's derived name for a self-reference here is 79
     * characters and Postgres silently TRUNCATES an identifier at 63, so the
     * name in this file would not be the name in the catalogue.
     */
    rotatedFromCredentialId: text(),
    /**
     * Attribution, not ownership — the application owns the credential. Nullable
     * with `SET NULL` for the same reason as `applications.created_by_user_id`:
     * Mongo's `required` only ever guaranteed a creator was recorded at INSERT,
     * and a deleted user left a dangling id with no error.
     */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The self-reference from the rotation chain — see the column.
    foreignKey({
      columns: [t.rotatedFromCredentialId],
      foreignColumns: [t.id],
      name: 'application_credentials_rotated_from_fk',
    }).onDelete('set null'),
    unique('application_credentials_public_key_key').on(t.publicKey),
    // "This app's credentials, live ones first" — the Console credentials tab
    // and every `clientId` → application resolution. Mongo's standalone
    // `{applicationId}` is dropped: a btree serves any leading prefix.
    index('application_credentials_application_id_status_idx').on(t.applicationId, t.status),
    check(
      'application_credentials_type_check',
      sql`${t.type} in (${sql.raw(inList(APPLICATION_CREDENTIAL_TYPES))})`
    ),
    check(
      'application_credentials_environment_check',
      sql`${t.environment} in (${sql.raw(inList(APPLICATION_CREDENTIAL_ENVIRONMENTS))})`
    ),
    check(
      'application_credentials_status_check',
      sql`${t.status} in (${sql.raw(inList(APPLICATION_CREDENTIAL_STATUSES))})`
    ),
    check(
      'application_credentials_scopes_check',
      sql`${t.scopes} <@ ${sql.raw(textArrayLiteral(APPLICATION_SCOPES))}`
    ),
    // A credential cannot be its own predecessor. The one-hop case of "a
    // rotation chain is acyclic", and the shape a bad write actually produces.
    check(
      'application_credentials_rotated_from_not_self_check',
      sql`${t.rotatedFromCredentialId} <> ${t.id}`
    ),
  ]
);
