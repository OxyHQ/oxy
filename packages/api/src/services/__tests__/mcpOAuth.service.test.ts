import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { accountClosureFences } from '../../db/schema/accountClosureFences';
import { mcpOauthGrants } from '../../db/schema/mcpOAuth';
import { accountMembers } from '../../db/schema/accountMembers';
import type { AgentKeyBinding } from '../agentKeyAuthority.service';
import type { AppCapabilityCatalog } from '@oxy.so/contracts';
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
  resolveLiveMcpAccessToken,
} from '../mcpOAuth.service';

const keyPair = generateKeyPairSync('ed25519');
const originalKeyId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
const originalPrivateKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
const originalApiUrl = process.env.OXY_API_URL;

beforeAll(async () => {
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'mcp-oauth-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = keyPair.privateKey
    .export({
      format: 'pem',
      type: 'pkcs8',
    })
    .toString();
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
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `MCP resource ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isInternal: true,
      scopes: ['catalogs:write'],
      capabilities: [`catalog:${appSlug}`],
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: 'MCP service credential',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'test-only-secret-hash',
      type: 'service',
      environment: 'production',
      scopes: ['catalogs:write'],
      status: 'active',
    })
    .returning({ id: applicationCredentials.id });
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
    ],
    events: [],
  };
  await getDb()
    .insert(appCapabilityCatalogRegistrations)
    .values({
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

    await expect(
      exchangeMcpAuthorizationCode({
        code: authorization.code,
        clientId: input.client.clientId,
        redirectUri: input.redirectUri,
        codeVerifier: verifier,
        resource: 'https://other.example.test',
      }),
    ).rejects.toBeInstanceOf(McpOAuthError);

    const tokens = await exchangeMcpAuthorizationCode({
      code: authorization.code,
      clientId: input.client.clientId,
      redirectUri: input.redirectUri,
      codeVerifier: verifier,
      resource: input.resource,
    });
    const introspection = await introspectMcpAccessToken(tokens.access_token, input.applicationId);
    expect(introspection?.claims).toMatchObject({
      sub: input.ownerId,
      account_id: input.ownerId,
      client_id: input.client.clientId,
      resource: input.resource,
      aud: input.descriptor.audience,
      scope: 'resource.read',
    });
    // A connection that was never widened still reports itself, with the token's
    // own account as its only member and the one being acted as.
    expect(introspection?.connection).toMatchObject({
      origin_account_id: input.ownerId,
      active_account_id: input.ownerId,
      accounts: [{ account_id: input.ownerId, is_origin: true }],
    });
    await expect(
      introspectMcpAccessToken(tokens.access_token, 'other-application'),
    ).resolves.toBeNull();
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
    await expect(
      introspectMcpAccessToken(second.access_token, input.applicationId),
    ).resolves.not.toBeNull();

    await expect(
      refreshMcpAccessToken({
        refreshToken: first.refresh_token,
        clientId: input.client.clientId,
        resource: input.resource,
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(
      introspectMcpAccessToken(second.access_token, input.applicationId),
    ).resolves.toBeNull();
  });
});

async function autonomousFixture() {
  const f = await fixture();
  await getDb().update(users).set({ kind: 'bot' }).where(eq(users.id, f.ownerId));
  const keys = await getDb()
    .insert(userAuthMethods)
    .values(
      ['A', 'B'].map((label) => ({
        userId: f.ownerId,
        type: 'agent_key' as const,
        methodPublicKey: `fixture-${randomUUID()}`,
        label,
        enrollmentMethod: 'governor' as const,
      })),
    )
    .returning({ id: userAuthMethods.id });
  const binding = (index: number): AgentKeyBinding => ({
    authMethodId: keys[index].id,
    authMethodOwnerId: f.ownerId,
  });
  const verifier = 'b'.repeat(64);
  const approve = (authMethod?: AgentKeyBinding, accountId = f.ownerId) =>
    authorizeMcpConnection({
      principalUserId: f.ownerId,
      effectiveAccountId: accountId,
      authMethod,
      client: f.client,
      descriptor: f.descriptor,
      redirectUri: f.redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['resource.read'],
    });
  const exchange = (code: string) =>
    exchangeMcpAuthorizationCode({
      code,
      clientId: f.client.clientId,
      redirectUri: f.redirectUri,
      codeVerifier: verifier,
      resource: f.resource,
    });
  return { ...f, keys, binding, approve, exchange };
}

it('agent A revocation and B reapproval never rebind old MCP tokens or widen their scopes/resource', async () => {
  const f = await autonomousFixture();
  await expect(f.approve()).rejects.toMatchObject({ code: 'access_denied' });
  const a = await f.exchange((await f.approve(f.binding(0))).code);
  const original = await resolveLiveMcpAccessToken(a.access_token, f.applicationId);
  expect(original?.grant.authMethodId).toBe(f.keys[0].id);
  expect(original?.claims).toMatchObject({
    sub: f.ownerId,
    account_id: f.ownerId,
    resource: f.resource,
    scope: 'resource.read',
  });
  const pendingA = await f.approve(f.binding(0));
  await getDb()
    .update(userAuthMethods)
    .set({ revokedAt: new Date() })
    .where(eq(userAuthMethods.id, f.keys[0].id));
  await expect(f.exchange(pendingA.code)).rejects.toMatchObject({ code: 'invalid_grant' });
  expect(await introspectMcpAccessToken(a.access_token, f.applicationId)).toBeNull();
  await expect(
    refreshMcpAccessToken({
      refreshToken: a.refresh_token,
      clientId: f.client.clientId,
      resource: f.resource,
    }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
  const b = await f.exchange((await f.approve(f.binding(1))).code);
  const replacement = await resolveLiveMcpAccessToken(b.access_token, f.applicationId);
  expect(replacement?.grant.id).not.toBe(original?.grant.id);
  expect(replacement?.grant.authMethodId).toBe(f.keys[1].id);
  expect(replacement?.claims).toMatchObject({
    sub: f.ownerId,
    account_id: f.ownerId,
    resource: f.resource,
    scope: 'resource.read',
  });
  expect(await introspectMcpAccessToken(a.access_token, f.applicationId)).toBeNull();
  expect(await resolveLiveMcpAccessToken(b.access_token, 'another-app')).toBeNull();
  const grants = await getDb()
    .select()
    .from(mcpOauthGrants)
    .where(eq(mcpOauthGrants.principalUserId, f.ownerId));
  expect(grants).toHaveLength(2);
  expect(grants.find((g) => g.authMethodId === f.keys[0].id)?.revokedAt).not.toBeNull();
  await getDb().insert(accountClosureFences).values({ accountId: f.ownerId });
  expect(await resolveLiveMcpAccessToken(b.access_token, f.applicationId)).toBeNull();
  await expect(f.approve(f.binding(1))).rejects.toMatchObject({ code: 'access_denied' });
});

it('agent MCP acting as another account still requires current membership and exact principal ownership', async () => {
  const f = await autonomousFixture();
  const [org] = await getDb()
    .insert(users)
    .values({ kind: 'organization' })
    .returning({ id: users.id });
  await expect(f.approve(f.binding(0), org.id)).rejects.toMatchObject({ code: 'access_denied' });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: org.id, memberUserId: f.ownerId, role: 'admin', status: 'active' });
  const tokens = await f.exchange((await f.approve(f.binding(0), org.id)).code);
  expect(
    (await resolveLiveMcpAccessToken(tokens.access_token, f.applicationId))?.claims,
  ).toMatchObject({ sub: f.ownerId, account_id: org.id });
  await expect(
    f.approve({ ...f.binding(0), authMethodOwnerId: org.id }, org.id),
  ).rejects.toMatchObject({ statusCode: 401 });
  const live = await resolveLiveMcpAccessToken(tokens.access_token, f.applicationId);
  if (!live) throw new Error('Expected live MCP authority');
  await expect(
    getDb()
      .update(mcpOauthGrants)
      .set({ principalUserId: org.id })
      .where(eq(mcpOauthGrants.id, live.grant.id)),
  ).rejects.toMatchObject({ cause: { code: '23503' } });
  await getDb().delete(accountMembers).where(eq(accountMembers.accountId, org.id));
  expect(await resolveLiveMcpAccessToken(tokens.access_token, f.applicationId)).toBeNull();
});
