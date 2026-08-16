/**
 * `internal_cost_centers` — which Oxy accounts first-party spend is booked to.
 *
 * ## A cost centre IS an account, not a parallel hierarchy
 *
 * #972's non-negotiable invariant is that there is exactly one account /
 * organization / project hierarchy. `users.kind` already has `project`, and
 * `applications.owner_account_id` already points at one, so "Alia production
 * chat" is a project account like any other and the settled receipts of its
 * applications are already attributed to it by the ledger.
 *
 * What was missing is only a LABEL and a stable name: a report that says
 * "codea spent $412 last month" needs a slug it can be addressed by, and a
 * human-readable title, without either becoming a second parent link that can
 * disagree with the account graph. Hence one row per account, primary-keyed on
 * the account, with no `parent_id`.
 *
 * Attribution therefore needs no column on any receipt. `resolveCostCenter`
 * walks the existing materialised `user_ancestors` path from an application's
 * owner account to the NEAREST account carrying one of these rows — the same
 * walk billing inheritance and permission inheritance already use, so all three
 * read one tree.
 *
 * ## The rows are not seeded here
 *
 * #972 workstream 14 asks for cost centres for Alia production chat, Codea,
 * research, voice and evaluations. Those are real project accounts under the Oxy
 * organization and creating them is an account-graph operation, not a schema
 * one. This table and `POST /billing/cost-centers` are what that work registers
 * INTO; as of this commit the table is empty, and that is a stated gap rather
 * than something to assume was filled elsewhere.
 *
 * ## `retired`, never deleted
 *
 * A cost centre that stops being used still names the account past spend was
 * booked to, and a historical report has to keep resolving it. `status` is what
 * takes it out of the picker; a DELETE would make last quarter's report
 * unreadable.
 *
 * ## `ON DELETE RESTRICT`
 *
 * Consistent with the rest of the billing family. A cost centre exists because
 * money was spent under it, and the account it names cannot quietly vanish from
 * under the reports.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, inList, updatedAt } from '@oxyhq/db';
import { COST_CENTER_STATUSES } from '@oxyhq/contracts';
import { users } from './users';

/** Taken from the wire contract so column and schema cannot drift. */
export const COST_CENTER_STATUS_VALUES = COST_CENTER_STATUSES;

export type CostCenterStatusValue = (typeof COST_CENTER_STATUS_VALUES)[number];

export const internalCostCenters = pgTable(
  'internal_cost_centers',
  {
    /**
     * The account that IS the cost centre. Primary key AND foreign key, with no
     * generator — the same shape `user_credits` takes, and for the same reason:
     * the identity comes from somewhere else, and a table whose id is supplied
     * says so by having no default.
     */
    accountId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** How a report addresses it: `alia-production-chat`, `codea`, `voice`. */
    slug: text().notNull(),
    label: text().notNull(),
    status: text({ enum: COST_CENTER_STATUS_VALUES }).notNull().default('active'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A slug addresses exactly one cost centre, retired ones included: reusing a
    // retired slug for a different account would silently re-attribute every
    // historical report that names it.
    unique('internal_cost_centers_slug_key').on(t.slug),
    // The picker: active centres only.
    index('internal_cost_centers_status_idx').on(t.status),

    check(
      'internal_cost_centers_status_check',
      sql`${t.status} in (${sql.raw(inList(COST_CENTER_STATUS_VALUES))})`
    ),
    // The same grammar `costCenterSchema` declares on the wire, so a slug cannot
    // be storable and unserialisable.
    check('internal_cost_centers_slug_check', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
    check(
      'internal_cost_centers_label_check',
      sql`length(${t.label}) between 1 and 120`
    ),
  ]
);

export type InternalCostCenterRow = typeof internalCostCenters.$inferSelect;
