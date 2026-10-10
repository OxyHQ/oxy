/** Mint/JWKS monitor: writes only auth lastUsedAt/rate-limit state. Tokens and credential values never enter output. */
import { createPublicKey, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const ORIGIN = 'https://api.oxy.so';
const GAP_MS = 245000;
function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}
async function jsonBounded(response, maximum = 65536) {
  const reader = response.body?.getReader();
  requireValue(reader, 'missing-response-body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValue(size <= maximum, 'response-too-large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}
function segment(value) {
  const bytes = Buffer.from(value, 'base64url');
  requireValue(bytes.toString('base64url') === value, 'noncanonical-jwt');
  return JSON.parse(bytes.toString('utf8'));
}
export async function probeIssuer({
  apiKey,
  apiSecret,
  baseURL = ORIGIN,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  requireValue(
    typeof apiKey === 'string' &&
      apiKey.length > 0 &&
      apiKey.length <= 128 &&
      typeof apiSecret === 'string' &&
      apiSecret.length > 0 &&
      apiSecret.length <= 1024,
    'missing-canary-credential',
  );
  const observations = [];
  let lastPrincipal;
  const startedAt = now();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(GAP_MS);
    const start = now();
    if (attempt) requireValue(start - startedAt > 240000, 'renewal-gap-too-short');
    const response = await fetchImpl(`${baseURL}/auth/service-token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, apiSecret }),
    });
    const finish = now();
    const observation = {
      attempt: attempt + 1,
      httpStatus: response.status,
      startMs: start,
      finishMs: finish,
      elapsedSinceFirstMs: start - startedAt,
      retryAfter: response.status === 429 ? response.headers.get('retry-after') : null,
    };
    // Record 429 explicitly; no hidden retries and no response body can echo credentials.
    if (response.status !== 200) {
      await response.body?.cancel();
      observations.push(observation);
      return {
        ok: false,
        code: response.status === 429 ? 'mint-throttled' : 'mint-http-error',
        observations,
      };
    }
    const envelope = await jsonBounded(response);
    const token = envelope?.data?.token;
    requireValue(
      envelope?.data?.expiresIn === 300 && typeof token === 'string' && token.length <= 32768,
      'issuer-response-not-300',
    );
    const parts = token.split('.');
    requireValue(parts.length === 3, 'malformed-token');
    const header = segment(parts[0]);
    const payload = segment(parts[1]);
    requireValue(
      header.alg === 'EdDSA' && header.typ === 'JWT' && typeof header.kid === 'string',
      'invalid-jwt-header',
    );
    const jwksResponse = await fetchImpl(`${baseURL}/.well-known/jwks.json`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    requireValue(jwksResponse.status === 200, 'jwks-http-error');
    const jwks = await jsonBounded(jwksResponse);
    requireValue(
      Array.isArray(jwks?.keys) && jwks.keys.length > 0 && jwks.keys.length <= 20,
      'invalid-jwks',
    );
    const matches = jwks.keys.filter((key) => key?.kid === header.kid);
    requireValue(matches.length === 1, 'jwks-key-not-unique');
    const jwk = matches[0];
    requireValue(
      jwk.kty === 'OKP' &&
        jwk.crv === 'Ed25519' &&
        jwk.alg === 'EdDSA' &&
        jwk.use === 'sig' &&
        !Object.hasOwn(jwk, 'd'),
      'invalid-public-key',
    );
    const signature = Buffer.from(parts[2], 'base64url');
    requireValue(
      signature.length === 64 &&
        signature.toString('base64url') === parts[2] &&
        verify(
          null,
          Buffer.from(`${parts[0]}.${parts[1]}`),
          createPublicKey({ key: jwk, format: 'jwk' }),
          signature,
        ),
      'jwt-signature-rejected',
    );
    requireValue(
      payload.type === 'service' &&
        payload.iss === 'oxy-auth' &&
        payload.aud === 'oxy-api' &&
        Number.isSafeInteger(payload.iat) &&
        Number.isSafeInteger(payload.exp) &&
        payload.exp - payload.iat === 300 &&
        payload.exp * 1000 > finish,
      'invalid-service-claims',
    );
    const principal = JSON.stringify([
      payload.appId,
      payload.credentialId,
      payload.ownerAccountId,
      payload.environment,
      payload.scopes,
    ]);
    requireValue(
      [payload.appId, payload.credentialId, payload.ownerAccountId, payload.environment].every(
        (value) => typeof value === 'string' && value.length > 0,
      ) &&
        Array.isArray(payload.scopes) &&
        payload.scopes.every((value) => typeof value === 'string'),
      'invalid-attribution',
    );
    if (lastPrincipal) requireValue(principal === lastPrincipal, 'principal-changed');
    lastPrincipal = principal;
    // Whole-second JWT iat bounds offset using both ends of the observed request.
    observations.push({
      ...observation,
      signatureVerified: true,
      expiresIn: 300,
      lifetimeSeconds: payload.exp - payload.iat,
      issuerClockOffsetBoundsMs: [payload.iat * 1000 - finish, (payload.iat + 1) * 1000 - start],
    });
  }
  return {
    ok: true,
    observations,
    limits: [
      'One selected credential, two mints; not a whole-fleet capacity measurement',
      'No token/use of scopes/effects; no secret or identity attributes returned',
    ],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeIssuer({
      apiKey: process.env.OXY_CANARY_API_KEY,
      apiSecret: process.env.OXY_CANARY_API_SECRET,
    });
    console.log(`OXY_SERVICE_TOKEN_CANARY ${JSON.stringify(result)}`);
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log('OXY_SERVICE_TOKEN_CANARY {"ok":false,"code":"canary-validation-failed"}');
    process.exitCode = 1;
  }
}
