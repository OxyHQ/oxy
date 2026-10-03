/** Fixed Stripe metadata GETs only; injected key remains inside the owned task. */
import { createHash } from 'node:crypto';
export const API_VERSION = '2026-07-29.dahlia';
function require(value, code) { if (!value) throw new Error(code); }
export function keyMode(key) {
  require(typeof key === 'string' && /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key), 'unrecognized_key_mode');
  return key.split('_')[1];
}
export function projectPortal(value, mode) {
  const cancel = value?.features?.subscription_cancel;
  const update = value?.features?.subscription_update;
  require(value?.object === 'billing_portal.configuration' && /^bpc_[A-Za-z0-9]+$/.test(value.id)
    && typeof value.active === 'boolean' && typeof value.is_default === 'boolean'
    && value.livemode === (mode === 'live') && typeof update?.enabled === 'boolean'
    && typeof cancel?.enabled === 'boolean' && ['immediately', 'at_period_end'].includes(cancel.mode), 'portal_projection_invalid');
  return { id: value.id, active: value.active, isDefault: value.is_default, livemode: value.livemode,
    subscriptionUpdateEnabled: update.enabled, subscriptionCancelEnabled: cancel.enabled,
    subscriptionCancelMode: cancel.mode,
    compatible: value.active && !update.enabled && (!cancel.enabled || cancel.mode === 'at_period_end') };
}
async function readJson(response) {
  require(response.status === 200, 'provider_metadata_http_not_200');
  const reader = response.body?.getReader(); const chunks = []; let bytes = 0;
  require(reader, 'provider_metadata_body_missing');
  try {
    while (true) { const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; require(bytes <= 524288, 'provider_metadata_oversized'); chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function readStripePreflight(profile, key, selectedPortal = null, fetcher = globalThis.fetch) {
  require(['mercaria', 'peable'].includes(profile), 'unknown_profile');
  require(selectedPortal === null || /^bpc_[A-Za-z0-9]+$/.test(selectedPortal), 'portal_reference_invalid');
  const mode = keyMode(key); let requests = 0;
  async function get(path) {
    require(++requests <= 6, 'request_budget_exceeded');
    const response = await fetcher('https://api.stripe.com' + path, { method: 'GET', redirect: 'error',
      headers: { authorization: 'Bearer ' + key, 'stripe-version': API_VERSION }, signal: AbortSignal.timeout(10000) });
    return readJson(response);
  }
  const account = await get('/v1/account');
  require(account?.object === 'account' && /^acct_[A-Za-z0-9]+$/.test(account.id), 'account_projection_invalid');
  const configurations = []; let cursor; let complete = false;
  for (let page = 0; page < 3; page++) {
    const path = '/v1/billing_portal/configurations?limit=100' + (cursor ? '&starting_after=' + cursor : '');
    const list = await get(path);
    require(list?.object === 'list' && list.url === '/v1/billing_portal/configurations'
      && typeof list.has_more === 'boolean' && Array.isArray(list.data) && list.data.length <= 100, 'portal_list_invalid');
    const rows = list.data.map(row => projectPortal(row, mode));
    for (const row of rows) require(!configurations.some(previous => previous.id === row.id), 'portal_duplicate_or_cursor_loop');
    configurations.push(...rows);
    if (!list.has_more) { complete = true; break; }
    require(rows.length > 0, 'empty_more_page'); cursor = rows.at(-1).id;
  }
  require(complete, 'portal_census_page_bound_exceeded');
  let selected = null;
  if (selectedPortal) {
    selected = projectPortal(await get('/v1/billing_portal/configurations/' + selectedPortal), mode);
    require(selected.id === selectedPortal && configurations.some(value => JSON.stringify(value) === JSON.stringify(selected)), 'selected_portal_changed_or_not_in_census');
  }
  // Account carries no livemode field: mode comes from the existing key prefix,
  // corroborated by every projected configuration. No key bytes/hash are returned.
  return { schemaVersion: 1, kind: 'stripe-account-portal-preflight', profile, readOnly: true,
    observedAt: new Date().toISOString(), apiVersion: API_VERSION, accountId: account.id,
    mode, modeEvidence: 'deployed_key_prefix_and_portal_livemode', platformScope: true,
    connectedAccountHeaderSent: false, configured: true, requests, configurations, selectedPortal: selected,
    portalSelectionRequired: selected === null, selectedPortalCompatible: selected?.compatible ?? null,
    completeCensus: true, remoteSnapshotAtomic: false, activationPerformed: false };
}
export function encodeStripePreflight(value, nonce) {
  require(/^[a-f0-9]{32}$/.test(nonce), 'nonce_invalid');
  const bytes = Buffer.from(JSON.stringify(value)); require(bytes.length <= 1048576, 'projection_oversized');
  const encoded = bytes.toString('base64'); const pieces = [];
  for (let offset = 0; offset < encoded.length; offset += 12000) pieces.push(encoded.slice(offset, offset + 12000));
  return pieces.map((data, seq) => `OXY_BILLING_INVENTORY ${JSON.stringify({ nonce, seq, total: pieces.length, sha256: createHash('sha256').update(bytes).digest('hex'), data })}`);
}
// Import alone has no effect; the pinned launcher supplies the exact invocation.
