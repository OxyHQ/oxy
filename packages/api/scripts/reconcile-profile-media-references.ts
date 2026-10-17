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
 * resume, `--max-batches=<n>` for a bounded run, `--sample=<n>` to print only
 * the first n account records (the summary still counts every account). Prints
 * one JSON line per account that needs (or, with `--apply`, got) a change, a
 * `{"progress": …}` line every 25 batches, and a final `{"summary": …}` whose
 * `lastUserId` resumes an unfinished run — as does the last progress line's,
 * should the run die. Nothing is written without `--apply`; a second `--apply`
 * run changes nothing.
 *
 * In production it runs inside the VPC as an ECS one-shot:
 * `.github/workflows/reconcile-profile-media-references.yml`.
 */
import { closePostgres, connectPostgres } from '../src/config/postgres';
import { runProfileMediaReconciliation } from '../src/services/profileMediaReferences.service';

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function boundedInt(
  name: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** A progress line every this many batches. */
const PROGRESS_EVERY_BATCHES = 25;

const KNOWN_ARGUMENT = /^--(apply|(batch-size|after|max-batches|sample)=.*)$/;

async function main(): Promise<void> {
  // A misspelled option would otherwise be ignored, and a bounded run unbounded.
  const unknown = process.argv.slice(2).filter((value) => !KNOWN_ARGUMENT.test(value));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}`);
  if (flag('apply') !== undefined) throw new Error('--apply takes no value');
  const apply = process.argv.includes('--apply');
  const batchSize = boundedInt('batch-size', 200, 1, 1000) ?? 200;
  const maxBatches = boundedInt('max-batches', undefined, 1, 1_000_000);
  const sample = boundedInt('sample', undefined, 0, 1_000_000);
  let printed = 0;
  await connectPostgres();
  try {
    const summary = await runProfileMediaReconciliation({
      apply,
      batchSize,
      after: flag('after'),
      maxBatches,
      emit: (record) => {
        if (sample !== undefined && printed >= sample) return;
        printed += 1;
        console.log(JSON.stringify(record));
      },
      progress: (totals) => {
        if (totals.batches % PROGRESS_EVERY_BATCHES === 0) {
          console.log(JSON.stringify({ progress: totals }));
        }
      },
    });
    console.log(JSON.stringify({ summary }));
  } finally {
    await closePostgres();
  }
}

// Exit once stdout and stderr are flushed: as an ECS one-shot, a handle left
// open by an imported module would otherwise keep the task running.
void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .then(async () => {
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
      ),
    );
    process.exit(process.exitCode ?? 0);
  });
