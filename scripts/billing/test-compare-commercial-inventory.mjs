import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareCommercialInventory } from './compare-commercial-inventory.mjs';
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function seal(input) { input.receipt.resultSha256 = createHash('sha256').update(canonical(input.result)).digest('hex'); input.receipt.tables = Object.fromEntries(Object.entries(input.result.tables).map(([key, row]) => [key, { status: row.status, count: row.count }])); }
function fixture() {
  const names = { oxy: ['billing_subscriptions', 'subscriptions', 'user_credits', 'billing_transactions'], clarity: ['clarity_subscriptions', 'clarity_billing_customers'], mercaria: ['merchant_plans', 'merchant_plan_prices', 'plan_entitlements', 'billing_customers', 'merchant_subscriptions', 'store_members'] };
  return Object.fromEntries(Object.entries(names).map(([profile, tables]) => { const input = { result: { schemaVersion: 1, profile, readOnly: true, isolation: 'repeatable read', observedAt: '2026-10-03T03:00:00Z', runtime: { node: 'fixture', postgresVersion: 'fixture', postgresEntrySha256: '0'.repeat(64) }, tables: Object.fromEntries(tables.map(table => [table, { status: 'complete', count: 0, rows: [] }])) }, receipt: { profile, readOnly: true }, cleanup: { taskStopped: true, definitionInactive: true, failures: [] } }; seal(input); return [profile, input]; }));
}
let passed = 0;
const empty = fixture(); empty.oxy.result.tables.access_products = { status: 'missing', count: null, rows: [] }; seal(empty.oxy);
assert.equal(compareCommercialInventory(empty).backfillStatus, 'no_existing_rows_to_backfill'); assert.equal(compareCommercialInventory(empty).targetMigrationRequired, true); passed++;
const legacy = fixture(); legacy.oxy.result.tables.billing_transactions.schemaProfile = 'oxy_pre_subscription_credit_ledger'; legacy.oxy.result.tables.billing_transactions.unavailableColumns = ['stripe_invoice_id']; seal(legacy.oxy); assert.equal(compareCommercialInventory(legacy).profiles.oxy.tables.billing_transactions.schemaProfile, 'oxy_pre_subscription_credit_ledger'); passed++;
const existing = fixture(); existing.clarity.result.tables.clarity_subscriptions = { status: 'complete', count: 1, rows: [{ id: 'NEVER_REPORT_REFERENCE' }] }; seal(existing.clarity); const preserved = compareCommercialInventory(existing); assert.equal(preserved.backfillStatus, 'blocked_preserve_legacy'); assert.equal(preserved.profiles.clarity.plannedBackfillWrites, 0); assert(!JSON.stringify(preserved).includes('NEVER_REPORT_REFERENCE')); passed++;
const missing = fixture(); missing.oxy.result.tables.billing_transactions = { status: 'schema_mismatch', count: null, rows: [] }; seal(missing.oxy); assert.equal(compareCommercialInventory(missing).profiles.oxy.status, 'incomplete_inventory'); passed++;
const wrong = fixture(); wrong.mercaria.result.tables.merchant_subscriptions.count = 1; assert.throws(() => compareCommercialInventory(wrong), /hash/); seal(wrong.mercaria); assert.throws(() => compareCommercialInventory(wrong), /count/); passed++;
const cleanup = fixture(); cleanup.oxy.cleanup.failures.push('fixture'); assert.throws(() => compareCommercialInventory(cleanup), /cleanup/); passed++;
console.log(`Commercial dry-run comparison fixtures: ${passed} passed; no DB/provider access.`);
