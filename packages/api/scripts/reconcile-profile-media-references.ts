/**
 * Back-fill and repair the Oxy Accounts `avatar` references (ADR 0043 D4,
 * stage 4b). Mechanism: `src/services/profileMediaReferences.service.ts`.
 *
 *   bun run packages/api/scripts/reconcile-profile-media-references.ts           # report (dry run)
 *   bun run packages/api/scripts/reconcile-profile-media-references.ts --apply   # write
 *
 * For every account with an avatar or an Oxy Accounts `avatar` reference: the
 * avatar file, when it is the account's own, gains the reference (created by
 * the account, as `PUT /users/me` writes it); every other `avatar` reference
 * of that account goes — the file is then *not in use* for its person, never
 * trashed. References naming an account that no longer exists go too.
 *
 * Options: `--batch-size=<n>` (default 200, max 1000), `--after=<user id>` to
 * resume, `--max-batches=<n>` for a bounded run. Prints one JSON line per
 * account that needs (or, with `--apply`, got) a change and a final
 * `{"summary": …}` whose `lastUserId` resumes an unfinished run. Nothing is
 * written without `--apply`; a second `--apply` run changes nothing.
 */
import { closePostgres, connectPostgres } from '../src/config/postgres';
import { runProfileMediaReconciliation } from '../src/services/profileMediaReferences.service';

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(name: string, fallback: number | undefined, max: number): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`--${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

async function main(): Promise<void> {
  if (flag('apply') !== undefined) throw new Error('--apply takes no value');
  const apply = process.argv.includes('--apply');
  const batchSize = positiveInt('batch-size', 200, 1000) ?? 200;
  const maxBatches = positiveInt('max-batches', undefined, 1_000_000);
  await connectPostgres();
  try {
    const summary = await runProfileMediaReconciliation({
      apply,
      batchSize,
      after: flag('after'),
      maxBatches,
      emit: (record) => console.log(JSON.stringify(record)),
    });
    console.log(JSON.stringify({ summary }));
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
