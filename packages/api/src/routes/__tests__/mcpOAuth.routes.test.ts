/**
 * The external MCP OAuth HTTP contract against real Postgres. The service-level
 * suite owns token lifecycle races; this suite proves the public wire format and
 * the authenticated consent/introspection edges use those bindings unchanged.
 */

import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mcpOAuthConsentResponseSchema,
  type AppCapabilityCatalog,
} from '@oxyhq/contracts';
import { eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';

let principalUserId = '';
let serviceApplicationId = '';
let serviceCredentialId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { oxyToken?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.oxyToken = {
      principalUserId,
      subjectAccountId: principalUserId,
    };
    next();
  },
  serviceAuthMiddleware: (
    req: { serviceApp?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = {
      appId: serviceApplicationId,
      credentialId: serviceCredentialId,
      ownerAccountId: principalUserId,
      environment: 'production',
      scopes: ['catalogs:write'],
    };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appCapabilityCatalogRegistrations } from '../../db/schema/agency';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import mcpOAuthRouter, { mcpOAuthDiscoveryRouter } from '../mcpOAuth';

const keyPair = generateKeyPairSync('ed25519');
const originalKeyId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
const originalPrivateKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
const originalApiUrl = process.env.OXY_API_URL;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(mcpOAuthDiscoveryRouter);
app.use('/auth/mcp/oauth', mcpOAuthRouter);

async function fixture(): Promise<{
  resource: string;
  redirectUri: string;
  resourceAppName: string;
  appId: string;
}> {
  const username = `mcp-owner-${randomUUID()}`;
  const [owner] = await getDb().insert(users).values({
    username,
    nameDisplay: 'Route Test Workspace',
    color: 'teal',
  }).returning({ id: users.id });
  principalUserId = owner.id;
  const appSlug = `mcp-route-${randomUUID()}`;
  const resource = `https://${appSlug}.example.test`;
  const resourceAppName = `MCP route resource ${randomUUID()}`;
  const [application] = await getDb().insert(applications).values({
    name: resourceAppName,
    ownerAccountId: owner.id,
    status: 'active',
    isInternal: true,
    scopes: ['catalogs:write'],
    capabilities: [`catalog:${appSlug}`],
  }).returning({ id: applications.id });
  serviceApplicationId = application.id;
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId: application.id,
    name: 'MCP route service credential',
    publicKey: `oxy_dk_${randomUUID()}`,
    secretHash: 'test-only-secret-hash',
    type: 'service',
    environment: 'production',
    scopes: ['catalogs:write'],
    status: 'active',
  }).returning({ id: applicationCredentials.id });
  serviceCredentialId = credential.id;
  const catalog: AppCapabilityCatalog = {
    schemaVersion: '1',
    appId: appSlug,
    version: '1.0.0',
    audience: `${appSlug}-api`,
    internalBaseUrl: 'https://api.example.test',
    accountResourceType: 'account',
    externalMcp: { resource },
    tools: [
      {
        name: 'readResource',
        version: '1.0.0',
        description: 'Read the selected account resource.',
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object' },
        capabilityPackage: 'read',
        requiredCapabilities: ['resource.read'],
        resourceTypes: ['account'],
        effect: 'read',
        idempotency: 'none',
        rollback: 'none',
        exposure: ['mcp'],
        limitKeys: [],
        invocation: { method: 'GET', path: '/resource' },
      },
      {
        name: 'updateResource',
        version: '1.0.0',
        description: 'Update the selected account resource.',
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object' },
        capabilityPackage: 'create',
        requiredCapabilities: ['resource.write'],
        resourceTypes: ['account'],
        effect: 'write',
        idempotency: 'required',
        rollback: 'supported',
        exposure: ['mcp'],
        limitKeys: [],
        invocation: { method: 'PATCH', path: '/resource' },
      },
    ],
    events: [],
  };
  await getDb().insert(appCapabilityCatalogRegistrations).values({
    appSlug,
    version: catalog.version,
    audience: catalog.audience,
    catalog,
    digest: '1'.repeat(64),
    signature: 'test-signature',
    registeredByApplicationId: application.id,
    registeredByCredentialId: credential.id,
    deployedAt: new Date(),
    active: true,
  });
  return {
    resource,
    redirectUri: 'http://127.0.0.1:43123/oauth/callback',
    resourceAppName,
    appId: appSlug,
  };
}

beforeAll(async () => {
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'mcp-oauth-route-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = keyPair.privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }).toString();
  process.env.OXY_API_URL = 'https://api.oxy.so';
  await connectPostgres();
});

afterAll(async () => {
  if (originalKeyId === undefined) delete process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
  else process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = originalKeyId;
  if (originalPrivateKey === undefined) delete process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
  else process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = originalPrivateKey;
  if (originalApiUrl === undefined) delete process.env.OXY_API_URL;
  else process.env.OXY_API_URL = originalApiUrl;
  await closePostgres();
});

it('publishes discovery and completes a resource-bound public-client flow', async () => {
  const input = await fixture();
  const discovery = await request(app).get('/.well-known/oauth-authorization-server');
  expect(discovery.status).toBe(200);
  expect(discovery.body).toMatchObject({
    issuer: 'https://api.oxy.so',
    authorization_endpoint: 'https://auth.oxy.so/authorize',
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    resource_parameter_supported: true,
  });
  expect(discovery.body.scopes_supported).toContain('resource.read');

  const registration = await request(app).post('/auth/mcp/oauth/register').send({
    client_name: 'Route test MCP client',
    redirect_uris: [input.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  expect(registration.status).toBe(201);
  const clientId = registration.body.client_id as string;
  expect(clientId).toMatch(/^oxy_mcp_/);
  expect(registration.body).not.toHaveProperty('client_secret');

  const wrongRedirect = await request(app)
    .get(`/auth/mcp/oauth/client/${encodeURIComponent(clientId)}`)
    .query({ resource: input.resource, redirectUri: 'https://wrong.example/callback' });
  expect(wrongRedirect.status).toBe(400);

  const client = await request(app)
    .get(`/auth/mcp/oauth/client/${encodeURIComponent(clientId)}`)
    .query({ resource: input.resource, redirectUri: input.redirectUri });
  expect(client.status).toBe(200);
  expect(client.body.application).toMatchObject({
    clientId,
    name: 'Route test MCP client',
    scopes: ['resource.read', 'resource.write'],
    type: 'third_party',
    isInternal: false,
  });
  expect(client.body.application).not.toHaveProperty('redirectUris');

  const consent = await request(app)
    .get('/auth/mcp/oauth/consent')
    .set('authorization', 'Bearer user-session')
    .query({
      clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scope: 'resource.read resource.write',
      accountId: principalUserId,
    });
  expect(consent.status).toBe(200);
  expect(mcpOAuthConsentResponseSchema.parse(consent.body)).toMatchObject({
    consentRequired: true,
    context: {
      client: { clientId, name: 'Route test MCP client' },
      account: { id: principalUserId, displayName: 'Route Test Workspace' },
      resource: {
        appId: input.appId,
        uri: input.resource,
        application: { name: input.resourceAppName },
      },
      capabilities: ['resource.read', 'resource.write'],
      writeActions: [{
        name: 'updateResource',
        version: '1.0.0',
        description: 'Update the selected account resource.',
        requiredCapabilities: ['resource.write'],
        effect: 'write',
      }],
    },
  });

  const verifier = 'r'.repeat(64);
  const authorization = await request(app)
    .post('/auth/mcp/oauth/authorize')
    .set('authorization', 'Bearer user-session')
    .send({
      responseType: 'code',
      clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scope: 'resource.read resource.write',
      accountId: principalUserId,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      state: 'client-state',
    });
  expect(authorization.status).toBe(200);
  expect(authorization.body).toMatchObject({ state: 'client-state' });
  expect(typeof authorization.body.code).toBe('string');

  const token = await request(app)
    .post('/auth/mcp/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code: authorization.body.code,
      client_id: clientId,
      redirect_uri: input.redirectUri,
      code_verifier: verifier,
      resource: input.resource,
    });
  expect(token.status).toBe(200);
  expect(token.headers['cache-control']).toBe('no-store');
  expect(token.body).toMatchObject({
    token_type: 'Bearer',
    scope: 'resource.read resource.write',
    resource: input.resource,
  });

  const introspection = await request(app)
    .post('/auth/mcp/oauth/introspect')
    .set('authorization', 'Bearer service-token')
    .send({ token: token.body.access_token });
  expect(introspection.status).toBe(200);
  expect(introspection.body).toMatchObject({
    active: true,
    sub: principalUserId,
    account_id: principalUserId,
    client_id: clientId,
    resource: input.resource,
  });

  await getDb().update(applicationCredentials).set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(applicationCredentials.id, serviceCredentialId));
  const afterServiceRevocation = await request(app)
    .post('/auth/mcp/oauth/introspect')
    .set('authorization', 'Bearer service-token')
    .send({ token: token.body.access_token });
  expect(afterServiceRevocation.status).toBe(401);
  expect(afterServiceRevocation.body).toMatchObject({ error: 'invalid_client' });
});

it('rejects insecure remote redirect URIs at dynamic registration', async () => {
  const response = await request(app).post('/auth/mcp/oauth/register').send({
    client_name: 'Insecure MCP client',
    redirect_uris: ['http://client.example/callback'],
    token_endpoint_auth_method: 'none',
  });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ error: 'invalid_request' });
});

it('requires the selected account and never presents an unrequested write action', async () => {
  const input = await fixture();
  const registration = await request(app).post('/auth/mcp/oauth/register').send({
    client_name: 'Read-only MCP client',
    redirect_uris: [input.redirectUri],
    token_endpoint_auth_method: 'none',
  });
  const clientId = registration.body.client_id as string;

  const readOnlyConsent = await request(app)
    .get('/auth/mcp/oauth/consent')
    .set('authorization', 'Bearer user-session')
    .query({
      clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scope: 'resource.read',
      accountId: principalUserId,
    });
  expect(readOnlyConsent.status).toBe(200);
  expect(readOnlyConsent.body.context).toMatchObject({
    account: { id: principalUserId },
    resource: { appId: input.appId, uri: input.resource },
    capabilities: ['resource.read'],
    writeActions: [],
  });

  const mismatchedAccount = await request(app)
    .get('/auth/mcp/oauth/consent')
    .set('authorization', 'Bearer user-session')
    .query({
      clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scope: 'resource.read',
      accountId: 'another-account',
    });
  expect(mismatchedAccount.status).toBe(403);
  expect(mismatchedAccount.body).toMatchObject({ error: 'access_denied' });
});
