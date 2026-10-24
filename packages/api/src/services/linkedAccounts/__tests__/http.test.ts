import { fork } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { safeFetch, readResponseBody } from '@oxy.so/core/server';
import {
  linkedAccountTransport,
  LinkedAccountJsonBudgetError,
  LINKED_ACCOUNT_JSON_LIMITS,
} from '../http';

jest.mock('@oxy.so/core/server', () => ({
  safeFetch: jest.fn(),
  readResponseBody: jest.fn(),
  assertSafePublicUrl: jest.fn(),
}));
const fetch = jest.mocked(safeFetch);
const read = jest.mocked(readResponseBody);
const endpoint = 'https://identity.example/.well-known/oauth-authorization-server';
// Resolve the actual maintained v3 dependency along the installed atproto chain.
// Transport budgets remain an independent boundary even with the parser fixed.
const nodeClientRequire = createRequire(require.resolve('@atproto/oauth-client-node'));
const oauthClientRequire = createRequire(nodeClientRequire.resolve('@atproto/oauth-client'));
const oauthTypesRequire = createRequire(oauthClientRequire.resolve('@atproto/oauth-types'));
const legacyZod = oauthTypesRequire('zod');
const upstreamSchema = legacyZod.z.object({
  scopes_supported: legacyZod.z.array(legacyZod.z.string()).max(100),
});

function payload(bytes: Buffer, status = 200, contentType = 'application/json') {
  fetch.mockResolvedValue({
    response: {},
    status,
    finalUrl: endpoint,
    headers: { 'content-type': contentType, 'cache-control': 'max-age=30' },
  } as Awaited<ReturnType<typeof safeFetch>>);
  read.mockResolvedValue({ kind: 'ok', body: bytes });
}
beforeEach(() => jest.clearAllMocks());
it('the actual transitive parser rejects oversized constrained arrays before traversal', () => {
  expect(oauthTypesRequire('zod/package.json')).toMatchObject({
    name: '@oxy.so/zod3',
    version: '3.25.77',
  });
  const child = jest.fn((value: unknown) => value);
  const bounded = legacyZod.z.array(legacyZod.z.preprocess(child, legacyZod.z.string())).max(100);
  const result = bounded.safeParse(Array(10_000).fill(0));
  expect(child).not.toHaveBeenCalled();
  expect(result.success).toBe(false);
  expect(result.error.issues).toHaveLength(1);
});

it.each([false, true])(
  'rejects an oversized array before the upstream parser receives a Response (BOM=%s)',
  async (bom) => {
    const bytes = Buffer.from(JSON.stringify({ scopes_supported: Array(10_000).fill(0) }));
    payload(
      bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes,
      200,
      'text/plain',
    );
    const upstreamParse = jest.fn((value: unknown) => upstreamSchema.parse(value));
    await expect(
      linkedAccountTransport()
        .fetch(endpoint)
        .then(async (response) => upstreamParse(await response.json())),
    ).rejects.toBeInstanceOf(LinkedAccountJsonBudgetError);
    expect(upstreamParse).not.toHaveBeenCalled();
  },
);
it('bounds depth, total nodes and object breadth independently', async () => {
  const deep =
    '['.repeat(LINKED_ACCOUNT_JSON_LIMITS.depth + 1) +
    '0' +
    ']'.repeat(LINKED_ACCOUNT_JSON_LIMITS.depth + 1);
  const manyNodes = JSON.stringify(Array.from({ length: 16 }, () => Array(1024).fill(0)));
  const wide = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: LINKED_ACCOUNT_JSON_LIMITS.collection + 1 }, (_, n) => [`k${n}`, null]),
    ),
  );
  for (const body of [deep, manyNodes, wide]) {
    payload(Buffer.from(body));
    await expect(linkedAccountTransport().fetch(endpoint)).rejects.toBeInstanceOf(
      LinkedAccountJsonBudgetError,
    );
  }
});
it.each([
  {
    issuer: 'https://identity.example',
    authorization_endpoint: 'https://identity.example/authorize',
    scopes_supported: ['atproto', 'openid'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  },
  {
    access_token: 'opaque-token',
    refresh_token: 'opaque-refresh',
    token_type: 'DPoP',
    expires_in: 300,
  },
  {
    id: 'did:plc:example',
    alsoKnownAs: ['at://example.test'],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.example',
      },
    ],
  },
])('preserves legitimate metadata/token/DID bytes and response metadata', async (body) => {
  const bytes = Buffer.from(` ${JSON.stringify(body)}\n`);
  payload(bytes);
  const response = await linkedAccountTransport().fetch(endpoint);
  expect(response.status).toBe(200);
  expect(response.url).toBe(endpoint);
  expect(response.headers.get('cache-control')).toBe('max-age=30');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});
it('preserves errors and the existing credential-safe redirect policy', async () => {
  payload(Buffer.from('not JSON'), 401, 'text/plain');
  const response = await linkedAccountTransport().fetch(endpoint, {
    method: 'POST',
    body: 'grant_type=authorization_code',
  });
  expect(response.status).toBe(401);
  expect(await response.text()).toBe('not JSON');
  expect(fetch).toHaveBeenCalledWith(
    endpoint,
    expect.objectContaining({ method: 'POST', maxRedirects: 0 }),
  );
  payload(Buffer.from('{}'));
  await linkedAccountTransport().fetch(endpoint);
  expect(fetch).toHaveBeenLastCalledWith(
    endpoint,
    expect.objectContaining({ method: 'GET', maxRedirects: 5 }),
  );
});

it('routes real NodeOAuthClient metadata and DID resolution through the guarded fetch seam', async () => {
  // ts-jest cannot import the upstream ESM client. The Node child runs the real
  // client and bridges only its injected fetch to this production transport.
  const child = fork(path.join(__dirname, '../__fixtures__/atproto-client.mjs'), [], {
    silent: true,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const requests: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`atproto child ${code}: ${stderr}`));
      });
      child.on(
        'message',
        async (message: { kind: string; id: number; url: string; error?: string }) => {
          if (message.kind === 'done') {
            resolve();
            return;
          }
          if (message.kind === 'failure') {
            reject(new Error(message.error));
            return;
          }
          requests.push(message.url);
          const body = message.url.includes('/did.json')
            ? { service: Array(10_000).fill(0) }
            : {
                issuer: 'https://identity.example',
                authorization_endpoint: 'https://identity.example/authorize',
                token_endpoint: 'https://identity.example/token',
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['none'],
                client_id_metadata_document_supported: true,
                scopes_supported: ['atproto'],
              };
          payload(Buffer.from(JSON.stringify(body)));
          try {
            const response = await linkedAccountTransport().fetch(message.url);
            child.send({
              id: message.id,
              body: await response.text(),
              status: response.status,
              headers: [...response.headers],
              url: response.url,
            });
          } catch (error) {
            child.send({
              id: message.id,
              error: error instanceof Error ? error.message : 'transport failed',
            });
          }
        },
      );
    });
    expect(requests).toEqual([endpoint, 'https://untrusted.example/.well-known/did.json']);
  } finally {
    child.kill();
  }
});
