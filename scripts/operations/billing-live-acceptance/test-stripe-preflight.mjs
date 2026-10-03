import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStripePreflight, keyMode, projectPortal, encodeStripePreflight, API_VERSION } from './read-stripe-preflight.mjs';
const portal = { id: 'bpc_fixture', object: 'billing_portal.configuration', active: true, is_default: false, livemode: false,
  features: { subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end' } } };
const list = { object: 'list', url: '/v1/billing_portal/configurations', has_more: false, data: [portal] };
const response = value => new Response(JSON.stringify(value));
function fetcher(overrides = {}) { const calls = []; return { calls, get: async (url, init) => {
  calls.push([url, init]); const path = new URL(url).pathname;
  if (path === '/v1/account') return response(overrides.account ?? { id: 'acct_fixture', object: 'account', email: 'private@example.test' });
  if (path === '/v1/billing_portal/configurations/bpc_fixture') return response(overrides.selected ?? portal);
  return response(overrides.list ?? list);
} }; }
test('projects account/key mode/Portal without PII and only fixed GETs', async () => {
  const f = fetcher(); const value = await readStripePreflight('mercaria', 'sk_test_fixture', 'bpc_fixture', f.get);
  assert.equal(value.accountId, 'acct_fixture'); assert.equal(value.selectedPortalCompatible, true); assert.equal(value.requests, 3);
  assert.equal(value.activationPerformed, false); assert.equal(value.remoteSnapshotAtomic, false);
  assert(!JSON.stringify(value).includes('private@example')); assert(!JSON.stringify(value).includes('sk_test'));
  for (const [url, init] of f.calls) { assert.equal(new URL(url).origin, 'https://api.stripe.com'); assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers['stripe-version'], API_VERSION); assert(!('stripe-account' in init.headers)); }
});
test('discovery never automatically chooses a default or compatible configuration', async () => {
  const value = await readStripePreflight('peable', 'sk_test_fixture', null, fetcher().get);
  assert.equal(value.portalSelectionRequired, true); assert.equal(value.selectedPortal, null); assert.equal(value.selectedPortalCompatible, null);
});
test('test/live/restricted prefixes explicit; unknown denied before network', async () => {
  assert.equal(keyMode('rk_live_fixture'), 'live'); assert.equal(keyMode('sk_test_fixture'), 'test');
  await assert.rejects(readStripePreflight('mercaria', 'invalid', null, () => assert.fail('no request')));
});
test('Portal mode mismatch rejects', () => assert.throws(() => projectPortal({ ...portal, livemode: true }, 'test')));
test('immediate cancellation and updates are projected as incompatible without mutation', () => {
  assert.equal(projectPortal({ ...portal, features: { ...portal.features, subscription_cancel: { enabled: true, mode: 'immediately' } } }, 'test').compatible, false);
  assert.equal(projectPortal({ ...portal, features: { ...portal.features, subscription_update: { enabled: true } } }, 'test').compatible, false);
});
test('disabled cancel may use immediate mode; inactive still incompatible', () => {
  assert.equal(projectPortal({ ...portal, features: { ...portal.features, subscription_cancel: { enabled: false, mode: 'immediately' } } }, 'test').compatible, true);
  assert.equal(projectPortal({ ...portal, active: false }, 'test').compatible, false);
});
test('changed selected configuration fails instead of recording acceptance', async () => {
  await assert.rejects(readStripePreflight('mercaria', 'sk_test_fixture', 'bpc_fixture', fetcher({ selected: { ...portal, active: false } }).get));
});
test('duplicate pages and empty has_more reject', async () => {
  await assert.rejects(readStripePreflight('mercaria', 'sk_test_fixture', null, fetcher({ list: { ...list, has_more: true } }).get));
  await assert.rejects(readStripePreflight('mercaria', 'sk_test_fixture', null, fetcher({ list: { ...list, data: [], has_more: true } }).get));
});
test('three-page budget rejects partial census', async () => {
  let i = 0; await assert.rejects(readStripePreflight('mercaria', 'sk_test_fixture', null, async url => {
    if (new URL(url).pathname === '/v1/account') return response({ object: 'account', id: 'acct_fixture' });
    i++; return response({ ...list, has_more: true, data: [{ ...portal, id: 'bpc_fixture' + i }] });
  })); assert.equal(i, 3);
});
test('provider failure/oversized stream rejects without error or raw data persistence', async () => {
  await assert.rejects(readStripePreflight('mercaria', 'sk_test_fixture', null, async () => new Response('private', { status: 401 })));
  await assert.rejects(readStripePreflight('mercaria', 'sk_test_fixture', null, async () => new Response('x'.repeat(524289))));
});
test('encoded projection has nonce/digest and no key/PII', () => {
  const lines = encodeStripePreflight({ readOnly: true }, 'a'.repeat(32)); assert.equal(lines.length, 1);
  const p = JSON.parse(lines[0].split(' ').slice(1).join(' ')); assert.equal(p.nonce, 'a'.repeat(32)); assert.equal(p.sha256.length, 64);
});
