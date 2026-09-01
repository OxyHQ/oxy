/**
 * Public manifest route tests: the only 400 conditions (missing/invalid required
 * protocol headers), 404 for a client id that resolves to nothing, correct wiring
 * of the parsed request into the manifest service (device key from
 * expo-extra-params, expect-signature), pass-through of the assembled response,
 * and the code-signing-misconfigured → 500 mapping.
 *
 * The manifest service is mocked — this file is about the ROUTE. Client-id
 * resolution is not mocked: it is a real credential joined to a real application,
 * so "usable credential on an active app" is answered by the same predicate and
 * the same rows production uses. The signing service is real so
 * `CodeSigningNotConfiguredError` is the real class.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockBuild = jest.fn();

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/updates/manifest.service', () => ({
  __esModule: true,
  buildManifestResponse: (...a: unknown[]) => mockBuild(...a),
}));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import updatesRouter from '../updates';
import { errorHandler } from '../../middleware/errorHandler';
import { CodeSigningNotConfiguredError } from '../../services/updates/signing.service';

function makeServer(): http.Server {
  const app = express();
  app.use('/updates/v1', updatesRouter);
  app.use(errorHandler);
  return http.createServer(app);
}

async function get(
  server: http.Server,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string; contentType: string | null }> {
  const address = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'GET', headers });
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') };
}

const VALID_HEADERS = {
  'expo-protocol-version': '1',
  'expo-platform': 'ios',
  'expo-runtime-version': '1.0.0',
  'expo-channel-name': 'production',
};

/**
 * An application with one credential. Both statuses are parameters because the
 * two of them together are what the route's resolution actually decides on.
 */
async function registerClient(
  options: {
    applicationStatus?: 'active' | 'suspended';
    credentialStatus?: 'active' | 'deprecated' | 'revoked';
    expiresAt?: Date;
  } = {}
): Promise<{ clientId: string; applicationId: string }> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({
    id: users.id,
  });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `OTA ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: options.applicationStatus ?? 'active',
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: application.id,
    name: 'updates',
    publicKey: clientId,
    type: 'public',
    environment: 'production',
    status: options.credentialStatus ?? 'active',
    expiresAt: options.expiresAt,
  });
  return { clientId, applicationId: application.id };
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach((done) => {
  jest.clearAllMocks();
  mockBuild.mockResolvedValue({ status: 204, headers: { 'expo-protocol-version': '1' } });
  server = makeServer();
  server.listen(0, done);
});

afterEach((done) => {
  server.close(done);
});

describe('GET /updates/v1/apps/:clientId/manifest — required-header 400s', () => {
  test('missing expo-platform → 400', async () => {
    const { status } = await get(server, '/updates/v1/apps/oxy_dk_x/manifest', {
      'expo-protocol-version': '1',
      'expo-runtime-version': '1.0.0',
    });
    expect(status).toBe(400);
  });

  test('missing expo-runtime-version → 400', async () => {
    const { status } = await get(server, '/updates/v1/apps/oxy_dk_x/manifest', {
      'expo-protocol-version': '1',
      'expo-platform': 'ios',
    });
    expect(status).toBe(400);
  });

  test('unsupported protocol version → 400', async () => {
    const { status } = await get(server, '/updates/v1/apps/oxy_dk_x/manifest', {
      ...VALID_HEADERS,
      'expo-protocol-version': '2',
    });
    expect(status).toBe(400);
  });

  test('unsupported platform → 400', async () => {
    const { status } = await get(server, '/updates/v1/apps/oxy_dk_x/manifest', {
      ...VALID_HEADERS,
      'expo-platform': 'windows',
    });
    expect(status).toBe(400);
  });
});

describe('GET /updates/v1/apps/:clientId/manifest — client id resolution', () => {
  test('unknown client id → 404', async () => {
    const { status } = await get(server, '/updates/v1/apps/oxy_dk_missing/manifest', VALID_HEADERS);
    expect(status).toBe(404);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('revoked credential → 404', async () => {
    const { clientId } = await registerClient({ credentialStatus: 'revoked' });
    const { status } = await get(server, `/updates/v1/apps/${clientId}/manifest`, VALID_HEADERS);
    expect(status).toBe(404);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('deprecated credential inside its rotation grace → resolves', async () => {
    const { clientId } = await registerClient({
      credentialStatus: 'deprecated',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { status } = await get(server, `/updates/v1/apps/${clientId}/manifest`, VALID_HEADERS);
    expect(status).toBe(204);
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });

  test('deprecated credential past its rotation grace → 404', async () => {
    const { clientId } = await registerClient({
      credentialStatus: 'deprecated',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const { status } = await get(server, `/updates/v1/apps/${clientId}/manifest`, VALID_HEADERS);
    expect(status).toBe(404);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('usable credential on a suspended application → 404', async () => {
    const { clientId } = await registerClient({ applicationStatus: 'suspended' });
    const { status } = await get(server, `/updates/v1/apps/${clientId}/manifest`, VALID_HEADERS);
    expect(status).toBe(404);
    expect(mockBuild).not.toHaveBeenCalled();
  });
});

describe('GET /updates/v1/apps/:clientId/manifest — wiring', () => {
  test('parses device key + expect-signature and returns the assembled response', async () => {
    const { clientId, applicationId } = await registerClient();
    mockBuild.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'multipart/mixed; boundary=abc', 'expo-protocol-version': '1' },
      body: Buffer.from('MULTIPART_BODY'),
    });

    const { status, text, contentType } = await get(
      server,
      `/updates/v1/apps/${clientId}/manifest`,
      {
        ...VALID_HEADERS,
        'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"',
        'expo-extra-params': 'oxy-device-id="device-abc", other="y"',
        'expo-current-update-id': 'cur-1',
      }
    );

    expect(status).toBe(200);
    expect(contentType).toContain('multipart/mixed');
    expect(text).toBe('MULTIPART_BODY');

    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId,
        platform: 'ios',
        runtimeVersion: '1.0.0',
        channelName: 'production',
        currentUpdateId: 'cur-1',
        protocolVersion: 1,
        expectSignature: true,
        deviceKey: 'device-abc',
      })
    );
  });

  test('protocol 0 empty 204 passes through with no body', async () => {
    const { clientId } = await registerClient();
    mockBuild.mockResolvedValue({ status: 204, headers: { 'expo-protocol-version': '1' } });
    const { status, text } = await get(server, `/updates/v1/apps/${clientId}/manifest`, {
      ...VALID_HEADERS,
      'expo-protocol-version': '0',
    });
    expect(status).toBe(204);
    expect(text).toBe('');
  });

  test('code signing requested but unconfigured → 500', async () => {
    const { clientId } = await registerClient();
    mockBuild.mockRejectedValue(new CodeSigningNotConfiguredError());
    const { status } = await get(server, `/updates/v1/apps/${clientId}/manifest`, {
      ...VALID_HEADERS,
      'expo-expect-signature': 'sig',
    });
    expect(status).toBe(500);
  });
});
