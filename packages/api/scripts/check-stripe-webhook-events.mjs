#!/usr/bin/env node
/**
 * Read-only preflight: does the Stripe webhook endpoint that points at Oxy send
 * every event `POST /billing/webhook` needs? (issue #1524)
 *
 * Renewal credits are granted on `invoice.paid` only. An endpoint that does not
 * send it deploys cleanly and then silently stops granting renewals, so this is
 * run BEFORE the deploy that ships that change, and whenever the endpoint is
 * edited. See docs/runbooks/stripe-renewal-grants.md §2.
 *
 *   STRIPE_SECRET_KEY=rk_live_… node packages/api/scripts/check-stripe-webhook-events.mjs
 *   # optional: OXY_STRIPE_WEBHOOK_URL (default https://api.oxy.so/billing/webhook)
 *
 * It only LISTS webhook endpoints (GET /v1/webhook_endpoints); a restricted key
 * with read access to webhook endpoints is enough. It creates, edits and
 * deletes nothing, and never prints the key. Exit 0 = ready, 1 = not ready,
 * 2 = could not check.
 */

import Stripe from 'stripe';

export const EXPECTED_STRIPE_API_VERSION = Stripe.API_VERSION;

/** Events the handler must receive. Missing any of these fails the check. */
export const REQUIRED_EVENTS = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'payment_intent.succeeded',
]);

/** Events the handler records when sent. Missing them is reported, not failed. */
export const OPTIONAL_EVENTS = Object.freeze(['invoice.payment_failed', 'charge.refunded']);

export const DEFAULT_WEBHOOK_URL = 'https://api.oxy.so/billing/webhook';

function normaliseUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Pure decision over the endpoints Stripe returned. No I/O.
 * @returns {{ ok: boolean, problems: string[], notes: string[], endpointId?: string }}
 */
export function evaluateWebhookEndpoints(endpoints, url = DEFAULT_WEBHOOK_URL, mode = 'live') {
  const target = normaliseUrl(url);
  if (!target || !['live', 'test'].includes(mode)) {
    return { ok: false, problems: ['invalid webhook URL or Stripe mode'], notes: [] };
  }
  const matching = (Array.isArray(endpoints) ? endpoints : []).filter(
    (endpoint) => endpoint && normaliseUrl(endpoint.url ?? '') === target,
  );
  if (matching.length === 0) {
    return { ok: false, problems: [`no webhook endpoint points at ${url}`], notes: [] };
  }
  const enabled = matching.filter((endpoint) => endpoint.status === 'enabled');
  if (enabled.length === 0) {
    return {
      ok: false,
      problems: [`the webhook endpoint for ${url} exists but is not enabled`],
      notes: [],
    };
  }
  if (enabled.length > 1) {
    // Two enabled endpoints deliver every event twice. The handler is idempotent,
    // but which secret signs which delivery is ambiguous; a human decides.
    return {
      ok: false,
      problems: [
        `${enabled.length} enabled webhook endpoints point at ${url} (${enabled
          .map((endpoint) => endpoint.id)
          .join(', ')}); expected exactly one`,
      ],
      notes: [],
    };
  }
  const [endpoint] = enabled;
  const compatibilityProblems = [];
  if (endpoint.livemode !== (mode === 'live')) {
    compatibilityProblems.push(`endpoint ${endpoint.id} does not prove ${mode} mode`);
  }
  if (endpoint.api_version !== EXPECTED_STRIPE_API_VERSION) {
    compatibilityProblems.push(
      `endpoint ${endpoint.id} API version ${endpoint.api_version ?? 'account default (unproven)'} must equal ${EXPECTED_STRIPE_API_VERSION}`,
    );
  }
  if (compatibilityProblems.length) {
    return { ok: false, problems: compatibilityProblems, notes: [], endpointId: endpoint.id };
  }
  const events = new Set(Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : []);
  if (events.has('*')) {
    return {
      ok: true,
      problems: [],
      notes: ['endpoint sends every event (*)'],
      endpointId: endpoint.id,
    };
  }
  const missingRequired = REQUIRED_EVENTS.filter((type) => !events.has(type));
  const missingOptional = OPTIONAL_EVENTS.filter((type) => !events.has(type));
  return {
    ok: missingRequired.length === 0,
    problems: missingRequired.map((type) => `endpoint ${endpoint.id} does not send ${type}`),
    notes: missingOptional.map(
      (type) => `endpoint ${endpoint.id} does not send ${type} (optional: recorded when sent)`,
    ),
    endpointId: endpoint.id,
  };
}

/** Lists every webhook endpoint, following Stripe's cursor pagination. */
export async function listWebhookEndpoints(secretKey, fetchImpl = globalThis.fetch) {
  const endpoints = [];
  let startingAfter;
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (startingAfter) query.set('starting_after', startingAfter);
    const response = await fetchImpl(`https://api.stripe.com/v1/webhook_endpoints?${query}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': EXPECTED_STRIPE_API_VERSION,
      },
    });
    if (!response.ok) {
      throw new Error(`Stripe answered ${response.status} listing webhook endpoints`);
    }
    const body = await response.json();
    if (!Array.isArray(body?.data) || typeof body.has_more !== 'boolean') {
      throw new Error('malformed webhook endpoint page; refusing incomplete evidence');
    }
    const data = body.data;
    endpoints.push(...data);
    if (!body.has_more) return endpoints;
    const cursor = data.at(-1)?.id;
    if (!cursor || cursor === startingAfter) throw new Error('pagination made no progress');
    startingAfter = cursor;
  }
  throw new Error('more than 50 pages of webhook endpoints; refusing to guess');
}

export async function main(env = process.env, fetchImpl = globalThis.fetch, log = console) {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    log.error('STRIPE_SECRET_KEY is not set; nothing was checked.');
    return 2;
  }
  const mode = env.OXY_STRIPE_MODE || 'live';
  const keyMode = /^(?:sk|rk)_(live|test)_/.exec(secretKey)?.[1];
  if (keyMode !== mode) {
    log.error('Stripe key mode must match OXY_STRIPE_MODE (default live); nothing was checked.');
    return 2;
  }
  const url = env.OXY_STRIPE_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
  let endpoints;
  try {
    endpoints = await listWebhookEndpoints(secretKey, fetchImpl);
  } catch (error) {
    log.error(
      `Could not list webhook endpoints: ${error instanceof Error ? error.message : error}`,
    );
    return 2;
  }
  const result = evaluateWebhookEndpoints(endpoints, url, mode);
  for (const note of result.notes) log.log(`note: ${note}`);
  if (!result.ok) {
    log.error(`Stripe webhook NOT ready for ${url}:`);
    for (const problem of result.problems) log.error(`  - ${problem}`);
    return 1;
  }
  log.log(`Stripe webhook ready: ${result.endpointId} sends every event ${url} requires.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
