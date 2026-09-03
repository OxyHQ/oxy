import type { AppCapabilityCatalog, CatalogTool } from '@oxyhq/contracts';
import { capabilityGrantError } from '../capabilityGrantPolicy';

function tool(input: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'readEmail',
    version: '1.0.0',
    description: 'Read one email.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    capabilityPackage: 'read',
    requiredCapabilities: ['email.read'],
    resourceTypes: ['mailbox'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [],
    invocation: { method: 'GET', path: '/email/messages/{messageId}' },
    ...input,
  };
}

function catalog(tools: CatalogTool[]): AppCapabilityCatalog {
  return {
    schemaVersion: '1',
    appId: 'inbox',
    version: '1.0.0',
    audience: 'oxy-inbox-api',
    internalBaseUrl: 'https://api.oxy.so',
    accountResourceType: 'email_account',
    tools,
    events: [],
  };
}

const emptyGrant = {
  resourceType: 'mailbox',
  capabilityPackages: [],
  capabilities: [],
  toolOverrides: [],
  limits: [],
  maximumAutonomy: 'read_only',
} as const;

describe('capability grant catalog policy', () => {
  it('rejects an allow override for a future tool absent from the active catalog', () => {
    expect(capabilityGrantError({
      ...emptyGrant,
      toolOverrides: [{ tool: 'futureAdminTool', decision: 'allow' }],
    }, catalog([tool()]))).toBe('override_tool_not_available_for_resource');
  });

  it('rejects capabilities and packages not available for the delegated resource', () => {
    expect(capabilityGrantError({
      ...emptyGrant,
      capabilityPackages: ['communicate'],
    }, catalog([tool()]))).toBe('capability_package_not_available_for_resource');
    expect(capabilityGrantError({
      ...emptyGrant,
      capabilities: ['email.send'],
    }, catalog([tool()]))).toBe('capability_not_available_for_resource');
  });

  it('requires the exact sensitive capability even for an explicit tool allow', () => {
    const financeTool = tool({
      name: 'sendPayment',
      capabilityPackage: 'finance',
      requiredCapabilities: ['payments.send'],
      effect: 'financial',
    });
    expect(capabilityGrantError({
      ...emptyGrant,
      toolOverrides: [{ tool: 'sendPayment', decision: 'allow' }],
    }, catalog([financeTool]))).toBe('sensitive_tool_requires_explicit_capabilities');
    expect(capabilityGrantError({
      ...emptyGrant,
      capabilities: ['payments.send'],
      toolOverrides: [{ tool: 'sendPayment', decision: 'allow' }],
    }, catalog([financeTool]))).toBeNull();
  });

  it('rejects a resource type and limit absent from current tool declarations', () => {
    expect(capabilityGrantError(emptyGrant, catalog([tool({ resourceTypes: ['email_account'] })])))
      .toBe('resource_type_not_available_in_catalog');
    expect(capabilityGrantError({
      ...emptyGrant,
      limits: [{ tool: 'readEmail', key: 'limit', value: 10 }],
    }, catalog([tool()]))).toBe('limit_key_not_declared_by_tool');
  });

  it('requires every declared bound for autonomous financial and security tools', () => {
    for (const effect of ['financial', 'security'] as const) {
      const capabilityPackage = effect === 'financial' ? 'finance' : 'security';
      const capability = `${effect}.execute`;
      const sensitiveTool = tool({
        name: `${effect}Effect`,
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'number' }, approved: { type: 'boolean' } },
          additionalProperties: false,
        },
        capabilityPackage,
        requiredCapabilities: [capability],
        effect,
        idempotency: 'required',
        limitKeys: [
          { key: 'amount', kind: 'maximum_number' },
          { key: 'approved', kind: 'exact_boolean' },
        ],
        invocation: { method: 'POST', path: `/${effect}` },
      });
      const autonomousGrant = {
        ...emptyGrant,
        capabilities: [capability],
        maximumAutonomy: 'autonomous' as const,
      };
      expect(capabilityGrantError(autonomousGrant, catalog([sensitiveTool])))
        .toBe('autonomous_sensitive_tool_limit_required');
      expect(capabilityGrantError({
        ...autonomousGrant,
        limits: [
          { tool: sensitiveTool.name, key: 'amount', value: 100 },
          { tool: sensitiveTool.name, key: 'approved', value: true },
        ],
      }, catalog([sensitiveTool]))).toBeNull();
    }
  });

  it('refuses autonomous sensitive tools that declare no bounded inputs', () => {
    const financialTool = tool({
      name: 'financialEffect',
      capabilityPackage: 'finance',
      requiredCapabilities: ['finance.execute'],
      effect: 'financial',
      idempotency: 'required',
      invocation: { method: 'POST', path: '/finance' },
    });
    expect(capabilityGrantError({
      ...emptyGrant,
      capabilities: ['finance.execute'],
      maximumAutonomy: 'autonomous',
    }, catalog([financialTool]))).toBe('autonomous_sensitive_tool_has_no_limit_keys');
  });
});
