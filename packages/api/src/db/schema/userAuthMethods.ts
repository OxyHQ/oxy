/**
 * `user_auth_methods` — one way an account can prove it is itself.
 *
 * Ported from the `authMethods` array embedded in `models/User.ts`. An account
 * may link an identity key and/or one or more passkeys; this table is the single
 * source the DID document's `verificationMethod[]` is built from
 * (`did.service.ts`), so it is a real relation rather than an opaque array.
 *
 * `metadata.*` flattens to columns: the shape is known and closed (four fields,
 * each meaningful to exactly one `type`), which is the opposite of the
 * shape-less data `jsonb` is for.
 *
 * No ordinal column. Mongo's array had a position, but nothing read it — the
 * meaningful order is `linked_at`, and the two identifiers (`public_key`,
 * `credential_id`) address a row directly.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

/** The kinds of proof an account can carry. */
export const AUTH_METHOD_TYPES = ['identity', 'webauthn'] as const;

export const userAuthMethods = pgTable(
  'user_auth_methods',
  {
    id: generatedId(),
    /** `CASCADE` — a proof of an account that no longer exists proves nothing. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text({ enum: AUTH_METHOD_TYPES }).notNull(),
    /**
     * When the method was linked. `NOT NULL`: Mongoose defaulted it to
     * `Date.now`, so every row has one, and the DID document reports it.
     */
    linkedAt: timestamptz().notNull().defaultNow(),

    // ---- metadata (flattened; each field belongs to one `type`) -----------
    /** `type = 'identity'` — the secp256k1 public key, lowercase hex. */
    methodPublicKey: text(),
    /** Contact email captured at link time. Advisory only; never an identifier. */
    methodEmail: text(),
    /** `type = 'webauthn'` — the base64url credential handle. */
    methodCredentialId: text(),
    /** `type = 'webauthn'` — the user-facing label for the passkey. */
    methodName: text(),

    createdAt: createdAt(),
  },
  (t) => [
    index('user_auth_methods_user_id_idx').on(t.userId),
    // Not an index for a query — today every signer lookup goes through
    // `users.public_key`. It is a CONSTRAINT: one identity key may authenticate
    // exactly one account. Mongo enforced that on `User.publicKey` and not at
    // all on this array, so a key could be linked to a second account with no
    // error. Case-insensitive because keys are stored lower-cased and a re-cased
    // duplicate must not slip past.
    uniqueIndex('user_auth_methods_lower_method_public_key_key')
      .on(sql`lower(${t.methodPublicKey})`)
      .where(sql`${t.methodPublicKey} is not null`),
    uniqueIndex('user_auth_methods_method_credential_id_key')
      .on(t.methodCredentialId)
      .where(sql`${t.methodCredentialId} is not null`),
    check(
      'user_auth_methods_type_check',
      sql`${t.type} in (${sql.raw(AUTH_METHOD_TYPES.map((value) => `'${value}'`).join(', '))})`
    ),
    // A method must carry the identifier its own type is addressed by, or it can
    // never be matched to an assertion. Mongo allowed a row with neither.
    check(
      'user_auth_methods_identifier_check',
      sql`(${t.type} = 'identity' and ${t.methodPublicKey} is not null) or (${t.type} = 'webauthn' and ${t.methodCredentialId} is not null)`
    ),
  ]
);
