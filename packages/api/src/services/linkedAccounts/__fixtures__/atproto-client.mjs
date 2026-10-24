import assert from 'node:assert/strict';
import { NodeOAuthClient } from '@atproto/oauth-client-node';
const pending = new Map();
let nextId = 0;
process.on('message', ({ id, error, body, status, headers, url }) => {
  const handlers = pending.get(id);
  if (!handlers) return;
  pending.delete(id);
  if (error) handlers.reject(new Error(error));
  else {
    const response = new Response(body, { status, headers });
    Object.defineProperty(response, 'url', { value: url });
    handlers.resolve(response);
  }
});
const guardedFetch = async (input) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  process.send({ kind: 'fetch', id, url: typeof input === 'string' ? input : input.url ?? String(input) });
});
const store = { get: async () => undefined, set: async () => {}, del: async () => {} };
globalThis.fetch = async () => { throw new Error('unguarded global fetch'); };
try {
  const client = new NodeOAuthClient({
    clientMetadata: {
      client_id: 'https://oxy.example/client-metadata.json', client_name: 'Oxy fixture',
      redirect_uris: ['https://oxy.example/callback'], scope: 'atproto',
      grant_types: ['authorization_code'], response_types: ['code'],
      token_endpoint_auth_method: 'none', application_type: 'web', dpop_bound_access_tokens: true,
    },
    stateStore: store, sessionStore: store, fetch: guardedFetch,
    requestLock: async (_name, callback) => callback(),
  });
  const metadata = await client.oauthResolver.getAuthorizationServerMetadata('https://identity.example');
  assert.equal(metadata.issuer, 'https://identity.example');
  assert.deepEqual(metadata.scopes_supported, ['atproto']);
  await assert.rejects(client.oauthResolver.resolveIdentity('did:web:untrusted.example'), (error) => {
    const messages = [];
    while (error instanceof Error) { messages.push(error.message); error = error.cause; }
    return messages.some(message => message.includes('Identity provider JSON exceeds'));
  });
  process.send({ kind: 'done' });
} catch (error) { const causes=[]; while(error instanceof Error) { causes.push(error.stack); error=error.cause; } process.send({ kind: 'failure', error: causes.join('\nCaused by: ') }); }
