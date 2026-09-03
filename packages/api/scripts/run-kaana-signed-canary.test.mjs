import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';

import {
  KaanaCanaryError,
  canaryFailureResult,
  readKaanaCanaryConfig,
  readKaanaLiveDeployments,
  readKaanaSigningConfig,
  runKaanaSignedCanary,
} from './run-kaana-signed-canary.mjs';

const DEPLOYMENT_ID = 'dep_cerebras_openai_gpt_oss_120b_observed_2026_08_05';
const ROUTING_PROFILE_ID = '68b7c4e19f2a6d0e3c8b5175';
const ROUTING_POLICY_ID = '68b7c4e19f2a6d0e3c8b5174';
const MODEL_REFERENCE = 'openai/gpt-oss-120b@2026-08-05';

function runtime() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const env = {
    INFERENCE_KAANA_EXECUTION: 'disabled',
    KAANA_BASE_URL: 'https://kaana.ai',
    KAANA_EDGE_SIGNING_KEY_ID: 'oxy-edge-test',
    KAANA_EDGE_SIGNING_PRIVATE_KEY: pem,
    CANARY_CONTRACT_VERSION: '2.0.0',
    CANARY_EXPECTED_SNAPSHOT_ID: 'snap-live-exact',
    CANARY_DEPLOYMENT_ID: DEPLOYMENT_ID,
    CANARY_ROUTING_PROFILE_ID: ROUTING_PROFILE_ID,
    CANARY_ROUTING_POLICY_ID: ROUTING_POLICY_ID,
    CANARY_ROUTING_POLICY_VERSION: '7',
    CANARY_ACCOUNT_ID: 'acc_exact',
    CANARY_APPLICATION_ID: 'app_exact',
    CANARY_CREDENTIAL_ID: 'cred_exact',
  };
  return {
    config: readKaanaCanaryConfig(env),
    signingConfig: readKaanaSigningConfig(env),
    publicKey,
  };
}

function signingInput(keyId, timestamp, body) {
  const digest = createHash('sha256').update(body).digest('hex');
  return Buffer.from(
    ['oxy-kaana-envelope:v1', keyId, timestamp, digest].join('\n'),
    'utf8',
  );
}

function readAndVerifyRequest(publicKey, url, init) {
  assert.ok(url.startsWith('https://kaana.ai/'));
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  const headers = new Headers(init.headers);
  const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(init.body);
  const keyId = headers.get('X-Oxy-Kaana-Key-Id');
  const timestamp = headers.get('X-Oxy-Kaana-Timestamp');
  const rawSignature = headers.get('X-Oxy-Kaana-Signature');
  assert.ok(keyId);
  assert.match(timestamp, /^[0-9]+$/);
  assert.match(rawSignature, /^v1=/);
  assert.equal(
    verify(
      null,
      signingInput(keyId, timestamp, body),
      publicKey,
      Buffer.from(rawSignature.slice(3), 'base64'),
    ),
    true,
  );
  return body.length === 0 ? undefined : JSON.parse(body.toString('utf8'));
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function sse(frames) {
  const body = frames.map(({ event, payload }) =>
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
  });
}

function errorEvent(requestId, code = 'invalid_request', param = 'authorizedRoutes[0]') {
  return {
    event: 'stream_event',
    payload: {
      schemaVersion: 1,
      type: 'error',
      requestId,
      sequence: 0,
      error: {
        schemaVersion: 1,
        code,
        message: 'safe fixture',
        retryable: false,
        requestId,
        param,
      },
    },
  };
}

function successfulFrames(request) {
  const requestId = request.attribution.requestId;
  const generationId = `gen-${requestId}`;
  const now = new Date().toISOString();
  return [
    {
      event: 'stream_event',
      payload: {
        schemaVersion: 1,
        type: 'start',
        requestId,
        sequence: 0,
        generationId,
        startedAt: now,
        resolvedModelReference: MODEL_REFERENCE,
        servingProvider: 'cerebras',
      },
    },
    {
      event: 'stream_event',
      payload: {
        schemaVersion: 1,
        type: 'done',
        requestId,
        sequence: 1,
        generationId,
        finishReason: 'length',
        completedAt: now,
      },
    },
    {
      event: 'usage_report',
      payload: {
        schemaVersion: 2,
        requestId,
        generationId,
        attribution: request.attribution,
        outcome: 'completed',
        units: [{ unit: 'input_tokens', quantity: 3 }],
        usageSource: 'provider',
        resolvedModelReference: MODEL_REFERENCE,
        servingProvider: 'cerebras',
        deploymentId: DEPLOYMENT_ID,
        routeSwitches: 0,
        startedAt: now,
        completedAt: now,
      },
    },
  ];
}

async function assertFirstPositiveFailure(expectedCode, mutateResponse) {
  const { config, publicKey } = runtime();
  let inferenceCalls = 0;
  const fetchImpl = async (url, init) => {
    const body = readAndVerifyRequest(publicKey, url, init);
    const path = new URL(url).pathname;
    if (path === '/internal/v1/health') return json({ contractVersion: '2.0.0' });
    if (path === '/internal/v1/deployments/query') {
      return json({
        snapshotId: 'snap-live-exact',
        deployments: [{
          deploymentId: DEPLOYMENT_ID,
          modelReference: MODEL_REFERENCE,
          provider: 'cerebras',
          regions: [],
        }],
      }, 200, { 'Cache-Control': 'no-store' });
    }
    inferenceCalls += 1;
    if (inferenceCalls <= 2) return json({ code: 'invalid_request' }, 400);
    if (inferenceCalls <= 4) return sse([errorEvent(body.attribution.requestId)]);
    return mutateResponse(successfulFrames(body), body);
  };

  let capturedError;
  await assert.rejects(
    () => runKaanaSignedCanary(config, fetchImpl),
    (error) => {
      capturedError = error;
      return error instanceof KaanaCanaryError && error.code === expectedCode;
    },
  );
  assert.equal(inferenceCalls, 5);
  return capturedError;
}

test('runs every closed negative before exactly two one-token positive probes', async () => {
  const { config, publicKey } = runtime();
  const inferenceBodies = [];
  const fetchImpl = async (url, init) => {
    const body = readAndVerifyRequest(publicKey, url, init);
    const path = new URL(url).pathname;
    if (path === '/internal/v1/health') {
      assert.equal(init.method, 'GET');
      assert.equal(body, undefined);
      return json({ contractVersion: '2.0.0' });
    }
    if (path === '/internal/v1/deployments/query') {
      assert.deepEqual(body, { deploymentIds: [DEPLOYMENT_ID] });
      return json({
        snapshotId: 'snap-live-exact',
        deployments: [{
          deploymentId: DEPLOYMENT_ID,
          modelReference: MODEL_REFERENCE,
          provider: 'cerebras',
          regions: ['us-west-2'],
        }],
      }, 200, { 'Cache-Control': 'no-store' });
    }

    assert.equal(path, '/internal/v1/inference');
    inferenceBodies.push(body);
    const index = inferenceBodies.length - 1;
    if (index < 2) {
      assert.equal(body.target.kind, 'routing_profile');
      assert.equal(body.target.routingProfile, 'canary');
      assert.match(body.authorizedRoutes[0].deploymentId, /^dep_canary_slug_guard_[0-9a-f]{32}$/);
      assert.notEqual(body.authorizedRoutes[0].deploymentId, DEPLOYMENT_ID);
      return json({ code: 'invalid_request' }, 400);
    }
    if (index < 4) {
      assert.equal(body.schemaVersion, 2);
      return sse([errorEvent(body.attribution.requestId)]);
    }
    return sse(successfulFrames(body));
  };

  const result = await runKaanaSignedCanary(config, fetchImpl);

  assert.equal(result.status, 'passed');
  assert.equal(result.providerRequests, 2);
  assert.equal(result.oxyLedgerWrites, 0);
  assert.equal(result.snapshotId, 'snap-live-exact');
  assert.equal(result.modelReference, MODEL_REFERENCE);
  assert.equal(result.cases.length, 6);

  assert.equal(inferenceBodies[0].schemaVersion, 1);
  assert.equal(inferenceBodies[1].schemaVersion, 2);
  assert.notEqual(inferenceBodies[2].authorizedRoutes[0].deploymentId, DEPLOYMENT_ID);
  assert.match(inferenceBodies[2].authorizedRoutes[0].deploymentId, /^dep_canary_unknown_[0-9a-f]{32}$/);
  assert.equal(inferenceBodies[3].authorizedRoutes[0].deploymentId, ` ${DEPLOYMENT_ID}`);

  const v1 = inferenceBodies[4];
  assert.equal(v1.schemaVersion, 1);
  assert.deepEqual(v1.target, { kind: 'model', modelReference: MODEL_REFERENCE });
  assert.equal(v1.maxOutputTokens, 1);
  assert.deepEqual(v1.sampling, {});
  assert.equal(v1.idempotencyKey, undefined);

  const v2 = inferenceBodies[5];
  assert.equal(v2.schemaVersion, 2);
  assert.deepEqual(v2.target, {
    kind: 'routing_profile_id',
    routingProfileId: ROUTING_PROFILE_ID,
  });
  assert.equal(v2.authorizedRoutes[0].deploymentId, DEPLOYMENT_ID);
  assert.equal(v2.maxOutputTokens, 1);
  assert.equal(v2.attribution.principal.billing.accountId, 'acc_exact');
  assert.equal(v2.routingPolicy.routingPolicyId, ROUTING_POLICY_ID);
  assert.equal(v2.routingPolicy.policyVersion, 7);
});

test('stops before either provider probe if a slug arm is unexpectedly accepted', async () => {
  const { config, publicKey } = runtime();
  let calls = 0;
  const fetchImpl = async (url, init) => {
    const body = readAndVerifyRequest(publicKey, url, init);
    calls += 1;
    const path = new URL(url).pathname;
    if (path === '/internal/v1/health') return json({ contractVersion: '2.0.0' });
    if (path === '/internal/v1/deployments/query') {
      return json({
        snapshotId: 'snap-live-exact',
        deployments: [{
          deploymentId: DEPLOYMENT_ID,
          modelReference: MODEL_REFERENCE,
          provider: 'cerebras',
          regions: [],
        }],
      }, 200, { 'Cache-Control': 'no-store' });
    }
    assert.equal(body.target.kind, 'routing_profile');
    return sse([errorEvent(body.attribution.requestId)]);
  };

  await assert.rejects(
    () => runKaanaSignedCanary(config, fetchImpl),
    (error) => error instanceof KaanaCanaryError && error.code === 'v1_slug_not_refused',
  );
  assert.equal(calls, 3);
});

test('refuses noncanonical origins, enabled ambient execution and fuzzy exact IDs before fetch', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const base = {
    INFERENCE_KAANA_EXECUTION: 'disabled',
    KAANA_BASE_URL: 'https://kaana.ai',
    KAANA_EDGE_SIGNING_KEY_ID: 'oxy-edge-test',
    KAANA_EDGE_SIGNING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    CANARY_CONTRACT_VERSION: '2.0.0',
    CANARY_EXPECTED_SNAPSHOT_ID: 'snap-live-exact',
    CANARY_DEPLOYMENT_ID: DEPLOYMENT_ID,
    CANARY_ROUTING_PROFILE_ID: ROUTING_PROFILE_ID,
    CANARY_ROUTING_POLICY_ID: ROUTING_POLICY_ID,
    CANARY_ROUTING_POLICY_VERSION: '1',
    CANARY_ACCOUNT_ID: 'acc',
    CANARY_APPLICATION_ID: 'app',
    CANARY_CREDENTIAL_ID: 'cred',
  };

  for (const changed of [
    { KAANA_BASE_URL: 'https://kaana.oxy.so' },
    { INFERENCE_KAANA_EXECUTION: 'enabled' },
    { CANARY_EXPECTED_SNAPSHOT_ID: ' snap-live-exact' },
    { CANARY_DEPLOYMENT_ID: ` ${DEPLOYMENT_ID}` },
    { CANARY_ROUTING_PROFILE_ID: `${ROUTING_PROFILE_ID} ` },
    { CANARY_ROUTING_POLICY_ID: `${ROUTING_POLICY_ID}\tcopy` },
  ]) {
    assert.throws(() => readKaanaCanaryConfig({ ...base, ...changed }), KaanaCanaryError);
  }
});

test('does not reinterpret a provider-credential UUID as a deployment identity', async () => {
  const { config, publicKey } = runtime();
  config.deploymentId = '43405cea-a7d1-49c2-ba73-5a84536d3abf';
  let calls = 0;
  const fetchImpl = async (url, init) => {
    readAndVerifyRequest(publicKey, url, init);
    calls += 1;
    const path = new URL(url).pathname;
    if (path === '/internal/v1/health') return json({ contractVersion: '2.0.0' });
    assert.equal(path, '/internal/v1/deployments/query');
    // The signed snapshot is the only authority and returns its actual opaque
    // deployment id, never the credential-shaped selector the operator passed.
    return json({
      snapshotId: 'snap-live-exact',
      deployments: [{
        deploymentId: DEPLOYMENT_ID,
        modelReference: MODEL_REFERENCE,
        provider: 'cerebras',
        regions: [],
      }],
    }, 200, { 'Cache-Control': 'no-store' });
  };

  await assert.rejects(
    () => runKaanaSignedCanary(config, fetchImpl),
    (error) => error instanceof KaanaCanaryError && error.code === 'deployment_identity_mismatch',
  );
  assert.equal(calls, 2);
});

test('refuses every start event field outside the exact contract shape', async (t) => {
  for (const field of ['deploymentId', 'routeId', 'providerDetail']) {
    await t.test(field, async () => {
      await assertFirstPositiveFailure(
        'v1-direct-model_start_route_identity_present',
        (frames) => {
          frames[0].payload[field] = 'must-not-cross-start-event';
          return sse(frames);
        },
      );
    });
  }
});

test('accepts the exact start shape when optional generationId is absent', async () => {
  const { config, publicKey } = runtime();
  let inferenceCalls = 0;
  const fetchImpl = async (url, init) => {
    const body = readAndVerifyRequest(publicKey, url, init);
    const path = new URL(url).pathname;
    if (path === '/internal/v1/health') return json({ contractVersion: '2.0.0' });
    if (path === '/internal/v1/deployments/query') {
      return json({
        snapshotId: 'snap-live-exact',
        deployments: [{
          deploymentId: DEPLOYMENT_ID,
          modelReference: MODEL_REFERENCE,
          provider: 'cerebras',
          regions: [],
        }],
      }, 200, { 'Cache-Control': 'no-store' });
    }
    inferenceCalls += 1;
    if (inferenceCalls <= 2) return json({ code: 'invalid_request' }, 400);
    if (inferenceCalls <= 4) return sse([errorEvent(body.attribution.requestId)]);
    const frames = successfulFrames(body);
    delete frames[0].payload.generationId;
    frames[0].payload.startedAt = '2026-09-03T10:34Z';
    return sse(frames);
  };

  const result = await runKaanaSignedCanary(config, fetchImpl);
  assert.equal(result.status, 'passed');
  assert.equal(inferenceCalls, 6);
});

test('refuses every invalid contractual start-event value', async (t) => {
  const cases = [
    {
      name: 'schema version',
      code: 'v1-direct-model_start_schema_mismatch',
      mutate: (start) => { start.schemaVersion = 2; },
    },
    {
      name: 'request identity',
      code: 'v1-direct-model_start_request_mismatch',
      mutate: (start) => { start.requestId = 'wrong-request'; },
    },
    ...[-1, 0.5, 1, Number.MAX_SAFE_INTEGER + 1].map((sequence) => ({
      name: `sequence ${sequence}`,
      code: 'v1-direct-model_start_sequence_mismatch',
      mutate: (start) => { start.sequence = sequence; },
    })),
    ...[
      { name: 'empty generation id', value: '' },
      { name: 'oversized generation id', value: 'g'.repeat(129) },
      { name: 'non-string generation id', value: 7 },
      { name: 'null generation id', value: null },
    ].map(({ name, value }) => ({
      name,
      code: 'v1-direct-model_start_generation_mismatch',
      mutate: (start) => { start.generationId = value; },
    })),
    ...[
      { name: 'offset timestamp', value: '2026-09-03T10:34:00+00:00' },
      { name: 'impossible calendar date', value: '2026-02-30T10:34:00Z' },
      { name: 'lowercase UTC marker', value: '2026-09-03T10:34:00z' },
    ].map(({ name, value }) => ({
      name,
      code: 'v1-direct-model_start_timestamp_mismatch',
      mutate: (start) => { start.startedAt = value; },
    })),
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assertFirstPositiveFailure(fixture.code, (frames) => {
        fixture.mutate(frames[0].payload);
        return sse(frames);
      });
    });
  }
});

test('projects only a closed inference error code from execution error events', async () => {
  const validError = await assertFirstPositiveFailure(
    'v1-direct-model_execution_error_event_present',
    (_frames, request) => {
      const event = errorEvent(request.attribution.requestId, 'provider_billing_refused');
      event.payload.error.message = 'secret provider response must never be projected';
      event.payload.error.providerDetail = { requestId: 'upstream-secret' };
      return sse([event]);
    },
  );
  assert.deepEqual(canaryFailureResult(validError), {
    schemaVersion: 1,
    status: 'failed',
    code: 'v1-direct-model_execution_error_event_present',
    providerRequests: 'at_most_2',
    oxyLedgerWrites: 0,
    inferenceErrorCode: 'provider_billing_refused',
  });

  const unknownError = await assertFirstPositiveFailure(
    'v1-direct-model_execution_error_event_present',
    (_frames, request) => sse([
      errorEvent(request.attribution.requestId, 'cerebras_uncontracted_detail'),
    ]),
  );
  assert.deepEqual(canaryFailureResult(unknownError), {
    schemaVersion: 1,
    status: 'failed',
    code: 'v1-direct-model_execution_error_event_present',
    providerRequests: 'at_most_2',
    oxyLedgerWrites: 0,
  });
});

test('reports the exact safe stage for every positive response-contract failure', async (t) => {
  const cases = [
    {
      name: 'HTTP status',
      code: 'v1-direct-model_wrong_http_status',
      mutate: () => json({ code: 'safe_fixture' }, 503),
    },
    {
      name: 'provider execution error event',
      code: 'v1-direct-model_execution_error_event_present',
      mutate: (_frames, request) => sse([errorEvent(request.attribution.requestId, 'provider_error')]),
    },
    {
      name: 'start event count',
      code: 'v1-direct-model_start_event_count_mismatch',
      mutate: (frames) => sse(frames.slice(1)),
    },
    {
      name: 'start event position',
      code: 'v1-direct-model_start_event_not_first',
      mutate: (frames) => sse([frames[1], frames[0], frames[2]]),
    },
    {
      name: 'start model identity',
      code: 'v1-direct-model_start_model_mismatch',
      mutate: (frames) => {
        frames[0].payload.resolvedModelReference = 'openai/gpt-oss-120b@wrong';
        return sse(frames);
      },
    },
    {
      name: 'start provider identity',
      code: 'v1-direct-model_start_provider_mismatch',
      mutate: (frames) => {
        frames[0].payload.servingProvider = 'wrong';
        return sse(frames);
      },
    },
    {
      name: 'done event count',
      code: 'v1-direct-model_done_event_count_mismatch',
      mutate: (frames) => sse([frames[0], frames[2]]),
    },
    {
      name: 'done event position',
      code: 'v1-direct-model_done_event_not_terminal',
      mutate: (frames, request) => sse([
        ...frames,
        {
          event: 'stream_event',
          payload: {
            schemaVersion: 1,
            type: 'output_text_delta',
            requestId: request.attribution.requestId,
            sequence: 2,
            delta: '',
          },
        },
      ]),
    },
    {
      name: 'receipt ownership',
      code: 'v1-direct-model_terminal_receipt_present',
      mutate: (frames) => {
        frames[1].payload.receiptId = 'must-belong-to-oxy';
        return sse(frames);
      },
    },
    {
      name: 'usage report count',
      code: 'v1-direct-model_usage_report_count_mismatch',
      mutate: (frames) => sse(frames.slice(0, 2)),
    },
    {
      name: 'usage schema',
      code: 'v1-direct-model_usage_schema_mismatch',
      mutate: (frames) => {
        frames[2].payload.schemaVersion = 1;
        return sse(frames);
      },
    },
    {
      name: 'usage request identity',
      code: 'v1-direct-model_usage_request_mismatch',
      mutate: (frames) => {
        frames[2].payload.requestId = 'wrong-request';
        return sse(frames);
      },
    },
    {
      name: 'usage outcome',
      code: 'v1-direct-model_usage_outcome_mismatch',
      mutate: (frames) => {
        frames[2].payload.outcome = 'failed';
        return sse(frames);
      },
    },
    {
      name: 'usage deployment identity',
      code: 'v1-direct-model_usage_deployment_mismatch',
      mutate: (frames) => {
        frames[2].payload.deploymentId = 'dep_wrong_usage_identity';
        return sse(frames);
      },
    },
    {
      name: 'usage model identity',
      code: 'v1-direct-model_usage_model_mismatch',
      mutate: (frames) => {
        frames[2].payload.resolvedModelReference = 'openai/gpt-oss-120b@wrong';
        return sse(frames);
      },
    },
    {
      name: 'usage provider identity',
      code: 'v1-direct-model_usage_provider_mismatch',
      mutate: (frames) => {
        frames[2].payload.servingProvider = 'wrong';
        return sse(frames);
      },
    },
    {
      name: 'usage units',
      code: 'v1-direct-model_usage_units_missing',
      mutate: (frames) => {
        frames[2].payload.units = [];
        return sse(frames);
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => assertFirstPositiveFailure(fixture.code, fixture.mutate));
  }
});

test('lists the complete signed safe deployment projection without selecting or executing', async () => {
  const { signingConfig, publicKey } = runtime();
  const paths = [];
  const fetchImpl = async (url, init) => {
    const body = readAndVerifyRequest(publicKey, url, init);
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/internal/v1/health') {
      assert.equal(body, undefined);
      return json({ contractVersion: '2.0.0' });
    }
    assert.equal(path, '/internal/v1/deployments/query');
    assert.deepEqual(body, {});
    return json({
      snapshotId: 'snap-live-exact',
      deployments: [
        {
          deploymentId: 'dep_z_exact',
          modelReference: 'openai/gpt-oss-120b@2026-08-05',
          provider: 'cerebras',
          regions: ['us-west-2'],
        },
        {
          deploymentId: 'dep_a_exact',
          modelReference: 'meta/llama-3.3-70b@2026-08-01',
          provider: 'groq',
          regions: [],
        },
      ],
    }, 200, { 'Cache-Control': 'no-store' });
  };

  const result = await readKaanaLiveDeployments(signingConfig, fetchImpl);
  assert.equal(result.snapshotId, 'snap-live-exact');
  assert.deepEqual(result.deployments.map((deployment) => deployment.deploymentId), [
    'dep_z_exact',
    'dep_a_exact',
  ]);
  assert.deepEqual(paths, ['/internal/v1/health', '/internal/v1/deployments/query']);
});

test('refuses a readback descriptor that exposes any field outside the safe projection', async () => {
  const { signingConfig, publicKey } = runtime();
  const fetchImpl = async (url, init) => {
    readAndVerifyRequest(publicKey, url, init);
    const path = new URL(url).pathname;
    if (path === '/internal/v1/health') return json({ contractVersion: '2.0.0' });
    return json({
      snapshotId: 'snap-live-exact',
      deployments: [{
        deploymentId: DEPLOYMENT_ID,
        modelReference: MODEL_REFERENCE,
        provider: 'cerebras',
        regions: [],
        upstreamModelId: 'must-never-cross-the-operator-surface',
      }],
    }, 200, { 'Cache-Control': 'no-store' });
  };

  await assert.rejects(
    () => readKaanaLiveDeployments(signingConfig, fetchImpl),
    (error) => error instanceof KaanaCanaryError &&
      error.code === 'invalid_deployment_descriptor',
  );
});

test('refuses a changed serving snapshot before any inference probe', async () => {
  const { config, publicKey } = runtime();
  let calls = 0;
  const fetchImpl = async (url, init) => {
    readAndVerifyRequest(publicKey, url, init);
    calls += 1;
    const path = new URL(url).pathname;
    if (path === '/internal/v1/health') return json({ contractVersion: '2.0.0' });
    assert.equal(path, '/internal/v1/deployments/query');
    return json({
      snapshotId: 'snap-changed-after-readback',
      deployments: [{
        deploymentId: DEPLOYMENT_ID,
        modelReference: MODEL_REFERENCE,
        provider: 'cerebras',
        regions: [],
      }],
    }, 200, { 'Cache-Control': 'no-store' });
  };

  await assert.rejects(
    () => runKaanaSignedCanary(config, fetchImpl),
    (error) => error instanceof KaanaCanaryError && error.code === 'snapshot_id_mismatch',
  );
  assert.equal(calls, 2);
});
