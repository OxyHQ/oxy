import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asc, eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { linkPreviews } from '../src/db/schema';
import { serializeResolvedLinkPreviews } from '../src/services/linkPreview/linkPreviewExport';

async function main(): Promise<void> {
  const outputArgument = process.argv[2];
  if (!outputArgument) throw new Error('Usage: bun export:clarity-link-previews <output.ndjson>');

  await connectPostgres();
  const rows = await getDb().select({
    id: linkPreviews.id,
    requestedUrl: linkPreviews.requestedUrl,
    canonicalUrl: linkPreviews.canonicalUrl,
    title: linkPreviews.title,
    description: linkPreviews.description,
    siteName: linkPreviews.siteName,
    favicon: linkPreviews.favicon,
    imageUrl: linkPreviews.imageUrl,
    version: linkPreviews.version,
    resolvedAt: linkPreviews.resolvedAt,
    createdAt: linkPreviews.createdAt,
    updatedAt: linkPreviews.updatedAt,
  }).from(linkPreviews).where(eq(linkPreviews.status, 'resolved')).orderBy(asc(linkPreviews.id));

  const outputPath = resolve(outputArgument);
  await writeFile(outputPath, serializeResolvedLinkPreviews(rows), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(`Exported ${rows.length} resolved link previews to ${outputPath}.\n`);
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`Export failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closePostgres);
