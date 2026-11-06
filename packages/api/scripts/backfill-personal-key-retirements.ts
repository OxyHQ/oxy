/**
 * Backfill `personal_identity_key_retirements` from Oxy's own records
 * (security review R6-5). An OWNER step, run once against production after the
 * release that ships it:
 *
 *   bun run scripts/backfill-personal-key-retirements.ts            # dry run
 *   bun run scripts/backfill-personal-key-retirements.ts --apply    # writes
 *
 * A root a rotation replaced before migration 0235 has no history row, so
 * Commons cannot bind the key it keeps quarantined. This adds every key that
 * verified, self-issued `signed_records` prove was a personal account's root,
 * under the rules of `POST /identity/key-history/claim`
 * (`src/services/personalKeyEvidence.ts`). It prints COUNTS only — never a key,
 * an account id or a record. Idempotent.
 */
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { backfillPersonalKeyRetirements } from '../src/services/personalKeyEvidence';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectPostgres();
  try {
    const report = await backfillPersonalKeyRetirements(getDb(), { apply });
    console.log(JSON.stringify({ apply, ...report }));
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'backfill failed');
  process.exitCode = 1;
});
