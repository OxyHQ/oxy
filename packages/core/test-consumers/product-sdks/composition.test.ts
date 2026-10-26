import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { OxyServer } from '@oxy.so/core/server';
import { createAliaTransportForOxyService, ALIA_SERVICE_AUDIENCE } from '@alia.onl/server';
import { clarityForOxyService, CLARITY_SERVICE_AUDIENCE } from '@clarity.surf/sdk/server';
import { kaanaForOxyService } from '@kaana.ai/sdk/server';
import { postOxyServiceJson } from '@oxy.so/mcp';
let baseURL: string;
let outsideURL: string;
let outsideRequests = 0;
const outside = createServer((_req, res) => {
  outsideRequests++;
  res.end('{}');
});
let streamingClosed: (() => void) | undefined;
const mints: Array<{ audience: string; protocolVersion: number }> = [];
const requests: Array<{
  path: string;
  bearer?: string;
  requester?: string;
  user?: string;
  body: string;
}> = [];
let refresh = true;
const externalRequests: Array<{ apiKey: string; apiSecret: string; scopes: string[] }> = [];
const token = (audience: string, generation: number, external = false) =>
  `e30.${Buffer.from(JSON.stringify({ type: 'service', iss: 'oxy-auth', appId: 'app', credentialId: external ? 'customer-key' : 'wl_fixture', ownerAccountId: 'owner', environment: 'development', aud: audience, authority: external ? 'external' : 'first_party', ...(external ? { scopes: ['files:read'] } : {}), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, generation })).toString('base64url')}.sig`;
const decode = (value: string) =>
  JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
const server = createServer(async (req, res) => {
  let body = '';
  for await (const p of req) body += p;
  res.setHeader('content-type', 'application/json');
  res.setHeader('Kaana-Request-Id', 'synthetic-request');
  if (req.url?.endsWith('/challenge')) return res.end(JSON.stringify({ nonce: 'local-nonce' }));
  if (req.url?.endsWith('/workload')) {
    const x = JSON.parse(body);
    mints.push({ ...x, audience: x.audience ?? 'oxy-api' });
    return res.end(
      JSON.stringify({
        token: token(x.audience ?? 'oxy-api', mints.length),
        expiresIn: 300,
        appName: 'fixture',
      }),
    );
  }
  if (req.url === '/auth/service-token') {
    externalRequests.push(JSON.parse(body));
    return res.end(
      JSON.stringify({
        token: token(JSON.parse(body).audience ?? 'oxy-api', 1, true),
        expiresIn: 300,
        appName: 'external',
      }),
    );
  }
  requests.push({
    path: req.url!,
    bearer: req.headers.authorization,
    requester: req.headers['x-oxy-requester-token'] as string,
    user: req.headers['x-oxy-user-id'] as string,
    body,
  });
  if (req.url === '/refresh' && refresh) {
    refresh = false;
    res.statusCode = 401;
    return res.end('{}');
  }
  if (req.url === '/v1/chat/completions') {
    res.setHeader('content-type', 'text/event-stream');
    res.on('close', () => streamingClosed?.());
    res.write(
      `data: ${JSON.stringify({
        id: 'synthetic-stream',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture/synthetic',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
      })}\n\n`,
    );
    return;
  }
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
  if (req.url === '/redirect') {
    res.statusCode = 302;
    res.setHeader('location', `${outsideURL}/private`);
    return res.end();
  }
  res.end(JSON.stringify({ ok: true, results: [] }));
});
beforeAll(async () => {
  await new Promise<void>((r) => outside.listen(0, '127.0.0.1', r));
  outsideURL = `http://127.0.0.1:${(outside.address() as AddressInfo).port}`;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  outside.closeAllConnections();
  await new Promise<void>((r) => outside.close(() => r()));
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const owner = () =>
  new OxyServer({
    baseURL,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIATEST',
      SecretAccessKey: 'synthetic',
      Token: 'temporary',
    }),
  });
test('packed Core manual and workload transports share v2 refresh and external pair stays external', async () => {
  const oxy = owner();
  const before = mints.length;
  const transport = oxy.createServiceClient({ baseURL, audience: 'oxy-api' });
  try {
    const first = await oxy.serviceToken();
    expect(decode(first).authority).toBe('first_party');
    expect(decode(first)).not.toHaveProperty('scopes');
    await (await transport.fetch('/refresh')).text();
    const second = await oxy.serviceToken();
    expect(second).not.toBe(first);
    expect(mints.slice(before).map((x) => x.protocolVersion)).toEqual([2, 2]);
    const external = await oxy.serviceToken('public-customer-key', 'synthetic-secret', {
      scopes: ['files:read'],
    });
    expect(decode(external).authority).toBe('external');
    expect(decode(external).scopes).toEqual(['files:read']);
    expect(mints.length - before).toBe(2);
    expect(mints.slice(before).every((mint) => !('scopes' in mint))).toBe(true);
    expect(externalRequests.at(-1)).toMatchObject({
      apiKey: 'public-customer-key',
      apiSecret: 'synthetic-secret',
      scopes: ['files:read'],
    });
  } finally {
    transport.dispose();
    oxy.dispose();
  }
});
test('published Alia and Clarity factories use packed shared audience/requester transport', async () => {
  const oxy = owner();
  const before = mints.length;
  const alia = createAliaTransportForOxyService(oxy, {
    baseURL,
    requester: { accountId: 'A', token: 'session-proof-A' },
  });
  const clarity = clarityForOxyService(oxy, { baseUrl: baseURL });
  try {
    await (
      await alia.fetch('/alia', {
        headers: { 'x-oxy-user-id': 'wrong', 'x-oxy-requester-token': 'wrong' },
      })
    ).text();
    const sent = requests.at(-1)!;
    expect(sent.user).toBe('A');
    expect(sent.requester).toBe('session-proof-A');
    expect(decode(sent.bearer!.slice(7)).aud).toBe(ALIA_SERVICE_AUDIENCE);
    await clarity.search({ query: 'synthetic' });
    expect(mints.slice(before).map((x) => x.audience)).toEqual([
      ALIA_SERVICE_AUDIENCE,
      CLARITY_SERVICE_AUDIENCE,
    ]);
    await expect(alia.fetch(`${outsideURL}/private`)).rejects.toThrow();
    await expect(alia.fetch('/redirect')).rejects.toThrow();
    expect(outsideRequests).toBe(0);
  } finally {
    alia.dispose();
    clarity.dispose();
    oxy.dispose();
  }
});
test('published Kaana and MCP compose with packed Core and canonical audience', async () => {
  const oxy = owner();
  const before = mints.length;
  const kaana = kaanaForOxyService(oxy, {
    baseURL: `${baseURL}/v1`,
    attribution: { accountId: 'attribution-A' },
  });
  const transport = oxy.createServiceClient({ baseURL, audience: 'oxy-api' });
  try {
    expect(await kaana.models.list()).toEqual([]);
    expect(requests.at(-1)?.user).toBe('attribution-A');
    expect(
      await postOxyServiceJson({ synthetic: true }, { endpoint: `${baseURL}/mcp`, transport }),
    ).toEqual({ ok: true, results: [] });
    expect(mints.slice(before).map((x) => [x.audience, x.protocolVersion])).toEqual([
      ['kaana.ai', 2],
      ['oxy-api', 2],
    ]);
  } finally {
    kaana.dispose();
    transport.dispose();
    oxy.dispose();
  }
});
test('packed linked session sends its bearer and rejects cross-origin/disposed access', async () => {
  const oxy = new OxyServices({ baseURL });
  const sessionToken = `e30.${Buffer.from(JSON.stringify({ userId: 'A', sessionId: 'session-A', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.sig`;
  oxy.session.setAccessToken(sessionToken);
  const linked = oxy.createLinkedClient({ baseURL });
  try {
    await (await linked.fetch('/session')).text();
    expect(requests.at(-1)?.bearer).toBe(`Bearer ${sessionToken}`);
    await expect(linked.fetch(`${outsideURL}/private`)).rejects.toThrow();
    linked.dispose();
    await expect(linked.fetch('/disposed')).rejects.toThrow();
  } finally {
    linked.dispose();
    oxy.dispose();
  }
});

test('published Kaana SSE carries canonical workload attribution and aborts the upstream stream', async () => {
  const oxy = owner();
  const kaana = kaanaForOxyService(oxy, {
    baseURL: `${baseURL}/v1`,
    attribution: { accountId: 'stream-account' },
  });
  const closed = new Promise<void>((resolve) => {
    streamingClosed = resolve;
  });
  const stream = kaana.chat.completions.stream({
    model: 'fixture/synthetic',
    messages: [{ role: 'user', content: 'synthetic input' }],
  });
  const iterator = stream[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ choices: [{ delta: { content: 'hello' } }] });
    const sent = requests.at(-1)!;
    expect(sent.user).toBe('stream-account');
    expect(decode(sent.bearer!.slice(7))).toMatchObject({
      aud: 'kaana.ai',
      authority: 'first_party',
    });
    const ended = iterator.next();
    const outcome = ended.then(
      () => ({ ok: true }),
      (error) => ({ error }),
    );
    stream.abort();
    expect(await outcome).toMatchObject({ error: { code: 'cancelled', afterOutput: true } });
    await closed;
    expect(requests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(1);
  } finally {
    stream.abort();
    await iterator.return?.();
    kaana.dispose();
    oxy.dispose();
  }
});
