/** Offline actual raw-body receiver; fixture signature, never provider delivery. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.cwd();
const api = resolve(root, 'packages/api');
const require = createRequire(resolve(api, 'package.json'));
const express = require('express');
const Stripe = require('stripe');
const engine = typeof Bun === 'undefined' ? 'node' : 'bun';
const prefix = engine === 'node' ? 'dist' : 'src';
const suffix = engine === 'node' ? 'js' : 'ts';
const source = async (path) =>
  import(pathToFileURL(resolve(api, prefix, path + '.' + suffix)).href);
const pg = await source('config/postgres');
const clientModule = await source('utils/stripeClient');
const getStripe = clientModule.getStripe ?? clientModule.default?.getStripe;
const routerModule = await source('routes/billing');
const router =
  typeof routerModule.default === 'function' ? routerModule.default : routerModule.default?.default;
assert.equal(typeof router, 'function');
assert.equal(process.env.STRIPE_SECRET_KEY, 'sk_test_offline_fixture');
assert.equal(process.env.BILLING_PROCESSOR_ENVIRONMENT, 'test');
assert.equal(process.env.NODE_ENV, 'test');
const secret = process.env.STRIPE_WEBHOOK_SECRET;
assert.equal(secret, 'whsec_offline_fixture');
const sign = (raw, key = secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', key).update(`${t}.${raw}`).digest('hex')}`;
const app = express();
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use('/billing', router);
const server = http.createServer(app);
let checked = 0;
try {
  await pg.connectPostgres();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const id = 'evt_offline_' + randomUUID();
  const raw = JSON.stringify({
    id,
    object: 'event',
    type: 'setup_intent.created',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'seti_offline_fixture', object: 'setup_intent' } },
  });
  const send = async (body, signature) =>
    fetch(`http://127.0.0.1:${server.address().port}/billing/webhook`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      signal: AbortSignal.timeout(5000),
    });
  assert.equal((await send(raw, sign(raw))).status, 200);
  checked++;
  assert.equal((await send(raw, sign(raw))).status, 200);
  checked++;
  assert.equal(
    (await send(raw.replace('seti_offline_fixture', 'seti_tampered_fixture'), sign(raw))).status,
    400,
  );
  checked++;
  assert.equal((await send(raw, sign(raw, 'whsec_wrong_fixture'))).status, 400);
  checked++;
  assert.equal(
    (await send(raw, sign(raw, secret, Math.floor(Date.now() / 1000) - 1000))).status,
    400,
  );
  checked++;
  const generated = await getStripe().webhooks.generateTestHeaderStringAsync({
    payload: raw,
    secret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  assert.equal(
    (
      await getStripe().webhooks.constructEventAsync(
        raw,
        generated,
        secret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      )
    ).id,
    id,
  );
  checked++;
  const { sql } = require('drizzle-orm');
  const rows = await pg
    .getDb()
    .execute(
      sql`select stripe_event_id,outcome,attempts from billing_stripe_events where stripe_event_id=${id}`,
    );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'ignored');
  assert.equal(rows[0].attempts, 2);
  checked++;
  console.log(
    JSON.stringify({
      engine,
      passed: checked,
      realStripeClient: true,
      realRawBodyRoute: true,
      remoteRequests: 0,
      providerSignedDelivery: false,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await pg.closePostgres();
}
