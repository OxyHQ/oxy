import { createHash, createPublicKey, verify } from 'node:crypto';

const ORIGIN = 'https://api.oxy.so';
const APP = '6a2f851751b784a86fd0e934';
const OWNER = '01a0369b-1222-712f-8df6-f8ffeb78ccc2';
const WORKLOAD_CREDENTIAL = 'wl_d50a0056191d0448024900b4';
const MODEL = 'openai/gpt-oss-120b@observed-2026-09-01';
const PROVIDERS = new Set(['cerebras', 'groq', 'openrouter']);
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
const digest = value => createHash('sha256').update(value).digest('hex');

async function boundedJSON(response, maximum = 65536) {
  const reader = response.body?.getReader();
  requireValue(reader, 'missing-response-body');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      requireValue(size <= maximum, 'response-too-large'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}

function segment(value) {
  const bytes = Buffer.from(value, 'base64url');
  requireValue(bytes.toString('base64url') === value, 'noncanonical-jwt');
  return JSON.parse(bytes.toString('utf8'));
}

export async function verifyAliaCredential(token, fetchImpl = fetch, now = Date.now) {
  requireValue(typeof token === 'string' && token.length <= 32768, 'missing-credential');
  const parts = token.split('.'); requireValue(parts.length === 3, 'malformed-token');
  const header = segment(parts[0]); const principal = segment(parts[1]);
  requireValue(header.alg === 'EdDSA' && header.typ === 'JWT' && typeof header.kid === 'string', 'invalid-jwt-header');
  const response = await fetchImpl(`${ORIGIN}/.well-known/jwks.json`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  requireValue(response.status === 200, 'jwks-http-error');
  const keys = (await boundedJSON(response)).keys;
  requireValue(Array.isArray(keys) && keys.length > 0 && keys.length <= 20, 'invalid-jwks');
  const matches = keys.filter(key => key?.kid === header.kid); requireValue(matches.length === 1, 'nonunique-key');
  const key = matches[0];
  requireValue(key.kty === 'OKP' && key.crv === 'Ed25519' && key.alg === 'EdDSA' && key.use === 'sig' && !Object.hasOwn(key, 'd'), 'invalid-public-key');
  const signature = Buffer.from(parts[2], 'base64url');
  requireValue(signature.length === 64 && signature.toString('base64url') === parts[2] && verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), signature), 'signature-rejected');
  requireValue(principal.type === 'service' && principal.iss === 'oxy-auth' && principal.aud === 'oxy-api'
    && principal.appId === APP && principal.environment === 'production'
    && Number.isSafeInteger(principal.iat) && Number.isSafeInteger(principal.exp)
    && principal.exp - principal.iat === 300 && principal.exp * 1000 > now() + 190000
    && principal.iat * 1000 <= now() + 10000
    && principal.ownerAccountId === OWNER
    && principal.credentialId === WORKLOAD_CREDENTIAL
    && Array.isArray(principal.scopes) && principal.scopes.every(scope => typeof scope === 'string')
    && principal.scopes.includes('inference:invoke') && principal.scopes.includes('inference:usage:read'), 'wrong-alia-authority');
  return { appId: APP, ownerAccountId: OWNER, credentialId: WORKLOAD_CREDENTIAL, environment: principal.environment, signatureVerified: true, lifetime: 300 };
}

