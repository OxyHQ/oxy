import { createHash } from 'node:crypto';
import { close as closeFile, createReadStream, open, read } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { OxyServer } from '../OxyServer';

const credentials = async () => ({
  AccessKeyId: 'fixture',
  SecretAccessKey: 'fixture',
  Token: 'fixture',
});
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withinDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Upload fixture did not close within 2s')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForClose(stream: Readable | ServerResponse): Promise<void> {
  if (stream.closed) return;
  let onClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
    stream.once('close', onClose);
  });
  try {
    await withinDeadline(closed);
  } finally {
    stream.off('close', onClose);
  }
}

it('reopens a file once after 401, preserves bytes/context, and never retries ambiguous failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxy-stream-'));
  const path = join(directory, 'upload.bin');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x53);
  await writeFile(path, bytes);
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  const requests: Array<{
    path: string;
    hash: string;
    bytes: number;
    token: string;
    account: string;
    proof: string;
  }> = [];
  const exchanges: Array<{ protocolVersion: number; audience: string }> = [];
  let firstResponse: ServerResponse | undefined;
  let first401 = true;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/challenge')) return res.end('{"nonce":"fixture"}');
    if (req.url?.endsWith('/workload')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const exchange = JSON.parse(body);
      exchanges.push(exchange);
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        type: 'service',
        authority: 'first_party',
        appId: 'app',
        credentialId: 'wl_app',
        ownerAccountId: 'owner',
        environment: 'development',
        iss: 'oxy-auth',
        iat: now,
        exp: now + 300,
        aud: exchange.audience,
        nonce: exchanges.length,
      };
      return res.end(
        JSON.stringify({
          token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`,
          expiresIn: 300,
        }),
      );
    }
    const hash = createHash('sha256');
    let length = 0;
    for await (const chunk of req) {
      hash.update(chunk);
      length += chunk.length;
    }
    requests.push({
      path: req.url ?? '',
      hash: hash.digest('hex'),
      bytes: length,
      token: String(req.headers.authorization),
      account: String(req.headers['x-oxy-user-id']),
      proof: String(req.headers['x-oxy-requester-context']),
    });
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers['content-type']).toBe('application/octet-stream');
    expect(req.headers['content-length']).toBe(String(bytes.length));
    if (req.url === '/upload' && first401) {
      first401 = false;
      firstResponse = res;
      res.writeHead(401);
      res.write('expired'); // Core must cancel this body rather than wait for an EOF.
      return;
    }
    if (req.url === '/drop') {
      req.socket.destroy();
      return;
    }
    if (req.url === '/always401') res.statusCode = 401;
    if (req.url === '/limited') res.statusCode = 429;
    if (req.url === '/unavailable') res.statusCode = 503;
    if (req.url === '/redirect') {
      res.writeHead(307, { location: '/wrong' });
      res.end();
      return;
    }
    res.end('accepted');
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({ baseURL, workloadCredentials: credentials });
  const client = oxy.createServiceClient({
    baseURL,
    audience: 'oxy-service:receiver',
    requester: { accountId: 'account', requesterContext: 'verified-context' },
  });
  let opened = 0;
  const streams: ReturnType<typeof createReadStream>[] = [];
  let eofGate: { reached: () => void; release: Promise<void> } | undefined;
  const bodyFactory = () => {
    expect(exchanges.length).toBeGreaterThan(0);
    opened++;
    const file = createReadStream(path, {
      highWaterMark: 16 * 1024,
      fs: {
        open,
        close: closeFile,
        read(fd, buffer, offset, length, position, callback) {
          read(fd, buffer, offset, length, position, (error, bytesRead, result) => {
            // Content-Length lets the receiver finish before the final local EOF
            // callback. Hold that real callback to reproduce the CI ordering.
            const gate = !error && bytesRead === 0 ? eofGate : undefined;
            if (gate) {
              gate.reached();
              void gate.release.then(() => callback(error, bytesRead, result));
            } else callback(error, bytesRead, result);
          });
        },
      },
    });
    streams.push(file);
    return Readable.toWeb(file) as ReadableStream<Uint8Array>;
  };
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      cookie: 'never',
      'x-oxy-user-id': 'forged',
      'x-oxy-requester-context': 'forged',
    },
    bodyFactory,
  };
  try {
    const response = await client.fetchReplayable('/upload', init);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('accepted');
    expect(opened).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0].token).not.toBe(requests[1].token);
    expect(firstResponse).toBeDefined();
    if (!firstResponse) throw new Error('Missing first 401 response');
    await waitForClose(firstResponse);
    for (const entry of requests)
      expect(entry).toMatchObject({
        hash: expectedHash,
        bytes: bytes.length,
        account: 'account',
        proof: 'verified-context',
      });
    expect(exchanges).toEqual([
      expect.objectContaining({ protocolVersion: 2, audience: 'oxy-service:receiver' }),
      expect.objectContaining({ protocolVersion: 2, audience: 'oxy-service:receiver' }),
    ]);
    for (const [path, status] of [
      ['/limited', 429],
      ['/unavailable', 503],
    ] as const) {
      const before = opened;
      expect((await client.fetchReplayable(path, init)).status).toBe(status);
      expect(opened).toBe(before + 1);
    }
    const before = opened;
    expect((await client.fetchReplayable('/always401', init)).status).toBe(401);
    expect(opened).toBe(before + 2);
    await Promise.all(streams.map(waitForClose));
    for (const path of ['/drop', '/redirect']) {
      const before = opened;
      let reached!: () => void;
      let release!: () => void;
      const eofReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      eofGate = {
        reached,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      try {
        await expect(client.fetchReplayable(path, init)).rejects.toBeDefined();
        expect(opened).toBe(before + 1);
        await withinDeadline(eofReached);
        // Fetch rejection is not the file descriptor's close barrier.
        expect(streams[before].closed).toBe(false);
      } finally {
        release();
        eofGate = undefined;
      }
      await waitForClose(streams[before]);
    }
    expect(requests.some(({ path }) => path === '/wrong')).toBe(false);
    expect(streams.every((stream) => stream.destroyed && stream.closed)).toBe(true);
  } finally {
    client.dispose();
    oxy.dispose();
    await close(server);
    await rm(directory, { recursive: true });
  }
});

it('validates destination, method, abort and disposal before opening the upload or minting', async () => {
  const mint = jest.fn(credentials);
  const oxy = new OxyServer({ baseURL: 'http://127.0.0.1:9', workloadCredentials: mint });
  const client = oxy.createServiceClient({ baseURL: 'http://127.0.0.1:9', audience: 'oxy-api' });
  const bodyFactory = jest.fn(() => 'body');
  try {
    await expect(
      client.fetchReplayable('http://127.0.0.1:8/upload', { method: 'POST', bodyFactory }),
    ).rejects.toThrow('configured API origin');
    await expect(client.fetchReplayable('/upload', { method: 'GET', bodyFactory })).rejects.toThrow(
      'GET and HEAD',
    );
    await expect(
      client.fetchReplayable('/upload', {
        method: 'POST',
        bodyFactory,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeDefined();
    client.dispose();
    await expect(
      client.fetchReplayable('/upload', { method: 'POST', bodyFactory }),
    ).rejects.toThrow('disposed');
    expect(bodyFactory).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  } finally {
    client.dispose();
    oxy.dispose();
  }
});

it('does not open cancelled bodies during a shared mint and does not cancel another caller mint', async () => {
  let arrived!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mints = 0;
  let uploads = 0;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/challenge')) {
      arrived();
      await hold;
      res.end('{"nonce":"fixture"}');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith('/workload')) {
      mints++;
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        type: 'service',
        authority: 'first_party',
        appId: 'app',
        credentialId: 'wl_app',
        ownerAccountId: 'owner',
        environment: 'development',
        iss: 'oxy-auth',
        iat: now,
        exp: now + 300,
        aud: 'oxy-api',
      };
      res.end(
        JSON.stringify({
          token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`,
          expiresIn: 300,
        }),
      );
      return;
    }
    uploads++;
    res.end(body);
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({ baseURL, workloadCredentials: credentials });
  const client = oxy.createServiceClient({ baseURL, audience: 'oxy-api' });
  const controller = new AbortController();
  const cancelledBody = jest.fn(() => 'cancelled');
  try {
    const cancelled = client.fetchReplayable('/upload', {
      method: 'POST',
      bodyFactory: cancelledBody,
      signal: controller.signal,
    });
    const refusal = expect(cancelled).rejects.toBeDefined();
    await waiting;
    const completed = client.fetchReplayable('/upload', {
      method: 'POST',
      bodyFactory: () => new Blob(['complete']),
    });
    controller.abort();
    await refusal;
    expect(cancelledBody).not.toHaveBeenCalled();
    release();
    expect(await (await completed).text()).toBe('complete');
    expect(mints).toBe(1);
    expect(uploads).toBe(1);
  } finally {
    release();
    client.dispose();
    oxy.dispose();
    await close(server);
  }
});

it('aborts an in-flight file upload and closes its stream without reopening it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oxy-stream-abort-'));
  const path = join(directory, 'upload.bin');
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 0x41));
  const controller = new AbortController();
  let uploadAttempts = 0;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/challenge')) return res.end('{"nonce":"fixture"}');
    if (req.url?.endsWith('/workload')) {
      for await (const _ of req) {
        /* Drain the credential exchange. */
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        type: 'service',
        authority: 'first_party',
        appId: 'app',
        credentialId: 'wl_app',
        ownerAccountId: 'owner',
        environment: 'development',
        iss: 'oxy-auth',
        iat: now,
        exp: now + 300,
        aud: 'oxy-api',
      };
      return res.end(
        JSON.stringify({
          token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`,
          expiresIn: 300,
        }),
      );
    }
    uploadAttempts++;
    req.once('data', () => {
      req.pause();
      controller.abort();
    });
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({ baseURL, workloadCredentials: credentials });
  const client = oxy.createServiceClient({ baseURL, audience: 'oxy-api' });
  let stream: ReturnType<typeof createReadStream> | undefined;
  let closed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const bodyFactory = jest.fn(() => {
    stream = createReadStream(path, { highWaterMark: 4096 });
    stream.on('close', closed);
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  });
  try {
    await expect(
      client.fetchReplayable('/upload', { method: 'POST', bodyFactory, signal: controller.signal }),
    ).rejects.toBeDefined();
    await withinDeadline(streamClosed);
    expect(stream?.destroyed).toBe(true);
    expect(bodyFactory).toHaveBeenCalledTimes(1);
    expect(uploadAttempts).toBe(1);
  } finally {
    client.dispose();
    oxy.dispose();
    await close(server);
    await rm(directory, { recursive: true });
  }
});
