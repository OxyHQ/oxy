import {
  agentRequesterCeilingSchema,
  agentRequesterCeilingWriteSchema,
  appCapabilityCatalogSchema,
  capabilityTicketClaimsSchema,
  policyDecisionSchema,
  type CatalogTool,
} from '../index';

const accountRoot = {
  appId: 'homiio',
  effectiveAccountId: 'person-1',
  resourceType: 'homiio_account',
  resourceId: 'person-1',
};

const ticket = {
  iss: 'https://api.oxy.so',
  aud: 'homiio-api',
  sub: 'sindi-bot',
  jti: 'ticket-1',
  iat: 1_788_256_800,
  exp: 1_788_256_860,
  runId: 'run-1',
  executionAuthorization: { kind: 'direct_request' as const, id: 'authorization-1' },
  coordinator: { applicationId: 'alia-app', credentialId: 'alia-credential' },
  ceilingId: 'ceiling-1',
  requesterAccountId: 'person-1',
  ownerAccountId: 'person-1',
  actor: { type: 'agent' as const, accountId: 'sindi-bot' },
  resource: accountRoot,
  tool: 'saveHome',
  capabilities: ['saved.write'],
  limits: [],
  autonomy: 'execute_on_request' as const,
};

function tool(overrides: Partial<CatalogTool> & Pick<CatalogTool, 'name'>): CatalogTool {
  return {
    version: '1.0.0',
    description: 'A tool.',
    inputSchema: { type: 'object' },
    capabilityPackage: 'read',
    requiredCapabilities: ['thing.read'],
    resourceTypes: ['homiio_account'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [],
    invocation: { method: 'GET', path: `/${overrides.name}` },
    ...overrides,
  };
}

function catalog(extra: Record<string, unknown>, tools: CatalogTool[]) {
  return {
    schemaVersion: '1' as const,
    appId: 'homiio',
    version: '1.0.0',
    audience: 'homiio-api',
    internalBaseUrl: 'https://api.homiio.com',
    accountResourceType: 'homiio_account',
    tools,
    events: [],
    ...extra,
  };
}

const checkTool = tool({ name: 'readFileEntitlement' });
const consumeTool = tool({
  name: 'consumeFileCredit',
  capabilityPackage: 'create',
  requiredCapabilities: ['files.consume'],
  effect: 'write',
  idempotency: 'required',
  invocation: { method: 'POST', path: '/consumeFileCredit' },
});

describe('agent requester ceilings (ADR 0042)', () => {
  it('publishes only the two levels an owner can choose', () => {
    const write = { capabilityPackages: ['read' as const], maximumAutonomy: 'read_only' as const };
    expect(agentRequesterCeilingWriteSchema.parse(write)).toEqual({
      ...write,
      capabilities: [],
      toolOverrides: [],
      limits: [],
    });
    expect(
      agentRequesterCeilingWriteSchema.safeParse({ ...write, maximumAutonomy: 'autonomous' })
        .success,
    ).toBe(true);
    for (const level of ['draft', 'execute_on_request']) {
      expect(
        agentRequesterCeilingWriteSchema.safeParse({ ...write, maximumAutonomy: level }).success,
      ).toBe(false);
    }
    expect(
      agentRequesterCeilingWriteSchema.safeParse({ ...write, ownerAccountId: 'someone' }).success,
    ).toBe(false);
  });

  it('binds a stored ceiling to its bot, app and catalogue', () => {
    const ceiling = {
      id: 'ceiling-1',
      agentAccountId: 'sindi-bot',
      appId: 'homiio',
      catalog: { registrationId: 'registration-1', version: '1.0.0', digest: 'a'.repeat(64) },
      capabilityPackages: ['read' as const, 'create' as const],
      capabilities: [],
      toolOverrides: [],
      limits: [],
      maximumAutonomy: 'autonomous' as const,
      version: 1,
      revokedAt: null,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
    };
    expect(agentRequesterCeilingSchema.safeParse(ceiling).success).toBe(true);
    expect(agentRequesterCeilingSchema.safeParse({ ...ceiling, version: 0 }).success).toBe(false);
  });

  it('lets a ticket carry a ceiling only for an agent on the requester own account root', () => {
    expect(capabilityTicketClaimsSchema.safeParse(ticket).success).toBe(true);
    expect(capabilityTicketClaimsSchema.safeParse({ ...ticket, grantId: 'grant-1' }).success).toBe(
      false,
    );
    expect(
      capabilityTicketClaimsSchema.safeParse({ ...ticket, ownerAccountId: 'the-agents-owner' })
        .success,
    ).toBe(false);
    expect(
      capabilityTicketClaimsSchema.safeParse({
        ...ticket,
        resource: { ...accountRoot, resourceId: 'listing-9' },
      }).success,
    ).toBe(false);
    expect(
      capabilityTicketClaimsSchema.safeParse({
        ...ticket,
        sub: 'alia:person-1',
        actor: { type: 'alia', ownerAccountId: 'person-1' },
      }).success,
    ).toBe(false);
    expect(
      capabilityTicketClaimsSchema.safeParse({
        ...ticket,
        executionAuthorization: {
          kind: 'automation',
          id: 'authorization-1',
          automationId: 'run:1',
        },
        automationId: 'run:1',
        autonomy: 'autonomous',
      }).success,
    ).toBe(true);
    expect(policyDecisionSchema.parse({ allowed: true, reason: 'ok', ceilingId: 'c' })).toEqual({
      allowed: true,
      reason: 'ok',
      ceilingId: 'c',
    });
  });
});

describe('catalogue features and internal transport', () => {
  it('accepts a feature checked and consumed by internal-only tools', () => {
    const parsed = appCapabilityCatalogSchema.parse(
      catalog(
        {
          internalTransport: 'mcp',
          features: [
            {
              key: 'sindi.files',
              description: 'Send files to Sindi.',
              checkTool: 'readFileEntitlement',
              consumeTool: 'consumeFileCredit',
            },
          ],
        },
        [checkTool, consumeTool],
      ),
    );
    expect(parsed.internalTransport).toBe('mcp');
    expect(parsed.features?.[0]?.key).toBe('sindi.files');
    expect(
      appCapabilityCatalogSchema.safeParse(catalog({ internalTransport: 'grpc' }, [checkTool]))
        .success,
    ).toBe(false);
  });

  it('refuses a feature whose tools could be called from outside or are the wrong kind', () => {
    const feature = {
      key: 'sindi.files',
      description: 'Send files to Sindi.',
      checkTool: 'readFileEntitlement',
      consumeTool: 'consumeFileCredit',
    };
    const refuse = (tools: CatalogTool[], features: unknown[] = [feature]) =>
      expect(appCapabilityCatalogSchema.safeParse(catalog({ features }, tools)).success).toBe(
        false,
      );

    refuse([consumeTool]);
    refuse([{ ...checkTool, exposure: ['internal', 'mcp'] }, consumeTool]);
    refuse([checkTool, { ...consumeTool, exposure: ['internal', 'mcp'] }]);
    refuse([checkTool, { ...consumeTool, idempotency: 'supported' }]);
    refuse([checkTool, consumeTool], [feature, feature]);
    refuse([checkTool, consumeTool], [{ ...feature, key: 'Sindi Files' }]);
    refuse([checkTool], [{ ...feature, consumeTool: 'readFileEntitlement' }]);
  });
});
