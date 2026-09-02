import type { CatalogTool } from '@oxyhq/contracts';
import {
  grantAllowsTool,
  mostRestrictiveAutonomy,
} from '../capabilityAuthority.service';

function tool(input: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'readEmail',
    version: '1.0.0',
    description: 'Read a message.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    capabilityPackage: 'read',
    requiredCapabilities: ['email.read'],
    resourceTypes: ['mailbox'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
    limitKeys: [],
    invocation: { method: 'GET', path: '/email/messages/:id' },
    ...input,
  };
}

describe('capability authority policy', () => {
  it('always applies the most restrictive autonomy', () => {
    expect(mostRestrictiveAutonomy(['autonomous', 'execute_on_request'])).toBe('execute_on_request');
    expect(mostRestrictiveAutonomy(['draft', 'autonomous', 'read_only'])).toBe('read_only');
  });

  it('lets a semantic package cover new non-sensitive tools', () => {
    expect(grantAllowsTool(tool(), {
      capabilityPackages: ['read'],
      capabilities: [],
      overrides: [],
    })).toBe(true);
  });

  it('requires explicit capabilities for sensitive packages', () => {
    const financeTool = tool({
      name: 'sendPayment',
      capabilityPackage: 'finance',
      requiredCapabilities: ['payments.send'],
      effect: 'financial',
    });
    expect(grantAllowsTool(financeTool, {
      capabilityPackages: ['finance'],
      capabilities: [],
      overrides: [],
    })).toBe(false);
    expect(grantAllowsTool(financeTool, {
      capabilityPackages: ['finance'],
      capabilities: ['payments.send'],
      overrides: [],
    })).toBe(true);
  });

  it('gives a tool denial precedence over packages and capabilities', () => {
    expect(grantAllowsTool(tool(), {
      capabilityPackages: ['read'],
      capabilities: ['email.read'],
      overrides: [{ tool: 'readEmail', decision: 'deny' }],
    })).toBe(false);
  });
});
