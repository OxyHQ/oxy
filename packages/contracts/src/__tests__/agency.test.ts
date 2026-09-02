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
            internalBaseUrl: 'https://api.oxy.so',
            accountResourceType: 'email_account',
            tools: [tool, tool],
            events: [],
        };

        expect(appCapabilityCatalogSchema.safeParse(catalog).success).toBe(false);
    });

    it('allows tools without structured output schemas', () => {
        const catalog = {
            schemaVersion: '1' as const,
            appId: 'noted',
            version: '1.0.0',
            audience: 'noted-api',
            internalBaseUrl: 'https://api.noted.oxy.so',
            accountResourceType: 'workspace',
            tools: [{
                name: 'reportSyncError',
                version: '1.0.0',
                description: 'Return a text-only domain result.',
                inputSchema: { type: 'object', additionalProperties: false },
                capabilityPackage: 'read' as const,
                requiredCapabilities: ['notes.read'],
                resourceTypes: ['workspace'],
                effect: 'read' as const,
                idempotency: 'none' as const,
                rollback: 'none' as const,
                exposure: ['mcp' as const],
                invocation: { method: 'GET' as const, path: '/notes/sync-status' },
            }],
            events: [],
        };

        expect(appCapabilityCatalogSchema.safeParse(catalog).success).toBe(true);
        expect(appCapabilityCatalogSchema.safeParse({
            ...catalog,
            internalBaseUrl: 'http://api.noted.oxy.so',
        }).success).toBe(false);
        expect(appCapabilityCatalogSchema.safeParse({
            ...catalog,
            internalBaseUrl: 'https://api.noted.oxy.so/private',
        }).success).toBe(false);
    });

    it('rejects unsafe or contradictory effect metadata', () => {
        const tool = {
            name: 'chargeAccount',
            version: '1.0.0',
            description: 'Charge a delegated account.',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            capabilityPackage: 'create' as const,
            requiredCapabilities: ['payments.charge'],
            resourceTypes: ['billing_account'],
            effect: 'financial' as const,
            idempotency: 'none' as const,
            rollback: 'none' as const,
            exposure: ['internal' as const, 'internal' as const],
            invocation: { method: 'POST' as const, path: '/payments' },
        };
        const result = appCapabilityCatalogSchema.safeParse({
            schemaVersion: '1',
            appId: 'mercaria',
            version: '1.0.0',
            audience: 'mercaria-api',
            internalBaseUrl: 'https://api.mercaria.oxy.so',
            accountResourceType: 'billing_account',
            tools: [tool],
            events: [],
        });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.map(({ message }) => message)).toEqual(expect.arrayContaining([
                'exposure must not contain duplicates',
                'Effectful tools must declare idempotency support',
                'Financial effects require the finance capability package',
                'Financial and security effects require idempotency keys',
            ]));
        }
    });
});
