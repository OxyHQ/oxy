import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { runCanary } from './pilot-canary.mjs';

const intent = 'oxy1519-i09-1791028800000-0011223344556677';
const now = () => 1791028800000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'EdDSA', use: 'sig' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: 'synthetic' })}.${encode({ type: 'service', iss: 'oxy-auth', aud: 'oxy-api', appId: '6a2f851751b784a86fd0e934', environment: 'production', ownerAccountId: '01a0369b-1222-712f-8df6-f8ffeb78ccc2', credentialId: 'wl_d50a0056191d0448024900b4', scopes: ['inference:invoke'], iat: now() / 1000, exp: now() / 1000 + 300, ...overrides })}`;
  const token = `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
  return { token, key };
}

test('real signed token and bounded HTTP response, exact intent repeated without token/text output', async () => {
  const { token, key } = fixture(); const invocations = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/jwks.json')) return json({ keys: [key] });
    invocations.push(options);
    return invocations.length === 1 ? json({ schemaVersion: 1, requestId: 'fixture-request', model: 'openai/gpt-oss-120b@observed-2026-09-01', servingProvider: 'groq', finishReason: 'stop', output: ['private-generated-text'], usage: [{ unit: 'output_tokens', quantity: 2 }], routingPolicy: { routingPolicyId: 'fixture-policy', policyVersion: 1 } }) : json({ code: 'idempotency_conflict' }, 409);
  };
  const result = await runCanary({ credential: async () => token, clientRequestId: intent, now, fetchImpl });
  assert.equal(result.ok, true); assert.equal(invocations.length, 2);
  assert.equal(invocations[0].body, invocations[1].body);
  assert.deepEqual(invocations[0].headers, invocations[1].headers);
  assert.equal(invocations[0].headers['X-Oxy-User-Id'], undefined);
  assert.equal(JSON.parse(invocations[0].body).maxOutputTokens, 16);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes('private-generated-text'), false);
});

for (const [label, changes] of [['wrong owner', { ownerAccountId: 'foreign' }], ['wrong workload', { credentialId: 'foreign' }], ['wrong app', { appId: 'foreign' }], ['wrong environment', { environment: 'test' }], ['missing scope', { scopes: [] }], ['old lifetime', { exp: now() / 1000 + 3600 }]]) {
  test(`${label} never invokes inference`, async () => {
    const { token, key } = fixture(changes); let calls = 0;
    await assert.rejects(runCanary({ credential: async () => token, clientRequestId: intent, now, fetchImpl: async url => { assert.equal(url.endsWith('/jwks.json'), true); calls++; return json({ keys: [key] }); } }), /wrong-alia-authority/);
    assert.equal(calls, 1);
  });
}

test('first refusal does not retry or silently choose another intent', async () => {
  const { token, key } = fixture(); let inference = 0;
  const result = await runCanary({ credential: async () => token, clientRequestId: intent, now, fetchImpl: async url => url.endsWith('/jwks.json') ? json({ keys: [key] }) : (inference++, json({ code: 'model_unavailable' }, 403)) });
  assert.equal(result.ok, false); assert.equal(result.retryAttempted, false); assert.equal(inference, 1);
});

test('bad signature never invokes inference', async () => {
  const a = fixture(), b = fixture(); let calls = 0;
  await assert.rejects(runCanary({ credential: async () => a.token, clientRequestId: intent, now, fetchImpl: async url => { assert.equal(url.endsWith('/jwks.json'), true); calls++; return json({ keys: [b.key] }); } }), /signature-rejected/);
  assert.equal(calls, 1);
});
