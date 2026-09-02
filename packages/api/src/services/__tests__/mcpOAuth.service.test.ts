import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AppCapabilityCatalog } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appCapabilityCatalogRegistrations } from '../../db/schema/agency';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  McpOAuthError,
  authorizeMcpConnection,
  exchangeMcpAuthorizationCode,
  introspectMcpAccessToken,
  refreshMcpAccessToken,
  registerMcpClient,
  resolveMcpResource,
} from '../mcpOAuth.service';

const keyPair = generateKeyPairSync('ed25519');
const originalKeyId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
const originalPrivateKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
const originalApiUrl = process.env.OXY_API_URL;

beforeAll(async () => {
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'mcp-oauth-test';
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

async function fixture() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const appSlug = `mcp-${randomUUID()}`;
  const resource = `https://${appSlug}.example.test`;
  const [application] = await getDb().insert(applications).values({
    name: `MCP resource ${randomUUID()}`,
    ownerAccountId: owner.id,
    status: 'active',
    isInternal: true,
    scopes: ['catalogs:write'],
    capabilities: [`catalog:${appSlug}`],
  }).returning({ id: applications.id });
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId: application.id,
    name: 'MCP service credential',
    publicKey: `oxy_dk_${randomUUID()}`,
    secretHash: 'test-only-secret-hash',
    type: 'service',
    environment: 'production',
    scopes: ['catalogs:write'],
    status: 'active',
  }).returning({ id: applicationCredentials.id });
  const catalog: AppCapabilityCatalog = {
    schemaVersion: '1',
    appId: appSlug,
    version: '1.0.0',
    audience: `${appSlug}-api`,
    internalBaseUrl: 'https://api.example.test',
    accountResourceType: 'account',
    externalMcp: { resource },
    tools: [{
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
    }],
    events: [],
  };
  await getDb().insert(appCapabilityCatalogRegistrations).values({
    appSlug,
    version: catalog.version,
    audience: catalog.audience,
    catalog,
    digest: '0'.repeat(64),
    signature: 'test-signature',
    registeredByApplicationId: application.id,
    registeredByCredentialId: credential.id,
    deployedAt: new Date(),
    active: true,
  });
  const redirectUri = 'http://127.0.0.1:43123/oauth/callback';
  const client = await registerMcpClient({
    clientName: 'MCP test client',
    redirectUris: [redirectUri],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
  return {
    ownerId: owner.id,
    applicationId: application.id,
    resource,
    redirectUri,
    client,
    descriptor: await resolveMcpResource(resource),
  };
}

describe('external MCP OAuth authority', () => {
  it('binds code, token and introspection to the exact client, account and resource', async () => {
    const input = await fixture();
    const verifier = 'v'.repeat(64);
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    const authorization = await authorizeMcpConnection({
      principalUserId: input.ownerId,
      effectiveAccountId: input.ownerId,
      client: input.client,
      descriptor: input.descriptor,
      redirectUri: input.redirectUri,
      codeChallenge,
      scopes: ['resource.read'],
    });

    await expect(exchangeMcpAuthorizationCode({
      code: authorization.code,
      clientId: input.client.clientId,
      redirectUri: input.redirectUri,
      codeVerifier: verifier,
      resource: 'https://other.example.test',
    })).rejects.toBeInstanceOf(McpOAuthError);

    const tokens = await exchangeMcpAuthorizationCode({
      code: authorization.code,
      clientId: input.client.clientId,
      redirectUri: input.redirectUri,
      codeVerifier: verifier,
      resource: input.resource,
    });
    const claims = await introspectMcpAccessToken(tokens.access_token, input.applicationId);
    expect(claims).toMatchObject({
      sub: input.ownerId,
      account_id: input.ownerId,
      client_id: input.client.clientId,
      resource: input.resource,
      aud: input.descriptor.audience,
      scope: 'resource.read',
    });
    await expect(introspectMcpAccessToken(tokens.access_token, 'other-application')).resolves.toBeNull();
  });

  it('rotates refresh tokens and revokes the whole grant on replay', async () => {
    const input = await fixture();
    const verifier = 'r'.repeat(64);
    const authorization = await authorizeMcpConnection({
      principalUserId: input.ownerId,
      effectiveAccountId: input.ownerId,
      client: input.client,
      descriptor: input.descriptor,
      redirectUri: input.redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['resource.read'],
    });
    const first = await exchangeMcpAuthorizationCode({
      code: authorization.code,
      clientId: input.client.clientId,
      redirectUri: input.redirectUri,
      codeVerifier: verifier,
      resource: input.resource,
    });
    const second = await refreshMcpAccessToken({
      refreshToken: first.refresh_token,
      clientId: input.client.clientId,
      resource: input.resource,
    });
    await expect(introspectMcpAccessToken(second.access_token, input.applicationId)).resolves.not.toBeNull();

    await expect(refreshMcpAccessToken({
      refreshToken: first.refresh_token,
      clientId: input.client.clientId,
      resource: input.resource,
    })).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(introspectMcpAccessToken(second.access_token, input.applicationId)).resolves.toBeNull();
  });
});
