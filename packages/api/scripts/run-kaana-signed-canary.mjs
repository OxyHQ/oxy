#!/usr/bin/env node

/**
 * Production Oxy -> Kaana wire canary.
 *
 * This command deliberately calls Kaana directly. It never calls an Oxy HTTP
 * endpoint, imports an Oxy database module, reserves balance, or settles a
 * receipt. The ECS workflow that owns it removes DATABASE_URL and every secret
 * except the Ed25519 edge-signing key before the task starts. The only writes
 * are Kaana's normal technical records for the two one-token positive probes —
 * or, in `realtime` mode, for its one bounded push-to-talk session.
 *
 * `realtime` mode opens signed sessions on Kaana's `/internal/v1/realtime` for
 * one exact deployment: first a session authorized only for an unknown
 * deployment, which must end `no_route_available` without ever opening, then
 * ONE text-only push-to-talk session (`turnDetection: none`, one text item,
 * one response, at most one second of output audio signed), which must open on
 * exactly that route, answer `response.done`, and settle on `session.close`
 * with `session.closed` and a usage report carrying units. The WebSocket client
 * below is a minimal RFC 6455 client on `node:http`: this script runs before
 * workspace dependencies are installed and imports nothing but Node.
 */

import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const CANONICAL_KAANA_ORIGIN = 'https://kaana.ai';
const SIGNATURE_DOMAIN = 'oxy-kaana-envelope:v1';
const INFERENCE_PATH = '/internal/v1/inference';
const HEALTH_PATH = '/internal/v1/health';
const DEPLOYMENTS_PATH = '/internal/v1/deployments/query';
const REALTIME_PATH = '/internal/v1/realtime';
/** The whole realtime probe — both sessions — must finish within this. */
const REALTIME_SESSION_TIMEOUT_MS = 60_000;
/** Kaana's own bound on one realtime frame it sends. */
const MAX_REALTIME_FRAME_BYTES = 8 * 1024 * 1024;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/**
 * The session's signed limits: one response, one minute, no input audio beyond
 * a single byte, and at most one second of 24 kHz PCM16 output — the provider
 * is asked for text only, and Kaana closes the session rather than exceed any
 * of these.
 */
const REALTIME_CANARY_LIMITS = {
  maxDurationMs: 60_000,
  idleTimeoutMs: 30_000,
  maxInputAudioBytes: 1,
  maxOutputAudioBytes: 48_000,
  maxResponses: 1,
};
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

const MODEL_REFERENCE_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

// This script runs in the secret-minimized deploy-script job before workspace
// dependencies are installed, so it cannot import @oxy.so/contracts. The gate
// holds this local closed set exactly equal to inference/errors.ts.
const CANARY_INFERENCE_ERROR_CODES = [
  'invalid_request',
  'authentication_failed',
  'permission_denied',
  'insufficient_scope',
  'model_not_found',
  'unsupported_modality',
  'context_length_exceeded',
  'request_too_large',
  'output_limit_exceeded',
  'idempotency_conflict',
  'insufficient_balance',
  'spending_limit_exceeded',
  'quota_exceeded',
  'byok_credential_invalid',
  'policy_violation',
  'commercial_permission_denied',
  'no_route_available',
  'upstream_content_filtered',
  'cancelled',
  'rate_limited',
  'deployment_unavailable',
  'provider_error',
  'provider_timeout',
  'provider_overloaded',
  'provider_credential_invalid',
  'provider_billing_refused',
  'service_unavailable',
  'internal_error',
];
const CANARY_INFERENCE_ERROR_CODE_SET = new Set(CANARY_INFERENCE_ERROR_CODES);
// The gate holds this wire allowlist exactly equal to the start-event contract.
// generationId is the contract's only optional key, so both exact shapes are valid.
const CANARY_START_EVENT_FIELDS = [
  'schemaVersion',
  'type',
  'requestId',
  'sequence',
  'generationId',
  'resolvedModelReference',
  'servingProvider',
  'startedAt',
];
const CANARY_START_ID_MAX_LENGTH = 128;
const CANARY_UTC_DATETIME_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]+))?)?Z$/;

export class KaanaCanaryError extends Error {
  constructor(code, inferenceErrorCode) {
    super(code);
    this.name = 'KaanaCanaryError';
    this.code = code;
    if (CANARY_INFERENCE_ERROR_CODE_SET.has(inferenceErrorCode)) {
      this.inferenceErrorCode = inferenceErrorCode;
    }
  }
}

function fail(code, inferenceErrorCode) {
  throw new KaanaCanaryError(code, inferenceErrorCode);
}

function safeInferenceErrorCode(event) {
  const code = event?.error?.code;
  return typeof code === 'string' && CANARY_INFERENCE_ERROR_CODE_SET.has(code)
    ? code
    : undefined;
}

function hasExactStartEventFields(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false;
  const hasGenerationId = Object.prototype.hasOwnProperty.call(event, 'generationId');
  const expectedFields = CANARY_START_EVENT_FIELDS.filter(
    (field) => field !== 'generationId' || hasGenerationId,
  );
  const actualFields = Object.keys(event);
  return actualFields.length === expectedFields.length &&
    expectedFields.every((field) => Object.prototype.hasOwnProperty.call(event, field));
}

function isContractUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = CANARY_UTC_DATETIME_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function exactString(env, name, maxLength) {
  const value = env[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /\s/u.test(value)
  ) {
    fail(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function positiveInteger(env, name) {
  const raw = exactString(env, name, 16);
  if (!/^[1-9][0-9]*$/.test(raw)) fail(`invalid_${name.toLowerCase()}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`invalid_${name.toLowerCase()}`);
  return value;
}

function secretString(env, name, maxLength) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function parsePrivateKey(raw) {
  try {
    const pem = raw.includes('-----BEGIN')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') fail('signing_key_is_not_ed25519');
    return key;
  } catch (error) {
    if (error instanceof KaanaCanaryError) throw error;
    fail('signing_key_is_unreadable');
  }
}

/** Read the common signed-operator boundary before making a network request. */
export function readKaanaSigningConfig(env = process.env) {
  if (env.KAANA_BASE_URL !== CANONICAL_KAANA_ORIGIN) {
    fail('kaana_origin_is_not_canonical');
  }

  let baseUrl = CANONICAL_KAANA_ORIGIN;
  if (env.CANARY_KAANA_PRIVATE_ORIGIN !== undefined) {
    const candidate = exactString(env, 'CANARY_KAANA_PRIVATE_ORIGIN', 64);
    const match = /^http:\/\/(10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3})\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3})\.\d{1,3}):8080$/.exec(candidate);
    if (match === null || match[1].split('.').some((octet) => Number(octet) > 255)) {
      fail('candidate_kaana_origin_is_not_private');
    }
    baseUrl = candidate;
  }

  return {
    baseUrl,
    keyId: exactString(env, 'KAANA_EDGE_SIGNING_KEY_ID', 128),
    privateKey: parsePrivateKey(secretString(env, 'KAANA_EDGE_SIGNING_PRIVATE_KEY', 16_384)),
    expectedContractVersion: exactString(env, 'CANARY_CONTRACT_VERSION', 32),
  };
}

/**
 * The realtime probe's inputs: the signing boundary, the exact snapshot and
 * deployment, and the attribution. No routing profile — a session names its
 * model and is never routed through one.
 */
export function readKaanaRealtimeCanaryConfig(env = process.env) {
  return {
    ...readKaanaSigningConfig(env),
    expectedSnapshotId: exactString(env, 'CANARY_EXPECTED_SNAPSHOT_ID', 256),
    deploymentId: exactString(env, 'CANARY_DEPLOYMENT_ID', 128),
    routingPolicyId: exactString(env, 'CANARY_ROUTING_POLICY_ID', 128),
    routingPolicyVersion: positiveInteger(env, 'CANARY_ROUTING_POLICY_VERSION'),
    accountId: exactString(env, 'CANARY_ACCOUNT_ID', 64),
    applicationId: exactString(env, 'CANARY_APPLICATION_ID', 64),
    credentialId: exactString(env, 'CANARY_CREDENTIAL_ID', 64),
  };
}

/** Read and validate all canary-only operator inputs before network access. */
export function readKaanaCanaryConfig(env = process.env) {
  return {
    ...readKaanaSigningConfig(env),
    expectedSnapshotId: exactString(env, 'CANARY_EXPECTED_SNAPSHOT_ID', 256),
    // Deployment ids are opaque inventory identities, not UUIDs. Exactness is
    // proved by the signed live lookup below; no format heuristic selects one
    // and no trimming or normalization is ever applied.
    deploymentId: exactString(env, 'CANARY_DEPLOYMENT_ID', 128),
    // Oxy owns both identities and supports legacy ObjectIds beside UUIDv7.
    // Their exact database lookup happens in the separate edge canary.
    routingProfileId: exactString(env, 'CANARY_ROUTING_PROFILE_ID', 128),
    routingPolicyId: exactString(env, 'CANARY_ROUTING_POLICY_ID', 128),
    routingPolicyVersion: positiveInteger(env, 'CANARY_ROUTING_POLICY_VERSION'),
    accountId: exactString(env, 'CANARY_ACCOUNT_ID', 64),
    applicationId: exactString(env, 'CANARY_APPLICATION_ID', 64),
    credentialId: exactString(env, 'CANARY_CREDENTIAL_ID', 64),
  };
}

function signingInput(keyId, timestamp, body) {
  const digest = createHash('sha256').update(body).digest('hex');
  return Buffer.from(
    [SIGNATURE_DOMAIN, keyId, String(timestamp), digest].join('\n'),
    'utf8',
  );
}

function signedHeaders(config, body, accept) {
  const timestamp = Date.now();
  const signature = sign(
    null,
    signingInput(config.keyId, timestamp, body),
    config.privateKey,
  ).toString('base64');
  return {
    Accept: accept,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Oxy-Kaana-Key-Id': config.keyId,
    'X-Oxy-Kaana-Timestamp': String(timestamp),
    'X-Oxy-Kaana-Signature': `v1=${signature}`,
  };
}

async function readBounded(response) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    fail('response_too_large');
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function signedRequest(config, fetchImpl, method, path, payload, accept) {
  const body = payload === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(payload), 'utf8');
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: signedHeaders(config, body, accept),
      body: method === 'GET' ? undefined : body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail('kaana_request_failed');
  }
  return { response, body: await readBounded(response) };
}

function parseJSON(body, code) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    fail(code);
  }
}

function parseSSE(body) {
  const frames = [];
  const text = body.toString('utf8').replace(/\r\n/g, '\n');
  for (const block of text.split('\n\n')) {
    if (block.length === 0) continue;
    let event = '';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (event === '' || data.length === 0) fail('invalid_sse_frame');
    if (event !== 'stream_event' && event !== 'usage_report') {
      fail('unknown_sse_event');
    }
    frames.push({ event, payload: parseJSON(Buffer.from(data.join('\n')), 'invalid_sse_json') });
  }
  if (frames.length === 0) fail('empty_sse_stream');
  return frames;
}

function assertNoStore(response) {
  if (!response.headers.get('cache-control')?.toLowerCase().includes('no-store')) {
    fail('response_is_cacheable');
  }
}

function hasExactKeys(value, keys) {
  return typeof value === 'object' &&
    value !== null &&
    Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000');
}

/**
 * Kaana's closed accepted-parameter vocabulary, sorted: `provider.RequestParameters()`
 * in Kaana's internal/provider/parameters.go. The same list as
 * `DEPLOYMENT_REQUEST_PARAMETERS` in packages/api/src/db/schema/inferenceDeployments.ts;
 * scripts/check-kaana-signed-canary.mjs fails if the two drift.
 */
const CANARY_DEPLOYMENT_REQUEST_PARAMETERS = [
  'maxOutputTokens',
  'reasoning.effort',
  'responseFormat',
  'sampling.frequencyPenalty',
  'sampling.presencePenalty',
  'sampling.seed',
  'sampling.stopSequences',
  'sampling.temperature',
  'sampling.topP',
  'toolChoice',
  'tools',
];

/**
 * Kaana's `ValidateParameterSet`: every word in the vocabulary, sorted, each
 * once. Absent is unknown and `[]` is "takes none"; anything else is refused.
 */
function isAcceptedParameterSet(value) {
  return Array.isArray(value) &&
    value.every((parameter, index) =>
      typeof parameter === 'string' &&
      CANARY_DEPLOYMENT_REQUEST_PARAMETERS.includes(parameter) &&
      (index === 0 || value[index - 1] < parameter));
}

function routeFromDescriptor(descriptor) {
  // `acceptedParameters` is the one optional field Kaana's DeploymentDescriptor
  // carries (`omitempty`). It is validated, never copied: it is not part of
  // the route identity the canary signs or the operator projection.
  const hasAcceptedParameters = typeof descriptor === 'object' &&
    descriptor !== null &&
    Object.hasOwn(descriptor, 'acceptedParameters');
  if (
    !hasExactKeys(descriptor, [
      'deploymentId',
      'modelReference',
      'provider',
      'regions',
      ...(hasAcceptedParameters ? ['acceptedParameters'] : []),
    ]) ||
    (hasAcceptedParameters && !isAcceptedParameterSet(descriptor.acceptedParameters)) ||
    typeof descriptor.deploymentId !== 'string' ||
    descriptor.deploymentId.length === 0 ||
    descriptor.deploymentId.length > 128 ||
    /\s/u.test(descriptor.deploymentId) ||
    typeof descriptor.modelReference !== 'string' ||
    descriptor.modelReference.length > 194 ||
    !MODEL_REFERENCE_PATTERN.test(descriptor.modelReference) ||
    typeof descriptor.provider !== 'string' ||
    descriptor.provider.length > 64 ||
    !SLUG_PATTERN.test(descriptor.provider) ||
    !Array.isArray(descriptor.regions) ||
    !descriptor.regions.every((region) =>
      typeof region === 'string' && region.length <= 64 && SLUG_PATTERN.test(region))
  ) {
    fail('invalid_deployment_descriptor');
  }
  return {
    substitution: 'same_model',
    deploymentId: descriptor.deploymentId,
    modelReference: descriptor.modelReference,
    provider: descriptor.provider,
    regions: descriptor.regions,
  };
}

function safeDescriptor(route) {
  return {
    deploymentId: route.deploymentId,
    modelReference: route.modelReference,
    provider: route.provider,
    regions: route.regions,
  };
}

async function requireCompatibleHealth(config, fetchImpl) {
  const health = await signedRequest(config, fetchImpl, 'GET', HEALTH_PATH, undefined, 'application/json');
  if (health.response.status !== 200) fail('health_refused');
  const healthPayload = parseJSON(health.body, 'invalid_health_json');
  if (healthPayload?.contractVersion !== config.expectedContractVersion) {
    fail('contract_version_mismatch');
  }
}

/** Read the signed serving projection without selecting by name or position. */
export async function readKaanaLiveDeployments(config, fetchImpl = globalThis.fetch) {
  await requireCompatibleHealth(config, fetchImpl);
  const lookup = await signedRequest(
    config,
    fetchImpl,
    'POST',
    DEPLOYMENTS_PATH,
    {},
    'application/json',
  );
  assertNoStore(lookup.response);
  if (lookup.response.status !== 200) fail('deployment_list_refused');
  const payload = parseJSON(lookup.body, 'invalid_deployment_list_json');
  if (
    !hasExactKeys(payload, ['snapshotId', 'deployments']) ||
    typeof payload?.snapshotId !== 'string' ||
    payload.snapshotId.length === 0 ||
    payload.snapshotId.length > 256 ||
    payload.snapshotId !== payload.snapshotId.trim() ||
    !Array.isArray(payload.deployments) ||
    payload.deployments.length === 0
  ) {
    fail('invalid_deployment_list');
  }
  const deployments = payload.deployments.map(routeFromDescriptor).map(safeDescriptor);
  if (new Set(deployments.map((descriptor) => descriptor.deploymentId)).size !== deployments.length) {
    fail('ambiguous_deployment_list');
  }
  return { snapshotId: payload.snapshotId, deployments };
}

async function readLiveDescriptor(config, fetchImpl) {
  await requireCompatibleHealth(config, fetchImpl);

  const lookup = await signedRequest(
    config,
    fetchImpl,
    'POST',
    DEPLOYMENTS_PATH,
    { deploymentIds: [config.deploymentId] },
    'application/json',
  );
  assertNoStore(lookup.response);
  if (lookup.response.status !== 200) fail('deployment_lookup_refused');
  const payload = parseJSON(lookup.body, 'invalid_deployment_lookup_json');
  if (
    !hasExactKeys(payload, ['snapshotId', 'deployments']) ||
    typeof payload?.snapshotId !== 'string' ||
    payload.snapshotId.length === 0 ||
    !Array.isArray(payload.deployments) ||
    payload.deployments.length !== 1
  ) {
    fail('invalid_deployment_lookup');
  }
  if (payload.snapshotId !== config.expectedSnapshotId) {
    fail('snapshot_id_mismatch');
  }
  const route = routeFromDescriptor(payload.deployments[0]);
  if (route.deploymentId !== config.deploymentId) {
    fail('deployment_identity_mismatch');
  }
  return { snapshotId: payload.snapshotId, route };
}

function requestId(label) {
  return `canary-${label}-${randomUUID()}`;
}

function envelope(config, schemaVersion, target, route, label) {
  const id = requestId(label);
  return {
    requestId: id,
    payload: {
      schemaVersion,
      attribution: {
        principal: {
          billing: { accountId: config.accountId },
          applicationId: config.applicationId,
          credentialId: config.credentialId,
          environment: 'production',
          inferenceScopes: ['inference:invoke'],
        },
        requestId: id,
      },
      target,
      modality: 'text',
      input: {
        format: 'messages',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Reply with OK.' }],
        }],
      },
      stream: true,
      maxOutputTokens: 1,
      sampling: {},
      tools: [],
      client: {
        apiFormat: 'responses',
        endpoint: '/v1/responses',
        receivedAt: new Date().toISOString(),
        labels: { purpose: 'production-signed-canary' },
      },
      routingPolicy: {
        routingPolicyId: config.routingPolicyId,
        policyVersion: config.routingPolicyVersion,
      },
      authorizedRoutes: [route],
    },
  };
}

async function inference(config, fetchImpl, payload) {
  const result = await signedRequest(
    config,
    fetchImpl,
    'POST',
    INFERENCE_PATH,
    payload,
    'text/event-stream',
  );
  return { ...result, frames: result.response.status === 200 ? parseSSE(result.body) : [] };
}

function streamEvents(result) {
  return result.frames.filter((frame) => frame.event === 'stream_event').map((frame) => frame.payload);
}

function usageReports(result) {
  return result.frames.filter((frame) => frame.event === 'usage_report').map((frame) => frame.payload);
}

async function expectSlugRefusal(config, fetchImpl, schemaVersion, route) {
  // Keep this probe non-executable even if a candidate accidentally accepts
  // the removed slug arm: the target parser is what must return HTTP 400, while
  // the deliberately unknown route prevents that regression from reaching a
  // provider before the canary can report it.
  const guardedRoute = {
    ...route,
    deploymentId: `dep_canary_slug_guard_${randomUUID().replaceAll('-', '')}`,
  };
  const probe = envelope(
    config,
    schemaVersion,
    { kind: 'routing_profile', routingProfile: 'canary' },
    guardedRoute,
    `v${schemaVersion}-slug`,
  );
  const result = await inference(config, fetchImpl, probe.payload);
  if (result.response.status !== 400) fail(`v${schemaVersion}_slug_not_refused`);
  const rejection = parseJSON(result.body, `v${schemaVersion}_slug_invalid_json`);
  if (rejection?.code !== 'invalid_request') fail(`v${schemaVersion}_slug_wrong_code`);
  return { name: `v${schemaVersion}_slug_rejected`, requestId: probe.requestId, status: 'passed', code: rejection.code };
}

async function expectRouteRefusal(config, fetchImpl, label, route) {
  const probe = envelope(
    config,
    2,
    { kind: 'routing_profile_id', routingProfileId: config.routingProfileId },
    route,
    label,
  );
  const result = await inference(config, fetchImpl, probe.payload);
  if (result.response.status !== 200) fail(`${label}_wrong_http_status`);
  const events = streamEvents(result);
  const reports = usageReports(result);
  const terminal = events.at(-1);
  if (
    reports.length !== 0 ||
    events.length !== 1 ||
    terminal?.type !== 'error' ||
    terminal?.error?.code !== 'invalid_request' ||
    terminal?.error?.param !== 'authorizedRoutes[0]'
  ) {
    fail(`${label}_reached_execution`);
  }
  return { name: `${label}_rejected`, requestId: probe.requestId, status: 'passed', code: terminal.error.code };
}

async function expectSuccess(config, fetchImpl, schemaVersion, target, route) {
  const label = schemaVersion === 1
    ? 'v1-direct-model'
    : 'v2-profile-id-propagated-exact-route';
  const probe = envelope(config, schemaVersion, target, route, label);
  const result = await inference(config, fetchImpl, probe.payload);
  if (result.response.status !== 200) fail(`${label}_wrong_http_status`);
  const events = streamEvents(result);
  const reports = usageReports(result);
  const start = events[0];
  const terminal = events.at(-1);
  const report = reports[0];
  const executionErrorEvent = events.find((event) => event?.type === 'error');
  if (executionErrorEvent !== undefined) {
    fail(
      `${label}_execution_error_event_present`,
      safeInferenceErrorCode(executionErrorEvent),
    );
  }
  if (events.filter((event) => event?.type === 'start').length !== 1) {
    fail(`${label}_start_event_count_mismatch`);
  }
  if (start?.type !== 'start') fail(`${label}_start_event_not_first`);
  if (!hasExactStartEventFields(start)) {
    fail(`${label}_start_route_identity_present`);
  }
  if (start.schemaVersion !== 1) fail(`${label}_start_schema_mismatch`);
  if (start.requestId !== probe.requestId) fail(`${label}_start_request_mismatch`);
  if (!Number.isSafeInteger(start.sequence) || start.sequence !== 0) {
    fail(`${label}_start_sequence_mismatch`);
  }
  if (
    Object.prototype.hasOwnProperty.call(start, 'generationId') &&
    (
      typeof start.generationId !== 'string' ||
      start.generationId.length < 1 ||
      start.generationId.length > CANARY_START_ID_MAX_LENGTH
    )
  ) {
    fail(`${label}_start_generation_mismatch`);
  }
  if (!isContractUtcTimestamp(start.startedAt)) {
    fail(`${label}_start_timestamp_mismatch`);
  }
  if (start.resolvedModelReference !== route.modelReference) {
    fail(`${label}_start_model_mismatch`);
  }
  if (start.servingProvider !== route.provider) {
    fail(`${label}_start_provider_mismatch`);
  }
  if (events.filter((event) => event?.type === 'done').length !== 1) {
    fail(`${label}_done_event_count_mismatch`);
  }
  if (terminal?.type !== 'done') fail(`${label}_done_event_not_terminal`);
  if (terminal.receiptId !== undefined) fail(`${label}_terminal_receipt_present`);
  if (reports.length !== 1) fail(`${label}_usage_report_count_mismatch`);
  if (report.schemaVersion !== 2) fail(`${label}_usage_schema_mismatch`);
  if (report.requestId !== probe.requestId) fail(`${label}_usage_request_mismatch`);
  if (report.outcome !== 'completed') fail(`${label}_usage_outcome_mismatch`);
  if (report.deploymentId !== route.deploymentId) {
    fail(`${label}_usage_deployment_mismatch`);
  }
  if (report.resolvedModelReference !== route.modelReference) {
    fail(`${label}_usage_model_mismatch`);
  }
  if (report.servingProvider !== route.provider) {
    fail(`${label}_usage_provider_mismatch`);
  }
  if (!Array.isArray(report.units) || report.units.length === 0) {
    fail(`${label}_usage_units_missing`);
  }
  return {
    name: label,
    requestId: probe.requestId,
    status: 'passed',
    outcome: report.outcome,
    deploymentId: route.deploymentId,
    modelReference: route.modelReference,
    receiptIdPresent: false,
  };
}

/** Run six signed probes. Only the final two can reach a provider. */
export async function runKaanaSignedCanary(config, fetchImpl = globalThis.fetch) {
  const { snapshotId, route } = await readLiveDescriptor(config, fetchImpl);
  const cases = [];

  // Run every fail-closed assertion before spending either positive request.
  cases.push(await expectSlugRefusal(config, fetchImpl, 1, route));
  cases.push(await expectSlugRefusal(config, fetchImpl, 2, route));
  cases.push(await expectRouteRefusal(config, fetchImpl, 'unknown-deployment', {
    ...route,
    deploymentId: `dep_canary_unknown_${randomUUID().replaceAll('-', '')}`,
  }));
  cases.push(await expectRouteRefusal(config, fetchImpl, 'whitespace-deployment', {
    ...route,
    deploymentId: ` ${route.deploymentId}`,
  }));

  cases.push(await expectSuccess(
    config,
    fetchImpl,
    1,
    { kind: 'model', modelReference: route.modelReference },
    route,
  ));
  cases.push(await expectSuccess(
    config,
    fetchImpl,
    2,
    { kind: 'routing_profile_id', routingProfileId: config.routingProfileId },
    route,
  ));

  return {
    schemaVersion: 1,
    status: 'passed',
    contractVersion: config.expectedContractVersion,
    snapshotId,
    deploymentId: config.deploymentId,
    modelReference: route.modelReference,
    routingProfileId: config.routingProfileId,
    providerRequests: 2,
    oxyLedgerWrites: 0,
    cases,
  };
}

/* -------------------------------------------------------------------------- */
/*  Realtime: a minimal signed WebSocket client (RFC 6455, text frames only)  */
/* -------------------------------------------------------------------------- */

/** `https://kaana.ai` → `wss://kaana.ai/internal/v1/realtime`; a private candidate stays `ws:`. */
export function kaanaRealtimeUrl(baseUrl) {
  const url = new URL(REALTIME_PATH, baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString();
}

/** The three signature headers, over the EXACT bytes of the first frame. */
function realtimeSignatureHeaders(config, firstFrame) {
  const timestamp = Date.now();
  const signature = sign(
    null,
    signingInput(config.keyId, timestamp, firstFrame),
    config.privateKey,
  ).toString('base64');
  return {
    'X-Oxy-Kaana-Key-Id': config.keyId,
    'X-Oxy-Kaana-Timestamp': String(timestamp),
    'X-Oxy-Kaana-Signature': `v1=${signature}`,
  };
}

function encodeClientFrame(opcode, payload) {
  const mask = randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * One open connection. `next()` yields `{type:'text', data}`, then — once the
 * peer closed or the frame stream broke — `{type:'close', code}` forever.
 */
class RealtimeWire {
  constructor(socket, head) {
    this.socket = socket;
    this.buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.queue = [];
    this.waiters = [];
    this.ended = undefined;
    this.sentClose = false;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => this.end(this.peerCloseCode ?? 1006));
    socket.on('error', () => undefined);
    this.drain();
  }

  drain() {
    while (this.ended === undefined && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      // No extension was negotiated and a server never masks.
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0) return this.broken();
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const long = this.buffer.readBigUInt64BE(2);
        if (long > BigInt(MAX_REALTIME_FRAME_BYTES)) return this.broken();
        length = Number(long);
        offset = 10;
      }
      if (length > MAX_REALTIME_FRAME_BYTES) return this.broken();
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if (opcode === 0x1 || opcode === 0x0) {
        if ((opcode === 0x1) === (this.fragments.length > 0)) return this.broken();
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_REALTIME_FRAME_BYTES) return this.broken();
        this.fragments.push(Buffer.from(payload));
        if (fin) {
          const data = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.fragmentBytes = 0;
          this.push({ type: 'text', data });
        }
      } else if (opcode === 0x8) {
        this.peerCloseCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(this.peerCloseCode === 1005 ? 1000 : this.peerCloseCode);
        this.end(this.peerCloseCode);
      } else if (opcode === 0x9) {
        if (!this.socket.destroyed) this.socket.write(encodeClientFrame(0xa, payload));
      } else if (opcode === 0xa) {
        // An unsolicited pong carries nothing.
      } else {
        // Binary or reserved: never part of the realtime protocol.
        return this.broken();
      }
    }
  }

  broken() {
    this.socket.destroy();
    this.end(1002);
  }

  push(item) {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.queue.push(item);
  }

  end(code) {
    if (this.ended !== undefined) return;
    this.ended = { type: 'close', code };
    for (const waiter of this.waiters.splice(0)) waiter(this.ended);
  }

  next(timeoutMs) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.ended !== undefined) return Promise.resolve(this.ended);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(settle);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve({ type: 'timeout' });
      }, Math.max(0, timeoutMs));
      const settle = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
      this.waiters.push(settle);
    });
  }

  sendText(data) {
    if (this.ended === undefined && !this.socket.destroyed) {
      this.socket.write(encodeClientFrame(0x1, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')));
    }
  }

  close(code = 1000) {
    if (!this.sentClose && !this.socket.destroyed) {
      this.sentClose = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.socket.write(encodeClientFrame(0x8, payload));
    }
    this.socket.end();
  }

  destroy() {
    this.socket.destroy();
    this.end(1006);
  }
}

/**
 * Open one WebSocket to `url` with `headers` on the upgrade, no subprotocol
 * and no extension. A refused upgrade (any HTTP answer) is a canary failure.
 */
export function openSignedWebSocket(url, headers, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      reject(new KaanaCanaryError('realtime_url_invalid'));
      return;
    }
    const secure = target.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    const request = (secure ? https : http).request({
      hostname: target.hostname,
      port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
      timeout: timeoutMs,
    });
    request.on('response', (response) => {
      response.resume();
      reject(new KaanaCanaryError('realtime_upgrade_refused'));
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new KaanaCanaryError('realtime_upgrade_timeout'));
    });
    request.on('error', () => reject(new KaanaCanaryError('realtime_upgrade_failed')));
    request.on('upgrade', (response, socket, head) => {
      const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
      if (
        response.statusCode !== 101 ||
        response.headers['sec-websocket-accept'] !== accept ||
        response.headers['sec-websocket-extensions'] !== undefined ||
        response.headers['sec-websocket-protocol'] !== undefined
      ) {
        socket.destroy();
        reject(new KaanaCanaryError('realtime_upgrade_invalid'));
        return;
      }
      socket.setTimeout(0);
      resolve(new RealtimeWire(socket, head));
    });
    request.end();
  });
}

/* -------------------------------------------------------------------------- */
/*  Realtime: the probe                                                       */
/* -------------------------------------------------------------------------- */

function realtimeSessionRequest(config, route, id) {
  return {
    schemaVersion: 1,
    attribution: {
      principal: {
        billing: { accountId: config.accountId },
        applicationId: config.applicationId,
        credentialId: config.credentialId,
        environment: 'production',
        inferenceScopes: ['inference:invoke'],
      },
      requestId: id,
    },
    modelReference: route.modelReference,
    kind: 'conversation',
    transport: 'websocket',
    // Push-to-talk and text-only: the cheapest session a provider can serve.
    // No voice, no output audio format, no tools, no token or sampling field
    // a provider might refuse.
    config: {
      instructions: 'Reply with OK.',
      outputModalities: ['text'],
      inputAudioFormat: 'pcm16_24khz',
      turnDetection: { type: 'none' },
    },
    limits: REALTIME_CANARY_LIMITS,
    client: {
      endpoint: '/v1/realtime',
      receivedAt: new Date().toISOString(),
      labels: { purpose: 'production-signed-canary' },
    },
    routingPolicy: {
      routingPolicyId: config.routingPolicyId,
      policyVersion: config.routingPolicyVersion,
    },
    authorizedRoutes: [route],
  };
}

function realtimeCommand(id, commandId, payload) {
  return JSON.stringify({ schemaVersion: 1, requestId: id, commandId, ...payload });
}

/**
 * Open one signed session and return a reader over its frames in protocol
 * order: events (framing-checked against this request and a strictly rising
 * sequence), then the one usage report, then the close.
 */
async function openRealtimeProbe(config, dial, route, label, deadline) {
  const id = requestId(label);
  const firstFrame = Buffer.from(JSON.stringify(realtimeSessionRequest(config, route, id)), 'utf8');
  const wire = await dial(kaanaRealtimeUrl(config.baseUrl), realtimeSignatureHeaders(config, firstFrame));
  // The SAME bytes that were signed, as the first text frame.
  wire.sendText(firstFrame);
  let sequence = -1;
  const frame = async () => {
    const item = await wire.next(deadline - Date.now());
    if (item.type === 'timeout') fail(`${label}_timeout`);
    if (item.type === 'close') fail(`${label}_closed_early`);
    return parseJSON(Buffer.from(item.data, 'utf8'), `${label}_invalid_json`);
  };
  const event = async () => {
    const payload = await frame();
    if (
      payload?.schemaVersion !== 1 ||
      payload.requestId !== id ||
      !Number.isSafeInteger(payload.sequence) ||
      payload.sequence <= sequence ||
      typeof payload.type !== 'string'
    ) {
      fail(`${label}_event_framing_mismatch`);
    }
    sequence = payload.sequence;
    return payload;
  };
  const closed = async () => {
    const item = await wire.next(deadline - Date.now());
    if (item.type === 'timeout') fail(`${label}_close_timeout`);
    if (item.type !== 'close') fail(`${label}_frame_after_usage_report`);
    return item.code;
  };
  return { id, wire, frame, event, closed };
}

/** A session authorized only for an unknown deployment must end without ever opening. */
async function expectRealtimeRouteRefusal(config, dial, route, deadline) {
  const label = 'realtime-unknown-deployment';
  const probe = await openRealtimeProbe(
    config,
    dial,
    { ...route, deploymentId: `dep_canary_unknown_${randomUUID().replaceAll('-', '')}` },
    label,
    deadline,
  );
  try {
    for (;;) {
      const event = await probe.event();
      if (event.type === 'session.created') fail(`${label}_reached_execution`);
      if (event.type === 'error') continue;
      if (event.type !== 'session.closed') fail(`${label}_unexpected_event`);
      if (event.reason !== 'no_route_available' || event.deploymentId !== undefined) {
        fail(`${label}_wrong_close`);
      }
      break;
    }
    // Kaana settles even a session that never opened: at most one report
    // frame follows, and it must carry no units.
    const next = await probe.wire.next(deadline - Date.now());
    if (next.type === 'text') {
      const report = parseJSON(Buffer.from(next.data, 'utf8'), `${label}_invalid_json`);
      if (report?.requestId !== probe.id || (Array.isArray(report.units) && report.units.length > 0)) {
        fail(`${label}_usage_report_mismatch`);
      }
    } else if (next.type === 'timeout') {
      fail(`${label}_close_timeout`);
    }
    return { name: `${label}_rejected`, requestId: probe.id, status: 'passed', code: 'no_route_available' };
  } finally {
    probe.wire.destroy();
  }
}

/** ONE push-to-talk session: one text item, one response, then close and settle. */
async function expectRealtimeSession(config, dial, route, deadline) {
  const label = 'realtime-push-to-talk-text';
  const probe = await openRealtimeProbe(config, dial, route, label, deadline);
  try {
    const created = await probe.event();
    if (created.type === 'error') {
      fail(`${label}_execution_error_event_present`, safeInferenceErrorCode(created));
    }
    if (created.type !== 'session.created' || created.sequence !== 0) {
      fail(`${label}_session_not_created`);
    }
    if (created.deploymentId !== route.deploymentId) fail(`${label}_session_deployment_mismatch`);
    if (created.resolvedModelReference !== route.modelReference) fail(`${label}_session_model_mismatch`);
    if (created.servingProvider !== route.provider) fail(`${label}_session_provider_mismatch`);
    if (created.kind !== 'conversation') fail(`${label}_session_kind_mismatch`);

    probe.wire.sendText(realtimeCommand(probe.id, 'canary-item', {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] },
    }));
    probe.wire.sendText(realtimeCommand(probe.id, 'canary-response', { type: 'response.create' }));

    const accepted = new Set();
    let done;
    while (done === undefined) {
      const event = await probe.event();
      if (event.type === 'error') {
        fail(`${label}_execution_error_event_present`, safeInferenceErrorCode(event));
      }
      if (event.type === 'session.closed') fail(`${label}_closed_before_response`);
      if (event.type === 'command.accepted') accepted.add(event.commandId);
      if (event.type === 'response.done') done = event;
    }
    if (!accepted.has('canary-item') || !accepted.has('canary-response')) {
      fail(`${label}_command_not_accepted`);
    }
    if (done.status !== 'completed') fail(`${label}_response_not_completed`);
    if (done.deploymentId !== route.deploymentId) fail(`${label}_response_deployment_mismatch`);

    probe.wire.sendText(realtimeCommand(probe.id, 'canary-close', { type: 'session.close' }));
    let closedEvent;
    while (closedEvent === undefined) {
      const event = await probe.event();
      if (event.type === 'error') {
        fail(`${label}_execution_error_event_present`, safeInferenceErrorCode(event));
      }
      if (event.type === 'session.closed') closedEvent = event;
    }
    if (closedEvent.reason !== 'client_closed') fail(`${label}_session_close_reason_mismatch`);
    if (closedEvent.deploymentId !== route.deploymentId) fail(`${label}_session_close_deployment_mismatch`);

    const report = await probe.frame();
    if (report?.schemaVersion !== 2) fail(`${label}_usage_schema_mismatch`);
    if (report.requestId !== probe.id) fail(`${label}_usage_request_mismatch`);
    if (report.outcome !== 'completed') fail(`${label}_usage_outcome_mismatch`);
    if (report.deploymentId !== route.deploymentId) fail(`${label}_usage_deployment_mismatch`);
    if (report.resolvedModelReference !== route.modelReference) fail(`${label}_usage_model_mismatch`);
    if (report.servingProvider !== route.provider) fail(`${label}_usage_provider_mismatch`);
    if (
      !Array.isArray(report.units) ||
      report.units.length === 0 ||
      !report.units.every((quantity) =>
        typeof quantity?.unit === 'string' &&
        /^[a-z_]{1,64}$/.test(quantity.unit) &&
        Number.isSafeInteger(quantity.quantity) &&
        quantity.quantity >= 0)
    ) {
      fail(`${label}_usage_units_missing`);
    }
    if ((await probe.closed()) !== 1000) fail(`${label}_close_code_mismatch`);
    return {
      name: label,
      requestId: probe.id,
      status: 'passed',
      outcome: report.outcome,
      usageSource: report.usageSource,
      deploymentId: route.deploymentId,
      modelReference: route.modelReference,
      // Unit names and counts only: no content crosses this projection.
      units: report.units.map((quantity) => ({ unit: quantity.unit, quantity: quantity.quantity })),
    };
  } finally {
    probe.wire.destroy();
  }
}

/**
 * The realtime probe: the exact live descriptor, one fail-closed session that
 * must never open, then exactly one bounded provider session.
 */
export async function runKaanaRealtimeCanary(
  config,
  fetchImpl = globalThis.fetch,
  dial = openSignedWebSocket,
) {
  const { snapshotId, route } = await readLiveDescriptor(config, fetchImpl);
  const deadline = Date.now() + REALTIME_SESSION_TIMEOUT_MS;
  const cases = [];
  cases.push(await expectRealtimeRouteRefusal(config, dial, route, deadline));
  cases.push(await expectRealtimeSession(config, dial, route, deadline));
  return {
    schemaVersion: 1,
    status: 'passed',
    mode: 'realtime',
    contractVersion: config.expectedContractVersion,
    snapshotId,
    deploymentId: config.deploymentId,
    modelReference: route.modelReference,
    providerSessions: 1,
    oxyLedgerWrites: 0,
    cases,
  };
}

/** Realtime failures report the one session they may have opened. */
export function realtimeCanaryFailureResult(error) {
  return { ...canaryFailureResult(error), providerRequests: 'at_most_1_session' };
}

export async function realtimeMain(env = process.env, fetchImpl = globalThis.fetch, dial = openSignedWebSocket) {
  try {
    const result = await runKaanaRealtimeCanary(readKaanaRealtimeCanaryConfig(env), fetchImpl, dial);
    process.stdout.write(`KAANA_SIGNED_CANARY_RESULT=${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`KAANA_SIGNED_CANARY_RESULT=${JSON.stringify(realtimeCanaryFailureResult(error))}\n`);
    process.exitCode = 1;
  }
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  try {
    const result = await runKaanaSignedCanary(readKaanaCanaryConfig(env), fetchImpl);
    process.stdout.write(`KAANA_SIGNED_CANARY_RESULT=${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`KAANA_SIGNED_CANARY_RESULT=${JSON.stringify(canaryFailureResult(error))}\n`);
    process.exitCode = 1;
  }
}

/** Build the only operator-visible failure projection; no provider detail crosses it. */
export function canaryFailureResult(error) {
  const code = error instanceof KaanaCanaryError ? error.code : 'unexpected_canary_failure';
  const result = {
    schemaVersion: 1,
    status: 'failed',
    code,
    providerRequests: 'at_most_2',
    oxyLedgerWrites: 0,
  };
  if (
    error instanceof KaanaCanaryError &&
    code.endsWith('_execution_error_event_present') &&
    error.inferenceErrorCode !== undefined
  ) {
    result.inferenceErrorCode = error.inferenceErrorCode;
  }
  return result;
}

/** Emit only the signed operator-safe descriptor projection, never content. */
export async function readbackMain(env = process.env, fetchImpl = globalThis.fetch) {
  try {
    const config = readKaanaSigningConfig(env);
    const result = await readKaanaLiveDeployments(config, fetchImpl);
    process.stdout.write(`KAANA_SIGNED_DEPLOYMENT_READBACK_RESULT=${JSON.stringify({
      schemaVersion: 1,
      status: 'passed',
      contractVersion: config.expectedContractVersion,
      snapshotId: result.snapshotId,
      deploymentCount: result.deployments.length,
      deployments: result.deployments,
      providerRequests: 0,
      oxyLedgerWrites: 0,
    })}\n`);
  } catch (error) {
    const code = error instanceof KaanaCanaryError ? error.code : 'unexpected_readback_failure';
    process.stdout.write(`KAANA_SIGNED_DEPLOYMENT_READBACK_RESULT=${JSON.stringify({
      schemaVersion: 1,
      status: 'failed',
      code,
      providerRequests: 0,
      oxyLedgerWrites: 0,
    })}\n`);
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  if (process.argv.length === 2) await main();
  else if (process.argv.length === 3 && process.argv[2] === 'readback') await readbackMain();
  else if (process.argv.length === 3 && process.argv[2] === 'realtime') await realtimeMain();
  else {
    process.stdout.write('KAANA_SIGNED_CANARY_RESULT={"schemaVersion":1,"status":"failed","code":"invalid_operation","providerRequests":0,"oxyLedgerWrites":0}\n');
    process.exitCode = 1;
  }
}
