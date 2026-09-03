#!/usr/bin/env node

/**
 * Production Oxy -> Kaana wire canary.
 *
 * This command deliberately calls Kaana directly. It never calls an Oxy HTTP
 * endpoint, imports an Oxy database module, reserves balance, or settles a
 * receipt. The ECS workflow that owns it removes DATABASE_URL and every secret
 * except the Ed25519 edge-signing key before the task starts. The only writes
 * are Kaana's normal technical records for the two one-token positive probes.
 */

import {
  createHash,
  createPrivateKey,
  randomUUID,
  sign,
} from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CANONICAL_KAANA_ORIGIN = 'https://kaana.ai';
const SIGNATURE_DOMAIN = 'oxy-kaana-envelope:v1';
const INFERENCE_PATH = '/internal/v1/inference';
const HEALTH_PATH = '/internal/v1/health';
const DEPLOYMENTS_PATH = '/internal/v1/deployments/query';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

const MODEL_REFERENCE_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

// This script runs in the secret-minimized deploy-script job before workspace
// dependencies are installed, so it cannot import @oxyhq/contracts. The gate
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
  if (env.INFERENCE_KAANA_EXECUTION !== 'disabled') {
    fail('ambient_kaana_execution_is_not_disabled');
  }
  if (env.KAANA_BASE_URL !== CANONICAL_KAANA_ORIGIN) {
    fail('kaana_origin_is_not_canonical');
  }

  return {
    baseUrl: CANONICAL_KAANA_ORIGIN,
    keyId: exactString(env, 'KAANA_EDGE_SIGNING_KEY_ID', 128),
    privateKey: parsePrivateKey(secretString(env, 'KAANA_EDGE_SIGNING_PRIVATE_KEY', 16_384)),
    expectedContractVersion: exactString(env, 'CANARY_CONTRACT_VERSION', 32),
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

function routeFromDescriptor(descriptor) {
  if (
    !hasExactKeys(descriptor, ['deploymentId', 'modelReference', 'provider', 'regions']) ||
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
  else {
    process.stdout.write('KAANA_SIGNED_CANARY_RESULT={"schemaVersion":1,"status":"failed","code":"invalid_operation","providerRequests":0,"oxyLedgerWrites":0}\n');
    process.exitCode = 1;
  }
}
