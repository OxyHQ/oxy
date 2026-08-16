/**
 * Telemetry retention is separate from financial retention — as a GATE.
 *
 * #972 workstream 8 asks for the separation. A comment saying so is not the
 * separation: the sweep registry is an ordinary array, and adding
 * `usage_receipts` to it would be a one-line change that deletes financial
 * records ninety days after they are written, silently, with every test still
 * green.
 *
 * So this file asserts the registry's CONTENTS both ways round:
 *
 *  - the inference telemetry stream IS swept, at the window it declares;
 *  - no financial table is swept, ever.
 *
 * Both halves carry their own vacuity floor. "No financial table appears" is
 * also what a check that read an empty registry reports, so the same traversal
 * has to be shown finding something.
 */

import { getTableName } from 'drizzle-orm';
import { EXPIRY_SWEEP_TARGETS } from '../expiry';
import {
  INFERENCE_USAGE_RETENTION_SECONDS,
  inferenceUsageEvents,
} from '../schema/inferenceUsageEvents';

/**
 * Tables whose rows are financial records. A row here outlives every telemetry
 * window by law and by reconciliation need, and there is no correct retention
 * for it that a 90-day sweep expresses.
 *
 * `inference_usage_daily_rollups` is on the list even though it is derived from
 * telemetry: it is the only usage history that survives the detail being swept,
 * so sweeping it would silently truncate every customer's usage chart to ninety
 * days while the ledger still held the charges.
 */
const NEVER_SWEPT = [
  'price_versions',
  'price_version_unit_prices',
  'billing_profiles',
  'account_balances',
  'billing_ledger_entries',
  'billing_ledger_postings',
  'usage_reservations',
  'usage_receipts',
  'usage_receipt_unit_prices',
  'usage_refunds',
  'spending_limits',
  'spending_limit_notifications',
  'billing_invoices',
  'billing_invoice_receipts',
  'inference_usage_daily_rollups',
  // Account billing and the processor boundary (#972 sections 7.1 and 7.4).
  // `billing_external_payments` is the only join between Oxy's ledger and the
  // processor's records, so sweeping it would make reconciliation of anything
  // older than the window impossible. `billing_auto_recharge_attempts` explains
  // a charge on a customer's card statement, and a support conversation about
  // one happens long after any telemetry window. The two reconciliation tables
  // are the audit trail of whether the books ever agreed.
  'billing_external_payments',
  'billing_auto_recharge_attempts',
  'billing_reconciliation_runs',
  'billing_reconciliation_discrepancies',
] as const;

const sweptTables = EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table));

it('sweeps the inference telemetry stream at the window it declares', () => {
  const target = EXPIRY_SWEEP_TARGETS.find(
    (candidate) => getTableName(candidate.table) === getTableName(inferenceUsageEvents)
  );
  expect(target).toBeDefined();
  expect(target?.retentionSeconds).toBe(INFERENCE_USAGE_RETENTION_SECONDS);
  expect(INFERENCE_USAGE_RETENTION_SECONDS).toBe(90 * 24 * 60 * 60);
});

it('never sweeps a financial record', () => {
  // The floor first: this traversal can see tables at all, so an empty
  // intersection below means "none of them is registered", not "the registry
  // was not read".
  expect(sweptTables.length).toBeGreaterThan(5);
  expect(sweptTables).toContain(getTableName(inferenceUsageEvents));

  const swept = NEVER_SWEPT.filter((table) => sweptTables.includes(table));
  expect(swept).toEqual([]);
});

it('names every financial table the ledger actually declares', () => {
  // A list that silently stopped covering a table would make the check above
  // pass for the wrong reason. Exact count, not a floor: a NEW financial table
  // has to be classified here deliberately.
  expect(NEVER_SWEPT.length).toBe(19);
  expect(new Set(NEVER_SWEPT).size).toBe(NEVER_SWEPT.length);
});
