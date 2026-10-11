#!/usr/bin/env bun
/** Plan file contains review metadata only. No bearer or provider credential is accepted. */
import { readFileSync } from 'node:fs';
import { connectPostgres, closePostgres } from '../config/postgres';
import { executeScopedLegalReview } from '../services/scopedLegalReviewOperation.service';

export async function recordScopedLegalReviewMain(args = process.argv.slice(2)) {
  const apply = args.length === 3 && args[1] === '--apply';
  if (!(args.length === 1 || apply))
    throw new Error('Usage: record-scoped-legal-review <plan.json> [--apply <plan-sha256>]');
  const plan = JSON.parse(readFileSync(args[0], 'utf8')) as unknown;
  await connectPostgres();
  try {
    const receipt = await executeScopedLegalReview(plan, {
      apply,
      expectedPlanSha256: apply ? args[2] : undefined,
    });
    console.log(JSON.stringify(receipt));
  } finally {
    await closePostgres();
  }
}
if (require.main === module)
  recordScopedLegalReviewMain().catch(() => {
    console.error(
      'Scoped legal review failed; reconcile the exact plan and audit before retrying an apply.',
    );
    process.exitCode = 1;
  });
