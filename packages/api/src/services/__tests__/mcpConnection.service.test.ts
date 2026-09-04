import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AppCapabilityCatalog } from '@oxyhq/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appCapabilityCatalogRegistrations } from '../../db/schema/agency';
import { mcpOauthGrants } from '../../db/schema/mcpOAuth';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  McpOAuthError,
  authorizeMcpConnection,
  exchangeMcpAuthorizationCode,
  introspectMcpAccessToken,
  registerMcpClient,
  resolveLiveMcpAccessToken,
  resolveMcpResource,
  revokeMcpGrant,
} from '../mcpOAuth.service';
import {
  approveMcpAccountLink,
  createMcpAccountLinkIntent,
  describeMcpAccountLinkIntent,
  setMcpConnectionActiveAccount,
} from '../mcpConnection.service';

const keyPair = generateKeyPairSync('ed25519');
const originalKeyId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
const originalPrivateKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
const originalApiUrl = process.env.OXY_API_URL;
const originalAuthUrl = process.env.OXY_AUTH_URL;

beforeAll(async () => {
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'mcp-connection-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = keyPair.privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }).toString();
  process.env.OXY_API_URL = 'https://api.oxy.so';
  process.env.OXY_AUTH_URL = 'https://auth.oxy.so';
  await connectPostgres();
});

afterAll(async () => {
  if (originalKeyId === undefined) delete process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
  else process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = originalKeyId;
  if (originalPrivateKey === undefined) delete process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
  else process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = originalPrivateKey;
  if (originalApiUrl === undefined) delete process.env.OXY_API_URL;
  else process.env.OXY_API_URL = originalApiUrl;
  if (originalAuthUrl === undefined) delete process.env.OXY_AUTH_URL;
  else process.env.OXY_AUTH_URL = originalAuthUrl;
  await closePostgres();
});

/**
 * One registered MCP resource plus a connector that already holds tokens for
 * `first`, and a second account (`second`) the same person can act as.
 */
async function connectedFixture() {
  const [first] = await getDb().insert(users).values({ color: 'teal' })
    .returning({ id: users.id });
  const [second] = await getDb().insert(users).values({ color: 'blue' })
    .returning({ id: users.id });
  const appSlug = `mcp-${randomUUID()}`;
  const resource = `https://${appSlug}.example.test`;
  const [application] = await getDb().insert(applications).values({
    name: `MCP resource ${randomUUID()}`,
    ownerAccountId: first.id,
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
    clientName: 'Test assistant',
    redirectUris: [redirectUri],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
  const descriptor = await resolveMcpResource(resource);
  const verifier = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  const authorization = await authorizeMcpConnection({
    principalUserId: first.id,
    effectiveAccountId: first.id,
    client,
    descriptor,
    redirectUri,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['resource.read'],
  });
  const tokens = await exchangeMcpAuthorizationCode({
    code: authorization.code,
    clientId: client.clientId,
    redirectUri,
    codeVerifier: verifier,
    resource,
  });

  return {
    firstAccountId: first.id,
    secondAccountId: second.id,
    applicationId: application.id,
    resource,
    client,
    accessToken: tokens.access_token,
  };
}

async function grantOf(accessToken: string, applicationId: string) {
  const resolved = await resolveLiveMcpAccessToken(accessToken, applicationId);
  if (!resolved) throw new Error('expected a live MCP access token');
  return resolved.grant;
}

describe('MCP connections', () => {
  it('adds a second account through a single-use link and lets the connector act as it', async () => {
    const input = await connectedFixture();
    const grant = await grantOf(input.accessToken, input.applicationId);

    const intent = await createMcpAccountLinkIntent({ grant, scopes: grant.scopes });
    expect(intent.link_url).toMatch(/^https:\/\/auth\.oxy\.so\/mcp\/link\?intent=/);
    const secret = new URL(intent.link_url).searchParams.get('intent') ?? '';

    // The invitation names the client and the scopes, and knows the approving
    // account is not on the connection yet.
    await expect(describeMcpAccountLinkIntent({
      secret,
      effectiveAccountId: input.secondAccountId,
    })).resolves.toMatchObject({
      client_name: 'Test assistant',
      scopes: ['resource.read'],
      already_linked: false,
    });

    await expect(approveMcpAccountLink({
      secret,
      principalUserId: input.secondAccountId,
      effectiveAccountId: input.secondAccountId,
    })).resolves.toMatchObject({ account_id: input.secondAccountId });

    const afterLink = await introspectMcpAccessToken(input.accessToken, input.applicationId);
    expect(afterLink?.connection.accounts.map((account) => account.account_id).sort())
      .toEqual([input.firstAccountId, input.secondAccountId].sort());
    // Linking alone does not move the connector: it still acts as the account
    // whose tokens it holds until it is told to switch.
    expect(afterLink?.connection.active_account_id).toBe(input.firstAccountId);

    await setMcpConnectionActiveAccount({ grant, accountId: input.secondAccountId });
    const afterSwitch = await introspectMcpAccessToken(input.accessToken, input.applicationId);
    expect(afterSwitch?.connection.active_account_id).toBe(input.secondAccountId);
    // The token itself is untouched — it stays bound to the origin account.
    expect(afterSwitch?.claims.account_id).toBe(input.firstAccountId);
  });

  it('spends a link exactly once', async () => {
    const input = await connectedFixture();
    const grant = await grantOf(input.accessToken, input.applicationId);
    const intent = await createMcpAccountLinkIntent({ grant, scopes: grant.scopes });
    const secret = new URL(intent.link_url).searchParams.get('intent') ?? '';

    await approveMcpAccountLink({
      secret,
      principalUserId: input.secondAccountId,
      effectiveAccountId: input.secondAccountId,
    });
    await expect(approveMcpAccountLink({
      secret,
      principalUserId: input.secondAccountId,
      effectiveAccountId: input.secondAccountId,
    })).rejects.toBeInstanceOf(McpOAuthError);
  });

  it('refuses an expired link', async () => {
    const input = await connectedFixture();
    const grant = await grantOf(input.accessToken, input.applicationId);
    const intent = await createMcpAccountLinkIntent({
      grant,
      scopes: grant.scopes,
      now: new Date(Date.now() - 60 * 60 * 1_000),
    });
    const secret = new URL(intent.link_url).searchParams.get('intent') ?? '';

    await expect(approveMcpAccountLink({
      secret,
      principalUserId: input.secondAccountId,
      effectiveAccountId: input.secondAccountId,
    })).rejects.toBeInstanceOf(McpOAuthError);
  });

  it('refuses to act as an account that is not connected', async () => {
    const input = await connectedFixture();
    const grant = await grantOf(input.accessToken, input.applicationId);

    await expect(setMcpConnectionActiveAccount({
      grant,
      accountId: input.secondAccountId,
    })).rejects.toBeInstanceOf(McpOAuthError);
  });

  it('drops a linked account from the connection when that account revokes its own grant', async () => {
    const input = await connectedFixture();
    const grant = await grantOf(input.accessToken, input.applicationId);
    const intent = await createMcpAccountLinkIntent({ grant, scopes: grant.scopes });
    const secret = new URL(intent.link_url).searchParams.get('intent') ?? '';
    await approveMcpAccountLink({
      secret,
      principalUserId: input.secondAccountId,
      effectiveAccountId: input.secondAccountId,
    });
    await setMcpConnectionActiveAccount({ grant, accountId: input.secondAccountId });

    const linkedGrants = await getDb().select({ id: mcpOauthGrants.id })
      .from(mcpOauthGrants)
      .where(and(
        eq(mcpOauthGrants.effectiveAccountId, input.secondAccountId),
        isNull(mcpOauthGrants.revokedAt),
      ));
    expect(linkedGrants).toHaveLength(1);

    await expect(revokeMcpGrant({
      grantId: linkedGrants[0].id,
      principalUserId: input.secondAccountId,
      effectiveAccountId: input.secondAccountId,
    })).resolves.toBe(true);

    // The connector keeps working — as the account it was authorized for.
    const afterRevoke = await introspectMcpAccessToken(input.accessToken, input.applicationId);
    expect(afterRevoke?.connection.accounts.map((account) => account.account_id))
      .toEqual([input.firstAccountId]);
    expect(afterRevoke?.connection.active_account_id).toBe(input.firstAccountId);
  });
});
