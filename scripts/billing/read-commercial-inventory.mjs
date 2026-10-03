/** Read-only SQL projection. Run only through the reviewed ECS launcher. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const require = createRequire(`${process.cwd()}/package.json`);
const postgres = require('postgres');
const MAX_ROWS = 1000;
const MAX_BYTES = 1024 * 1024;
const PROJECTIONS = {
  'mercaria-cohort': {
    stores: ['id', 'status'],
    store_members: { columns: ['id', 'store_id', 'oxy_user_id', 'role'], where: "role = 'owner'" },
  },
  'peable-cohort': {
    merchants: { columns: ['id', 'public_id', 'oxy_app_id', 'environment', 'livemode'], where: "oxy_app_id = '6a37d0cc5d4b5f15482a9340'" },
  },
  oxy: {
    billing_subscriptions: ['id', 'user_id', 'stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id', 'status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'plan_name', 'plan_credits_per_month', 'plan_price_minor_units', 'plan_currency'],
    subscriptions: ['id', 'user_id', 'plan', 'status', 'start_date', 'end_date', 'auto_renew', 'latest_invoice'],
    user_credits: { columns: ['user_id', 'stripe_customer_id', 'credits_paid', 'credits_free'], where: 'credits_paid > 0 OR stripe_customer_id IS NOT NULL' },
    billing_transactions: { legacyProfile: { name: 'oxy_pre_subscription_credit_ledger', absentColumns: ['stripe_invoice_id'] }, columns: ['id', 'user_id', 'stripe_customer_id', 'stripe_subscription_id', 'stripe_invoice_id', 'stripe_subscription_period_start', 'type', 'amount_minor_units', 'currency', 'credits', 'status'], where: "type IN ('subscription_payment','subscription_proration','subscription_promotional_grant','credit_purchase')" },
    access_products: ['id', 'application_id', 'owner_account_id'],
    access_offers: ['id', 'version', 'kind', 'expected_benefit_count'],
    access_offer_benefits: ['offer_id', 'offer_version', 'benefit_index', 'product_id', 'kind', 'key', 'unit', 'included', 'combination'],
    access_subscription_sources: ['id', 'beneficiary_account_id', 'payer_account_id', 'provider', 'provider_subscription_id', 'provider_account_ref', 'mode', 'environment', 'status', 'period_start', 'period_end', 'cancel_at_period_end'],
    access_offer_segments: ['id', 'subscription_id', 'beneficiary_account_id', 'offer_id', 'offer_version', 'origin', 'period_start', 'period_end'],
    access_grants: ['id', 'source_segment_id', 'beneficiary_account_id', 'offer_id', 'offer_version', 'origin', 'benefit_index', 'product_id', 'period_start', 'period_end', 'revoked_at'],
    billing_credit_grants: ['id', 'user_id', 'transaction_id', 'provider_account_ref', 'invoice_id', 'subscription_id', 'source_type', 'period_start', 'period_end', 'currency', 'amount_paid', 'granted', 'consumed', 'clawed'],
  },
  clarity: {
    clarity_subscriptions: { columns: ['id', 'oxy_user_id', 'stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id', 'status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'plan_id', 'billing_period'], extra: ["plan_snapshot ->> 'product' AS product", "plan_snapshot ->> 'currency' AS currency", "plan_snapshot ->> 'price' AS price_minor_units", "plan_snapshot ->> 'creditsPerMonth' AS legacy_credit_allowance"], required: ['plan_snapshot'] },
    clarity_billing_customers: ['oxy_user_id', 'stripe_customer_id'],
  },
  mercaria: {
    merchant_plans: ['id', 'plan_key', 'version', 'tier', 'status', 'terms_version', 'trial_days', 'grace_period_days'],
    merchant_plan_prices: ['id', 'plan_id', 'provider', 'livemode', 'interval', 'unit_price_amount', 'unit_price_currency', 'provider_price_id'],
    plan_entitlements: ['id', 'plan_id', 'capability_key', 'limit_kind', 'limit_value'],
    billing_customers: ['id', 'store_id', 'provider', 'livemode', 'provider_customer_id'],
    merchant_subscriptions: ['id', 'store_id', 'plan_id', 'billing_customer_id', 'provider', 'livemode', 'provider_subscription_id', 'status', 'interval', 'current_period_start', 'current_period_end', 'grace_expires_at', 'cancellation_behavior', 'cancel_at', 'ended_at'],
    store_members: { columns: ['id', 'store_id', 'oxy_user_id', 'role'], where: "role = 'owner' AND EXISTS (SELECT 1 FROM public.merchant_subscriptions s WHERE s.store_id = public.store_members.store_id)", dependsOn: 'merchant_subscriptions' },
  },
};
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export async function readInventory(profile, databaseUrl) {
  if (!Object.hasOwn(PROJECTIONS, profile) || !databaseUrl) throw new Error('Invalid fixed inventory profile');
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} });
  try {
    return await client.begin('isolation level repeatable read read only', async tx => {
      await tx`SET LOCAL statement_timeout = '15000'`;
      await tx`SET LOCAL lock_timeout = '3000'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '30000'`;
      const [safety] = await tx`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, transaction_timestamp()::text AS observed_at`;
      if (safety.read_only !== 'on' || safety.isolation !== 'repeatable read') throw new Error('Required SQL read-only snapshot absent');
      const tables = {};
      for (const [table, spec] of Object.entries(PROJECTIONS[profile])) {
        const descriptor = Array.isArray(spec) ? { columns: spec } : spec;
        const [presence] = await tx`SELECT to_regclass(${`public.${table}`})::text AS name`;
        if (!presence.name) { tables[table] = { status: 'missing', count: null, rows: [] }; continue; }
        const columns = await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
        const names = new Set(columns.map(row => row.column_name));
        const missing = [...descriptor.columns, ...(descriptor.required ?? [])].filter(column => !names.has(column));
        const legacy = descriptor.legacyProfile && missing.length === descriptor.legacyProfile.absentColumns.length
          && descriptor.legacyProfile.absentColumns.every(column => missing.includes(column));
        if (missing.length && !legacy) { tables[table] = { status: 'schema_mismatch', count: null, missing, rows: [] }; continue; }
        const selectedColumns = legacy ? descriptor.columns.filter(column => !missing.includes(column)) : descriptor.columns;
        if (descriptor.dependsOn) {
          const [dependency] = await tx`SELECT to_regclass(${`public.${descriptor.dependsOn}`})::text AS name`;
          if (!dependency.name) { tables[table] = { status: 'dependency_missing', count: null, rows: [] }; continue; }
        }
        // SQL identifiers, expressions and filters originate exclusively in the fixed map above.
        const where = descriptor.where ? ` WHERE ${descriptor.where}` : '';
        const [total] = await tx.unsafe(`SELECT count(*)::text AS n FROM public.${table}${where}`);
        const count = Number(total.n);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid inventory count');
        if (count > MAX_ROWS) { tables[table] = { status: 'row_limit', count, rows: [] }; continue; }
        const selected = [...selectedColumns.map(column => `"${column}"`), ...(descriptor.extra ?? [])].join(', ');
        const rows = await tx.unsafe(`SELECT ${selected} FROM public.${table}${where} ORDER BY ${selectedColumns.map(column => `"${column}"`).join(', ')} LIMIT ${MAX_ROWS + 1}`);
        if (rows.length !== count) throw new Error('Inventory snapshot count differs');
        tables[table] = { status: 'complete', count, rows: Array.from(rows), ...(legacy ? { schemaProfile: descriptor.legacyProfile.name, unavailableColumns: missing } : {}) };
      }
      const dependency = require.resolve('postgres');
      let packageDirectory = dirname(dependency); let packageMetadata;
      for (let depth = 0; depth < 6; depth++) {
        try { const metadata = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')); if (metadata.name === 'postgres') { packageMetadata = metadata; break; } } catch {}
        packageDirectory = dirname(packageDirectory);
      }
      if (!packageMetadata || typeof packageMetadata.version !== 'string') throw new Error('Resolved postgres package lacks metadata');
      const result = { schemaVersion: 1, profile, readOnly: true, isolation: safety.isolation, observedAt: safety.observed_at,
        runtime: { node: process.version, postgresVersion: packageMetadata.version, postgresEntrySha256: hash(readFileSync(dependency)) }, tables };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error('Inventory output exceeds fixed byte bound');
      return result;
    });
  } finally { await client.end({ timeout: 5 }); }
}
export function encodeInventory(result, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid result nonce');
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > MAX_BYTES) throw new Error('Inventory output exceeds fixed byte bound');
  const payload = bytes.toString('base64'); const chunks = [];
  for (let start = 0; start < payload.length; start += 12000) chunks.push(payload.slice(start, start + 12000));
  return chunks.map((data, seq) => `OXY_BILLING_INVENTORY ${JSON.stringify({ nonce, seq, total: chunks.length, sha256: hash(bytes), data })}`);
}
// The launcher concatenates the fixed invocation below; imports alone make no connection.
