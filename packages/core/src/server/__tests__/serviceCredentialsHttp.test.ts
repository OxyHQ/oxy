import { createServer } from 'node:http';
import { OxyServer } from '../OxyServer';

it('shares v2 workload credentials across HTTP/WS and bounds destinations, cancellation and disposal before returning a token', async () => {
  let arrived!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mints: Array<{ protocolVersion: number; audience: string }> = [];
  let challenges = 0;
  let receivedAuthorization: string | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/challenge')) {
      challenges++;
      arrived();
      await hold;
      return res.end('{"nonce":"nonce"}');
    }
    if (req.url?.endsWith('/workload')) {
      const request = JSON.parse(body);
      mints.push(request);
      const now = Math.floor(Date.now() / 1000);
      const token = `e30.${Buffer.from(JSON.stringify({ type: 'service', authority: 'first_party', appId: 'app', credentialId: 'wl_app', ownerAccountId: 'owner', environment: 'development', iss: 'oxy-auth', aud: request.audience, iat: now, exp: now + 300 })).toString('base64url')}.sig`;
      return res.end(JSON.stringify({ token, expiresIn: 300 }));
    }
    receivedAuthorization = req.headers.authorization;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const baseURL = `http://127.0.0.1:${address.port}`;
  const oxy = new OxyServer({
    baseURL,
    serviceAuth: { apiKey: 'external', apiSecret: 'external-secret' },
    workloadCredentials: async () => ({ AccessKeyId: 'ASIATEST', SecretAccessKey: 'test' }),
  });
  const client = oxy.createServiceClient({ baseURL, audience: 'kaana.ai' });
  const disposedDuringMint = oxy.createServiceClient({ baseURL, audience: 'kaana.ai' });
  try {
    for (const target of [
      'https://foreign.test/v1',
      `wss://127.0.0.1:${address.port}/v1`,
      `ws://user:password@127.0.0.1:${address.port}/v1`,
      'file:///tmp/token',
    ]) {
      await expect(client.getAccessToken(target)).rejects.toThrow('configured API origin');
    }
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      client.getAccessToken(`${baseURL}/v1`, { signal: alreadyAborted.signal }),
    ).rejects.toBeDefined();
    expect(challenges).toBe(0);
    const controller = new AbortController();
    const cancelled = client.getAccessToken(`${baseURL.replace('http:', 'ws:')}/v1/realtime`, {
      signal: controller.signal,
    });
    const cancelledResult = expect(cancelled).rejects.toBeDefined();
    await waiting;
    const surviving = client.getAccessToken(new URL('/v1/realtime', baseURL));
    const disposed = disposedDuringMint.getAccessToken(`${baseURL}/v1`);
    const disposedResult = expect(disposed).rejects.toThrow('disposed');
    disposedDuringMint.dispose();
    controller.abort();
    await cancelledResult;
    release();
    const bearer = await surviving;
    await disposedResult;
    await client.fetch('/read');
    expect(receivedAuthorization).toBe(`Bearer ${bearer}`);
    expect(challenges).toBe(1);
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({ protocolVersion: 2, audience: 'kaana.ai' });
    client.dispose();
    await expect(client.getAccessToken(`${baseURL}/v1`)).rejects.toThrow('disposed');
    expect(challenges).toBe(1);
  } finally {
    release();
    client.dispose();
    disposedDuringMint.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
