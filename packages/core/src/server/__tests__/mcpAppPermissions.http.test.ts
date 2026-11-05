/**
 * An MCP tool call's application permissions, over a REAL socket.
 *
 * A local HTTP server plays Oxy, so each case asserts what went over the wire —
 * the service bearer, the MCP token in the body, nothing else — and that Oxy's
 * OAuth-shaped refusals (`{ error, error_description }`) reach the right outcome:
 * a refused TOKEN is "no session", a refused SERVICE is never a "no".
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServer } from '../OxyServer';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

let httpServer: http.Server;
let baseURL: string;
const seen: Seen[] = [];
let answer: () => { status: number; body: unknown } = () => ({ status: 404, body: {} });

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });
      const reply = answer();
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

function server() {
  const oxy = new OxyServer({ baseURL, enableRetry: false, applicationId: 'app-website' });
  jest
    .spyOn(oxy as unknown as { platformServiceToken: jest.Mock }, 'platformServiceToken')
    .mockResolvedValue('service-jwt');
  return oxy;
}

const mcpCall = { authInfo: { token: 'mcp-token-1' } };

it('sends the MCP token in the body under the service bearer', async () => {
  answer = () => ({
    status: 200,
    body: {
      applicationId: 'app-website',
      userId: 'person-1',
      permissions: ['website.content.manage'],
    },
  });
  const held = await server().appPermissionsFor(mcpCall);

  expect(seen).toEqual([
    {
      method: 'POST',
      url: '/auth/mcp/oauth/app-permissions',
      authorization: 'Bearer service-jwt',
      body: JSON.stringify({ token: 'mcp-token-1' }),
    },
  ]);
  expect(held.operatorId).toBe('person-1');
  expect(held.has('website.content.manage')).toBe(true);
});

it("reads Oxy's OAuth refusals: a refused token is no session, a refused service is unavailable", async () => {
  answer = () => ({
    status: 401,
    body: { error: 'invalid_grant', error_description: 'The MCP access token is invalid' },
  });
  await expect(server().appPermissionsFor(mcpCall)).rejects.toMatchObject({
    code: 'APP_PERMISSION_SESSION_REQUIRED',
  });

  answer = () => ({
    status: 401,
    body: { error: 'invalid_client', error_description: 'The Oxy service credential is inactive' },
  });
  await expect(server().appPermissionsFor(mcpCall)).rejects.toMatchObject({
    code: 'APP_PERMISSION_UNAVAILABLE',
  });
});
