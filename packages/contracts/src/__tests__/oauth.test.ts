import {
  mcpOAuthConsentResponseSchema,
  mcpOAuthWriteActionSchema,
} from '../oauth';

const publicApplication = {
  id: 'application-1',
  name: 'Inbox',
  type: 'first_party' as const,
  isOfficial: true,
  isInternal: true,
  scopes: [],
};

describe('external MCP OAuth consent contracts', () => {
  it('accepts an exact account/resource context with catalog-derived write actions', () => {
    expect(mcpOAuthConsentResponseSchema.parse({
      consentRequired: true,
      context: {
        client: {
          ...publicApplication,
          id: 'mcp-client-record-1',
          clientId: 'oxy_mcp_public',
          name: 'Desktop Assistant',
          type: 'third_party',
          isOfficial: false,
          isInternal: false,
        },
        account: { id: 'account-1', displayName: 'Oxy Mail', handle: 'mail' },
        resource: {
          appId: 'inbox',
          uri: 'https://mcp.inbox.oxy.so',
          application: publicApplication,
        },
        capabilities: ['email.read', 'email.send'],
        writeActions: [{
          name: 'sendEmail',
          version: '1.0.0',
          description: 'Send an email from the selected mailbox.',
          requiredCapabilities: ['email.send'],
          effect: 'external',
        }],
      },
    })).toMatchObject({
      context: {
        account: { id: 'account-1' },
        resource: { appId: 'inbox', uri: 'https://mcp.inbox.oxy.so' },
      },
    });
  });

  it('refuses to classify a read-only catalog tool as a write action', () => {
    expect(mcpOAuthWriteActionSchema.safeParse({
      name: 'readEmail',
      version: '1.0.0',
      description: 'Read an email.',
      requiredCapabilities: ['email.read'],
      effect: 'read',
    }).success).toBe(false);
  });
});
