/**
 * `identity_bindings` — proof that an Oxy identity was present in one
 * application, as one named local principal, at one instant.
 *
 * Ported from `models/IdentityBinding.ts`. It closes the hole the reputation
 * bridge exists around: an effect references a binding, and the engine checks
 * that the binding resolves to the claimed principal, belongs to the emitting
 * application, is not revoked, and was verified AT OR BEFORE the reported
 * action. A binding created after the fact proves nothing about who acted.
 *
 * NO PROOF MATERIAL IS STORED. A `session_proof` binding is made by verifying
 * the user's own access token and discarding it; what survives is that the check
 * passed, and when. There is no column here that could hold a credential.
 *
 * ## Why the unique index is PARTIAL
 *
 * One ACTIVE binding per `(application, local principal)`, so a local principal
 * can never resolve to two Oxy users at once. Rebinding REVOKES the old row and
 * inserts a new one, and the revoked row must survive: a past effect references
 * it, and its original `verified_at` is what made that effect legitimate. A
 * total unique index would force the rebind to overwrite history instead.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { IDENTITY_BINDING_STATUSES, IDENTITY_BINDING_TYPES } from '@oxyhq/contracts';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const identityBindings = pgTable(
  'identity_bindings',
  {
    id: generatedId(),
    /**
     * The application the binding is scoped to. Never cross-application.
     *
     * `CASCADE`, as the deferred-FK ledger decided before `applications`
     * landed: a binding proves nothing once its application is gone. Note
     * applications are SOFT-deleted (`status: 'deleted'`) on the normal path,
     * so this fires only on a hard delete.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The bound Oxy user. `CASCADE` — a binding to a deleted account binds nothing. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The application's own identifier for this person. */
    localPrincipalId: text().notNull(),
    bindingType: text({ enum: IDENTITY_BINDING_TYPES }).notNull(),
    status: text({ enum: IDENTITY_BINDING_STATUSES }).notNull().default('active'),
    /** When the proof was verified. Effects are only derived at or after this. */
    verifiedAt: timestamptz().notNull().defaultNow(),
    /**
     * The credential that presented the proof, for AUDIT only — deliberately not
     * part of the check, so a credential rotation cannot invalidate a binding
     * the user consented to. `SET NULL`, as the deferred-FK ledger decided
     * before `application_credentials` landed: NULL here already means "not
     * recorded", so losing the audit pointer costs the trail and nothing else,
     * where CASCADE would delete the evidence a past moderation effect rests on.
     */
    credentialId: text().references(() => applicationCredentials.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('identity_bindings_application_id_local_principal_id_active_key')
      .on(t.applicationId, t.localPrincipalId)
      .where(sql`${t.status} = 'active'`),
    // Resolving a subject's bindings within one application.
    index('identity_bindings_application_id_user_id_status_idx').on(
      t.applicationId,
      t.userId,
      t.status
    ),
    // "Every application this user is bound in" — the compound above leads with
    // `application_id` and cannot serve it.
    index('identity_bindings_user_id_idx').on(t.userId),
    // Mongo's field-level `{applicationId: 1}` and `{status: 1}` are dropped:
    // the compound already serves any leading `application_id` prefix, and a
    // standalone index over two status values can never beat a scan.
    check(
      'identity_bindings_binding_type_check',
      sql`${t.bindingType} in (${sql.raw(IDENTITY_BINDING_TYPES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'identity_bindings_status_check',
      sql`${t.status} in (${sql.raw(IDENTITY_BINDING_STATUSES.map((value) => `'${value}'`).join(', '))})`
    ),
    // A revoked binding must say when it was revoked, and an active one must
    // not claim to be. Mongo could express neither, so a row could read
    // `active` while carrying a `revokedAt` — and the engine's "is not revoked"
    // check reads `status`, so such a row would keep producing effects.
    check(
      'identity_bindings_revoked_at_check',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`
    ),
  ]
);
