import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  AGENT_REQUESTER_CEILING_AUTONOMY,
  AUTONOMY_LEVELS,
  CAPABILITY_PACKAGES,
  type AppCapabilityCatalog,
  type AuditEvent,
  type AgentRequesterCeilingAutonomy,
  type AutonomyLevel,
  type CapabilityPackage,
  type GrantLimit,
  type ToolGrantOverride,
} from '@oxy.so/contracts';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { users } from './users';
import { userAuthMethods } from './userAuthMethods';

export const delegationGrants = pgTable(
  'delegation_grants',
  {
    id: generatedId(),
    ownerAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resourceApp: text().notNull(),
    effectiveAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resourceType: text().notNull(),
    resourceKey: text().notNull(),
    catalogRegistrationId: text().references(() => appCapabilityCatalogRegistrations.id, {
      onDelete: 'restrict',
    }),
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
    check(
      'delegation_grants_autonomy_check',
      sql`${t.maximumAutonomy} in (${sql.raw(inList(AUTONOMY_LEVELS))})`,
    ),
    check(
      'delegation_grants_packages_check',
      sql`${t.capabilityPackages} <@ array[${sql.raw(inList(CAPABILITY_PACKAGES))}]::text[]`,
    ),
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
    index('delegation_grants_catalog_registration_idx').on(t.catalogRegistrationId),
  ],
);

export const delegationCapabilities = pgTable(
  'delegation_capabilities',
  {
    id: generatedId(),
    grantId: text()
      .notNull()
      .references(() => delegationGrants.id, { onDelete: 'cascade' }),
    capability: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('delegation_capabilities_grant_capability_key').on(t.grantId, t.capability)],
);

export const delegationToolOverrides = pgTable(
  'delegation_tool_overrides',
  {
    id: generatedId(),
    grantId: text()
      .notNull()
      .references(() => delegationGrants.id, { onDelete: 'cascade' }),
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
    grantId: text()
      .notNull()
      .references(() => delegationGrants.id, { onDelete: 'cascade' }),
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

/**
 * What an agent may do in one app for WHOEVER uses it (ADR 0042): its owner's
 * published ceiling. It grants nothing by itself — only a present requester's
 * execution authorization activates it, and only on that requester's own
 * account root. One live row per (agent, app); a revoked row is kept so a
 * ticket that named it can be refused by id.
 */
export const agentRequesterCeilings = pgTable(
  'agent_requester_ceilings',
  {
    id: generatedId(),
    agentAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    appSlug: text().notNull(),
    catalogRegistrationId: text()
      .notNull()
      .references(() => appCapabilityCatalogRegistrations.id, { onDelete: 'restrict' }),
    capabilityPackages: text({ enum: CAPABILITY_PACKAGES })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    capabilities: text().array().notNull().default(sql`'{}'::text[]`),
    toolOverrides: jsonb().$type<ToolGrantOverride[]>().notNull().default(sql`'[]'::jsonb`),
    limits: jsonb().$type<GrantLimit[]>().notNull().default(sql`'[]'::jsonb`),
    maximumAutonomy: text({ enum: AGENT_REQUESTER_CEILING_AUTONOMY })
      .$type<AgentRequesterCeilingAutonomy>()
      .notNull(),
    version: integer().notNull().default(1),
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'agent_requester_ceilings_autonomy_check',
      sql`${t.maximumAutonomy} in (${sql.raw(inList(AGENT_REQUESTER_CEILING_AUTONOMY))})`,
    ),
    check(
      'agent_requester_ceilings_packages_check',
      sql`${t.capabilityPackages} <@ array[${sql.raw(inList(CAPABILITY_PACKAGES))}]::text[]`,
    ),
    check('agent_requester_ceilings_version_check', sql`${t.version} > 0`),
    check(
      'agent_requester_ceilings_overrides_check',
      sql`jsonb_typeof(${t.toolOverrides}) = 'array'
        and not jsonb_path_exists(${t.toolOverrides}, '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.decision) || (@.decision != "allow" && @.decision != "deny"))')
        and not jsonb_path_exists(${t.toolOverrides}, '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "decision")')`,
    ),
    check(
      'agent_requester_ceilings_limits_check',
      sql`jsonb_typeof(${t.limits}) = 'array'
        and not jsonb_path_exists(${t.limits}, '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
        and not jsonb_path_exists(${t.limits}, '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "key" && @.key != "value")')`,
    ),
    uniqueIndex('agent_requester_ceilings_live_key')
      .on(t.agentAccountId, t.appSlug)
      .where(sql`${t.revokedAt} is null`),
    index('agent_requester_ceilings_catalog_registration_idx').on(t.catalogRegistrationId),
  ],
);

export type AgentRequesterCeilingRow = typeof agentRequesterCeilings.$inferSelect;

/** Context stays inspectable for thirty days after expiry or revocation. */
export const FIRST_PARTY_TASK_RETENTION_SECONDS = 30 * 86400;

/** Durable context for an Oxy-owned request, goal or schedule. No app permissions. */
export const firstPartyTasks = pgTable(
  'first_party_tasks',
  {
    id: generatedId(),
    originKind: text({ enum: ['request', 'goal', 'automation'] }).notNull(),
    originId: text().notNull(),
    requesterAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    effectiveAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requesterSessionId: text().notNull(),
    requesterSessionBindingDigest: text().notNull(),
    requesterAuthMethodId: text(),
    coordinatorApplicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    coordinatorCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'cascade' }),
    actorType: text({ enum: ['alia', 'agent', 'requester'] }).notNull(),
    actorAccountId: text().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'first_party_tasks_origin_check',
      sql`${t.originKind} in ('request', 'goal', 'automation')`,
    ),
    check(
      'first_party_tasks_digest_check',
      sql`${t.requesterSessionBindingDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'first_party_tasks_actor_check',
      sql`(${t.actorType} = 'alia' and ${t.actorAccountId} is null) or (${t.actorType} in ('agent', 'requester') and ${t.actorAccountId} is not null)`,
    ),
    foreignKey({
      name: 'first_party_tasks_requester_method_fk',
      columns: [t.requesterAuthMethodId, t.requesterAccountId],
      foreignColumns: [userAuthMethods.id, userAuthMethods.userId],
    }).onDelete('restrict'),
    index('first_party_tasks_expiry_idx').on(t.expiresAt),
    index('first_party_tasks_revoked_idx').on(t.revokedAt),
    index('first_party_tasks_requester_idx').on(t.requesterAccountId, t.createdAt),
    index('first_party_tasks_origin_idx').on(t.coordinatorApplicationId, t.originKind, t.originId),
  ],
);

export const capabilityExecutionAuthorizations = pgTable(
  'capability_execution_authorizations',
  {
    id: generatedId(),
    authority: text({ enum: ['first_party', 'external'] }),
    taskId: text().references(() => firstPartyTasks.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['direct_request', 'automation'] }).notNull(),
    requesterAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Autonomous approval provenance; revocation is live, never SET NULL. */
    requesterAuthMethodId: text(),
    ownerAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    coordinatorApplicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    coordinatorCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'cascade' }),
    actorType: text({ enum: ['alia', 'agent', 'requester'] }).notNull(),
    /** Historical approval handle: live session checks deny absent/expired rows. */
    requesterSessionId: text(),
    requesterSessionBindingDigest: text(),
    /** Frozen foreground approval: a new catalogue requires new approval. */
    requesterCatalogRegistrationId: text().references(() => appCapabilityCatalogRegistrations.id, {
      onDelete: 'restrict',
    }),
    requesterCatalogVersion: text(),
    requesterCatalogDigest: text(),
    actorAccountId: text().references(() => users.id, { onDelete: 'cascade' }),
    resourceApp: text().notNull(),
    effectiveAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resourceType: text().notNull(),
    resourceKey: text().notNull(),
    tool: text().notNull(),
    /** Direct requests are bound here; automations bind a fresh run when a ticket is issued. */
    runId: text(),
    stepId: text(),
    automationId: text(),
    maximumAutonomy: text({ enum: AUTONOMY_LEVELS }).$type<AutonomyLevel>().notNull(),
    limits: jsonb().$type<GrantLimit[]>().notNull().default(sql`'[]'::jsonb`),
    /** Set when an agent acts for a non-owner under its owner's ceiling (ADR 0042). */
    ceilingId: text().references(() => agentRequesterCeilings.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'capability_execution_authority_check',
      sql`${t.authority} in ('first_party', 'external')`,
    ),
    check(
      'capability_execution_ceiling_scope_check',
      sql`${t.ceilingId} is null or (
        ${t.actorType} = 'agent'
        and ${t.ownerAccountId} = ${t.requesterAccountId}
        and ${t.resourceKey} = ${t.effectiveAccountId})`,
    ),
    index('capability_execution_ceiling_idx')
      .on(t.ceilingId)
      .where(sql`${t.ceilingId} is not null`),
    foreignKey({
      name: 'capability_execution_requester_method_fk',
      columns: [t.requesterAuthMethodId, t.requesterAccountId],
      foreignColumns: [userAuthMethods.id, userAuthMethods.userId],
    }).onDelete('restrict'),
    index('capability_execution_requester_method_idx')
      .on(t.requesterAuthMethodId)
      .where(sql`${t.requesterAuthMethodId} is not null`),
    check(
      'capability_execution_authorizations_kind_check',
      sql`${t.kind} in ('direct_request', 'automation')`,
    ),
    check(
      'capability_execution_authorizations_actor_check',
      sql`(${t.actorType} = 'alia' and ${t.actorAccountId} is null) or (${t.actorType} in ('agent', 'requester') and ${t.actorAccountId} is not null)`,
    ),
    check(
      'capability_execution_requester_session_check',
      sql`
      case when coalesce(${t.authority}, 'external') = 'first_party' then
        (${t.requesterSessionId} is not null and length(${t.requesterSessionId}) > 0
         and ${t.requesterSessionBindingDigest} is not null and ${t.requesterSessionBindingDigest} ~ '^[a-f0-9]{64}$' and ${t.ceilingId} is null)
      else (${t.actorType} = 'requester' and ${t.requesterSessionId} is not null and length(${t.requesterSessionId}) > 0
       and ${t.requesterSessionBindingDigest} is not null
       and ${t.requesterSessionBindingDigest} ~ '^[a-f0-9]{64}$'
       and ${t.kind} = 'direct_request' and ${t.maximumAutonomy} = 'read_only'
       and ${t.actorAccountId} = ${t.requesterAccountId})
      or (${t.actorType} <> 'requester' and ${t.requesterSessionId} is null and ${t.requesterSessionBindingDigest} is null) end`,
    ),
    check(
      'capability_execution_requester_catalog_check',
      sql`
      case when coalesce(${t.authority}, 'external') = 'first_party' then
        (${t.requesterCatalogRegistrationId} is not null and length(${t.requesterCatalogRegistrationId}) > 0
         and ${t.requesterCatalogVersion} is not null and length(${t.requesterCatalogVersion}) > 0
         and ${t.requesterCatalogDigest} is not null and ${t.requesterCatalogDigest} ~ '^[a-f0-9]{64}$')
      else (${t.actorType} = 'requester' and (
        (${t.requesterCatalogRegistrationId} is not null and length(${t.requesterCatalogRegistrationId}) > 0
         and ${t.requesterCatalogVersion} is not null and length(${t.requesterCatalogVersion}) > 0
         and ${t.requesterCatalogDigest} is not null and ${t.requesterCatalogDigest} ~ '^[a-f0-9]{64}$')
        or (${t.revokedAt} is not null and ${t.requesterCatalogRegistrationId} is null
         and ${t.requesterCatalogVersion} is null and ${t.requesterCatalogDigest} is null)))
      or (${t.actorType} <> 'requester' and ${t.requesterCatalogRegistrationId} is null
       and ${t.requesterCatalogVersion} is null and ${t.requesterCatalogDigest} is null) end`,
    ),
    check(
      'capability_execution_authorizations_automation_check',
      sql`(${t.kind} = 'automation') = (${t.automationId} is not null)`,
    ),
    check(
      'capability_execution_authorizations_run_scope_check',
      sql`(${t.kind} = 'direct_request' and ${t.runId} is not null)
        or (${t.kind} = 'automation' and ${t.runId} is null and ${t.stepId} is null)`,
    ),
    check(
      'capability_execution_authorizations_autonomy_check',
      sql`${t.maximumAutonomy} in (${sql.raw(inList(AUTONOMY_LEVELS))})`,
    ),
    check(
      'capability_execution_authorizations_limits_check',
      sql`jsonb_typeof(${t.limits}) = 'array'
        and not jsonb_path_exists(${t.limits}, '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
        and not jsonb_path_exists(${t.limits}, '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "key" && @.key != "value")')`,
    ),
    index('capability_execution_authorizations_live_idx').on(t.id, t.expiresAt, t.revokedAt),
    index('capability_execution_authorizations_owner_idx').on(t.ownerAccountId, t.createdAt),
    index('capability_execution_authorizations_coordinator_idx').on(
      t.coordinatorApplicationId,
      t.coordinatorCredentialId,
    ),
  ],
);

export const accountCapabilityPolicies = pgTable(
  'account_capability_policies',
  {
    id: generatedId(),
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    appSlug: text().notNull(),
    maximumAutonomy: text({ enum: AUTONOMY_LEVELS }).$type<AutonomyLevel>().notNull(),
    deniedCapabilities: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'account_capability_policies_autonomy_check',
      sql`${t.maximumAutonomy} in (${sql.raw(inList(AUTONOMY_LEVELS))})`,
    ),
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
    registeredByApplicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * How the registration was authorized. `credential`: an application's
     * `catalogs:write` credential posted it (`registeredByCredentialId` names
     * it). `first_party`: Oxy's own deploy registered a catalogue it ships, with
     * no credential involved — see ADR 0048.
     */
    source: text().notNull().default('credential'),
    registeredByCredentialId: text().references(() => applicationCredentials.id, {
      onDelete: 'cascade',
    }),
    deployedAt: timestamptz().notNull(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('app_capability_catalog_source_check', sql`${t.source} in ('credential', 'first_party')`),
    // A registration is attributable to exactly one authority: a credential, or
    // Oxy's own deploy. Never both, never neither.
    check(
      'app_capability_catalog_credential_source_check',
      sql`(${t.source} = 'credential') = (${t.registeredByCredentialId} is not null)`,
    ),
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
    effectiveAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
    check(
      'capability_idempotency_keys_status_check',
      sql`${t.status} in ('started', 'succeeded', 'failed')`,
    ),
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
