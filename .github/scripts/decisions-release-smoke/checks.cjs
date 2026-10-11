'use strict';
// Shared by the ESM and CJS entry points: the same assertions against whichever
// module format the runtime resolved. Synthetic fixtures only; fetch is stubbed,
// nothing leaves the process.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf8'));
const CREDENTIAL = 'synthetic-smoke-credential';

function stub(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', ...next.headers },
    });
  };
  return { fetch, calls };
}
function header(init, name) {
  return new Headers(init.headers).get(name);
}

async function check(contracts, inference, label) {
  const { request, answers, usage } = fixtures;
  assert.equal(contracts.INFERENCE_CONTRACT_VERSION, '3.5.0', `${label}: contract set`);
  assert.deepEqual(contracts.decisionRequestSchema.parse(request), request);
  assert.equal(
    contracts.decisionRequestSchema.safeParse({ ...request, stream: true }).success,
    false,
  );
  const result = {
    schemaVersion: 1,
    requestId: 'req_smoke',
    model: request.model,
    data: answers,
    usage,
  };
  assert.equal(
    contracts.decisionResultSchema.safeParse(result).success,
    true,
    `${label}: result with output_tokens`,
  );
  assert.equal(contracts.decisionAnswersMatch(request, answers), true);
  const error = {
    schemaVersion: 1,
    code: 'provider_credential_invalid',
    message: 'Synthetic.',
    retryable: false,
    requestId: 'req_smoke',
  };
  assert.equal(
    contracts.decisionFailureSchema.safeParse({ schemaVersion: 1, requestId: 'req_smoke', error })
      .success,
    true,
  );
  assert.equal(
    contracts.decisionFailureSchema.safeParse({
      schemaVersion: 1,
      requestId: 'req_smoke',
      error,
      usage,
    }).success,
    false,
    `${label}: failure usage cannot claim completion`,
  );
  assert.equal(
    contracts.decisionFailureSchema.safeParse({
      schemaVersion: 1,
      requestId: 'req_smoke',
      error,
      usage: { ...usage, outcome: 'failed' },
    }).success,
    true,
  );

  const success = {
    schemaVersion: 1,
    requestId: 'req_smoke',
    model: request.model,
    data: answers,
    usage: [{ unit: 'requests', quantity: 1 }],
    routingPolicy: { routingPolicyId: 'rp_smoke', policyVersion: 1 },
  };
  const ok = (body = success, requestId = 'req_smoke') => ({
    status: 200,
    body,
    headers: { 'X-Oxy-Request-Id': requestId },
  });

  // The wire request: method, path, credential, content type, idempotency, body.
  const sent = stub([ok()]);
  const client = new inference.OxyInferenceClient({ credential: CREDENTIAL, fetch: sent.fetch });
  assert.equal(typeof client.decide, 'function', `${label}: SDK decide`);
  assert.deepEqual(await client.decide(request, { idempotencyKey: 'smoke-once' }), success);
  assert.equal(sent.calls.length, 1);
  const [{ url, init }] = sent.calls;
  assert.match(url, /\/v1\/decisions$/);
  assert.equal(init.method, 'POST');
  assert.equal(header(init, 'Authorization'), `Bearer ${CREDENTIAL}`, `${label}: bearer`);
  assert.equal(header(init, 'Content-Type'), 'application/json');
  assert.equal(header(init, 'Idempotency-Key'), 'smoke-once', `${label}: idempotency key`);
  assert.deepEqual(JSON.parse(init.body), request);

  // Typed failures surface code, retryable and requestId; never a replay.
  for (const [status, code] of [
    [409, 'idempotency_conflict'],
    [502, 'provider_credential_invalid'],
  ]) {
    const failing = stub([
      {
        status,
        body: {
          schemaVersion: 1,
          code,
          message: 'Synthetic refusal.',
          retryable: false,
          requestId: `req_${status}`,
        },
        headers: { 'X-Oxy-Request-Id': `req_${status}` },
      },
    ]);
    await assert.rejects(
      new inference.OxyInferenceClient({ credential: CREDENTIAL, fetch: failing.fetch }).decide(
        request,
        { idempotencyKey: 'smoke-once' },
      ),
      (thrown) =>
        thrown instanceof inference.OxyInferenceError &&
        thrown.code === code &&
        thrown.retryable === false &&
        thrown.requestId === `req_${status}` &&
        thrown.status === status,
      `${label}: typed ${status}`,
    );
    assert.equal(failing.calls.length, 1, `${label}: ${status} is not retried`);
  }

  // A nominal 200 that does not answer this request is refused.
  for (const [name, response] of [
    ['header binding', ok(success, 'req_other')],
    ['model', ok({ ...success, model: 'typesafe/jev@other' })],
    ['answers', ok({ ...success, data: answers.slice(1) })],
    ['answer id', ok({ ...success, data: [{ ...answers[2], id: 'YES' }, ...answers.slice(0, 2)] })],
  ]) {
    const mismatched = stub([response]);
    await assert.rejects(
      new inference.OxyInferenceClient({ credential: CREDENTIAL, fetch: mismatched.fetch }).decide(
        request,
      ),
      inference.OxyInferenceProtocolError,
      `${label}: ${name} mismatch`,
    );
  }
}

module.exports = { check };
