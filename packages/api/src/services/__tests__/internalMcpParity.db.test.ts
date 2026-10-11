import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { sql } from 'drizzle-orm';
import {
  appCapabilityCatalogSchema,
  canonicalCapabilityJson,
  inputSatisfiesCapabilityLimits,
  type AppCapabilityCatalog,
  type CapabilityTicketClaims,
  type InvocationPrincipal,
  type ResourceRef,
} from '@oxy.so/contracts';
import {
  createCapabilityTicketMiddleware,
  createLiveCapabilityTicketVerifier,
  issueCapabilityTicket,
  verifyCapabilityTicket,
  type CapabilityTicketRequest,
} from '@oxy.so/core/server';
import {
  createCatalogMcpHttpServiceWithInvocationPrincipal,
  createInternalCatalogMcpClient,
  createInternalCatalogMcpHttpService,
  type InvocationContext,
  type InvocationHandlers,
} from '../../../../mcp/src/index';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';

// Test-only tables in the harness's throwaway database; no product schema/DDL.
const keys = generateKeyPairSync('ed25519');
let server: Server;
let origin: string;
let catalog: AppCapabilityCatalog;
let ticket: string;
let claims: CapabilityTicketClaims;
let internal: ReturnType<typeof createInternalCatalogMcpHttpService>;
let external: ReturnType<typeof createCatalogMcpHttpServiceWithInvocationPrincipal>;
const issuer = 'https://api.oxy.so';
const verification = { audience: 'fixture-api', issuer, resolvePublicKey: () => keys.publicKey };

async function hasAccess(account: string) {
  const result = await getDb().execute(
    sql`SELECT allowed FROM i04_parity_access WHERE account = ${account}`,
  );
  return result[0]?.allowed === true;
}
function resourceFor(input: Readonly<Record<string, unknown>>): ResourceRef {
  return {
    appId: 'fixture',
    effectiveAccountId: String(input.account),
    resourceType: 'workspace',
    resourceId: String(input.resource),
  };
}
async function authorize(input: Readonly<Record<string, unknown>>, context: InvocationContext) {
  const account =
    context.principal.kind === 'oauth'
      ? context.principal.activeAccountId
      : context.principal.claims.resource.effectiveAccountId;
  return account === input.account && (await hasAccess(account))
    ? { allowed: true as const, effectiveAccountId: account }
    : { allowed: false as const, reason: 'resource membership revoked or mismatched' };
}
const handler: InvocationHandlers[string] = async (input, context) => {
  const operation =
    context.principal.kind === 'capability'
      ? context.principal.claims.executionAuthorization.id
      : String(input.operation);
  const digest = createHash('sha256').update(canonicalCapabilityJson(input)).digest('hex');
  await getDb().execute(
    sql`INSERT INTO i04_parity_effects(operation, digest, account, resource) VALUES (${operation}, ${digest}, ${String(input.account)}, ${String(input.resource)}) ON CONFLICT DO NOTHING`,
  );
  const row = (
    await getDb().execute(
      sql`SELECT digest, account, resource FROM i04_parity_effects WHERE operation = ${operation}`,
    )
  )[0];
  if (row.digest !== digest) throw new Error('Conflicting operation replay');
  return { structuredContent: { account: row.account, resource: row.resource, effectCount: 1 } };
};

beforeAll(async () => {
  await connectPostgres();
  await getDb().execute(
    sql`CREATE TABLE i04_parity_access(account text PRIMARY KEY, allowed boolean NOT NULL)`,
  );
  await getDb().execute(
    sql`CREATE TABLE i04_parity_effects(operation text PRIMARY KEY, digest text NOT NULL, account text NOT NULL, resource text NOT NULL)`,
  );
  const app = express();
  // Bound synthetic loopback requests before auth/domain work, without storing IPs.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 128,
      keyGenerator: () => 'synthetic-parity-fixture',
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.post(
    '/_oxy/capabilities/writeResource',
    express.json(),
    createCapabilityTicketMiddleware({
      ...verification,
      authorize: async (value) => ({
        allowed: await hasAccess(value.resource.effectiveAccountId),
        reason: 'fixture_live_membership',
      }),
    }),
    async (req: CapabilityTicketRequest, res) => {
      const value = req.capabilityTicket;
      if (
        !value ||
        canonicalCapabilityJson(resourceFor(req.body)) !==
          canonicalCapabilityJson(value.resource) ||
        !inputSatisfiesCapabilityLimits(value.tool, req.body, value.limits)
      ) {
        res.status(403).json({ error: 'resource mismatch' });
        return;
      }
      const context = {
        appId: 'fixture',
        tool: catalog.tools[0],
        principal: { kind: 'capability', claims: value } as InvocationPrincipal,
        request: {},
      } as InvocationContext;
      const decision = await authorize(req.body, context);
      if (!decision.allowed) {
        res.status(403).json({ error: decision.reason });
        return;
      }
      try {
        res.json(await handler(req.body, context));
      } catch {
        res.status(409).json({ error: 'operation conflict' });
      }
    },
  );
  app.use('/_oxy/mcp', (req, res) => {
    void internal.handleMcp(req, res);
  });
  app.use('/mcp', (req, res) => {
    void external.handleMcp(req, res);
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

async function setup(appId: string, account: string, operation: string) {
  await getDb().execute(
    sql`INSERT INTO i04_parity_access(account, allowed) VALUES ('account-A', true), ('account-B', true) ON CONFLICT(account) DO UPDATE SET allowed = true`,
  );
  catalog = appCapabilityCatalogSchema.parse({
    schemaVersion: '1',
    appId,
    version: '1',
    audience: 'fixture-api',
    internalBaseUrl: origin,
    accountResourceType: 'workspace',
    externalMcp: { resource: `${origin}/mcp` },
    tools: [
      {
        name: 'writeResource',
        version: '1',
        description: 'Fixture effect.',
        inputSchema: {
          type: 'object',
          properties: {
            account: { type: 'string' },
            resource: { type: 'string' },
            operation: { type: 'string' },
          },
          required: ['account', 'resource', 'operation'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            account: { type: 'string' },
            resource: { type: 'string' },
            effectCount: { type: 'integer' },
          },
          required: ['account', 'resource', 'effectCount'],
          additionalProperties: false,
        },
        capabilityPackage: 'create',
        requiredCapabilities: ['resource.write'],
        resourceTypes: ['workspace'],
        effect: 'external',
        idempotency: 'required',
        rollback: 'manual',
        exposure: ['internal', 'mcp'],
        limitKeys: [],
        invocation: { method: 'POST', path: '/_oxy/capabilities/writeResource' },
      },
    ],
    events: [],
  });
  const binding = {
    registrationId: `${appId}-registration`,
    version: catalog.version,
    digest: createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex'),
  };
  ticket = issueCapabilityTicket(
    {
      aud: catalog.audience,
      sub: 'alia:account-A',
      requesterAccountId: 'account-A',
      ownerAccountId: 'account-A',
      actor: { type: 'alia', ownerAccountId: 'account-A' },
      coordinator: { applicationId: 'alia', credentialId: 'credential' },
      executionAuthorization: { kind: 'direct_request', id: operation },
      runId: `run-${operation}`,
      resource: {
        appId,
        effectiveAccountId: account,
        resourceType: 'workspace',
        resourceId: 'resource-1',
      },
      tool: 'writeResource',
      capabilities: ['resource.write'],
      limits: [],
      autonomy: 'execute_on_request',
      catalog: binding,
    },
    { issuer, keyId: 'key', privateKey: keys.privateKey },
  );
  claims = verifyCapabilityTicket(ticket, verification);
  const handlers = { writeResource: handler };
  const resolveResource = (input: Readonly<Record<string, unknown>>) => ({
    ...resourceFor(input),
    appId,
  });
  internal = createInternalCatalogMcpHttpService({
    catalog,
    binding,
    handlers,
    resolveResource,
    authorize,
    verifyTicket: createLiveCapabilityTicketVerifier({
      ...verification,
      introspect: async () => ({ active: await hasAccess(account), claims }),
    }),
  });
  external = createCatalogMcpHttpServiceWithInvocationPrincipal({
    catalog,
    handlers,
    authorizationServer: issuer,
    authorize,
    introspectToken: async () => {
      if (!(await hasAccess('account-B'))) return null;
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: issuer,
        sub: 'requester-A',
        aud: catalog.audience,
        resource: `${origin}/mcp`,
        client_id: 'external-client',
        jti: 'oauth-token',
        iat: now,
        exp: now + 60,
        account_id: 'account-A',
        scope: 'resource.write',
        connection: {
          connection_id: 'connection',
          origin_account_id: 'account-A',
          active_account_id: 'account-B',
          accounts: [
            { account_id: 'account-A', is_origin: true, linked_at: '2026-10-02' },
            { account_id: 'account-B', is_origin: false, linked_at: '2026-10-02' },
          ],
        },
      };
    },
  });
}
function externalCall(input: Record<string, unknown>) {
  return fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer fixture-oauth',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'writeResource', arguments: input },
    }),
  });
}

it('preserves origin A → active B, exact A/B resources, live revocation and durable retry parity across the three transports', async () => {
  // Generic contract fixture, not execution against product repositories/deployments.
  const operation = 'operation-parity';
  await setup('fixture', 'account-B', operation);
  const input = { account: 'account-B', resource: 'resource-1', operation };
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
  const legacy = await fetch(`${origin}/_oxy/capabilities/writeResource`, {
    method: 'POST',
    headers: { authorization: `Capability ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(legacy.status).toBe(200);
  const first = await legacy.json();
  const retry = await client.callTool(ticket, 'writeResource', input, {
    idempotencyKey: operation,
  });
  const oauth = await (await externalCall(input)).json();
  expect(retry.structuredContent).toEqual(first.structuredContent);
  expect(oauth.result.structuredContent).toEqual(first.structuredContent);
  expect(
    (
      await getDb().execute(
        sql`SELECT count(*)::int AS count FROM i04_parity_effects WHERE operation = ${operation}`,
      )
    )[0].count,
  ).toBe(1);
  const legacyCall = (value: Record<string, unknown>, proof = ticket) =>
    fetch(`${origin}/_oxy/capabilities/writeResource`, {
      method: 'POST',
      headers: { authorization: `Capability ${proof}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  const wrongAccount = { ...input, account: 'account-A' };
  expect((await legacyCall(wrongAccount)).status).toBe(403);
  expect(
    (await client.callTool(ticket, 'writeResource', wrongAccount, { idempotencyKey: operation }))
      .isError,
  ).toBe(true);
  expect((await (await externalCall(wrongAccount)).json()).result.isError).toBe(true);
  const conflict = { ...input, resource: 'resource-2' };
  expect((await legacyCall(conflict)).status).toBe(403);
  expect(
    (await client.callTool(ticket, 'writeResource', conflict, { idempotencyKey: operation }))
      .isError,
  ).toBe(true);
  expect((await (await externalCall(conflict)).json()).result.isError).toBe(true);
  // New intent has a new authority identity; a client parameter cannot widen the old ticket.
  const nextOperation = 'operation-new-intent';
  const nextTicket = issueCapabilityTicket(
    {
      ...claims,
      executionAuthorization: { kind: 'direct_request', id: nextOperation },
      runId: 'run-new-intent',
    },
    { issuer, keyId: 'key', privateKey: keys.privateKey },
  );
  const previousClaims = claims;
  claims = verifyCapabilityTicket(nextTicket, verification);
  const nextInput = { ...input, operation: nextOperation };
  expect((await legacyCall(nextInput, nextTicket)).status).toBe(200);
  expect(
    (
      await client.callTool(nextTicket, 'writeResource', nextInput, {
        idempotencyKey: nextOperation,
      })
    ).structuredContent,
  ).toEqual(first.structuredContent);
  expect((await (await externalCall(nextInput)).json()).result.structuredContent).toEqual(
    first.structuredContent,
  );
  expect(
    (await getDb().execute(sql`SELECT count(*)::int AS count FROM i04_parity_effects`))[0].count,
  ).toBe(2);
  claims = previousClaims;
  await client.listTools(ticket);
  await getDb().execute(
    sql`UPDATE i04_parity_access SET allowed = false WHERE account = 'account-B'`,
  );
  await expect(
    client.callTool(ticket, 'writeResource', input, { idempotencyKey: operation }),
  ).rejects.toThrow();
  expect((await externalCall(input)).status).toBe(401);
  const revokedLegacy = await fetch(`${origin}/_oxy/capabilities/writeResource`, {
    method: 'POST',
    headers: { authorization: `Capability ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(revokedLegacy.status).toBe(403);
  expect(
    (
      await getDb().execute(
        sql`SELECT count(*)::int AS count FROM i04_parity_effects WHERE operation = ${operation}`,
      )
    )[0].count,
  ).toBe(1);
});
