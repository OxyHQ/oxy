/**
 * `device_account_contexts` — one principal acting as one account.
 *
 * The globally switchable unit, and the thing `contextId` names on the wire
 * (ADR 0002). A context is PERSONAL when `principal.user_id == account_id` and
 * DELEGATED otherwise; a delegated context requires a live `account:act_as`
 * membership, re-checked at activation and never assumed from the row existing.
 *
 * ## Why the pair, and not the account
 *
 * The same managed account is legitimately reachable through two different
 * people on one device. Those are different sessions, different permissions,
 * different audit actors and different revocation paths, so the unique is on the
 * TRIPLE — `(device, principal, account)` — where the flat table's
 * `UNIQUE(device, account)` made the second one unrepresentable.
 *
 * ## `session_id` is NULLABLE, and that is load-bearing
 *
 * A row exists for every account a principal MAY act as, so the switcher has a
 * stable id to activate. The delegated session is minted on first activation,
 * not eagerly for every organization the person belongs to. `session_id IS NULL`
 * therefore reads as "reachable, never yet used here" and is exactly what the
 * directory reports as `onDevice: false`.
 *
 * The compatibility projection (`DeviceSessionState.accounts[]`) omits such a
 * row entirely: its `sessionId` is a required string on that contract, and a
 * placeholder there would be a phantom account the mint path would then have to
 * defend against.
 *
 * ## `session_id` also carries no FOREIGN KEY, deliberately
 *
 * Identical reasoning to `device_session_accounts.session_id`, recorded in
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY`: it names a `sessions` row by its natural
 * key, the application never deletes a session (only the expiry sweep does), and
 * when one goes the context must SURVIVE so the mint path answers "dead session"
 * rather than the device's set silently shrinking behind the client's back — a
 * shrink that would also skip the `revision` bump every real membership change
 * makes. `CASCADE` would cause exactly that shrink; `RESTRICT` would stop the
 * sweep.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxyhq/db';
import { devicePrincipals } from './devicePrincipals';
import { deviceSessions } from './deviceSessions';
import { users } from './users';

export const deviceAccountContexts = pgTable(
  'device_account_contexts',
  {
    id: generatedId(),
    /**
     * `CASCADE` — a context of a device that no longer exists addresses nothing.
     *
     * Denormalized from `principal.device_session_id` so the device's whole
     * context set is one indexed read and so `device_sessions.active_context_id`
     * can be scoped without a join. The two cannot disagree in practice: every
     * write resolves the principal from the same device row it inserts against.
     */
    deviceSessionId: text()
      .notNull()
      .references(() => deviceSessions.id, { onDelete: 'cascade' }),
    /**
     * The person acting. `CASCADE` — removing a principal removes exactly its
     * own contexts and nobody else's, including when another principal can
     * independently operate the same account (ADR 0001).
     */
    principalId: text()
      .notNull()
      .references(() => devicePrincipals.id, { onDelete: 'cascade' }),
    /**
     * The subject being acted as: the principal's own account for a personal
     * context, an organization/project/bot/channel for a delegated one.
     *
     * `CASCADE` — deleting an account removes every context pointing at it,
     * under any principal, on every device at once.
     */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `sessions.session_id`, or NULL for "reachable, never yet used here". */
    sessionId: text(),
    addedAt: timestamptz().notNull().defaultNow(),
    lastUsedAt: timestamptz(),
    /** Set when the context is removed but kept for audit. See `device_principals`. */
    revokedAt: timestamptz(),
  },
  (t) => [
    // The unique is on the PAIR within a device. Named short deliberately:
    // spelling all three columns out exceeds Postgres' 63-character identifier
    // limit and would be silently truncated to something nobody can grep for.
    unique('device_account_contexts_device_principal_account_key').on(
      t.deviceSessionId,
      t.principalId,
      t.accountId
    ),
    // "Every device/principal this account is reachable through" — the read
    // an account deletion and an `account:act_as` revocation both run.
    index('device_account_contexts_account_id_idx').on(t.accountId),
    // "This person's contexts" — the switcher's own read, and the one
    // "remove this principal" walks.
    index('device_account_contexts_principal_id_idx').on(t.principalId),
  ]
);
