/** Local dry-run only. Verifies completed read-only receipts; makes no DB/provider call. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const REQUIRED = {
  oxy: ['billing_subscriptions', 'subscriptions', 'user_credits', 'billing_transactions'],
  clarity: ['clarity_subscriptions', 'clarity_billing_customers'],
  mercaria: [
    'merchant_plans',
    'merchant_plan_prices',
    'plan_entitlements',
    'billing_customers',
    'merchant_subscriptions',
    'store_members',
  ],
};
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonical(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function require(condition, message) {
  if (!condition) throw new Error(message);
}
export function compareCommercialInventory(inputs) {
  require(Object.keys(inputs).sort().join(',') ===
    'clarity,mercaria,oxy', 'All three fixed inventory profiles are required');
  const profiles = {};
  for (const [profile, { result, receipt, cleanup }] of Object.entries(inputs)) {
    require(result.schemaVersion === 1 &&
      result.profile === profile &&
      result.readOnly === true &&
      result.isolation === 'repeatable read', 'Read-only inventory identity differs');
    require(receipt.profile === profile &&
      receipt.readOnly === true &&
      receipt.resultSha256 === digest(result), 'Inventory receipt hash differs');
    require(cleanup.taskStopped === true &&
      cleanup.definitionInactive === true &&
      Array.isArray(cleanup.failures) &&
      !cleanup.failures.length, 'Inventory cleanup is incomplete');
    const tables = {};
    for (const table of REQUIRED[profile]) {
      const row = result.tables[table];
      require(row &&
        receipt.tables[table]?.status === row.status &&
        receipt.tables[table]?.count === row.count, 'Receipt table metadata differs');
      const complete = row.status === 'complete';
      require(!complete ||
        (Number.isSafeInteger(row.count) &&
          row.count >= 0 &&
          row.count <= 1000 &&
          Array.isArray(row.rows) &&
          row.rows.length === row.count), 'Inventory row count differs');
      if (row.schemaProfile)
        require(profile === 'oxy' &&
          table === 'billing_transactions' &&
          row.schemaProfile === 'oxy_pre_subscription_credit_ledger' &&
          JSON.stringify(row.unavailableColumns) ===
            '["stripe_invoice_id"]', 'Unknown legacy schema profile');
      tables[table] = {
        status: row.status,
        count: row.count,
        ...(row.schemaProfile
          ? { schemaProfile: row.schemaProfile, unavailableColumns: row.unavailableColumns }
          : {}),
      };
    }
    const complete = Object.values(tables).every((table) => table.status === 'complete');
    const existingRows = complete
      ? Object.values(tables).reduce((sum, table) => sum + table.count, 0)
      : null;
    const absentNewTables =
      profile === 'oxy'
        ? Object.entries(result.tables)
            .filter(([table, row]) => !REQUIRED.oxy.includes(table) && row.status === 'missing')
            .map(([table]) => table)
            .sort()
        : [];
    profiles[profile] = {
      observedAt: result.observedAt,
      runtime: {
        node: result.runtime?.node,
        postgresVersion: result.runtime?.postgresVersion,
        postgresEntrySha256: result.runtime?.postgresEntrySha256,
      },
      tables,
      absentNewTables,
      status: !complete
        ? 'incomplete_inventory'
        : existingRows === 0
          ? 'verified_no_existing_rows'
          : 'legacy_rows_require_explicit_mapping',
      existingProjectedRows: existingRows,
      existingRowsPreserved: true,
      plannedBackfillWrites: 0,
      plannedCharges: 0,
      plannedCreditReconstruction: 0,
      currentReadComparison:
        complete && existingRows === 0
          ? 'existing_sql_projection_empty_and_planned_grants_empty'
          : 'not_demonstrated',
    };
  }
  return {
    schemaVersion: 1,
    dryRun: true,
    profiles,
    actualDatabaseWrites: false,
    providerInventoryClaimed: false,
    backfillStatus: Object.values(profiles).every(
      (profile) => profile.status === 'verified_no_existing_rows',
    )
      ? 'no_existing_rows_to_backfill'
      : 'blocked_preserve_legacy',
    catalogueDecision:
      'No existing subscription/offer is inferred; no Oxy One sale or price is introduced.',
    targetMigrationRequired: profiles.oxy.absentNewTables.length > 0,
  };
}
function read(directory, filename) {
  const bytes = readFileSync(join(directory, filename));
  require(bytes.length <= 1024 * 1024, 'Inventory input exceeds bound');
  return JSON.parse(bytes.toString('utf8'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  require(args.length ===
    8, 'Use --oxy DIR --clarity DIR --mercaria DIR --output NEW_JSON (dry-run only)');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    require(args[index].startsWith('--'), 'Invalid dry-run option');
    const key = args[index].slice(2);
    require(['oxy', 'clarity', 'mercaria', 'output'].includes(key) &&
      !Object.hasOwn(options, key), 'Unknown/duplicate dry-run option');
    options[key] = args[index + 1];
  }
  require(Object.keys(options).length === 4, 'All fixed dry-run options are required');
  const inputs = {};
  for (const profile of Object.keys(REQUIRED))
    inputs[profile] = {
      result: read(options[profile], 'result.private.json'),
      receipt: read(options[profile], 'receipt.json'),
      cleanup: read(options[profile], 'cleanup.json'),
    };
  writeFileSync(
    options.output,
    `${JSON.stringify(compareCommercialInventory(inputs), null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Dry-run comparison recorded. No database/provider writes or raw financial references.',
  );
}
