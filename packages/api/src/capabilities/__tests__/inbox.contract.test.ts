/**
 * The Inbox catalog, end to end over its HTTP transport.
 *
 * For EVERY catalog tool and EVERY resource type it accepts, this signs a real
 * capability ticket, builds the request exactly the way a coordinator does
 * (`resolveCatalogInvocation`, the builder Alia is meant to share), sends it
 * through the real `/email` router and `emailCapabilityAuth`, and requires a
 * 2xx whose body equals what the MCP transport answers for the same input.
 *
 * This is the test that did not exist when `getUnreadEmails` shipped: the
 * catalog said `GET /email/messages`, the ticket was valid, and the REST route
 * that served it answered every account-wide call with a 400. Each unit in
 * between had its own green suite. A tool with no fixture below FAILS the
 * census, so a new tool cannot ship without passing through here.
 *
 * The domain edge (email service, outbound send, drafts, contacts, context) is
 * a deterministic fake: what is under test is the path from a ticket to a tool
 * and back, identical for both transports.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketClaims, CatalogTool } from '@oxy.so/contracts';

const mockKeyPair = generateKeyPairSync('ed25519');
const ACCOUNT_ID = 'account-contract-1';
const MAILBOX_ID = 'mailbox-contract-inbox';
const EMAIL_ID = 'email-contract-1';
const OWN_ADDRESS = 'owner@oxy.so';

const mockEmailFixture = {
  _id: EMAIL_ID,
  id: EMAIL_ID,
  userId: ACCOUNT_ID,
  mailboxId: MAILBOX_ID,
  messageId: '<contract-1@example.com>',
  from: { name: 'Ana', address: 'ana@example.com' },
  to: [{ name: '', address: OWN_ADDRESS }],
  cc: [{ name: 'Bo', address: 'bo@example.com' }],
  bcc: [],
  subject: 'Quarterly plan',
  labels: ['Work'],
  inReplyTo: null,
  references: [],
  flags: {
    seen: false,
    starred: false,
    answered: false,
    forwarded: false,
    draft: false,
    pinned: false,
  },
  date: '2026-09-30T10:00:00.000Z',
};
const mockPage = { data: [mockEmailFixture], total: 1, limit: 20, offset: 0, nextCursor: null };

jest.mock('../../config/capabilityTicketSigning', () => ({
  capabilityTicketSigningConfig: () => ({
    keyId: 'contract-key',
    privateKey: mockKeyPair.privateKey,
    publicKey: mockKeyPair.publicKey,
  }),
}));
jest.mock('../../services/capabilityAuthority.service', () => ({
  reauthorizeCapabilityTicket: async () => ({
    allowed: true,
    reason: 'allowed_by_current_authority',
    effectiveAutonomy: 'execute_on_request',
  }),
}));
jest.mock('../../services/capabilityRuntimeStore.service', () => ({
  mailboxBelongsToAccount: async (mailboxId: string, accountId: string) =>
    mailboxId === MAILBOX_ID && accountId === ACCOUNT_ID,
  messageBelongsToMailbox: async (emailId: string, accountId: string, mailboxId: string) =>
    emailId === EMAIL_ID && accountId === ACCOUNT_ID && mailboxId === MAILBOX_ID,
  persistCapabilityAuditEvent: async () => undefined,
  reserveCapabilityEffect: async () => true,
  finalizeCapabilityEffect: async () => undefined,
  reserveCapabilityEffectFor: async () => true,
  finalizeCapabilityEffectFor: async () => undefined,
}));
jest.mock('../../services/email.service', () => {
  const mailboxes: Record<string, { id: string }> = {
    '\\Inbox': { id: MAILBOX_ID },
    '\\Archive': { id: 'mailbox-contract-archive' },
    '\\Trash': { id: 'mailbox-contract-trash' },
  };
  const moved = (target: string) => ({ ...mockEmailFixture, mailboxId: target });
  return {
    emailService: {
      ensureMailboxes: async () => undefined,
      listMailboxes: async () => [
        {
          id: MAILBOX_ID,
          name: 'INBOX',
          specialUse: '\\Inbox',
          totalMessages: 1,
          unseenMessages: 1,
        },
      ],
      getMailboxBySpecialUse: async (_account: string, specialUse: string) => mailboxes[specialUse],
      getMailboxById: async (_account: string, id: string) =>
        Object.values(mailboxes).find((mailbox) => mailbox.id === id),
      listMessages: async () => mockPage,
      searchMessages: async () => mockPage,
      getMessage: async (_account: string, id: string) =>
        id === EMAIL_ID ? mockEmailFixture : undefined,
      getThread: async () => [
        mockEmailFixture,
        { ...mockEmailFixture, id: 'email-contract-2', mailboxId: 'elsewhere' },
      ],
      listLabels: async () => [{ _id: 'Work', name: 'Work' }],
      getQuotaUsage: async () => ({ used: 10, limit: 100, percentage: 10 }),
      moveMessage: async (_account: string, _id: string, target: string) => moved(target),
      updateMessageFlags: async (_account: string, _id: string, flags: object) => ({
        ...mockEmailFixture,
        flags: { ...mockEmailFixture.flags, ...flags },
      }),
      updateMessageLabels: async () => ({ ...mockEmailFixture, labels: ['Work', 'Later'] }),
      snoozeMessage: async () => moved('mailbox-contract-snoozed'),
    },
  };
});
jest.mock('../../controllers/email.controller', () => ({
  ...jest.requireActual('../../controllers/email.controller'),
  senderIdentityFor: async () => ({ address: OWN_ADDRESS, name: 'Owner' }),
  sendMessageForUser: async (_account: string, command: { subject?: string }) => ({
    status: 202,
    data: {
      messageId: '<sent-contract@oxy.so>',
      queued: false,
      message: `Sent ${command.subject ?? ''}`,
    },
  }),
  saveDraftForUser: async (_account: string, command: { subject?: string }) => ({
    id: 'draft-contract-1',
    subject: command.subject,
  }),
  suggestContactsForUser: async () => [{ name: 'Ana', address: 'ana@example.com' }],
}));
jest.mock('../../controllers/emailContext.controller', () => ({
  ...jest.requireActual('../../controllers/emailContext.controller'),
  buildEmailAgentContext: async (accountId: string, options: { mailboxId?: string | null }) => ({
    accountId,
    resourceMailboxId: options.mailboxId ?? null,
    mailboxes: [],
    recentUnread: [],
    needsResponse: [],
  }),
}));
jest.mock('../../services/emailOutbox.service', () => ({
  ...jest.requireActual('../../services/emailOutbox.service'),
  listEmailOutbox: async () => [{ id: 'outbox-contract-1', status: 'failed' }],
  cancelEmailOutbox: async (_account: string, id: string) => ({ id, status: 'cancelled' }),
}));
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    _req: unknown,
    res: { status: (code: number) => { json: (body: unknown) => void } },
  ) => {
    res.status(401).json({ error: 'bearer requests are not part of this test' });
  },
}));
jest.mock('../../services/smtp.outbound', () => ({ smtpOutbound: {} }));
jest.mock('../../services/assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { resolveCatalogInvocation } from '@oxy.so/contracts';
import { issueCapabilityTicket } from '@oxy.so/core/server';
import { createCatalogMcpToolDefinitions, type CatalogInvocationContext } from '@oxy.so/mcp';
import emailRouter from '../../routes/email';
import { errorHandler } from '../../middleware/errorHandler';
import { INBOX_CAPABILITY_CATALOG } from '../inbox.catalog';
import { INBOX_MCP_CATALOG, INBOX_MCP_HANDLERS } from '../inbox.handlers';
import { INBOX_TOOLS } from '../inbox.tools';

const future = new Date(Date.now() + 86_400_000).toISOString();

/**
 * One valid input per catalog tool. Valid for EVERY resource type the tool
 * accepts — `inbox` and EMAIL_ID are inside the mailbox a mailbox ticket names.
 */
const FIXTURES: Record<string, Record<string, unknown>> = {
  listEmails: { mailbox: 'inbox', unreadOnly: true },
  getUnreadEmails: {},
  searchEmails: { q: 'plan', unread: true, hasAttachment: false, limit: 10 },
  readEmail: { emailId: EMAIL_ID },
  getEmailThread: { emailId: EMAIL_ID },
  listMailboxes: {},
  listLabels: {},
  suggestContacts: { q: 'an' },
  getEmailQuota: {},
  listOutboundEmails: {},
  getEmailContext: { limit: 5 },
  sendEmail: {
    to: [{ name: 'Ana', address: 'ana@example.com' }],
    subject: 'Hello',
    text: 'Body',
    scheduledAt: future,
  },
  replyToEmail: { emailId: EMAIL_ID, text: 'Sounds good', replyAll: true },
  createDraft: { replyToEmailId: EMAIL_ID, text: 'Draft body' },
  cancelOutboundEmail: { outboxId: 'outbox-contract-1' },
  archiveEmail: { emailId: EMAIL_ID },
  trashEmail: { emailId: EMAIL_ID },
  moveEmail: { emailId: EMAIL_ID, mailbox: 'archive' },
  updateEmailFlags: { emailId: EMAIL_ID, flags: { seen: true, starred: true } },
  setEmailLabels: { emailId: EMAIL_ID, add: ['Later'] },
  snoozeEmail: { emailId: EMAIL_ID, until: future },
};

function ticketFor(tool: CatalogTool, resourceType: string): string {
  const claims: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
    aud: INBOX_CAPABILITY_CATALOG.audience,
    sub: `alia:${ACCOUNT_ID}`,
    runId: 'contract-run',
    executionAuthorization: { kind: 'direct_request', id: 'contract-authorization' },
    coordinator: { applicationId: 'alia-app', credentialId: 'alia-credential' },
    requesterAccountId: ACCOUNT_ID,
    ownerAccountId: ACCOUNT_ID,
    actor: { type: 'alia', ownerAccountId: ACCOUNT_ID },
    resource: {
      appId: INBOX_CAPABILITY_CATALOG.appId,
      effectiveAccountId: ACCOUNT_ID,
      resourceType,
      resourceId: resourceType === 'mailbox' ? MAILBOX_ID : ACCOUNT_ID,
    },
    tool: tool.name,
    capabilities: tool.requiredCapabilities,
    limits: [],
    autonomy: 'execute_on_request',
  };
  return issueCapabilityTicket(claims, {
    issuer: 'https://api.oxy.so',
    privateKey: mockKeyPair.privateKey,
    keyId: 'contract-key',
    ttlSeconds: 60,
  });
}

let server: http.Server;
let origin: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/email', emailRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

/** Send one tool call the way a coordinator does. */
async function callOverHttp(
  tool: CatalogTool,
  resourceType: string,
  input: Record<string, unknown>,
) {
  const resolved = resolveCatalogInvocation(INBOX_CAPABILITY_CATALOG, tool, input);
  const headers: Record<string, string> = {
    authorization: `Capability ${ticketFor(tool, resourceType)}`,
    accept: 'application/json',
  };
  if (resolved.body) headers['content-type'] = 'application/json';
  if (tool.idempotency === 'required')
    headers['idempotency-key'] = `contract:${tool.name}:${resourceType}`;
  const response = await fetch(`${origin}${resolved.url.pathname}${resolved.url.search}`, {
    method: resolved.method,
    headers,
    ...(resolved.body ? { body: JSON.stringify(resolved.body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/**
 * The same call through the other transport: the MCP view of the tool's schema
 * parses the arguments (as the MCP server does before any handler runs), then
 * the handler answers, and the result is compared as JSON would carry it.
 */
const mcpDefinitions = new Map(
  createCatalogMcpToolDefinitions(INBOX_MCP_CATALOG, INBOX_MCP_HANDLERS).map((definition) => [
    definition.tool.name,
    definition,
  ]),
);
async function callOverMcp(tool: CatalogTool, input: Record<string, unknown>): Promise<unknown> {
  const definition = mcpDefinitions.get(tool.name);
  if (!definition) throw new Error(`${tool.name} has no MCP handler`);
  const parsed = definition.inputSchema.parse(
    tool.idempotency === 'required'
      ? { ...input, idempotencyKey: `contract:${tool.name}:mcp` }
      : input,
  ) as Record<string, unknown>;
  const result = await definition.handler(parsed, {
    appId: 'inbox',
    tool: definition.tool,
    principal: {
      accountId: ACCOUNT_ID,
      activeAccountId: ACCOUNT_ID,
      connection: null,
      clientId: 'contract-client',
      scopes: tool.requiredCapabilities,
      subject: ACCOUNT_ID,
    },
    request: {},
  } as unknown as CatalogInvocationContext);
  return JSON.parse(JSON.stringify(result.structuredContent));
}

const cases = INBOX_CAPABILITY_CATALOG.tools.flatMap((tool) =>
  tool.resourceTypes.map((resourceType) => [tool.name, resourceType, tool] as const),
);

describe('Inbox catalog contract over HTTP', () => {
  it('has exactly one fixture per catalog tool', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(
      INBOX_CAPABILITY_CATALOG.tools.map(({ name }) => name).sort(),
    );
  });

  it('covers every tool and resource type pairing', () => {
    // A floor, so a catalog that stopped listing resource types cannot make
    // the table below vacuous: 21 tools, 12 of which also accept a mailbox.
    expect(cases.length).toBeGreaterThanOrEqual(INBOX_CAPABILITY_CATALOG.tools.length);
    expect(cases.filter(([, resourceType]) => resourceType === 'mailbox').length).toBeGreaterThan(
      0,
    );
  });

  it.each(cases)(
    '%s with a %s ticket answers 2xx, identically to the other transport',
    async (name, resourceType, tool) => {
      const input = FIXTURES[name];
      if (!input) throw new Error(`No contract fixture for ${name}`);

      const http = await callOverHttp(tool, resourceType, input);
      expect({ tool: name, resourceType, status: http.status, body: http.body }).toEqual({
        tool: name,
        resourceType,
        status: 200,
        body: expect.objectContaining({ data: expect.anything() }),
      });

      // The canonical (validated, defaulted) input both transports hand the tool.
      const expected =
        resourceType === 'mailbox' || !tool.exposure.includes('mcp')
          ? JSON.parse(
              JSON.stringify(
                await INBOX_TOOLS[name]!(input, {
                  accountId: ACCOUNT_ID,
                  ...(resourceType === 'mailbox' ? { mailboxId: MAILBOX_ID } : {}),
                }),
              ),
            )
          : await callOverMcp(tool, input);
      expect(http.body).toEqual(expected);
    },
  );

  it('keeps a mailbox ticket inside its mailbox over HTTP', async () => {
    const thread = INBOX_CAPABILITY_CATALOG.tools.find(({ name }) => name === 'getEmailThread')!;
    const scoped = await callOverHttp(thread, 'mailbox', { emailId: EMAIL_ID });
    expect(scoped.body.data).toEqual([expect.objectContaining({ id: EMAIL_ID })]);

    const read = INBOX_CAPABILITY_CATALOG.tools.find(({ name }) => name === 'readEmail')!;
    const outside = await callOverHttp(read, 'mailbox', { emailId: 'email-in-another-mailbox' });
    expect(outside.status).toBe(404);

    const list = INBOX_CAPABILITY_CATALOG.tools.find(({ name }) => name === 'listEmails')!;
    const otherFolder = await callOverHttp(list, 'mailbox', { mailbox: 'archive' });
    expect(otherFolder.status).toBe(403);
  });
});
