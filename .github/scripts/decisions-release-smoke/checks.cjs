'use strict';
// Shared by the ESM and CJS entry points: the same assertions against whichever
// module format the runtime resolved. Synthetic fixtures only; fetch is stubbed.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf8'));

async function check(contracts, inference, label) {
  const { request, answers, usage } = fixtures;
  assert.equal(contracts.INFERENCE_CONTRACT_VERSION, '3.5.0', `${label}: contract set`);
  assert.deepEqual(contracts.decisionRequestSchema.parse(request), request);
  assert.equal(contracts.decisionRequestSchema.safeParse({ ...request, stream: true }).success, false);
  const result = { schemaVersion: 1, requestId: 'req_smoke', model: request.model, data: answers, usage };
  assert.equal(contracts.decisionResultSchema.safeParse(result).success, true, `${label}: result with output_tokens`);
  assert.equal(contracts.decisionAnswersMatch(request, answers), true);
  const error = { schemaVersion: 1, code: 'provider_credential_invalid', message: 'Synthetic.', retryable: false, requestId: 'req_smoke' };
  assert.equal(contracts.decisionFailureSchema.safeParse({ schemaVersion: 1, requestId: 'req_smoke', error }).success, true);
  assert.equal(contracts.decisionFailureSchema.safeParse({ schemaVersion: 1, requestId: 'req_smoke', error, usage }).success, false,
    `${label}: failure usage cannot claim completion`);
  assert.equal(contracts.decisionFailureSchema.safeParse({ schemaVersion: 1, requestId: 'req_smoke', error,
    usage: { ...usage, outcome: 'failed' } }).success, true);

  const success = { schemaVersion: 1, requestId: 'req_smoke', model: request.model, data: answers,
    usage: [{ unit: 'requests', quantity: 1 }], routingPolicy: { routingPolicyId: 'rp_smoke', policyVersion: 1 } };
  const calls = [];
  const respond = (headerId) => async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(success), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Oxy-Request-Id': headerId } });
  };
  const client = new inference.OxyInferenceClient({ credential: 'synthetic-smoke', fetch: respond('req_smoke') });
  assert.equal(typeof client.decide, 'function', `${label}: SDK decide`);
  assert.deepEqual(await client.decide(request, { idempotencyKey: 'smoke-once' }), success);
  assert.match(calls[0].url, /\/v1\/decisions$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  const mismatched = new inference.OxyInferenceClient({ credential: 'synthetic-smoke', fetch: respond('req_other') });
  await assert.rejects(mismatched.decide(request), inference.OxyInferenceProtocolError, `${label}: header binding`);
}

module.exports = { check };
