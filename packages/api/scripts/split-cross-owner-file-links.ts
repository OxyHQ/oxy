/**
 * Split cross-owner file shares left by the one-live-row-per-hash model.
 * Mechanism and reasoning: `src/services/fileOwnerSplit.service.ts`; rollout:
 * `docs/engineering/per-owner-asset-rows.md`.
 *
 *   bun run packages/api/scripts/split-cross-owner-file-links.ts                      # report (dry run)
 *   bun run packages/api/scripts/split-cross-owner-file-links.ts --apply=create-rows  # additive
 *   bun run packages/api/scripts/split-cross-owner-file-links.ts --apply=repoint-links --app=<name>
 *
 * Options: `--batch-size=<n>` (default 200, max 1000), `--after=<file_links.id>`
 * to resume, `--max-batches=<n>` for a bounded run, `--app=<name>` to limit to
 * one application. Prints one JSON line per (file, linking account) pair and a
 * final `{"summary": …}` line whose `lastLinkId` resumes an unfinished run.
 * Nothing is written without `--apply`.
 */
import 'dotenv/config';
import { closePostgres, connectPostgres } from '../src/config/postgres';
import {
  countCrossOwnerMessageAttachments,
  runFileOwnerSplit,
  type FileOwnerSplitMode,
} from '../src/services/fileOwnerSplit.service';

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

function mode(): FileOwnerSplitMode {
  const apply = flag('apply');
  if (apply === undefined) {
    if (process.argv.includes('--apply'))
      throw new Error('--apply needs a value: create-rows or repoint-links');
    return 'report';
  }
  if (apply === 'create-rows' || apply === 'repoint-links') return apply;
  throw new Error(`Unknown --apply=${apply}; expected create-rows or repoint-links`);
}

async function main(): Promise<void> {
  const selected = mode();
  const batchSize = positiveInt('batch-size', 200, 1000) ?? 200;
  const maxBatches = positiveInt('max-batches', undefined, 1_000_000);
  await connectPostgres();
  try {
    const summary = await runFileOwnerSplit({
      mode: selected,
      batchSize,
      after: flag('after'),
      app: flag('app'),
      maxBatches,
      emit: (record) => console.log(JSON.stringify(record)),
    });
    const crossOwnerMessageAttachments =
      selected === 'report' ? await countCrossOwnerMessageAttachments() : undefined;
    console.log(JSON.stringify({ summary: { ...summary, crossOwnerMessageAttachments } }));
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
