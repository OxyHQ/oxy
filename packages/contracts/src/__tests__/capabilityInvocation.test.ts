import {
    appCapabilityCatalogSchema,
    catalogInvocationsOverlap,
    catalogInvocationTemplatesEquivalent,
    matchCatalogInvocation,
    resolveCatalogInvocation,
} from '../index';

function tool(name: string, method: 'GET' | 'POST', path: string, inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    additionalProperties: false,
}) {
    return {
        name,
        version: '1.0.0',
        description: `${name} test tool.`,
        inputSchema,
        capabilityPackage: 'read' as const,
        requiredCapabilities: ['email.read'],
        resourceTypes: ['email_account'],
        effect: 'read' as const,
        idempotency: 'none' as const,
        rollback: 'none' as const,
        exposure: ['internal' as const],
        limitKeys: [],
        invocation: { method, path },
    };
}

const byId = {
    type: 'object',
    properties: { emailId: { type: 'string' } },
    required: ['emailId'],
    additionalProperties: false,
};

function catalog(tools: unknown[]) {
    return {
        schemaVersion: '1' as const,
        appId: 'inbox',
        version: '1.0.0',
        audience: 'inbox-api',
        internalBaseUrl: 'https://api.oxy.so',
        accountResourceType: 'email_account',
        tools,
        events: [],
    };
}

describe('catalog invocation templates', () => {
    it('detects templates one concrete request could satisfy', () => {
        expect(catalogInvocationsOverlap(
            { method: 'GET', path: '/email/messages/{emailId}' },
            { method: 'GET', path: '/email/messages/unread' },
        )).toBe(true);
        expect(catalogInvocationsOverlap(
            { method: 'GET', path: '/email/messages/{a}' },
            { method: 'get', path: '/email/messages/{b}' },
        )).toBe(true);
        expect(catalogInvocationsOverlap(
            { method: 'GET', path: '/email/messages/{emailId}' },
            { method: 'GET', path: '/email/messages/{emailId}/thread' },
        )).toBe(false);
        expect(catalogInvocationsOverlap(
            { method: 'GET', path: '/email/messages/{emailId}' },
            { method: 'POST', path: '/email/messages/{emailId}' },
        )).toBe(false);
        expect(catalogInvocationsOverlap(
            { method: 'GET', path: '/email/unread' },
            { method: 'GET', path: '/email/search' },
        )).toBe(false);
    });

    it('tells one address from an overlapping one', () => {
        expect(catalogInvocationTemplatesEquivalent(
            { method: 'GET', path: '/email/messages/{messageId}' },
            { method: 'get', path: '/email/messages/{emailId}' },
        )).toBe(true);
        expect(catalogInvocationTemplatesEquivalent(
            { method: 'GET', path: '/email/messages/{emailId}' },
            { method: 'GET', path: '/email/messages/bundled' },
        )).toBe(false);
        expect(catalogInvocationTemplatesEquivalent(
            { method: 'GET', path: '/email/messages/bundled' },
            { method: 'GET', path: '/email/messages/{emailId}' },
        )).toBe(false);
        expect(catalogInvocationTemplatesEquivalent(
            { method: 'POST', path: '/email/messages' },
            { method: 'GET', path: '/email/messages' },
        )).toBe(false);
    });

    it('refuses a catalog whose invocations overlap, in either declaration order', () => {
        const byIdTool = tool('readEmail', 'GET', '/email/messages/{emailId}', byId);
        const literal = tool('getUnreadEmails', 'GET', '/email/messages/unread');
        expect(appCapabilityCatalogSchema.safeParse(catalog([byIdTool, literal])).success).toBe(false);
        expect(appCapabilityCatalogSchema.safeParse(catalog([literal, byIdTool])).success).toBe(false);
        // The positive control: the same two tools on disjoint paths are fine.
        expect(appCapabilityCatalogSchema.safeParse(catalog([
            byIdTool,
            tool('getUnreadEmails', 'GET', '/email/unread'),
        ])).success).toBe(true);
    });

    it('requires every path parameter to be a required input property', () => {
        expect(appCapabilityCatalogSchema.safeParse(catalog([
            tool('readEmail', 'GET', '/email/messages/{emailId}'),
        ])).success).toBe(false);
        expect(appCapabilityCatalogSchema.safeParse(catalog([
            tool('readEmail', 'GET', '/email/messages/{emailId}', { ...byId, required: [] }),
        ])).success).toBe(false);
        expect(appCapabilityCatalogSchema.safeParse(catalog([
            tool('readEmail', 'GET', '/email/messages/{emailId}', byId),
        ])).success).toBe(true);
    });

    it('allows only scalar GET inputs, which is all a query string can carry', () => {
        expect(appCapabilityCatalogSchema.safeParse(catalog([
            tool('listEmails', 'GET', '/email/messages', {
                type: 'object',
                properties: { labels: { type: 'array', items: { type: 'string' } } },
            }),
        ])).success).toBe(false);
        expect(appCapabilityCatalogSchema.safeParse(catalog([
            tool('listEmails', 'GET', '/email/messages', {
                type: 'object',
                properties: { label: { type: 'string' }, limit: { type: 'integer' }, unread: { type: 'boolean' } },
            }),
        ])).success).toBe(true);
    });

    it('matches one tool regardless of declaration order', () => {
        const tools = [
            tool('readEmail', 'GET', '/email/messages/{emailId}', byId),
            tool('getEmailThread', 'GET', '/email/messages/{emailId}/thread', byId),
            tool('listEmails', 'GET', '/email/messages'),
        ];
        for (const ordering of [tools, [...tools].reverse()]) {
            expect(matchCatalogInvocation(ordering, 'GET', '/email/messages/a%2Fb')).toEqual({
                tool: tools[0],
                params: { emailId: 'a/b' },
            });
            expect(matchCatalogInvocation(ordering, 'GET', '/email/messages/abc/thread')?.tool.name)
                .toBe('getEmailThread');
            expect(matchCatalogInvocation(ordering, 'GET', '/email/messages')?.tool.name).toBe('listEmails');
            expect(matchCatalogInvocation(ordering, 'POST', '/email/messages')).toBeNull();
            expect(matchCatalogInvocation(ordering, 'GET', '/email/messages/%E0%A4%A')).toBeNull();
        }
    });

    it('throws instead of choosing when an unvalidated tool list is ambiguous', () => {
        expect(() => matchCatalogInvocation([
            tool('readEmail', 'GET', '/email/messages/{emailId}', byId),
            tool('getUnreadEmails', 'GET', '/email/messages/unread'),
        ], 'GET', '/email/messages/unread')).toThrow(/Ambiguous/);
    });
});

describe('resolveCatalogInvocation', () => {
    const origin = { internalBaseUrl: 'https://api.oxy.so' };

    it('fills path parameters and sends GET arguments as the query', () => {
        const resolved = resolveCatalogInvocation(
            origin,
            tool('getEmailThread', 'GET', '/email/messages/{emailId}/thread', byId),
            { emailId: 'a/b', limit: 5, unread: true, skipped: undefined },
        );
        expect(resolved.method).toBe('GET');
        expect(resolved.url.toString()).toBe('https://api.oxy.so/email/messages/a%2Fb/thread?limit=5&unread=true');
        expect(resolved.body).toBeUndefined();
    });

    it('sends the remaining arguments of a non-GET call as its body', () => {
        const resolved = resolveCatalogInvocation(
            origin,
            tool('moveEmail', 'POST', '/email/messages/{emailId}/move', byId),
            { emailId: 'abc', mailbox: 'archive' },
        );
        expect(resolved.url.pathname).toBe('/email/messages/abc/move');
        expect(resolved.body).toEqual({ mailbox: 'archive' });
    });

    it('refuses missing parameters, non-scalar GET arguments and origin escapes', () => {
        const read = tool('readEmail', 'GET', '/email/messages/{emailId}', byId);
        expect(() => resolveCatalogInvocation(origin, read, {})).toThrow(/emailId/);
        expect(() => resolveCatalogInvocation(origin, read, { emailId: '' })).toThrow(/emailId/);
        expect(() => resolveCatalogInvocation(origin, tool('listEmails', 'GET', '/email/messages'), {
            labels: ['a'],
        })).toThrow(/scalar|string, number or boolean/);
        expect(() => resolveCatalogInvocation(origin, tool('escape', 'GET', '//outside.example/x'), {}))
            .toThrow(/escapes/);
    });
});
