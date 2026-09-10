import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const identifierSchema = z.string().trim().min(1).max(255);
const limitKeySchema = z.string().regex(
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/,
    'limit keys must be dot-separated input property names',
).max(255);
const auditCodeSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const invocationPathSchema = z.string().regex(
    /^\/(?!\/)[^\\?#]*$/,
    'invocation paths must be absolute app-local paths without backslashes, query or fragment',
);

/** Autonomy is ordered from least to most permissive. */
export const AUTONOMY_LEVELS = [
    'read_only',
    'draft',
    'execute_on_request',
    'autonomous',
] as const;

export const autonomyLevelSchema = z.enum(AUTONOMY_LEVELS);

export const CAPABILITY_PACKAGES = [
    'read',
    'create',
    'publish',
    'communicate',
    'administer',
    'finance',
    'security',
    'delegate',
] as const;

export const capabilityPackageSchema = z.enum(CAPABILITY_PACKAGES);

export const actorRefSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('alia'),
        ownerAccountId: identifierSchema,
    }).strict(),
    z.object({
        type: z.literal('agent'),
        accountId: identifierSchema,
    }).strict(),
]);

export const resourceRefSchema = z.object({
    appId: identifierSchema,
    effectiveAccountId: identifierSchema,
    resourceType: identifierSchema,
    resourceId: identifierSchema,
}).strict();

export const toolGrantOverrideSchema = z.object({
    tool: identifierSchema,
    decision: z.enum(['allow', 'deny']),
}).strict();

export const grantLimitSchema = z.object({
    tool: identifierSchema,
    key: limitKeySchema,
    // Persisted limits are deliberately closed scalar bounds. Strings and
    // arrays are tool arguments in disguise (recipient lists, prompts, search
    // queries) and ADR 0016 forbids persisting those in Oxy.
    value: z.union([z.number().finite(), z.boolean()]),
}).strict();

export const capabilityCatalogBindingSchema = z.object({
    registrationId: identifierSchema,
    version: identifierSchema,
    digest: sha256HexSchema,
}).strict();

export const executionAuthorizationRefSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('direct_request'),
        id: identifierSchema,
    }).strict(),
    z.object({
        kind: z.literal('automation'),
        id: identifierSchema,
        automationId: identifierSchema,
    }).strict(),
]);

export const capabilityCoordinatorSchema = z.object({
    applicationId: identifierSchema,
    credentialId: identifierSchema,
}).strict();

export const delegationGrantSchema = z.object({
    id: identifierSchema,
    ownerAccountId: identifierSchema,
    actor: actorRefSchema,
    resource: resourceRefSchema,
    catalog: capabilityCatalogBindingSchema.nullable(),
    capabilityPackages: z.array(capabilityPackageSchema),
    capabilities: z.array(identifierSchema),
    toolOverrides: z.array(toolGrantOverrideSchema).default([]),
    limits: z.array(grantLimitSchema).default([]),
    maximumAutonomy: autonomyLevelSchema,
    canRedelegate: z.boolean().default(false),
    expiresAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable().default(null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
}).strict();

export const automationTriggerSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('manual') }).strict(),
    z.object({
        type: z.literal('event'),
        appId: identifierSchema,
        eventType: identifierSchema,
        resource: resourceRefSchema.optional(),
    }).strict(),
    z.object({
        type: z.literal('schedule'),
        cron: nonEmptyStringSchema,
        timezone: nonEmptyStringSchema,
    }).strict(),
]);

export const automationActorSelectionSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('fixed'), actor: actorRefSchema }).strict(),
    z.object({ mode: z.literal('automatic') }).strict(),
]);

export const automationDataFlowSchema = z.object({
    sources: z.array(resourceRefSchema),
    destinations: z.array(resourceRefSchema),
}).strict();

export const automationDefinitionSchema = z.object({
    id: identifierSchema,
    ownerAccountId: identifierSchema,
    objective: nonEmptyStringSchema,
    trigger: automationTriggerSchema,
    actorSelection: automationActorSelectionSchema,
    inputs: z.record(z.unknown()),
    resources: z.array(resourceRefSchema),
    dataFlow: automationDataFlowSchema,
    maximumAutonomy: autonomyLevelSchema,
    limits: z.array(grantLimitSchema).default([]),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
}).strict();

export const capabilityTicketClaimsSchema = z.object({
    iss: nonEmptyStringSchema,
    aud: identifierSchema,
    sub: identifierSchema,
    jti: identifierSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    runId: identifierSchema,
    stepId: identifierSchema.optional(),
    automationId: identifierSchema.optional(),
    executionAuthorization: executionAuthorizationRefSchema,
    coordinator: capabilityCoordinatorSchema,
    grantId: identifierSchema.optional(),
    requesterAccountId: identifierSchema,
    ownerAccountId: identifierSchema,
    actor: actorRefSchema,
    resource: resourceRefSchema,
    tool: identifierSchema,
    capabilities: z.array(identifierSchema).min(1),
    limits: z.array(grantLimitSchema).default([]),
    autonomy: autonomyLevelSchema,
}).strict().superRefine((claims, context) => {
    const expectedSubject = claims.actor.type === 'agent'
        ? claims.actor.accountId
        : `alia:${claims.actor.ownerAccountId}`;
    if (claims.sub !== expectedSubject) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'sub must identify the exact executing actor',
            path: ['sub'],
        });
    }
    if (claims.actor.type === 'alia' && claims.actor.ownerAccountId !== claims.ownerAccountId) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Alia actor owner must match ownerAccountId',
            path: ['actor', 'ownerAccountId'],
        });
    }
    if (claims.exp <= claims.iat) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'exp must be later than iat',
            path: ['exp'],
        });
    }
    if (claims.executionAuthorization.kind === 'automation') {
        if (claims.automationId !== claims.executionAuthorization.automationId) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'automationId must match the execution authorization',
                path: ['automationId'],
            });
        }
    } else if (claims.automationId !== undefined || claims.autonomy === 'autonomous') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'direct requests cannot carry automation identity or autonomous authority',
            path: ['executionAuthorization'],
        });
    }
    for (const [index, limit] of claims.limits.entries()) {
        if (limit.tool !== claims.tool) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'ticket limits must be scoped to the ticket tool',
                path: ['limits', index, 'tool'],
            });
        }
    }
});

export const policyDecisionSchema = z.object({
    allowed: z.boolean(),
    reason: identifierSchema,
    effectiveAutonomy: autonomyLevelSchema.optional(),
    grantId: identifierSchema.optional(),
}).strict();

export const auditResultSchema = z.object({
    status: z.enum(['planned', 'allowed', 'denied', 'succeeded', 'failed', 'rolled_back']),
    code: auditCodeSchema.optional(),
}).strict();

export const auditEventSchema = z.object({
    eventId: identifierSchema,
    occurredAt: z.string().datetime(),
    requesterAccountId: identifierSchema,
    coordinator: capabilityCoordinatorSchema,
    executor: actorRefSchema,
    effectiveAccountId: identifierSchema,
    resource: resourceRefSchema,
    appId: identifierSchema,
    tool: identifierSchema,
    capabilities: z.array(identifierSchema),
    policyDecision: policyDecisionSchema,
    result: auditResultSchema,
    rollback: z.object({
        supported: z.boolean(),
        attempted: z.boolean(),
        succeeded: z.boolean().optional(),
    }).strict(),
    correlation: z.object({
        runId: identifierSchema,
        stepId: identifierSchema.optional(),
        automationId: identifierSchema.optional(),
        idempotencyKeyHash: sha256HexSchema.optional(),
        capabilityTicketId: identifierSchema.optional(),
    }).strict(),
}).strict();

export const catalogToolSchema = z.object({
    name: identifierSchema,
    version: identifierSchema,
    description: nonEmptyStringSchema,
    inputSchema: z.record(z.unknown()),
    outputSchema: z.record(z.unknown()).optional(),
    capabilityPackage: capabilityPackageSchema,
    requiredCapabilities: z.array(identifierSchema).min(1),
    resourceTypes: z.array(identifierSchema).min(1),
    effect: z.enum(['read', 'write', 'external', 'financial', 'security']),
    idempotency: z.enum(['none', 'supported', 'required']),
    rollback: z.enum(['none', 'manual', 'supported']),
    exposure: z.array(z.enum(['internal', 'mcp'])).min(1),
    limitKeys: z.array(z.object({
        key: limitKeySchema,
        kind: z.enum(['maximum_number', 'exact_boolean']),
    }).strict()).default([]),
    invocation: z.object({
        method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
        path: invocationPathSchema,
    }).strict(),
}).strict().superRefine((tool, context) => {
    const requireUnique = (values: readonly string[], path: string): void => {
        if (new Set(values).size !== values.length) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${path} must not contain duplicates`,
                path: [path],
            });
        }
    };

    requireUnique(tool.requiredCapabilities, 'requiredCapabilities');
    requireUnique(tool.resourceTypes, 'resourceTypes');
    requireUnique(tool.exposure, 'exposure');
    requireUnique(tool.limitKeys.map((limit) => limit.key), 'limitKeys');

    const inputSchemaAt = (key: string): Record<string, unknown> | null => {
        let schema: unknown = tool.inputSchema;
        for (const segment of key.split('.')) {
            if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return null;
            const properties = (schema as Record<string, unknown>).properties;
            if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return null;
            schema = (properties as Record<string, unknown>)[segment];
        }
        return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
            ? schema as Record<string, unknown>
            : null;
    };
    for (const [index, limit] of tool.limitKeys.entries()) {
        const input = inputSchemaAt(limit.key);
        const inputType = input?.type;
        const compatible = limit.kind === 'maximum_number'
            ? inputType === 'number' || inputType === 'integer'
            : inputType === 'boolean';
        if (!compatible) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${limit.kind} must name a compatible input property`,
                path: ['limitKeys', index, 'key'],
            });
        }
    }

    if (tool.inputSchema.type !== 'object') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'MCP-compatible tool input schemas must have object roots',
            path: ['inputSchema', 'type'],
        });
    }
    if (tool.outputSchema && tool.outputSchema.type !== 'object') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Tool output schemas must have object roots',
            path: ['outputSchema', 'type'],
        });
    }
    if (tool.effect !== 'read' && tool.idempotency === 'none') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Effectful tools must declare idempotency support',
            path: ['idempotency'],
        });
    }
    if (tool.effect === 'financial' && tool.capabilityPackage !== 'finance') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Financial effects require the finance capability package',
            path: ['capabilityPackage'],
        });
    }
    if (tool.effect === 'security' && tool.capabilityPackage !== 'security') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Security effects require the security capability package',
            path: ['capabilityPackage'],
        });
    }
    if ((tool.effect === 'financial' || tool.effect === 'security') && tool.idempotency !== 'required') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Financial and security effects require idempotency keys',
            path: ['idempotency'],
        });
    }
    if (tool.effect !== 'read' && tool.invocation.method === 'GET') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Effectful tools cannot use GET invocations',
            path: ['invocation', 'method'],
        });
    }
});

export const catalogEventSchema = z.object({
    type: identifierSchema,
    version: identifierSchema,
    description: nonEmptyStringSchema,
    dataSchema: z.record(z.unknown()),
    resourceTypes: z.array(identifierSchema).min(1),
}).strict();

export const appCapabilityCatalogSchema = z.object({
    schemaVersion: z.literal('1'),
    appId: identifierSchema,
    version: identifierSchema,
    audience: identifierSchema,
    /** HTTPS origin that serves the catalog's internal invocation paths. */
    internalBaseUrl: z.string().url().superRefine((value, context) => {
        const url = new URL(value);
        const localDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'internalBaseUrl must use HTTPS outside local development',
            });
        }
        if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'internalBaseUrl must be an origin without path, query or fragment',
            });
        }
    }),
    /** Account-scoped resource used for native Alia bindings without app-specific code. */
    accountResourceType: identifierSchema,
    /** Canonical protected-resource URI when this catalog is also exposed as an external MCP server. */
    externalMcp: z.object({
        resource: z.string().url().superRefine((value, context) => {
            const url = new URL(value);
            const localDevelopment = url.hostname === 'localhost'
                || url.hostname === '127.0.0.1'
                || url.hostname === '[::1]';
            if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'externalMcp.resource must use HTTPS outside local development',
                });
            }
            if (url.username || url.password || url.search || url.hash) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'externalMcp.resource cannot contain credentials, query or fragment',
                });
            }
        }),
    }).strict().optional(),
    tools: z.array(catalogToolSchema),
    events: z.array(catalogEventSchema),
}).strict().superRefine((catalog, context) => {
    const names = new Set<string>();
    for (const [index, tool] of catalog.tools.entries()) {
        if (names.has(tool.name)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate tool name: ${tool.name}`,
                path: ['tools', index, 'name'],
            });
        }
        names.add(tool.name);
    }

    const eventTypes = new Set<string>();
    for (const [index, event] of catalog.events.entries()) {
        if (eventTypes.has(event.type)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate event type: ${event.type}`,
                path: ['events', index, 'type'],
            });
        }
        eventTypes.add(event.type);
    }
});

export const catalogRegistrationSchema = z.object({
    catalog: appCapabilityCatalogSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    signature: nonEmptyStringSchema,
    deployedAt: z.string().datetime(),
}).strict();

export const normalizedAppEventSchema = z.object({
    eventId: identifierSchema,
    appId: identifierSchema,
    accountId: identifierSchema,
    resource: resourceRefSchema,
    type: identifierSchema,
    occurredAt: z.string().datetime(),
    data: z.record(z.unknown()),
}).strict();

export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;
export type CapabilityPackage = z.infer<typeof capabilityPackageSchema>;
export type ActorRef = z.infer<typeof actorRefSchema>;
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export type ToolGrantOverride = z.infer<typeof toolGrantOverrideSchema>;
export type GrantLimit = z.infer<typeof grantLimitSchema>;
export type CapabilityCatalogBinding = z.infer<typeof capabilityCatalogBindingSchema>;
export type ExecutionAuthorizationRef = z.infer<typeof executionAuthorizationRefSchema>;
export type CapabilityCoordinator = z.infer<typeof capabilityCoordinatorSchema>;
export type DelegationGrant = z.infer<typeof delegationGrantSchema>;
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AutomationActorSelection = z.infer<typeof automationActorSelectionSchema>;
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type CapabilityTicketClaims = z.infer<typeof capabilityTicketClaimsSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type CatalogTool = z.infer<typeof catalogToolSchema>;
export type CatalogEvent = z.infer<typeof catalogEventSchema>;
export type AppCapabilityCatalog = z.infer<typeof appCapabilityCatalogSchema>;
export type CatalogRegistration = z.infer<typeof catalogRegistrationSchema>;
export type NormalizedAppEvent = z.infer<typeof normalizedAppEventSchema>;
