/**
 * Deploy the new welcome renderer BEFORE applying this one-time cutover, so
 * running API instances cannot create more legacy messages afterwards.
 *
 * From packages/api, with DATABASE_URL set to the intended database:
 *   bun scripts/backfill-welcome-emails.ts          # counts only; no writes
 *   bun scripts/backfill-welcome-emails.ts --apply  # atomic replacement
 *   bun scripts/backfill-welcome-emails.ts          # must report zero candidates
 *
 * Does not send mail or emit new-message notifications. Open Inbox clients see
 * updated content on refetch/reload. Logs contain counts, never message bodies.
 */
import { closePostgres, connectPostgres } from '../src/config/postgres';
import { backfillWelcomeEmails, WelcomeBackfillError } from '../src/scripts/backfillWelcomeEmails';

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply') || args.length > 1) {
    throw new WelcomeBackfillError('Usage: bun scripts/backfill-welcome-emails.ts [--apply]');
  }
  const apply = args.includes('--apply');
  try {
    const db = await connectPostgres();
    const result = await backfillWelcomeEmails(db, apply);
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }));
    if (result.unrecognised) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

main().catch((error) => {
  // Drizzle errors can include bound parameters containing the email bodies.
  console.error(
    error instanceof WelcomeBackfillError
      ? error.message
      : 'Welcome backfill failed. Check database access and schema, then rerun the dry-run.',
  );
  process.exitCode = 1;
});
