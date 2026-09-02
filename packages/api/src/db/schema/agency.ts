import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  AUTONOMY_LEVELS,
  CAPABILITY_PACKAGES,
  type AppCapabilityCatalog,
  type AuditEvent,
  type AutonomyLevel,
  type CapabilityPackage,
  type GrantLimit,
} from '@oxyhq/contracts';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { users } from './users';

export const delegationGrants = pgTable(
  'delegation_grants',
  {
    id: generatedId(),
    ownerAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    actorAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    resourceApp: text().notNull(),
    effectiveAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    resourceType: text().notNull(),
    resourceKey: text().notNull(),
    capabilityPackages: text({ enum: CAPABILITY_PACKAGES })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    maximumAutonomy: text({ enum: AUTONOMY_LEVELS }).$type<AutonomyLevel>().notNull(),
    canRedelegate: boolean().notNull().default(false),
    expiresAt: timestamptz(),
    revokedAt: timestamptz(),
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('delegation_grants_autonomy_check', sql`${t.maximumAutonomy} in (${sql.raw(inList(AUTONOMY_LEVELS))})`),
    check('delegation_grants_packages_check', sql`${t.capabilityPackages} <@ array[${sql.raw(inList(CAPABILITY_PACKAGES))}]::text[]`),
    index('delegation_grants_actor_resource_idx').on(
      t.ownerAccountId,
      t.actorAccountId,
      t.resourceApp,
      t.effectiveAccountId,
      t.resourceType,
      t.resourceKey,
    ),
    index('delegation_grants_expiry_idx').on(t.expiresAt),
    index('delegation_grants_revoked_at_idx').on(t.revokedAt),
  ],
);

export const delegationCapabilities = pgTable(
  'delegation_capabilities',
  {
    id: generatedId(),
    grantId: text().notNull().references(() => delegationGrants.id, { onDelete: 'cascade' }),
    capability: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('delegation_capabilities_grant_capability_key').on(t.grantId, t.capability)],
);

export const delegationToolOverrides = pgTable(
  'delegation_tool_overrides',
  {
    id: generatedId(),
    grantId: text().notNull().references(() => delegationGrants.id, { onDelete: 'cascade' }),
    tool: text().notNull(),
    decision: text({ enum: ['allow', 'deny'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('delegation_tool_overrides_decision_check', sql`${t.decision} in ('allow', 'deny')`),
    unique('delegation_tool_overrides_grant_tool_key').on(t.grantId, t.tool),
  ],
);

export const delegationLimits = pgTable(
  'delegation_limits',
  {
    id: generatedId(),
    grantId: text().notNull().references(() => delegationGrants.id, { onDelete: 'cascade' }),
    tool: text().notNull(),
    key: text().notNull(),
    value: jsonb().$type<GrantLimit['value']>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'delegation_limits_scalar_value_check',
      sql`jsonb_typeof(${t.value}) in ('number', 'boolean')`,
    ),
    unique('delegation_limits_grant_tool_key_key').on(t.grantId, t.tool, t.key),
  ],
);

export const capabilityExecutionAuthorizations = pgTable(
  'capability_execution_authorizations',
  {
    id: generatedId(),
    kind: text({ enum: ['direct_request', 'automation'] }).notNull(),
    requesterAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    ownerAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    coordinatorApplicationId: text().notNull().references(() => applications.id, { onDelete: 'cascade' }),
    coordinatorCredentialId: text().notNull().references(() => applicationCredentials.id, { onDelete: 'cascade' }),
    actorType: text({ enum: ['alia', 'agent'] }).notNull(),
    actorAccountId: text().references(() => users.id, { onDelete: 'cascade' }),
    resourceApp: text().notNull(),
    effectiveAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    resourceType: text().notNull(),
    resourceKey: text().notNull(),
    tool: text().notNull(),
    /** Direct requests are bound here; automations bind a fresh run when a ticket is issued. */
    runId: text(),
    stepId: text(),
    automationId: text(),
    maximumAutonomy: text({ enum: AUTONOMY_LEVELS }).$type<AutonomyLevel>().notNull(),
    limits: jsonb().$type<GrantLimit[]>().notNull().default(sql`'[]'::jsonb`),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('capability_execution_authorizations_kind_check', sql`${t.kind} in ('direct_request', 'automation')`),
    check('capability_execution_authorizations_actor_check', sql`(${t.actorType} = 'alia' and ${t.actorAccountId} is null) or (${t.actorType} = 'agent' and ${t.actorAccountId} is not null)`),
    check('capability_execution_authorizations_automation_check', sql`(${t.kind} = 'automation') = (${t.automationId} is not null)`),
    check(
      'capability_execution_authorizations_run_scope_check',
      sql`(${t.kind} = 'direct_request' and ${t.runId} is not null)
        or (${t.kind} = 'automation')`,
    ),
    check('capability_execution_authorizations_autonomy_check', sql`${t.maximumAutonomy} in (${sql.raw(inList(AUTONOMY_LEVELS))})`),
    check(
      'capability_execution_authorizations_limits_check',
      sql`jsonb_typeof(${t.limits}) = 'array'
        and not jsonb_path_exists(${t.limits}, '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
        and not jsonb_path_exists(${t.limits}, '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "key" && @.key != "value")')`,
    ),
    index('capability_execution_authorizations_live_idx').on(t.id, t.expiresAt, t.revokedAt),
    index('capability_execution_authorizations_owner_idx').on(t.ownerAccountId, t.createdAt),
    index('capability_execution_authorizations_coordinator_idx').on(t.coordinatorApplicationId, t.coordinatorCredentialId),
  ],
);

export const accountCapabilityPolicies = pgTable(
  'account_capability_policies',
  {
    id: generatedId(),
    accountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    appSlug: text().notNull(),
    maximumAutonomy: text({ enum: AUTONOMY_LEVELS }).$type<AutonomyLevel>().notNull(),
    deniedCapabilities: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('account_capability_policies_autonomy_check', sql`${t.maximumAutonomy} in (${sql.raw(inList(AUTONOMY_LEVELS))})`),
    unique('account_capability_policies_account_app_key').on(t.accountId, t.appSlug),
  ],
);

export const appCapabilityCatalogRegistrations = pgTable(
  'app_capability_catalog_registrations',
  {
    id: generatedId(),
    appSlug: text().notNull(),
    version: text().notNull(),
    audience: text().notNull(),
    catalog: jsonb().$type<AppCapabilityCatalog>().notNull(),
    digest: text().notNull(),
    signature: text().notNull(),
    registeredByApplicationId: text().notNull().references(() => applications.id, { onDelete: 'cascade' }),
    registeredByCredentialId: text().notNull().references(() => applicationCredentials.id, { onDelete: 'cascade' }),
    deployedAt: timestamptz().notNull(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('app_capability_catalog_version_digest_key').on(t.appSlug, t.version, t.digest),
    uniqueIndex('app_capability_catalog_active_key').on(t.appSlug).where(sql`${t.active}`),
    index('app_capability_catalog_application_idx').on(t.registeredByApplicationId),
  ],
);

export const capabilityAuditEvents = pgTable(
  'capability_audit_events',
  {
    id: generatedId(),
    eventKey: text().notNull(),
    effectiveAccountKey: text().notNull(),
    executorAccountKey: text(),
    runKey: text().notNull(),
    event: jsonb().$type<AuditEvent>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'capability_audit_events_bounded_event_check',
      sql`jsonb_typeof(${t.event}) = 'object'
        and jsonb_typeof(${t.event} -> 'result') = 'object'
        and not (${t.event} -> 'result' ? 'message')
        and jsonb_typeof(${t.event} -> 'correlation') = 'object'
        and not (${t.event} -> 'correlation' ? 'idempotencyKey')
        and (${t.event} #>> '{correlation,idempotencyKeyHash}' is null or ${t.event} #>> '{correlation,idempotencyKeyHash}' ~ '^[a-f0-9]{64}$')
        and not jsonb_path_exists(${t.event}, '$.** ? (@.type() == "object").keyvalue() ? (@.key == "prompt" || @.key == "completion" || @.key == "payload" || @.key == "toolArguments" || @.key == "toolInput" || @.key == "toolOutput" || @.key == "rawRequest" || @.key == "rawResponse" || @.key == "messageBody" || @.key == "messageContent" || @.key == "modelOutput")')`,
    ),
    unique('capability_audit_events_event_key').on(t.eventKey),
    index('capability_audit_events_account_created_idx').on(t.effectiveAccountKey, t.createdAt),
    index('capability_audit_events_executor_created_idx').on(t.executorAccountKey, t.createdAt),
    index('capability_audit_events_run_created_idx').on(t.runKey, t.createdAt),
  ],
);

export const capabilityIdempotencyKeys = pgTable(
  'capability_idempotency_keys',
  {
    id: generatedId(),
    effectiveAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    appSlug: text().notNull(),
    tool: text().notNull(),
    keyHash: text().notNull(),
    ticketJti: text().notNull(),
    status: text({ enum: ['started', 'succeeded', 'failed'] }).notNull(),
    responseStatus: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('capability_idempotency_keys_status_check', sql`${t.status} in ('started', 'succeeded', 'failed')`),
    unique('capability_idempotency_keys_effect_key').on(
      t.effectiveAccountId,
      t.appSlug,
      t.tool,
      t.keyHash,
    ),
  ],
);

export type DelegationGrantRow = typeof delegationGrants.$inferSelect;
export type CapabilityPackageRow = CapabilityPackage;
