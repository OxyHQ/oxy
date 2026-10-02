import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_WEBHOOK_URL,
  EXPECTED_STRIPE_API_VERSION,
  OPTIONAL_EVENTS,
  REQUIRED_EVENTS,
  evaluateWebhookEndpoints,
  listWebhookEndpoints,
  main,
} from './check-stripe-webhook-events.mjs';

const ALL = [...REQUIRED_EVENTS, ...OPTIONAL_EVENTS];

function endpoint(overrides = {}) {
  return {
    id: 'we_oxy',
    url: DEFAULT_WEBHOOK_URL,
    status: 'enabled',
    livemode: true,
    api_version: EXPECTED_STRIPE_API_VERSION,
    enabled_events: ALL,
    ...overrides,
  };
}

test('every event the webhook handler dispatches is checked, and nothing else', () => {
  const source = readFileSync(new URL('../src/routes/billing.ts', import.meta.url), 'utf8');
  const dispatch = source.slice(source.indexOf('async function dispatchStripeEvent'));
  const body = dispatch.slice(0, dispatch.indexOf('\n}\n'));
  const handled = [...body.matchAll(/case '([a-z_.]+)':/g)].map((match) => match[1]).sort();
  assert.deepEqual([...ALL].sort(), handled);
});

test('every required and optional event present passes', () => {
  const result = evaluateWebhookEndpoints([endpoint()]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.endpointId, 'we_oxy');
});

test('an endpoint without invoice.paid FAILS', () => {
  const result = evaluateWebhookEndpoints([
    endpoint({ enabled_events: ALL.filter((type) => type !== 'invoice.paid') }),
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['endpoint we_oxy does not send invoice.paid']);
});

test('each required event is load-bearing on its own', () => {
  for (const missing of REQUIRED_EVENTS) {
    const result = evaluateWebhookEndpoints([
      endpoint({ enabled_events: ALL.filter((type) => type !== missing) }),
    ]);
    assert.equal(result.ok, false, `${missing} missing must fail`);
  }
});

test('a missing optional event passes with a note', () => {
  const result = evaluateWebhookEndpoints([endpoint({ enabled_events: [...REQUIRED_EVENTS] })]);
  assert.equal(result.ok, true);
  assert.equal(result.notes.length, OPTIONAL_EVENTS.length);
});

test('no endpoint for the Oxy URL FAILS', () => {
  const result = evaluateWebhookEndpoints([
    endpoint({ url: 'https://example.com/billing/webhook' }),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /no webhook endpoint points at/);
  assert.equal(evaluateWebhookEndpoints([]).ok, false);
  assert.equal(evaluateWebhookEndpoints(undefined).ok, false);
});

test('a wildcard endpoint passes', () => {
  const result = evaluateWebhookEndpoints([endpoint({ enabled_events: ['*'] })]);
  assert.equal(result.ok, true);
});

test('a disabled endpoint FAILS even with every event', () => {
  const result = evaluateWebhookEndpoints([endpoint({ status: 'disabled' })]);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /not enabled/);
});

test('two enabled endpoints for the same URL FAIL', () => {
  const result = evaluateWebhookEndpoints([endpoint(), endpoint({ id: 'we_dup' })]);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /expected exactly one/);
});

test('the URL comparison ignores case and a trailing slash, nothing else', () => {
  const upper = evaluateWebhookEndpoints([endpoint({ url: 'HTTPS://API.OXY.SO/billing/webhook/' })]);
  assert.equal(upper.ok, true);
  const other = evaluateWebhookEndpoints([
    endpoint({ url: 'https://api.oxy.so/billing/webhook-old' }),
  ]);
  assert.equal(other.ok, false);
});

function fakeFetch(pages, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    const index = seen.length - 1;
    const page = pages[index];
    if (page instanceof Error) throw page;
    if (typeof page === 'number') return { ok: false, status: page, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => page };
  };
}

test('listing follows pagination with a GET and a bearer key only', async () => {
  const seen = [];
  const fetchImpl = fakeFetch(
    [
      { data: [endpoint({ id: 'we_a', url: 'https://x' })], has_more: true },
      { data: [endpoint({ id: 'we_b' })], has_more: false },
    ],
    seen
  );
  const endpoints = await listWebhookEndpoints('rk_test', fetchImpl);
  assert.deepEqual(
    endpoints.map((e) => e.id),
    ['we_a', 'we_b']
  );
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Authorization, 'Bearer rk_test');
    assert.equal(call.init.body, undefined);
  }
  assert.match(seen[1].url, /starting_after=we_a/);
});

function capture() {
  const lines = [];
  return {
    lines,
    log: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  };
}

test('main exits 2 without a key and never calls Stripe', async () => {
  const seen = [];
  const { log } = capture();
  assert.equal(await main({}, fakeFetch([], seen), log), 2);
  assert.equal(seen.length, 0);
});

test('main exits 1 when invoice.paid is missing, 0 when ready, 2 when Stripe errors', async () => {
  const missing = capture();
  const code = await main(
    { STRIPE_SECRET_KEY: 'rk_live_secret_value' },
    fakeFetch([
      {
        data: [endpoint({ enabled_events: ALL.filter((t) => t !== 'invoice.paid') })],
        has_more: false,
      },
    ]),
    missing.log
  );
  assert.equal(code, 1);
  assert.ok(missing.lines.some((line) => line.includes('invoice.paid')));
  assert.ok(!missing.lines.some((line) => line.includes('rk_live_secret_value')), 'key never printed');

  const ready = capture();
  assert.equal(
    await main(
      { STRIPE_SECRET_KEY: 'rk_live_fixture' },
      fakeFetch([{ data: [endpoint()], has_more: false }]),
      ready.log
    ),
    0
  );

  const failing = capture();
  assert.equal(await main({ STRIPE_SECRET_KEY: 'rk_live_fixture' }, fakeFetch([401]), failing.log), 2);
});

test('OXY_STRIPE_WEBHOOK_URL selects another endpoint (e.g. staging)', async () => {
  const { log } = capture();
  const code = await main(
    { STRIPE_SECRET_KEY: 'rk_live_fixture', OXY_STRIPE_WEBHOOK_URL: 'https://staging.oxy.so/billing/webhook' },
    fakeFetch([{ data: [endpoint()], has_more: false }]),
    log
  );
  assert.equal(code, 1);
});

for (const api_version of [null, '2024-06-20']) {
  test(`unproven or incompatible version ${api_version} fails even with wildcard`, () => {
    assert.equal(evaluateWebhookEndpoints([endpoint({ api_version, enabled_events: ['*'] })]).ok, false);
  });
}
test('live and test endpoint modes cannot be substituted', () => {
  assert.equal(evaluateWebhookEndpoints([endpoint({ livemode: false })]).ok, false);
  assert.equal(evaluateWebhookEndpoints([endpoint({ livemode: false })], DEFAULT_WEBHOOK_URL, 'test').ok, true);
  assert.equal(evaluateWebhookEndpoints([endpoint({ livemode: undefined })]).ok, false);
});
test('URL paths preserve case and query strings', () => {
  assert.equal(evaluateWebhookEndpoints([endpoint({ url: 'https://api.oxy.so/Billing/webhook' })]).ok, false);
  assert.equal(evaluateWebhookEndpoints([endpoint({ url: `${DEFAULT_WEBHOOK_URL}?wrong=1` })]).ok, false);
});
test('malformed or stalled pagination fails instead of returning partial endpoints', async () => {
  for (const page of [{ data: [], has_more: true }, { has_more: false }, { data: [endpoint()] }]) {
    await assert.rejects(listWebhookEndpoints('rk_test_fixture', fakeFetch([page])));
  }
});
test('test key cannot certify default live deployment and is never logged', async () => {
  const { log, lines } = capture();
  const seen = [];
  assert.equal(await main({ STRIPE_SECRET_KEY: 'rk_test_secret' }, fakeFetch([], seen), log), 2);
  assert.equal(seen.length, 0);
  assert.ok(lines.every(line => !line.includes('rk_test_secret')));
  assert.equal(await main({ STRIPE_SECRET_KEY: 'rk_test_secret', OXY_STRIPE_MODE: 'test' }, fakeFetch([{ data: [endpoint({ livemode: false })], has_more: false }]), log), 0);
});
