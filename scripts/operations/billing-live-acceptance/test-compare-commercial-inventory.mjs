import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compareCommercialInventory } from './compare-commercial-inventory.mjs';
const names = { oxy: ['billing_subscriptions', 'subscriptions', 'user_credits', 'billing_transactions', 'access_products', 'access_offers', 'access_offer_benefits', 'access_subscription_sources', 'access_offer_segments', 'access_grants', 'access_provider_periods', 'access_provider_events', 'billing_credit_grants', 'billing_credit_invoices', 'billing_credit_spends', 'billing_credit_consumptions', 'billing_credit_refund_observations'], clarity: ['clarity_subscriptions', 'clarity_billing_customers'], mercaria: ['merchant_plans', 'merchant_plan_prices', 'plan_entitlements', 'billing_customers', 'merchant_subscriptions', 'stores', 'store_members'] };
function canonical(x) { if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']'; if (x !== null && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => canonical(k) + ':' + canonical(x[k])).join(',') + '}'; return JSON.stringify(x); }
function commit(input) {
  input.receipt.resultSha256 = createHash('sha256').update(canonical(input.result)).digest('hex');
  input.receipt.tables = Object.fromEntries(Object.entries(input.result.tables).map(([k, r]) => [k, { status: r.status, count: r.count }]));
}
function fixture() {
  return Object.fromEntries(Object.entries(names).map(([profile, tables]) => { const value = { result: { schemaVersion: 1, profile, readOnly: true, isolation: 'repeatable read', observedAt: '2026-10-04T00:00:00Z', tables: Object.fromEntries(tables.map(t => [t, { status: 'complete', count: 0, rows: [] }])) }, receipt: { profile, readOnly: true }, cleanup: { taskStopped: true, definitionInactive: true, failures: [] } }; commit(value); return [profile, value]; }));
}
test('post-DDL zero financial rows and two stores/owners imply zero backfill writes', () => {
  const f = fixture();
  for (const name of ['stores', 'store_members']) f.mercaria.result.tables[name] = { status: 'complete', count: 2, rows: [{ id: 'synthetic-a' }, { id: 'synthetic-b' }] };
  commit(f.mercaria); const r = compareCommercialInventory(f);
  assert.equal(r.backfillStatus, 'no_existing_rows_to_backfill'); assert.equal(r.profiles.mercaria.storeCount, 2); assert.equal(r.profiles.mercaria.ownerBindingCount, 2); assert.equal(r.profiles.mercaria.existingCommercialRows, 0); assert.equal(r.actualDatabaseWrites, false);
});
test('missing target table cannot pass post-DDL comparison', () => {
  const f = fixture(); f.oxy.result.tables.access_provider_events = { status: 'missing', count: null, rows: [] }; commit(f.oxy);
  const r = compareCommercialInventory(f); assert.equal(r.backfillStatus, 'blocked_preserve_legacy'); assert.equal(r.targetMigrationRequired, true); assert.equal(r.profiles.oxy.destinationRows, null);
});
test('nonzero financial destination cannot be called empty backfill acceptance', () => {
  const f = fixture(); f.oxy.result.tables.billing_credit_spends = { status: 'complete', count: 1, rows: [{ id: 'synthetic-only' }] }; commit(f.oxy);
  const r = compareCommercialInventory(f); assert.equal(r.backfillStatus, 'blocked_preserve_legacy'); assert.equal(r.profiles.oxy.destinationRows, 1); assert.equal(r.profiles.oxy.currentReadComparison, 'not_demonstrated');
});
test('legacy missing invoice-column fallback is insufficient after142', () => {
  const f = fixture(); f.oxy.result.tables.billing_transactions.schemaProfile = 'oxy_pre_subscription_credit_ledger'; f.oxy.result.tables.billing_transactions.unavailableColumns = ['stripe_invoice_id']; commit(f.oxy);
  assert.throws(() => compareCommercialInventory(f), /post-DDL/);
});
test('omitted table census denied', () => { const f = fixture(); delete f.oxy.result.tables.billing_credit_invoices; commit(f.oxy); assert.throws(() => compareCommercialInventory(f)); });
test('changed receipt denied', () => { const f = fixture(); f.oxy.receipt.resultSha256 = '0'.repeat(64); assert.throws(() => compareCommercialInventory(f)); });
test('incomplete ECS cleanup denied', () => { const f = fixture(); f.oxy.cleanup.taskStopped = false; assert.throws(() => compareCommercialInventory(f)); });
