/** Operator control-plane metadata; no tenant content or extra authorization lane. */
import { sql } from 'drizzle-orm';
import { pgTable, text, uuid, check } from 'drizzle-orm/pg-core';
import { createdAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';
import { APPLICATION_CREDENTIAL_ENVIRONMENTS } from './applicationCredentials';

export const managedApplicationDeployments = pgTable(
  'managed_application_deployments',
  {
    deploymentId: uuid().primaryKey(),
    applicationId: text()
      .notNull()
      .unique()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Immutable declaration detects drift rather than silently rebinding a deployment. */
    ownerAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    origin: text().notNull().unique(),
    environment: text({ enum: APPLICATION_CREDENTIAL_ENVIRONMENTS }).notNull(),
    backendRoleArn: text().notNull(),
    workerRoleArn: text().notNull(),
    mcpRoleArn: text().notNull(),
    /** Public OxyProvider identifier, never a service credential or secret. */
    publicClientId: text().notNull().unique(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'managed_application_deployments_environment_check',
      sql`${table.environment} in (${sql.raw(APPLICATION_CREDENTIAL_ENVIRONMENTS.map((value) => `'${value}'`).join(', '))})`,
    ),
    check(
      'managed_application_deployments_distinct_roles_check',
      sql`${table.backendRoleArn} <> ${table.workerRoleArn} and ${table.backendRoleArn} <> ${table.mcpRoleArn} and ${table.workerRoleArn} <> ${table.mcpRoleArn}`,
    ),
  ],
);
