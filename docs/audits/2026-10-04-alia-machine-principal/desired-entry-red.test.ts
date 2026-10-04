import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Real SDK, bypassing the pass-through router-test alias. App dependencies only.
vi.mock('@oxy.so/core/server', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('@oxy.so/core/server') as Record<string, unknown>;
});
const serviceVerifier = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../lib/oxy-service-client.js', () => ({ oxyServiceClient: () => serviceVerifier.current }));
const observedRefusals = vi.hoisted(() => [] as string[]);
vi.mock('../../lib/logger.js', () => ({ log: { auth: {
  warn: (record: { code?: string }) => { if (record.code) observedRefusals.push(record.code); },
  info: vi.fn(), error: vi.fn(),
} } }));
vi.mock('../../lib/channels/registry.js', () => ({ getConfiguredChannels: () => [] }));

const { OxyServer, OXY_ALIA_RESOURCE_APPLICATION_ID, getOxyAliaMachineCredentialBearer } = await import('@oxy.so/core/server');
const { authenticateTokenOrApiKey } = await import('../auth.baseline-1571.js');
const verifier = new OxyServer({ baseURL: 'https://api.oxy.invalid' });
serviceVerifier.current = verifier;
const introspect = vi.spyOn(verifier.apps, 'introspectAliaMachineCredential');
const principal = {
  kind: 'machine', audience: OXY_ALIA_RESOURCE_APPLICATION_ID, applicationId: 'caller-app',
  credentialId: 'caller-credential', ownerAccountId: 'payer-account', environment: 'development',
  scopes: ['alia:chat', 'inference:invoke'],
} as const;
const machineToken = `oxy_sk_${'a'.repeat(16)}_${'b'.repeat(64)}`;
let server: http.Server;
let origin: string;
let handlerEntries = 0;

beforeAll(async () => {
  const app = express();
  app.post(['/alia/chat', '/v1/chat/completions', '/v1/audio/speech'], authenticateTokenOrApiKey, (req, res) => {
    handlerEntries += 1;
    res.json({ principal: req.machineCredential, user: req.user ?? null, serviceApp: req.serviceApp ?? null,
      forwarded: getOxyAliaMachineCredentialBearer(req) === machineToken });
  });
  app.get('/v1/me', authenticateTokenOrApiKey, (_req, res) => res.json({ unexpected: true }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  handlerEntries = 0;
  introspect.mockReset();
  introspect.mockResolvedValue({ active: true, principal });
});
const send = (route: string, headers: Record<string, string> = {}, method = 'POST') => fetch(`${origin}${route}`, {
  method, headers: { Authorization: `Bearer ${machineToken}`, ...headers },
});

describe('Console machine credential on the actual Alia HTTP auth entry', () => {
  for (const route of ['/alia/chat', '/v1/chat/completions']) {
    it(`${route} admits only the canonical machine principal and forwards no human identity`, async () => {
      const response = await send(route);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ principal, user: null, serviceApp: null, forwarded: true });
      expect(introspect).toHaveBeenCalledWith(machineToken);
    });
  }
  it.each(['/v1/me', '/v1/audio/speech'])('does not enable machine keys on %s', async route => {
    expect((await send(route, {}, route.endsWith('/me') ? 'GET' : 'POST')).status).toBe(403);
    expect(introspect).not.toHaveBeenCalled();
  });
  it.each(['x-oxy-user-id', 'x-oxy-requester-assertion'])('does not manufacture a person from %s', async header => {
    expect((await send('/alia/chat', { [header]: 'claimed-person' })).status).toBe(403);
    expect(handlerEntries).toBe(0);
    expect(introspect).not.toHaveBeenCalled();
  });
  it('preserves the invalid JWT refusal path', async () => {
    expect((await send('/alia/chat', { Authorization: 'Bearer not-a-jwt' })).status).toBe(401);
    expect(observedRefusals.at(-1)).toBe('INVALID_TOKEN_FORMAT');
    expect(handlerEntries).toBe(0);
  });
  it('keeps retired Alia keys retired', async () => {
    const response = await send('/alia/chat', { Authorization: 'Bearer alia_sk_retired' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'credential_retired' });
  });
  it('denies revoked or ungranted keys rather than falling back to Alia identity', async () => {
    introspect.mockResolvedValueOnce({ active: false });
    expect((await send('/alia/chat')).status).toBe(401);
    expect(handlerEntries).toBe(0);
  });
  it('fails closed without exposing a credential-bearing error', async () => {
    introspect.mockRejectedValueOnce(new Error(machineToken));
    const response = await send('/alia/chat');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(machineToken);
    expect(handlerEntries).toBe(0);
  });
});
