/**
 * `device_principal_backfill_conflicts` — what the ADR 0001 backfill could not
 * map cleanly, recorded rather than dropped.
 *
 * The flat `device_session_accounts` row shape cannot express everything the
 * principal/context split needs, so a handful of legacy rows map by RULE rather
 * than by translation. ADR 0001 is explicit that those are "reported, never
 * dropped": a device keeps its signed-in state, and the compromise is written
 * down where somebody can act on it.
 *
 * ## Why a table and not a script, and not a log line
 *
 * A one-shot script cannot be atomic with the copy — the new tables become the
 * read authority the moment the new image starts, so a report produced at some
 * other time is describing different data — and a script that nobody remembers
 * to run reports nothing at all, indistinguishably from a clean backfill.
 * `RAISE NOTICE` is atomic but lands in a deploy log that ages out, and "did we
 * lose anything?" is a question asked weeks later.
 *
 * A row written by the same transaction as the copy is the only form where the
 * report and the thing it reports on cannot disagree, and it stays queryable.
 *
 * ## Lifecycle
 *
 * Written exactly once, by migration `0028`. Nothing reads or writes it at
 * runtime. It is deleted by the same clean cut that drops
 * `device_session_accounts`, once the flat contract has no consumers left.
 *
 * ## No surrogate id
 *
 * The primary key is the natural triple. A backfill is idempotent by
 * construction — `ON CONFLICT DO NOTHING` on re-run — and there is nothing a
 * generated id would identify that the triple does not. `link_previews` sets the
 * precedent that a table whose identity is intrinsic says so by having no
 * generator.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { inList, timestamptz } from '@oxyhq/db';

/**
 * The closed set of things the backfill can find. Declared once and used for
 * both the column type and the CHECK, so they cannot drift.
 *
 * - `authuser_collapsed` — two people claimed the same `authuser` on one device.
 *   The flat table never carried a `UNIQUE(device, authuser)`, so two concurrent
 *   adds could both allocate the same "lowest free" slot; here the slot must
 *   name exactly one person. The earlier arrival keeps it, the later is moved
 *   above every slot in use. Only the NUMBER changes, and it is display
 *   metadata.
 * - `principal_without_personal_context` — a person present on the device ONLY
 *   as somebody else's operator. Their slot is inherited from a delegated entry
 *   and they have no personal context, which ADR 0001 requires of a live
 *   principal. One is NOT invented for them: the flat table never said this
 *   person was signed in here as themselves, and a fabricated row would assert
 *   it.
 * - `active_account_without_context` — `device_sessions.active_account_id`
 *   names an account with no row in the device's set, so no context can be
 *   elected. `active_context_id` is left NULL, which is a first-class state
 *   ("signed in, nothing selected") and what `healActiveAccount` already
 *   re-elects from on the next read.
 * - `non_personal_principal` — a row with NO `operated_by_user_id` whose
 *   `account_id` is an organization/project/bot/channel. It maps to a principal
 *   that is not a person, which ADR 0001's central invariant forbids. It is
 *   copied faithfully anyway: dropping it would sign a real device out of a real
 *   account, and preserving the user's state beats preserving the invariant on
 *   data that predates it.
 * - `duplicate_principal_account` — the same `(principal, account)` pair arising
 *   twice with different sessions. Structurally impossible while
 *   `device_session_accounts_device_session_id_account_id_key` exists; checked
 *   because it costs one aggregate and because the constraint that makes it
 *   impossible is the thing being retired.
 * - `orphan_operator` — a delegated row whose operator is not a `users` row.
 *   Structurally impossible while
 *   `device_session_accounts_operated_by_user_id_users_id_fk` exists; checked
 *   for the same reason.
 */
export const DEVICE_PRINCIPAL_BACKFILL_CONFLICTS = [
  'authuser_collapsed',
  'principal_without_personal_context',
  'active_account_without_context',
  'non_personal_principal',
  'duplicate_principal_account',
  'orphan_operator',
] as const;

export type DevicePrincipalBackfillConflict =
  (typeof DEVICE_PRINCIPAL_BACKFILL_CONFLICTS)[number];

export const devicePrincipalBackfillConflicts = pgTable(
  'device_principal_backfill_conflicts',
  {
    /**
     * `device_sessions.device_id`, the central device id space — NOT the device
     * row's primary key and NOT a foreign key.
     *
     * A report about a device that has since been deleted still answers "did the
     * backfill lose anything?", which is the only question this table exists to
     * answer. A `CASCADE` would delete exactly the evidence, and a `RESTRICT`
     * would make a device undeletable because of a note about it.
     */
    deviceId: text().notNull(),
    conflict: text({ enum: DEVICE_PRINCIPAL_BACKFILL_CONFLICTS }).notNull(),
    /**
     * The account or user the conflict is about. Deliberately unconstrained for
     * the same reason as `device_id`: the report must outlive its subject.
     */
    subjectId: text().notNull(),
    /** One line, human-readable, naming what was kept and what was released. */
    detail: text().notNull(),
    recordedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'device_principal_backfill_conflicts_pkey',
      columns: [t.deviceId, t.conflict, t.subjectId],
    }),
    // Columns are INTERPOLATED and the value list goes through `sql.raw`: a
    // bound value would emit the placeholder `$1` into the migration and fail
    // at APPLY time.
    check(
      'device_principal_backfill_conflicts_conflict_check',
      sql`${t.conflict} in (${sql.raw(inList(DEVICE_PRINCIPAL_BACKFILL_CONFLICTS))})`
    ),
  ]
);
