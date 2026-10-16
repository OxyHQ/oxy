/**
 * An application's file-events endpoint (ADR 0043 D9):
 * `GET`/`PUT`/`DELETE /applications/:appId/files-webhook`, and the challenge
 * that verifies it — against a REAL Postgres; the network is a stubbed
 * `safeFetch` (the challenge's receiver) that falls through to the real guard
 * for unknown URLs.
 *
 *  1. `https` only; a private address and a receiver that does not echo the
 *     challenge are refused (422) and nothing is stored.
 *  2. A verified endpoint is stored with its secret SEALED and its time; the
 *     secret is returned once, never by GET or the application read.
 *  3. The challenge is signed with that new secret.
 *  4. `webhooks:update` is needed; DELETE clears all three columns.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { eq } from 'drizzle-orm';

type Receiver = (body: string, headers: Record<string, string>) => { status: number; body: string };
const mockReceivers = new Map<string, Receiver>();

jest.mock('@oxy.so/core/server', () => {
  const actual = jest.requireActual('@oxy.so/core/server');
  return {
    ...actual,
    safeFetch: async (
      url: string,
      options: { body?: string; headers?: Record<string, string> } = {},
    ) => {
      const receiver = mockReceivers.get(url);
      if (!receiver) return actual.safeFetch(url, options);
      const answer = receiver(String(options.body ?? ''), options.headers ?? {});
      const response = new PassThrough();
      response.end(answer.body);
      return { response, status: answer.status, headers: {}, finalUrl: url };
    },
  };
});

const accountServiceMock = {
  resolveEffectiveAccess: jest.fn(async (userId: string, accountId: string) => {
    const { permissionsForAccountRole } = jest.requireActual('../../utils/accountRoles');
    const role = userId === accountId ? 'owner' : mockGrants.get(`${userId}:${accountId}`);
    return role
      ? { role, permissions: permissionsForAccountRole(role), source: 'direct', membership: null }
      : null;
  }),
  listAccessibleAccounts: jest.fn(async () => []),
};
const mockGrants = new Map<string, string>();
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: accountServiceMock,
}));
let mockCurrentUserId = '';
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: { toString: () => mockCurrentUserId }, isStaff: false };
    next();
  },
}));
jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: async () => {},
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { verifyFileEventSignature } from '@oxy.so/core/server';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, users } from '../../db/schema';
import applicationsRouter from '../applications';
import { errorHandler } from '../../middleware/errorHandler';
import { openFileWebhookSecret } from '../../services/fileEvents.service';

jest.setTimeout(60_000);

let server: http.Server;

function request(
  method: string,
  path: string,
  payload?: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
): Promise<{ status: number; body: any }> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function app(owner: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: 'Webhook App', ownerAccountId: owner, createdByUserId: owner })
    .returning({ id: applications.id });
  return row.id;
}

async function stored(id: string) {
  const [row] = await getDb().select().from(applications).where(eq(applications.id, id));
  return row;
}

const echo: Receiver = (body) => ({
  status: 200,
  body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
});

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  await connectPostgres();
  const server_ = express();
  server_.use(express.json());
  server_.use('/applications', applicationsRouter);
  server_.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = server_.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('/applications/:appId/files-webhook', () => {
  it('stores a verified endpoint with its sealed secret, returned once and signed into the challenge', async () => {
    const owner = await account();
    const appId = await app(owner);
    mockCurrentUserId = owner;
    const url = 'https://receiver.example/oxy/files';
    let challengeSignature = '';
    let challengeBody = '';
    mockReceivers.set(url, (body, headers) => {
      challengeBody = body;
      challengeSignature = headers['oxy-signature'];
      return echo(body, headers);
    });

    const res = await request('PUT', `/applications/${appId}/files-webhook`, { url });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url, secret: expect.stringMatching(/^whsec_/) });

    const row = await stored(appId);
    expect(row.filesWebhookUrl).toBe(url);
    expect(row.filesWebhookVerifiedAt).not.toBeNull();
    expect(row.filesWebhookSecretCiphertext).not.toContain(res.body.secret);
    expect(openFileWebhookSecret(appId, row.filesWebhookSecretCiphertext ?? '')).toBe(
      res.body.secret,
    );

    // The challenge is signed with the new secret (a receiver MAY check it).
    expect(JSON.parse(challengeBody).type).toBe('webhook.challenge');
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(challengeSignature) ?? [];
    expect(t && v1).toBeTruthy();
    const { createHmac } = await import('node:crypto');
    expect(
      createHmac('sha256', res.body.secret).update(`${t}.${challengeBody}`).digest('hex'),
    ).toBe(v1);
    // The SDK hands a receiver the challenge to echo.
    expect(verifyFileEventSignature(challengeBody, {}, '')).toMatchObject({
      type: 'webhook.challenge',
    });

    const read = await request('GET', `/applications/${appId}/files-webhook`);
    expect(read.body).toEqual({ url, verifiedAt: expect.any(String) });
    const detail = await request('GET', `/applications/${appId}`);
    expect(detail.body.application.filesWebhookUrl).toBe(url);
    expect(JSON.stringify(detail.body)).not.toContain(res.body.secret);
    expect(JSON.stringify(detail.body)).not.toContain('SecretCiphertext');

    // A second PUT rotates the secret.
    const again = await request('PUT', `/applications/${appId}/files-webhook`, { url });
    expect(again.body.secret).not.toBe(res.body.secret);

    const cleared = await request('DELETE', `/applications/${appId}/files-webhook`);
    expect(cleared.status).toBe(200);
    expect(await stored(appId)).toMatchObject({
      filesWebhookUrl: null,
      filesWebhookSecretCiphertext: null,
      filesWebhookVerifiedAt: null,
    });
  });

  it('refuses http, a private address, and a receiver that does not echo — storing nothing', async () => {
    const owner = await account();
    const appId = await app(owner);
    mockCurrentUserId = owner;

    expect(
      (
        await request('PUT', `/applications/${appId}/files-webhook`, {
          url: 'http://receiver.example/x',
        })
      ).status,
    ).toBe(400);

    const internal = await request('PUT', `/applications/${appId}/files-webhook`, {
      url: 'https://127.0.0.1/hook',
    });
    expect(internal).toMatchObject({ status: 422, body: { error: 'WEBHOOK_VERIFICATION_FAILED' } });

    const wrong = 'https://wrong.example/hook';
    mockReceivers.set(wrong, () => ({ status: 200, body: '{"challenge":"something else"}' }));
    expect(
      (await request('PUT', `/applications/${appId}/files-webhook`, { url: wrong })).status,
    ).toBe(422);

    const failing = 'https://failing.example/hook';
    mockReceivers.set(failing, () => ({ status: 500, body: '' }));
    expect(
      (await request('PUT', `/applications/${appId}/files-webhook`, { url: failing })).status,
    ).toBe(422);

    expect((await stored(appId)).filesWebhookUrl).toBeNull();
  });

  it('needs webhooks:update', async () => {
    const owner = await account();
    const appId = await app(owner);
    const viewer = await account();
    mockGrants.set(`${viewer}:${owner}`, 'viewer');
    mockCurrentUserId = viewer;
    const url = 'https://viewer.example/hook';
    mockReceivers.set(url, echo);
    expect((await request('PUT', `/applications/${appId}/files-webhook`, { url })).status).toBe(
      403,
    );
    expect((await stored(appId)).filesWebhookUrl).toBeNull();
  });
});
