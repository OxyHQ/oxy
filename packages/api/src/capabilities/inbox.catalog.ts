import type { AppCapabilityCatalog, CatalogTool } from '@oxyhq/contracts';

const objectOutput = { type: 'object', additionalProperties: true } as const;
const recipient = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { type: 'string', format: 'email' },
  },
  required: ['address'],
  additionalProperties: false,
} as const;

function readTool(input: Omit<CatalogTool, 'version' | 'capabilityPackage' | 'requiredCapabilities' | 'effect' | 'idempotency' | 'rollback' | 'exposure'>): CatalogTool {
  return {
    ...input,
    version: '1.0.0',
    capabilityPackage: 'read',
    requiredCapabilities: ['email.read'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
  };
}

export const INBOX_CAPABILITY_CATALOG: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'inbox',
  version: '1.0.0',
  audience: 'oxy-inbox-api',
  accountResourceType: 'email_account',
  tools: [
    readTool({
      name: 'searchEmails',
      description: 'Search messages in one delegated mailbox.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
          subject: { type: 'string' }, hasAttachment: { type: 'boolean' },
          dateAfter: { type: 'string' }, dateBefore: { type: 'string' },
          label: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' },
        },
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/search' },
    }),
    readTool({
      name: 'getUnreadEmails',
      description: 'List unread messages in one delegated mailbox.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer' }, offset: { type: 'integer' } },
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/messages' },
    }),
    readTool({
      name: 'readEmail',
      description: 'Read one message from a delegated mailbox.',
      inputSchema: {
        type: 'object', properties: { messageId: { type: 'string' } },
        required: ['messageId'], additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/messages/{messageId}' },
    }),
    readTool({
      name: 'getEmailThread',
      description: 'Read the messages in a thread that are visible in one delegated mailbox.',
      inputSchema: {
        type: 'object', properties: { messageId: { type: 'string' } },
        required: ['messageId'], additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/messages/{messageId}/thread' },
    }),
    {
      name: 'sendEmail',
      version: '1.0.0',
      description: 'Send or schedule an email from a delegated Oxy email account.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: recipient }, cc: { type: 'array', items: recipient },
          bcc: { type: 'array', items: recipient }, subject: { type: 'string' },
          text: { type: 'string' }, html: { type: 'string' }, inReplyTo: { type: 'string' },
          references: { type: 'array', items: { type: 'string' } }, scheduledAt: { type: 'string' },
          requestReadReceipt: { type: 'boolean' },
        },
        required: ['to'], additionalProperties: false,
      },
      outputSchema: objectOutput,
      capabilityPackage: 'communicate',
      requiredCapabilities: ['email.send'],
      resourceTypes: ['email_account'],
      effect: 'external',
      idempotency: 'required',
      rollback: 'none',
      exposure: ['internal', 'mcp'],
      invocation: { method: 'POST', path: '/email/messages' },
    },
    readTool({
      name: 'listMailboxes',
      description: 'List mailboxes belonging to a delegated Oxy email account.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: objectOutput,
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/mailboxes' },
    }),
    readTool({
      name: 'listLabels',
      description: 'List labels belonging to a delegated Oxy email account.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: objectOutput,
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/labels' },
    }),
    {
      name: 'moveEmail',
      version: '1.0.0',
      description: 'Move one message out of a delegated mailbox into another mailbox in the same account.',
      inputSchema: {
        type: 'object',
        properties: { messageId: { type: 'string' }, mailboxId: { type: 'string' } },
        required: ['messageId', 'mailboxId'], additionalProperties: false,
      },
      outputSchema: objectOutput,
      capabilityPackage: 'administer',
      requiredCapabilities: ['email.organize'],
      resourceTypes: ['mailbox', 'email_account'],
      effect: 'write',
      idempotency: 'required',
      rollback: 'manual',
      exposure: ['internal', 'mcp'],
      invocation: { method: 'POST', path: '/email/messages/{messageId}/move' },
    },
    {
      name: 'updateEmailFlags',
      version: '1.0.0',
      description: 'Update flags on one message in a delegated mailbox.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          flags: {
            type: 'object',
            properties: { seen: { type: 'boolean' }, starred: { type: 'boolean' }, pinned: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
        required: ['messageId', 'flags'], additionalProperties: false,
      },
      outputSchema: objectOutput,
      capabilityPackage: 'administer',
      requiredCapabilities: ['email.organize'],
      resourceTypes: ['mailbox', 'email_account'],
      effect: 'write',
      idempotency: 'required',
      rollback: 'manual',
      exposure: ['internal', 'mcp'],
      invocation: { method: 'PUT', path: '/email/messages/{messageId}/flags' },
    },
    readTool({
      name: 'getEmailQuota',
      description: 'Read storage quota for a delegated Oxy email account.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: objectOutput,
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/quota' },
    }),
    {
      ...readTool({
        name: 'getEmailContext',
        description: 'Build typed minimal context for email coordination and event handling.',
        inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
        outputSchema: objectOutput,
        resourceTypes: ['mailbox', 'email_account'],
        invocation: { method: 'GET', path: '/email/ai-context' },
      }),
      exposure: ['internal'],
    },
  ],
  events: [
    {
      type: 'new_email', version: '1.0.0', description: 'A message arrived in a mailbox.',
      dataSchema: {
        type: 'object',
        properties: { messageId: { type: 'string' }, mailboxId: { type: 'string' }, from: { type: 'string' }, subject: { type: 'string' } },
        required: ['messageId', 'mailboxId'], additionalProperties: false,
      },
      resourceTypes: ['mailbox'],
    },
    {
      type: 'email_needs_response', version: '1.0.0', description: 'A message is likely to need a response.',
      dataSchema: {
        type: 'object',
        properties: { messageId: { type: 'string' }, mailboxId: { type: 'string' }, reason: { type: 'string' } },
        required: ['messageId', 'mailboxId', 'reason'], additionalProperties: false,
      },
      resourceTypes: ['mailbox'],
    },
  ],
};
