#!/usr/bin/env bun
/**
 * Make Oxy's published plans exist as Orbit catalog rows (ADR 0046 as built):
 *
 *   OXY_PEABLE_BILLING_AWS_PROFILE=<billing profile> \
 *   BILLING_PRODUCT_CATALOGUE_FILE=<reviewed catalogue.json> \
 *   bun scripts/sync-peable-catalogue.ts --merchant merch_… --application <app id> \
 *     --mode live --environment production [--apply]
 *
 * Without `--apply` it only reads and prints the plan. It never enables a
 * purchase: the output is the `prices[]` binding for the reviewed catalogue and
 * the `offers[]` for the personal-plan runtime file, both of which ship through
 * their own reviewed deployment change. The workload must be the billing
 * merchant's (the merchant readback refuses any other).
 */
import { parseArgs } from 'node:util';
import { billingNamespaceSchema } from '../src/config/billingNamespace';
import {
  assertPeableBillingWorkloadConfiguration,
  createPeableBillingClient,
} from '../src/services/peableBillingWorkload.service';
import { syncPeableCatalogue } from '../src/services/peableCatalogueSync.service';
import { loadProductBillingCatalogue } from '../src/services/productBillingCatalogue.service';

const { values } = parseArgs({
  options: {
    merchant: { type: 'string' },
    application: { type: 'string' },
    mode: { type: 'string' },
    environment: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
  strict: true,
});
const merchantId = values.merchant ?? '';
const applicationId = values.application ?? '';
if (!merchantId.startsWith('merch_') || !applicationId)
  throw new Error('--merchant merch_… and --application are required');
if (!process.env.BILLING_PRODUCT_CATALOGUE_FILE)
  throw new Error('BILLING_PRODUCT_CATALOGUE_FILE must name the reviewed catalogue');
async function main() {
  const namespace = billingNamespaceSchema.parse({
    mode: values.mode,
    environment: values.environment,
  });
  assertPeableBillingWorkloadConfiguration();
  const catalogue = await loadProductBillingCatalogue();
  const owned = createPeableBillingClient();
  try {
    const result = await syncPeableCatalogue(
      owned.client,
      catalogue,
      { merchantId, applicationId, namespace },
      { apply: values.apply },
    );
    console.log(JSON.stringify({ apply: values.apply, ...result }, null, 2));
  } finally {
    owned.dispose();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
