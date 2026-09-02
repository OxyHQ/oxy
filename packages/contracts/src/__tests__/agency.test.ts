import {
    appCapabilityCatalogSchema,
    capabilityTicketClaimsSchema,
    delegationGrantSchema,
} from '../index';

const resource = {
    appId: 'inbox',
    effectiveAccountId: 'account-1',
    resourceType: 'mailbox',
    resourceId: 'mailbox-1',
};

describe('agency contracts', () => {
    it('accepts a scoped agent delegation and rejects a session-wide resource', () => {
        const grant = {
            id: 'grant-1',
            ownerAccountId: 'owner-1',
            actor: { type: 'agent' as const, accountId: 'agent-1' },
            resource,
            capabilityPackages: ['read' as const],
            capabilities: ['email.read'],
            toolOverrides: [],
            limits: [],
            maximumAutonomy: 'execute_on_request' as const,
            canRedelegate: false,
            expiresAt: null,
            revokedAt: null,
            createdAt: '2026-09-01T10:00:00.000Z',
            updatedAt: '2026-09-01T10:00:00.000Z',
        };

        expect(delegationGrantSchema.safeParse(grant).success).toBe(true);
        expect(delegationGrantSchema.safeParse({
            ...grant,
            resource: { ...resource, resourceId: '' },
        }).success).toBe(false);
    });

    it('requires capability tickets to name the exact actor, account, resource and run', () => {
        const ticket = {
            iss: 'https://api.oxy.so',
            aud: 'inbox-api',
            sub: 'agent-1',
            jti: 'ticket-1',
            iat: 1_788_256_800,
            exp: 1_788_256_860,
            runId: 'run-1',
            executionAuthorization: { kind: 'direct_request' as const, id: 'authorization-1' },
            coordinator: { applicationId: 'alia-app', credentialId: 'alia-credential' },
            requesterAccountId: 'owner-1',
            ownerAccountId: 'owner-1',
            actor: { type: 'agent' as const, accountId: 'agent-1' },
            resource,
            tool: 'readEmail',
            capabilities: ['email.read'],
            limits: [],
            autonomy: 'execute_on_request' as const,
        };

        expect(capabilityTicketClaimsSchema.safeParse(ticket).success).toBe(true);
        expect(capabilityTicketClaimsSchema.safeParse({ ...ticket, capabilities: [] }).success).toBe(false);
        expect(capabilityTicketClaimsSchema.safeParse({ ...ticket, sub: 'different-agent' }).success).toBe(false);
        expect(capabilityTicketClaimsSchema.safeParse({
            ...ticket,
            autonomy: 'autonomous',
        }).success).toBe(false);
        expect(capabilityTicketClaimsSchema.safeParse({
            ...ticket,
            exp: ticket.iat,
        }).success).toBe(false);
        expect(capabilityTicketClaimsSchema.safeParse({
            ...ticket,
            limits: [{ tool: 'sendEmail', key: 'to.address', value: ['allowed@example.com'] }],
        }).success).toBe(false);
        expect(capabilityTicketClaimsSchema.safeParse({
            ...ticket,
            automationId: 'automation-1',
            executionAuthorization: {
                kind: 'automation',
                id: 'authorization-1',
                automationId: 'automation-2',
            },
        }).success).toBe(false);
    });

    it('rejects duplicate tool definitions in a catalog', () => {
        const tool = {
            name: 'readEmail',
            version: '1.0.0',
            description: 'Read one message from a delegated mailbox.',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            capabilityPackage: 'read' as const,
            requiredCapabilities: ['email.read'],
            resourceTypes: ['mailbox'],
            effect: 'read' as const,
            idempotency: 'none' as const,
            rollback: 'none' as const,
            exposure: ['internal' as const, 'mcp' as const],
            invocation: { method: 'GET' as const, path: '/email/messages/:id' },
        };
        const catalog = {
            schemaVersion: '1' as const,
            appId: 'inbox',
            version: '1.0.0',
            audience: 'inbox-api',
            accountResourceType: 'email_account',
            tools: [tool, tool],
            events: [],
        };

        expect(appCapabilityCatalogSchema.safeParse(catalog).success).toBe(false);
    });
});
