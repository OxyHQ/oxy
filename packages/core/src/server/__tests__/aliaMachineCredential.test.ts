import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createOxyAliaMachineCredentialAuth, getOxyAliaMachineCredentialBearer,
  isOxyAliaMachinePrincipal, OXY_ALIA_RESOURCE_APPLICATION_ID,
  type AliaMachineCredentialIntrospection, type OxyAliaMachineRequest,
} from '../aliaMachineCredential';
import { OxyServer } from '../OxyServer';

const principal = {
  kind: 'machine', audience: OXY_ALIA_RESOURCE_APPLICATION_ID,
  applicationId: 'caller-app', credentialId: 'caller-credential', ownerAccountId: 'payer-account',
  environment: 'production', scopes: ['alia:chat', 'inference:invoke'],
} as const;
const token = 'oxy_sk_synthetic_test_token';

describe('Alia-only machine credential contract', () => {
  let server: http.Server;
  let origin: string;
  const introspect = jest.fn<Promise<AliaMachineCredentialIntrospection>, [string]>();
  beforeAll(async () => {
    const app = express();
    app.post('/chat', createOxyAliaMachineCredentialAuth(
      { apps: { introspectAliaMachineCredential: introspect } }, { environment: 'production' },
    ), (req, res) => {
      const p = (req as OxyAliaMachineRequest).machineCredential;
      res.json({ principal: p, forwarded: getOxyAliaMachineCredentialBearer(req) === token,
        user: Reflect.get(req, 'user') ?? null, serviceApp: Reflect.get(req, 'serviceApp') ?? null,
        enumerableBearer: Object.values(req).includes(token) || Object.values(p ?? {}).includes(token) });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => { introspect.mockReset(); introspect.mockResolvedValue({ active: true, principal }); });
  const send = (headers: Record<string, string> = {}) => fetch(`${origin}/chat`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers },
  });

  it('admits app-only authority and keeps the bearer out of principal serialization', async () => {
    const response = await send();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ principal, forwarded: true, user: null, serviceApp: null, enumerableBearer: false });
    expect(JSON.stringify(body)).not.toContain(token);
  });
  it.each(['x-oxy-user-id', 'x-oxy-requester-assertion'])('rejects claimed person authority via %s before introspection', async header => {
    expect((await send({ [header]: 'untrusted-person' })).status).toBe(403);
    expect(introspect).not.toHaveBeenCalled();
  });
  it('revalidates every request, including revocation after an accepted request', async () => {
    expect((await send()).status).toBe(200);
    introspect.mockResolvedValueOnce({ active: false });
    expect((await send()).status).toBe(401);
    expect(introspect).toHaveBeenCalledTimes(2);
  });
  it('rejects another deployment environment', async () => {
    introspect.mockResolvedValueOnce({ active: true, principal: { ...principal, environment: 'development' } });
    expect((await send()).status).toBe(401);
  });
  it('does not expose a transport error carrying credential data', async () => {
    introspect.mockRejectedValueOnce(new Error(token));
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(token);
  });
  it.each([
    { ...principal, audience: 'another-resource' },
    { ...principal, scopes: ['inference:invoke'] },
    { ...principal, scopes: ['alia:chat'] },
    { ...principal, scopes: [...principal.scopes, 'acting-as:offline'] },
    { ...principal, userId: 'owner-as-user' },
    { ...principal, tier: 'internal' },
  ])('rejects audience/scope/authority drift in the receipt', changed => {
    expect(isOxyAliaMachinePrincipal(changed)).toBe(false);
  });
  it('uses the receiver service token, with no SDK caching or retries', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.invalid' });
    jest.spyOn(oxy, 'serviceToken').mockResolvedValue('resource-service-token');
    const request = jest.spyOn(oxy, 'request').mockResolvedValue({ active: true, principal });
    expect(await oxy.apps.introspectAliaMachineCredential(token)).toEqual({ active: true, principal });
    expect(request).toHaveBeenCalledWith('POST', '/internal/alia/machine-credentials/introspect', { token }, {
      cache: false, retry: false, headers: { Authorization: 'Bearer resource-service-token' },
    });
  });
});
