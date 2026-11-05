/** Real external OAuth grants and workloads; only byte storage/fetching are stubbed. */
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
const mockUpload = jest.fn(async (..._args: unknown[]) => ({
  file: { id: 'mcp-file', size: 4, mime: 'image/png', visibility: 'public', sha256: 'hash' },
  deduplicated: false,
}));
const mockImport = jest.fn(async (..._args: unknown[]) => ({
  file: {
    id: 'mcp-file',
    size: 4,
    mime: 'image/png',
    visibility: 'public',
    sha256: 'hash',
    status: 'active',
  },
  outcome: 'downloaded',
  deduplicated: false,
  source: { host: 'media.example.test', fetchedAt: new Date(), etag: null, lastModified: null },
}));
jest.mock('../assetServiceSingleton', () => ({
  assetService: { uploadUserMediaStreamDetailed: (...args: unknown[]) => mockUpload(...args) },
  s3Service: {},
}));
jest.mock('../fileIngestSingleton', () => ({
  fileImportService: { importFromUrl: (...args: unknown[]) => mockImport(...args) },
  fileIngestService: {},
}));
jest.mock('../fileAccessGrant.service', () => ({
  ...jest.requireActual('../fileAccessGrant.service'),
  grantUploadAccess: jest.fn(),
}));
const mockDocument = {
  uploadId: 'document-upload',
  status: 'uploading',
  size: 4,
  mime: 'application/pdf',
  visibility: 'private',
  reference: null,
  metadata: {} as Record<string, unknown>,
};
const mockLargeOpen = jest.fn(async (...args: unknown[]) => {
  mockDocument.metadata = (args[2] as { metadata: Record<string, unknown> }).metadata;
  return mockDocument;
});
const mockLargeComplete = jest.fn(async (..._args: unknown[]) => ({
  ...mockDocument,
  status: 'verifying',
}));
jest.mock('../fileUploadSessionSingleton', () => ({
  fileUploadSessionService: {
    open: (...args: unknown[]) => mockLargeOpen(...args),
    load: jest.fn(async () => mockDocument),
    complete: (...args: unknown[]) => mockLargeComplete(...args),
    describe: jest.fn(async () => mockDocument),
    requestPartUrls: jest.fn(async () => mockDocument),
  },
}));
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { AppCapabilityCatalog } from '@oxy.so/contracts';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { applications } from '../../db/schema/applications';
import { mcpOauthGrants, mcpOauthClients } from '../../db/schema/mcpOAuth';
import { bindWorkloadIdentity } from '../workloadIdentityBinding.service';
import { registerFirstPartyCapabilityCatalog } from '../capabilityCatalog.service';
import {
  registerMcpClient,
  resolveMcpResource,
  authorizeMcpConnection,
  exchangeMcpAuthorizationCode,
  resolveLiveMcpAccessToken,
} from '../mcpOAuth.service';
import {
  resolveExternalMcpMediaRequest,
  externalDocumentMetadata,
} from '../externalMcpMediaRequester.service';
import assetsRouter from '../../routes/assets';
import privacyRouter from '../../routes/privacy';
import internalRouter from '../../routes/internal';
import { errorHandler } from '../../middleware/errorHandler';
const app = express();
app.use(express.json());
app.use('/assets', assetsRouter);
app.use('/privacy', privacyRouter);
app.use('/internal', internalRouter);
app.use(errorHandler);
const saved = { ...process.env };
let databaseUrl: string | undefined;
jest.setTimeout(60_000);
beforeAll(async () => {
  await closePostgres();
  databaseUrl = await createTestDatabase();
  process.env.DATABASE_URL = databaseUrl;
  const keys = generateKeyPairSync('ed25519');
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'mcp-media-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = keys.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
  if (databaseUrl) await dropTestDatabase(databaseUrl);
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
async function fixture(scopes = ['social.media.create'], housing = false) {
  const [owner, user, other] = await insertAccountFixtures([{}, {}, {}]);
  const [application] = await getDb()
    .insert(applications)
    .values({
      ...(housing ? { id: '6a2f851751b784a86fd0e922' } : {}),
      name: 'MCP media recipient',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: [],
      capabilities: [],
    })
    .returning();
  const { binding } = await bindWorkloadIdentity({
    applicationId: application.id,
    subject: `arn:aws:iam::237343248947:role/mcp-media-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  const presenter = {
    authority: 'first_party' as const,
    applicationId: application.id,
    credentialId: binding.attestationId,
    ownerAccountId: owner.id,
    capabilities: [],
  };
  const resource = `https://mcp-${randomUUID()}.example.test`;
  const catalog: AppCapabilityCatalog = {
    schemaVersion: '1',
    appId: `mcp-${randomUUID()}`,
    version: '1.0.0',
    audience: `mcp-${randomUUID()}`,
    internalBaseUrl: 'https://mention.example.test',
    accountResourceType: 'mention_account',
    externalMcp: { resource },
    events: [],
    tools: (housing
      ? ['uploadLeaseDocument', 'submitApplication', 'addApplicationDocuments', 'unrelated-write']
      : ['upload-media', 'upload-media-from-url', 'unrelated-write']
    ).map((name) => ({
      name,
      version: '1.0.0',
      description: 'Existing media action',
      inputSchema: { type: 'object', additionalProperties: false },
      capabilityPackage: 'create',
      requiredCapabilities: [
        name === 'unrelated-write'
          ? 'social.other.write'
          : housing
            ? name === 'uploadLeaseDocument'
              ? 'housing.leases.manage'
              : 'housing.applications.submit'
            : 'social.media.create',
      ],
      resourceTypes: housing ? ['homiio_account'] : ['mention_account', 'media'],
      effect: 'write',
      idempotency: 'supported',
      rollback: 'supported',
      exposure: ['mcp'],
      limitKeys: [],
      invocation: {
        method: 'POST',
        path: `/_oxy/capabilities/${name}`,
      },
    })),
  };
  await registerFirstPartyCapabilityCatalog({ applicationId: application.id, catalog });
  const client = await registerMcpClient({
    clientName: 'External MCP consumer',
    redirectUris: ['https://external.example.test/callback'],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
  const verifier = 'v'.repeat(64);
  const code = await authorizeMcpConnection({
    principalUserId: user.id,
    effectiveAccountId: user.id,
    client,
    descriptor: await resolveMcpResource(resource),
    redirectUri: client.redirectUris[0],
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    scopes,
  });
  const tokens = await exchangeMcpAuthorizationCode({
    code: code.code,
    clientId: client.clientId,
    redirectUri: client.redirectUris[0],
    codeVerifier: verifier,
    resource,
  });
  const resolved = await resolveLiveMcpAccessToken(tokens.access_token, application.id);
  if (!resolved) throw new Error('Fixture grant missing');
  const token = signServiceTokenEd25519({
    type: 'service',
    authority: 'first_party',
    appId: application.id,
    appName: application.name,
    credentialId: binding.attestationId,
    ownerAccountId: owner.id,
    environment: 'development',
    tier: 'internal',
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  if (!token) throw new Error('Fixture service token missing');
  const headers = (tool = 'upload-media', accountId = user.id) => ({
    Authorization: `Bearer ${token}`,
    'X-Oxy-Mcp-Media-Token': tokens.access_token,
    'X-Oxy-Mcp-Media-Tool': tool,
    'x-owner-user-id': accountId,
  });
  return { owner, user, other, application, presenter, client, resolved, headers, tokens };
}
it('uploads and imports with the existing external tool grant and preserves external client/account provenance', async () => {
  const f = await fixture();
  const operation = await resolveExternalMcpMediaRequest(f.presenter, {
    method: 'POST',
    baseUrl: '/assets',
    path: '/service/user-media',
    headers: {
      'x-oxy-mcp-media-token': f.tokens.access_token,
      'x-oxy-mcp-media-tool': 'upload-media',
      'x-owner-user-id': f.user.id,
    },
  });
  expect(operation).toMatchObject({
    authority: 'external',
    clientId: f.client.clientId,
    originGrantId: f.resolved.grant.id,
    activeGrantId: f.resolved.grant.id,
    requesterAccountId: f.user.id,
    effectiveAccountId: f.user.id,
    scopes: ['social.media.create'],
  });
  expect(
    (
      await request(app)
        .post('/assets/service/user-media')
        .set(f.headers())
        .set('Content-Type', 'image/png')
        .send(Buffer.from('test'))
    ).status,
  ).toBe(200);
  const imported = await request(app)
    .post('/assets/service/user-media/import')
    .set(f.headers('upload-media-from-url'))
    .send({ sourceUrl: 'https://media.example.test/image.png' });
  expect(imported.status).toBe(200);
  expect(mockImport).toHaveBeenLastCalledWith(
    { kind: 'account', userId: f.user.id },
    expect.objectContaining({ sourceUrl: 'https://media.example.test/image.png' }),
    f.application.id,
  );
});
it('rejects another action, selected account, receiver, mixed proof, application reference and arbitrary private/session APIs', async () => {
  const f = await fixture();
  const before = mockUpload.mock.calls.length;
  const upload = (headers = f.headers()) =>
    request(app)
      .post('/assets/service/user-media')
      .set(headers)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('test'));
  expect((await upload(f.headers('upload-media', f.other.id))).status).toBe(403);
  expect((await upload(f.headers('unrelated-write'))).status).toBe(403);
  expect((await upload(f.headers('upload-media-from-url'))).status).toBe(403);
  expect((await upload().set('X-Oxy-Task-Id', 'unproven-root')).status).toBe(403);
  const other = await fixture();
  expect(
    (await upload({ ...f.headers(), Authorization: other.headers().Authorization })).status,
  ).toBe(403);
  expect((await request(app).get('/privacy/blocked').set(f.headers())).status).toBe(403);
  expect(
    (
      await request(app)
        .post(`/internal/accounts/${f.user.id}/service-switch`)
        .set(f.headers())
        .send({})
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/assets/service/user-media/import')
        .set(f.headers('upload-media-from-url'))
        .send({
          sourceUrl: 'https://media.example.test/image.png',
          reference: { entityType: 'post', entityId: 'unrelated' },
        })
    ).status,
  ).not.toBe(200);
  expect(mockUpload.mock.calls.length).toBe(before);
});
it('requires the existing media scope and rechecks client and grant revocation on every call', async () => {
  const noScope = await fixture(['social.other.write']);
  const upload = (f: Awaited<ReturnType<typeof fixture>>) =>
    request(app)
      .post('/assets/service/user-media')
      .set(f.headers())
      .set('Content-Type', 'image/png')
      .send(Buffer.from('test'));
  expect((await upload(noScope)).status).toBe(403);
  const f = await fixture();
  expect((await upload(f)).status).toBe(200);
  await getDb()
    .update(mcpOauthGrants)
    .set({ revokedAt: new Date() })
    .where(eq(mcpOauthGrants.id, f.resolved.grant.id));
  expect((await upload(f)).status).toBe(403);
  const client = await fixture();
  await getDb()
    .update(mcpOauthClients)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(mcpOauthClients.id, client.client.id));
  expect((await upload(client)).status).toBe(403);
});

it('keeps external housing uploads private, bounded, on the active account and live until commit', async () => {
  const f = await fixture(['housing.leases.manage', 'housing.applications.submit'], true);
  const base = '/assets/service/user-media/uploads';
  expect(
    externalDocumentMetadata(undefined, {
      _oxy_mcp_document_authority: { clientId: 'forged' },
      ordinary: true,
    }),
  ).toEqual({ ordinary: true });
  const input = { sha256: 'a'.repeat(64), size: 4, mime: 'application/pdf', visibility: 'private' };
  for (const tool of ['uploadLeaseDocument', 'submitApplication', 'addApplicationDocuments']) {
    expect((await request(app).post(base).set(f.headers(tool)).send(input)).status).toBe(201);
  }
  for (const change of [
    { visibility: 'public' },
    { size: 10 * 1024 * 1024 + 1 },
    { mime: 'text/plain' },
  ]) {
    expect(
      (
        await request(app)
          .post(base)
          .set(f.headers('uploadLeaseDocument'))
          .send({ ...input, ...change })
      ).status,
    ).toBe(403);
  }
  expect(
    (await request(app).post(base).set(f.headers('uploadLeaseDocument', f.other.id)).send(input))
      .status,
  ).toBe(403);
  expect((await request(app).post(base).set(f.headers('unrelated-write')).send(input)).status).toBe(
    403,
  );
  expect(
    (
      await request(app)
        .post('/assets/service/user-media/import')
        .set(f.headers('uploadLeaseDocument'))
        .send({})
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post(`${base}/document-upload/complete`)
        .set(f.headers('uploadLeaseDocument'))
        .send({})
    ).status,
  ).toBe(403);
  await request(app).post(base).set(f.headers('uploadLeaseDocument')).send(input);
  expect(
    (
      await request(app)
        .post(`${base}/document-upload/complete`)
        .set(f.headers('uploadLeaseDocument'))
        .send({})
    ).status,
  ).toBe(202);
  const anotherClient = await registerMcpClient({
    clientName: 'Other document client',
    redirectUris: ['https://another.example.test/callback'],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
  const verifier = 'q'.repeat(64);
  const anotherCode = await authorizeMcpConnection({
    principalUserId: f.user.id,
    effectiveAccountId: f.user.id,
    client: anotherClient,
    descriptor: await resolveMcpResource(f.resolved.grant.resource),
    redirectUri: anotherClient.redirectUris[0],
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['housing.leases.manage'],
  });
  const anotherToken = await exchangeMcpAuthorizationCode({
    code: anotherCode.code,
    clientId: anotherClient.clientId,
    redirectUri: anotherClient.redirectUris[0],
    codeVerifier: verifier,
    resource: f.resolved.grant.resource,
  });
  expect(
    (
      await request(app)
        .post(`${base}/document-upload/complete`)
        .set({
          ...f.headers('uploadLeaseDocument'),
          'X-Oxy-Mcp-Media-Token': anotherToken.access_token,
        })
        .send({})
    ).status,
  ).toBe(403);
  mockDocument.visibility = 'public';
  expect(
    (await request(app).get(`${base}/document-upload`).set(f.headers('uploadLeaseDocument')))
      .status,
  ).toBe(403);
  mockDocument.visibility = 'private';
  const committed = mockLargeComplete.mock.calls.length;
  await getDb()
    .update(mcpOauthGrants)
    .set({ revokedAt: new Date() })
    .where(eq(mcpOauthGrants.id, f.resolved.grant.id));
  expect(
    (
      await request(app)
        .post(`${base}/document-upload/complete`)
        .set(f.headers('uploadLeaseDocument'))
        .send({})
    ).status,
  ).toBe(403);
  expect(mockLargeComplete).toHaveBeenCalledTimes(committed);
});
