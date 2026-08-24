/**
 * `service_acting_as_revocations` — a user's standing refusal to let one
 * application act as them from its own backend.
 *
 * ## Why a marker table, when `app_grants` already exists
 *
 * Because for the applications that matter here there IS no `app_grants` row,
 * and there is not supposed to be one.
 *
 * A first-party Oxy application acting for a user is automatic: the platform
 * does not ask a user to authorize one Oxy app to act for them in another. That
 * is the same stance `app_grants` already takes — trusted applications are
 * auto-approved on the consent path and deliberately record no grant. So for
 * exactly the applications that can reach offline delegation, the grant table is
 * empty by design, and "delete the row" is not a revocation anyone can perform.
 *
 * Absence therefore cannot carry the answer in either direction:
 *
 *   - absence CANNOT mean revoked — a user who never connected anything has no
 *     row, and would be refusing an app they have never heard of;
 *   - absence CANNOT mean authorized on its own — that is what the trusted +
 *     active check decides, and it is checked separately.
 *
 * A revocation needs its own positive, persisted fact. This table is that fact
 * and nothing else: a row here means "no", and no row here means "ask the rest
 * of the rules".
 *
 * ## This does not reintroduce a second revocation surface
 *
 * The rule that kept delegation out of a second GRANT table still holds, and
 * this is its mirror rather than its exception. A second place to say YES is
 * dangerous: revoking in one leaves the other authorising. A second place to say
 * NO can only ever subtract authority, so the failure mode of forgetting to
 * consult it is caught by the guard that consults it, and the failure mode of
 * writing to it by mistake is a refusal.
 *
 * It also stays ONE user-facing action. `DELETE /auth/grants/:applicationId` is
 * still the only button: it deletes the grant row if there is one AND writes the
 * marker, so the same click revokes an OAuth grant and an automatic first-party
 * delegation without the user having to know which they had.
 *
 * ## Undoing it takes a real decision, not an auto-approval
 *
 * The marker is cleared by `recordAppGrant` only when the granted scopes name
 * `acting-as:offline`, and that scope is in `USER_CONSENT_REQUIRED_SCOPES` — so
 * a request carrying it ALWAYS reaches the consent screen, for a trusted
 * application exactly as for a third-party one. Reaching the authorize endpoint
 * with that scope therefore means a person read the screen and approved.
 *
 * The alternative — clearing on any successful authorize — would have made the
 * revocation worthless: a first-party app is auto-approved, so it would silently
 * undo a deliberate refusal on its very next sign-in.
 *
 * ## What this table is NOT
 *
 * Not an audit log. One row per (user, application), upserted, holding the
 * latest refusal. If a history of revocations is ever wanted, it belongs
 * somewhere append-only, not here — a marker that grows a second meaning stops
 * answering the first one cleanly.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { applications } from './applications';
import { users } from './users';

export const serviceActingAsRevocations = pgTable(
  'service_acting_as_revocations',
  {
    id: generatedId(),
    /** `CASCADE` — a deleted user's refusals protect nobody. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * `CASCADE` — an application that no longer exists cannot act, so its
     * marker has nothing left to refuse. Note this differs from a SUSPENSION,
     * which must NOT clear the marker: a suspended app can be restored, and a
     * restore must not resurrect an authority the user took away.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** When the user last refused. Refreshed on re-revoke; never cleared in place. */
    revokedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One marker per (user, application). The revoke path upserts against this,
    // so revoking twice refreshes the timestamp rather than accumulating rows —
    // and the verify path's existence check cannot be defeated by a duplicate.
    unique('service_acting_as_revocations_user_id_application_id_key').on(
      t.userId,
      t.applicationId
    ),
    // The reverse direction the unique above cannot serve, and the index
    // Postgres needs to cascade an application delete without a table scan.
    index('service_acting_as_revocations_application_id_idx').on(t.applicationId),
  ]
);
