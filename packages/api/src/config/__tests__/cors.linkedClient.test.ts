/**
 * The browser preflight the Inbosh client sends to `api.inbo.sh`.
 *
 * Inbosh reaches the email backend with `OxyServices.createLinkedClient({ baseURL })`,
 * which sends the primary client's bearer plus the SDK's own headers. A preflight
 * that omits one of them from `Access-Control-Allow-Headers` fails in the browser
 * with no server-side trace, so each is asserted by name. The CORS middleware is
 * mounted globally and does not depend on the API role; this pins that the
 * `inbosh` role, which mounts the same middleware, answers the way the platform does.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCorsMiddleware } from '../cors';
import { resetOriginRegistryForTests, setOriginSnapshotForTests } from '../dynamicOriginRegistry';

/** Everything a linked client's request can carry, as a lowercase preflight list. */
const LINKED_CLIENT_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'idempotency-key',
  'x-device-fingerprint',
  'x-oxy-activity-id',
  'x-oxy-edge-region',
  'x-session-id',
];

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(createCorsMiddleware());
  app.get('/email/mailboxes', (_req, res) => res.json([]));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetOriginRegistryForTests();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  setOriginSnapshotForTests(['https://inbo.sh', 'https://inbox.oxy.so'], []);
});

function preflight(origin: string) {
  return fetch(`${baseUrl}/email/mailboxes`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': LINKED_CLIENT_REQUEST_HEADERS.join(','),
    },
  });
}

describe('preflight from the registered Inbosh origins', () => {
  it.each(['https://inbo.sh', 'https://inbox.oxy.so'])(
    'admits %s with credentials and every header the linked client sends',
    async (origin) => {
      const response = await preflight(origin);
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      const allowed = (response.headers.get('access-control-allow-headers') ?? '')
        .toLowerCase()
        .split(',')
        .map((header) => header.trim());
      for (const header of LINKED_CLIENT_REQUEST_HEADERS) {
        expect(allowed).toContain(header);
      }
    },
  );

  it('still refuses an origin nobody registered', async () => {
    const response = await preflight('https://not-registered.example');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
