import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://api.oxy.so';
const APP = '6a2f851751b784a86fd0e934';
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
    && principal.exp - principal.iat === 300 && principal.exp * 1000 > now()
    && principal.iat * 1000 <= now() + 10000
    && typeof principal.ownerAccountId === 'string' && principal.ownerAccountId.length > 0
    && typeof principal.credentialId === 'string' && principal.credentialId.length > 0
    && Array.isArray(principal.scopes) && principal.scopes.every(scope => typeof scope === 'string')
    && principal.scopes.includes('inference:invoke'), 'wrong-alia-authority');
  return { appId: APP, environment: principal.environment, signatureVerified: true, lifetime: 300 };
}

export async function runCanary({ credential, clientRequestId, fetchImpl = fetch, now = Date.now }) {
  requireValue(typeof credential === 'function' && /^oxy1519-i09-[0-9]{13}-[a-f0-9]{16}$/.test(clientRequestId), 'invalid-intent');
  // The caller factory is the reviewed deployed Alia adapter; no locally manufactured service bearer.
  const token = await credential();
  const principal = await verifyAliaCredential(token, fetchImpl, now);
  const body = JSON.stringify({ model: MODEL, input: 'Reply with OK.', maxOutputTokens: 16, stream: false, clientRequestId });
  const invoke = () => fetchImpl(`${ORIGIN}/v1/responses`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': clientRequestId }, body,
  });
  const started = now(); const first = await invoke();
  const base = { schemaVersion: 1, clientRequestId, requestBodySha256: digest(body), authority: principal,
    firstHttpStatus: first.status, elapsedMs: now() - started };
  if (first.status !== 200) {
    await first.body?.cancel();
    return { ...base, ok: false, code: 'first-request-refused-or-failed', retryAttempted: false };
  }
  const completion = await boundedJSON(first);
  requireValue(completion.schemaVersion === 1 && typeof completion.requestId === 'string' && completion.requestId.length <= 256
    && completion.model === MODEL && PROVIDERS.has(completion.servingProvider)
    && typeof completion.finishReason === 'string' && completion.finishReason.length <= 64
    && Array.isArray(completion.usage) && completion.usage.length <= 32
    && completion.usage.every(row => typeof row?.unit === 'string' && row.unit.length <= 64 && Number.isSafeInteger(row.quantity) && row.quantity >= 0)
    && typeof completion.routingPolicy?.routingPolicyId === 'string' && completion.routingPolicy.routingPolicyId.length <= 128 && Number.isSafeInteger(completion.routingPolicy.policyVersion) && completion.routingPolicy.policyVersion > 0, 'unexpected-completion');
  // Only repeat the same admitted intent. Never generate a new key after failure/timeout.
  const second = await invoke();
  const conflict = await boundedJSON(second);
  const ok = second.status === 409 && conflict.code === 'idempotency_conflict';
  return { ...base, ok, code: ok ? 'admission-and-conflict-observed' : 'retry-contract-failed', retryAttempted: true,
    requestId: completion.requestId, model: completion.model, provider: completion.servingProvider,
    finishReason: completion.finishReason, usage: completion.usage,
    routingPolicy: { routingPolicyId: completion.routingPolicy.routingPolicyId, policyVersion: completion.routingPolicy.policyVersion }, retryHttpStatus: second.status,
    limits: ['Requires separate exact SQL attempt-set/no-second-operation and authenticated feed replay readback.',
      'One real inference may incur upstream cost. Usage does not assert price or unknown money as zero.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, helperPath, helperSha256, intent] = process.argv.slice(2);
  try {
    requireValue(action === '--execute' && /^\/app\/.*oxy-inference-credential\.(js|ts)$/.test(helperPath ?? '') && /^[a-f0-9]{64}$/.test(helperSha256 ?? ''), 'invalid-execution-plan');
    const bytes = readFileSync(helperPath); requireValue(digest(bytes) === helperSha256, 'helper-source-changed');
    requireValue(process.env.OXY_API_URL === ORIGIN && Boolean(process.env.OXY_SERVICE_API_KEY) === Boolean(process.env.OXY_SERVICE_API_SECRET), 'wrong-lane-configuration');
    const module = await import(pathToFileURL(helperPath).href);
    requireValue(typeof module.createOxyInferenceCredential === 'function', 'missing-real-alia-factory');
    const credential = module.createOxyInferenceCredential(process.env);
    const result = await runCanary({ credential, clientRequestId: intent });
    console.log(`OXY_INTERNAL_PILOT_CANARY ${JSON.stringify(result)}`); process.exitCode = result.ok ? 0 : 1;
  } catch {
    // Exceptions can contain a response body or credential; never emit them.
    console.log('OXY_INTERNAL_PILOT_CANARY {"ok":false,"code":"execution-validation-or-request-failed","inspectOriginalIntentBeforeAnyRetry":true}'); process.exitCode = 1;
  }
}
