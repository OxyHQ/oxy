import type { CatalogTool } from '@oxyhq/contracts';
import { capabilityLimitError } from '../capabilityLimitPolicy';

function tool(input: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'searchEmails',
    version: '1.0.0',
    description: 'Search one delegated mailbox.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer' }, unread: { type: 'boolean' } },
    },
    capabilityPackage: 'read',
    requiredCapabilities: ['email.read'],
    resourceTypes: ['mailbox'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [
      { key: 'limit', kind: 'maximum_number' },
      { key: 'unread', kind: 'exact_boolean' },
    ],
    invocation: { method: 'GET', path: '/email/search' },
    ...input,
  };
}

describe('capabilityLimitError', () => {
  it('accepts declared numeric and boolean constraints', () => {
    expect(capabilityLimitError([
      { tool: 'searchEmails', key: 'limit', value: 25 },
      { tool: 'searchEmails', key: 'unread', value: true },
    ], [tool()], 'mailbox')).toBeNull();
  });

  it.each([
    {
      name: 'undeclared key',
      limits: [{ tool: 'searchEmails', key: 'offset', value: 25 }],
      tools: [tool()],
      resource: 'mailbox',
      error: 'limit_key_not_declared_by_tool',
    },
    {
      name: 'duplicate key',
      limits: [
        { tool: 'searchEmails', key: 'limit', value: 25 },
        { tool: 'searchEmails', key: 'limit', value: 10 },
      ],
      tools: [tool()],
      resource: 'mailbox',
      error: 'duplicate_limit',
    },
    {
      name: 'wrong declared kind',
      limits: [{ tool: 'searchEmails', key: 'unread', value: 1 }],
      tools: [tool()],
      resource: 'mailbox',
      error: 'limit_value_kind_mismatch',
    },
    {
      name: 'wrong tool',
      limits: [{ tool: 'sendEmail', key: 'limit', value: 1 }],
      tools: [tool()],
      resource: 'mailbox',
      error: 'limit_tool_not_available_for_resource',
    },
    {
      name: 'wrong resource',
      limits: [{ tool: 'searchEmails', key: 'limit', value: 1 }],
      tools: [tool()],
      resource: 'email_account',
      error: 'limit_tool_not_available_for_resource',
    },
    {
      name: 'legacy catalog without declarations',
      limits: [{ tool: 'searchEmails', key: 'limit', value: 1 }],
      tools: [{ ...tool(), limitKeys: undefined } as unknown as CatalogTool],
      resource: 'mailbox',
      error: 'limit_key_not_declared_by_tool',
    },
  ])('rejects $name', ({ limits, tools, resource, error }) => {
    expect(capabilityLimitError(limits, tools, resource)).toBe(error);
  });
});
