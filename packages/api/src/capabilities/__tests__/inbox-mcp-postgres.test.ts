/** Real Oxy Inbox HTTP MCP -> catalog/handlers -> domain -> SQL.
 * Authority is synthetic: no OAuth consent, minting/signature or grant SQL.
 * This is not three-transport parity. External email/AI/avatar effects are isolated.
 */
const mockIntrospect = jest.fn();
const mockResolveResource = jest.fn();
const mockSend = jest.fn(() => { throw new Error('Unexpected outbound email'); });
jest.mock('../../services/mcpOAuth.service', () => ({
  introspectMcpAccessToken: (...args: unknown[]) => mockIntrospect(...args),
  resolveMcpResource: (...args: unknown[]) => mockResolveResource(...args),
}));
jest.mock('../../services/senderAvatar.service', () => ({ getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()) }));
jest.mock('../../services/aiLabeling.service', () => ({ aiLabelingService: { enqueueClassification: jest.fn() } }));
jest.mock('../../services/cardExtraction.service', () => ({ cardExtractionService: { extractAndUpdate: jest.fn() } }));
jest.mock('../../services/smtp.outbound', () => ({
  __esModule: true, smtpOutbound: { send: mockSend, sendRaw: mockSend, sendMdn: mockSend }, default: {},
}));
jest.mock('../../services/emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../../services/assetServiceSingleton', () => ({ assetService: { unlinkFile: jest.fn() } }));

import { randomUUID } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { createInboxMcpHttpService } from '../inbox-mcp-http';
import { INBOX_MCP_CATALOG } from '../inbox.handlers';

let server: Server;
let externalFetch: jest.SpiedFunction<typeof fetch>;
let port: number;
let origin: Awaited<ReturnType<typeof seedAccount>>;
let active: Awaited<ReturnType<typeof seedAccount>>;
const token = 'synthetic-inbox-origin-A-token';
const resource = INBOX_MCP_CATALOG.externalMcp?.resource;
if (!resource) throw new Error('Inbox catalog must expose an MCP resource');
const resourceHost = new URL(resource).host;
const previousApiUrl = process.env.OXY_API_URL;

async function seedAccount(label: string) {
  const [account] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [mailbox] = await getDb().insert(mailboxes).values({
    userId: account.id, name: `Fixture ${label}`, path: `fixture-${label}`,
  }).returning({ id: mailboxes.id });
  const [message] = await getDb().insert(messages).values({
    userId: account.id, mailboxId: mailbox.id, messageId: `<${randomUUID()}@example.test>`,
    fromAddress: 'synthetic@example.test', subject: `Private ${label}`, text: `Body ${label}`,
    size: 10, date: new Date(),
  }).returning({ id: messages.id });
  return { accountId: account.id, mailboxId: mailbox.id, messageId: message.id };
}

beforeAll(async () => {
  externalFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external fetch'));
  process.env.OXY_API_URL = 'https://api.oxy.so';
  const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  expect(databaseName).toMatch(/^oxy_test_[0-9a-f]{16}$/);
  console.info('Inbox fixture disposable database:', databaseName);
  await connectPostgres();
  origin = await seedAccount('A');
  active = await seedAccount('B');
  const app = express();
  const service = createInboxMcpHttpService();
  app.all(service.mcpPath, (req, res) => { void service.handleMcp(req, res); });
  app.use(express.json());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await closePostgres();
  externalFetch.mockRestore();
  if (previousApiUrl === undefined) delete process.env.OXY_API_URL;
  else process.env.OXY_API_URL = previousApiUrl;
});

afterEach(() => {
  expect(externalFetch).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveResource.mockResolvedValue({ registeredByApplicationId: 'synthetic-inbox-app' });
  const now = Math.floor(Date.now() / 1000);
  mockIntrospect.mockResolvedValue({
    claims: {
      iss: 'https://api.oxy.so', sub: origin.accountId, aud: INBOX_MCP_CATALOG.audience,
      resource, client_id: 'synthetic-client', account_id: origin.accountId,
      scope: 'email.read', jti: 'synthetic-jti', iat: now, nbf: now, exp: now + 600,
    },
    connection: {
      connection_id: 'synthetic-connection', origin_account_id: origin.accountId,
      active_account_id: active.accountId,
      accounts: [
        { account_id: origin.accountId, is_origin: true, linked_at: new Date().toISOString() },
        { account_id: active.accountId, is_origin: false, linked_at: new Date().toISOString() },
      ],
    },
  });
});

type RpcBody = {
  result?: { isError?: boolean; structuredContent?: { data?: unknown; pagination?: { total: number } }; content?: unknown };
  error?: { message: string };
};
async function call(name: string, input: Record<string, unknown>) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } });
  return new Promise<{ status: number; body: RpcBody }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
      host: resourceHost, authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

it('lists and reads SQL resources of active B with a token whose origin remains A', async () => {
  const listed = await call('listEmails', { mailbox: active.mailboxId });
  expect(listed.status).toBe(200);
  expect(listed.body.result?.isError).not.toBe(true);
  expect(listed.body.result?.structuredContent).toMatchObject({
    data: [{ id: active.messageId, subject: 'Private B' }], pagination: { total: 1 },
  });
  expect(listed.body.result?.structuredContent?.data).toHaveLength(1);
  const read = await call('readEmail', { emailId: active.messageId });
  expect(read.status).toBe(200);
  expect(read.body.result?.structuredContent).toMatchObject({ data: { id: active.messageId, text: 'Body B' } });
  expect(mockIntrospect).toHaveBeenCalledTimes(2);
  expect(mockIntrospect).toHaveBeenLastCalledWith(token, 'synthetic-inbox-app');
  expect(mockSend).not.toHaveBeenCalled();
});

it.each(['message', 'mailbox'] as const)('refuses the origin A %s while B is active, despite A being linked', async (kind) => {
  const result = await (kind === 'message'
    ? call('readEmail', { emailId: origin.messageId })
    : call('listEmails', { mailbox: origin.mailboxId }));
  expect(result.status).toBe(200); // MCP encodes domain failures in its tool result.
  expect(result.body.result?.isError).toBe(true);
  expect(JSON.stringify(result.body)).toContain(kind === 'message' ? 'Email not found' : 'Mailbox not found');
  expect(JSON.stringify(result.body)).not.toContain('Private A');
  expect(JSON.stringify(result.body)).not.toContain('Body A');
  // Prove ownership refusal, not absence from the database.
  const stored = await getDb().select({ subject: messages.subject }).from(messages).where(eq(messages.id, origin.messageId));
  expect(stored).toEqual([{ subject: 'Private A' }]);
});

it('rejects the next HTTP call when synthetic authority revokes the same token', async () => {
  const before = await call('readEmail', { emailId: active.messageId });
  expect(before.body.result?.structuredContent).toMatchObject({ data: { id: active.messageId } });
  mockIntrospect.mockResolvedValue(null);
  const revoked = await call('readEmail', { emailId: active.messageId });
  expect(revoked.status).toBe(401);
  expect(revoked.body.result).toBeUndefined();
  expect(JSON.stringify(revoked.body)).not.toContain('Body B');
  expect(mockIntrospect).toHaveBeenCalledTimes(2);
  expect(mockIntrospect).toHaveBeenNthCalledWith(2, token, 'synthetic-inbox-app');
  const stored = await getDb().select({ text: messages.text }).from(messages).where(eq(messages.id, active.messageId));
  expect(stored).toEqual([{ text: 'Body B' }]);
  expect(mockSend).not.toHaveBeenCalled();
});
