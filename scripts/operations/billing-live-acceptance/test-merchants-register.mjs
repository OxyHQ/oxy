import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { APP, hash, verifySdk, registerOnce, boundedFetch, merchantIdentity, validateMaterial } from './merchants-register.mjs';
const root = '/home/nate/Oxy/Peable/.worktrees/i11-webhook-registry-h6rhBR/node_modules/@peable.to/sdk';
const archive = '/home/nate/Oxy/.agent-evidence/i04-handoff-i08-20261003/sdk-0.2.2-published/registry-sdk-0.2.2.tgz';
const registry = '/home/nate/Oxy/Peable/.worktrees/1519-i11-sdk022-registry-20261003/docs/audits/2026-10-03-i11-sdk-webhook-parity/published/registry.json';
const { Peable } = await import(pathToFileURL(join(root, 'dist/esm/index.js')).href);
const secret = 'a'.repeat(64), material = { publicKey: 'oxy_dk_' + 'b'.repeat(48), secret, secretHash: hash(secret) };
function plan(origin) { return { oxyBase: origin, peableBase: origin, expiresAt: Date.now() + 60000, ephemeral: { credentialId: '12345678-1234-1234-1234-123456789012', expiresAt: new Date(Date.now() + 60000).toISOString() } }; }
const merchant = { id: 'merch_syntheticfixture', object: 'merchant', oxyAppId: APP, environment: 'development', network: null, xpub: null };
async function fixture(t, mode) {
  let present = mode === 'existing', posts = 0, gets = 0, mints = 0;
  const events = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/service-token') {
      ++mints; assert.deepEqual(JSON.parse(body), { apiKey: material.publicKey, apiSecret: secret });
      const claims = { appId: APP, credentialId: '12345678-1234-1234-1234-123456789012', environment: 'development', exp: Math.floor(Date.now() / 1000) + 300, scopes: ['payments:read', 'payments:write'] };
      const token = 'synthetic.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.not-a-provider-signature';
      res.end(JSON.stringify({ data: { token, expiresIn: 300 } })); return;
    }
    if (req.url === '/v1/merchants/me') { ++gets; res.statusCode = present ? 200 : 404; res.end(JSON.stringify(present ? merchant : { error: { type: 'invalid_request_error', message: 'fixture absence' } })); return; }
    if (req.url === '/v1/merchants') {
      ++posts; assert.equal(body, '{}'); present = true;
      if (mode === 'lost') { res.destroy(); return; }
      if (mode === 'conflict') { res.statusCode = 409; res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture conflict' } })); return; }
      res.statusCode = 201; res.end(JSON.stringify(merchant)); return;
    }
    assert.fail('Unallowed fixture path');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const p = plan('http://127.0.0.1:' + server.address().port);
  const result = await registerOnce(Peable, p, material, event => events.push(event));
  assert.equal(result.merchant.id, merchant.id); assert.equal(result.issuer.environment, 'development');
  assert.equal(posts, mode === 'existing' ? 0 : 1); assert.equal(mints, 1); assert.equal(gets, mode === 'existing' ? 1 : 2);
  assert(!JSON.stringify(events).includes(secret)); assert(!JSON.stringify(result).includes('synthetic.'));
  return result;
}
test('registry archive, metadata and all53 installed SDK files match', () => assert.equal(verifySdk(root, archive, registry).files.length, 53));
test('published SDK registers only empty technical namespace and reads it back', t => fixture(t, 'created'));
test('existing own development merchant causes no POST', t => fixture(t, 'existing'));
test('lost registration response reconciles via GET and never repeats POST', async t => assert((await fixture(t, 'lost')).reconciledAfterUnknown));
test('409 registration reconciles via GET and never repeats POST', async t => assert((await fixture(t, 'conflict')).reconciledAfterUnknown));
test('transport denies foreign URL before native fetch', async () => {
  let attempts = 0; const p = plan('https://api.peable.to'); p.oxyBase = 'https://api.oxy.so';
  const fetch = boundedFetch(async () => { attempts++; }, p, material, {}, () => {});
  await assert.rejects(fetch('https://evil.invalid/v1/merchants', { method: 'POST', body: '{}' })); assert.equal(attempts, 0);
});
test('transport denies second POST before native fetch', async () => {
  let attempts = 0; const p = plan('https://api.peable.to');
  const fetch = boundedFetch(async () => { attempts++; return new Response('{}'); }, p, material, {}, () => {});
  await fetch(p.peableBase + '/v1/merchants', { method: 'POST', body: '{}' });
  await assert.rejects(fetch(p.peableBase + '/v1/merchants', { method: 'POST', body: '{}' })); assert.equal(attempts, 1);
});
test('transport denies custom registration fields before native fetch', async () => {
  let attempts = 0; const p = plan('https://api.peable.to');
  const fetch = boundedFetch(async () => { attempts++; }, p, material, {}, () => {});
  await assert.rejects(fetch(p.peableBase + '/v1/merchants', { method: 'POST', body: '{"price":1}' })); assert.equal(attempts, 0);
});
test('expired operation performs no native fetch', async () => {
  let attempts = 0; const p = plan('https://api.peable.to'); p.expiresAt = Date.now() - 1;
  const fetch = boundedFetch(async () => { attempts++; }, p, material, {}, () => {});
  await assert.rejects(fetch(p.peableBase + '/v1/merchants/me')); assert.equal(attempts, 0);
});
test('production or foreign merchant is rejected', () => {
  assert.throws(() => merchantIdentity({ ...merchant, environment: 'production' }));
  assert.throws(() => merchantIdentity({ ...merchant, oxyAppId: 'other' }));
});
test('material verifier mismatch is rejected', () => assert.throws(() => validateMaterial(JSON.stringify({ ...material, secretHash: '0'.repeat(64) }))));
test('transport enforces redirect:error and stream byte bound', async () => {
  const p = plan('https://api.peable.to'); let redirect;
  const fetch = boundedFetch(async (url, options) => { redirect = options.redirect; return new Response('x'.repeat(65537)); }, p, material, {}, () => {});
  await assert.rejects(fetch(p.peableBase + '/v1/merchants/me')); assert.equal(redirect, 'error');
});
