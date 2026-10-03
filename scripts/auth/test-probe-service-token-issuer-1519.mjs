import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { probeIssuer } from './probe-service-token-issuer-1519.mjs';
const keys = generateKeyPairSync('ed25519');
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'EdDSA', use: 'sig' };
let clock = Date.now(); let requests = 0; let status = 200; let lifetime = 300;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/.well-known/jwks.json') return res.end(JSON.stringify({ keys: [jwk] }));
  assert.equal(req.method, 'POST'); assert.equal(req.url, '/auth/service-token');
  requests++; req.resume();
  if (status !== 200) { res.statusCode = status; res.setHeader('Retry-After', '300'); return res.end('{}'); }
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(clock / 1000);
  const header = encode({ alg: 'EdDSA', typ: 'JWT', kid: 'fixture' });
  const payload = encode({ type: 'service', iss: 'oxy-auth', aud: 'oxy-api', iat, exp: iat + lifetime,
    appId: 'fixture-app', credentialId: 'fixture-credential', ownerAccountId: 'fixture-owner', environment: 'production', scopes: [] });
  const body = `${header}.${payload}`;
  res.end(JSON.stringify({ data: { token: `${body}.${sign(null, Buffer.from(body), keys.privateKey).toString('base64url')}`, expiresIn: lifetime } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const options = { apiKey: 'fixture-public', apiSecret: 'fixture-secret', baseURL: `http://127.0.0.1:${server.address().port}`,
    sleep: async ms => { clock += ms; }, now: () => clock };
  const result = await probeIssuer(options); assert.equal(result.ok, true); assert.equal(requests, 2);
  assert.equal(result.observations[1].elapsedSinceFirstMs, 245000);
  assert.ok(!JSON.stringify(result).includes('fixture-secret')); assert.ok(!JSON.stringify(result).includes('fixture-public'));
  status = 429; requests = 0;
  const throttled = await probeIssuer(options); assert.equal(throttled.ok, false); assert.equal(throttled.code, 'mint-throttled'); assert.equal(requests, 1);
  status = 200; lifetime = 3600;
  await assert.rejects(probeIssuer(options), /issuer-response-not-300/);
  lifetime = 300;
  await assert.rejects(probeIssuer({ ...options, sleep: async () => {} }), /renewal-gap-too-short/);
  console.log('Issuer monitor: actual HTTP + EdDSA/JWKS fixtures PASS; virtual delay only, no live mint.');
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
