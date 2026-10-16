/**
 * `application_agents` — which agents are an application's, and where they open
 * (ADR 0044).
 *
 * One row says that an agent's bot account belongs to an application and
 * whether it is available `anywhere` or only on that application's own surfaces
 * (`own_application`: a request whose verified app assertion, ADR 0045, names
 * it). An agent with no row is available anywhere.
 *
 * ## An agent is one application's
 *
 * `agent_account_id` is the PRIMARY KEY, so an agent has at most one row, and
 * therefore at most one application. That also makes `(application_id,
 * agent_account_id)` unique without a second index.
 *
 * ## Who writes it
 *
 * Only Oxy staff, through the application administration lane that governs an
 * application's scopes and capabilities (`routes/applications.ts`, behind
 * `requireStaff`), via `services/applicationAgents.service.ts`, which checks
 * that the bot is under an account the application's owner operates. No agent
 * owner, person or app writes it through any other route.
 *
 * ## `ON DELETE`
 *
 * - `application_id` CASCADE: applications are soft-deleted, so this fires only
 *   when the owning account is erased, which already cascades the application.
 * - `agent_account_id` CASCADE: the row describes the agent and means nothing
 *   without it.
 * - `created_by_user_id` SET NULL: attribution, which an erasure must not turn
 *   into the loss of the record it attributes.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import {
  APPLICATION_AGENT_AVAILABILITIES,
  type ApplicationAgentAvailability,
} from '@oxy.so/contracts';
import { createdAt, inList, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

export const applicationAgents = pgTable(
  'application_agents',
  {
    agentAccountId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    availability: text({ enum: APPLICATION_AGENT_AVAILABILITIES })
      .$type<ApplicationAgentAvailability>()
      .notNull(),
    /** The staff member who wrote the row. */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'application_agents_availability_check',
      sql`${t.availability} in (${sql.raw(inList(APPLICATION_AGENT_AVAILABILITIES))})`,
    ),
    index('application_agents_application_id_idx').on(t.applicationId),
  ],
);

export type ApplicationAgentRow = typeof applicationAgents.$inferSelect;
