/**
 * `serviceRequest` on a 401: Oxy refused the cached service token (keys
 * rotated, credential revoked) before the request ran, so the server drops it,
 * mints a fresh one and sends the request once more — every caller of the
 * service lane gets this — and a session-less read sent with the service token
 * (`serviceIdentity: 'when-anonymous'`) — not only `createServiceClient`. Exercised against a
 * real HTTP server, so the bearer each attempt carried is what is asserted.
 */
jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => true,
  requestWorkloadServiceToken: jest.fn(),
}));
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestWorkloadServiceToken } from '../workloadIdentity';
import { OxyServer } from '../OxyServer';

const mint = requestWorkloadServiceToken as jest.Mock;

interface Seen {
  authorization: string | undefined;
  body: string;
}

async function startOxy(answer: (seen: Seen, index: number) => number): Promise<{
  url: string;
  seen: Seen[];
  server: Server;
}> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const entry = {
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    };
    seen.push(entry);
    const status = answer(entry, seen.length - 1);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      status === 200
        ? JSON.stringify({ data: { ok: true, id: 'u1', username: 'ada' } })
        : JSON.stringify({ error: 'UNAUTHORIZED', message: 'Invalid service token' }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A service token the server will reuse: a JWT with a bounded, unexpired lifetime. */
function jwt(name: string): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'EdDSA' })}.${part({ name, iat: now, exp: now + 300 })}.sig`;
}
const STALE = jwt('stale');
const FRESH = jwt('fresh');

let tokens: string[];
beforeEach(() => {
  tokens = [STALE, FRESH, jwt('third')];
  mint.mockReset();
  mint.mockImplementation(async () => ({ token: tokens.shift(), expiresIn: 300, appName: 'test' }));
});

it('drops a refused cached token and sends the request once more with a fresh one', async () => {
  const oxy_ = await startOxy((seen) => (seen.authorization === `Bearer ${STALE}` ? 401 : 200));
  const oxy = new OxyServer({ baseURL: oxy_.url });
  try {
    await expect(
      oxy.serviceRequest('POST', '/assets/service/references', { references: [1] }),
    ).resolves.toMatchObject({ ok: true });

    expect(oxy_.seen.map((s) => s.authorization)).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`]);
    // The same body went the second time: a 401 means the request never ran.
    expect(oxy_.seen[1].body).toBe(oxy_.seen[0].body);
    expect(mint).toHaveBeenCalledTimes(2);

    // The fresh token is the cached one now.
    await oxy.serviceRequest('GET', '/x');
    expect(oxy_.seen[2].authorization).toBe(`Bearer ${FRESH}`);
    expect(mint).toHaveBeenCalledTimes(2);
  } finally {
    oxy.dispose();
    await close(oxy_.server);
  }
});

it('retries only once: a second 401 is the caller’s', async () => {
  const oxy_ = await startOxy(() => 401);
  const oxy = new OxyServer({ baseURL: oxy_.url });
  try {
    await expect(oxy.serviceRequest('POST', '/x', {})).rejects.toMatchObject({ status: 401 });
    expect(oxy_.seen).toHaveLength(2);
    expect(mint).toHaveBeenCalledTimes(2);
  } finally {
    oxy.dispose();
    await close(oxy_.server);
  }
});

it('does not resend on any other refusal', async () => {
  const oxy_ = await startOxy(() => 403);
  const oxy = new OxyServer({ baseURL: oxy_.url });
  try {
    await expect(oxy.serviceRequest('POST', '/x', {})).rejects.toMatchObject({ status: 403 });
    expect(oxy_.seen).toHaveLength(1);
    expect(mint).toHaveBeenCalledTimes(1);
  } finally {
    oxy.dispose();
    await close(oxy_.server);
  }
});

it('reaches every service-lane namespace call', async () => {
  const oxy_ = await startOxy((seen) => (seen.authorization === `Bearer ${STALE}` ? 401 : 200));
  const oxy = new OxyServer({ baseURL: oxy_.url });
  try {
    await oxy.assets.mediaCache.delete('cache-1');
    expect(oxy_.seen.map((s) => s.authorization)).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`]);
  } finally {
    oxy.dispose();
    await close(oxy_.server);
  }
});

it('heals a session-less read sent with the service token (serviceIdentity: when-anonymous)', async () => {
  const oxy_ = await startOxy((seen) => (seen.authorization === `Bearer ${STALE}` ? 401 : 200));
  const oxy = new OxyServer({ baseURL: oxy_.url, serviceIdentity: 'when-anonymous' });
  try {
    await expect(
      oxy.withCallOptions({ retry: false }).users.byUsername('ada', { cache: false }),
    ).resolves.toBeDefined();
    expect(oxy_.seen.map((s) => s.authorization)).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`]);
  } finally {
    oxy.dispose();
    await close(oxy_.server);
  }
});

it('a session-less read that is refused twice is the caller’s', async () => {
  const oxy_ = await startOxy(() => 401);
  const oxy = new OxyServer({ baseURL: oxy_.url, serviceIdentity: 'when-anonymous' });
  try {
    await expect(oxy.users.byUsername('ada', { cache: false })).rejects.toMatchObject({
      status: 401,
    });
    expect(oxy_.seen).toHaveLength(2);
  } finally {
    oxy.dispose();
    await close(oxy_.server);
  }
});
