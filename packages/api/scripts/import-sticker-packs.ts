#!/usr/bin/env bun
/**
 * Import sticker packs staged in the media bucket, from inside the API image.
 *
 * `upload-sticker-packs.ts` goes through the staff API and so needs a staff
 * person's session. This is the same import without one: it runs as a one-off
 * ECS task beside the API (the `seed-oxy-applications` mechanism), reads the
 * packs from a PRIVATE staging prefix of the media bucket, and calls the
 * sticker service directly — the same normalization, rendering and storage as
 * the staff route, with no route in between.
 *
 * Staging (from wherever the art lives; nothing enters the repository):
 *
 *   bun run packages/api/scripts/upload-sticker-packs.ts <folder> --manifest <folder>/manifest.json
 *   aws s3 cp --recursive <folder> s3://<media bucket>/staging/sticker-import/<run>/
 *
 * The prefix must be OUTSIDE `public/`, so the CDN can never serve the staged
 * copies; delete it once the import has run.
 *
 * Idempotent per pack, like the upload script: a pack whose slug exists with
 * as many stickers as the manifest lists is skipped; an incomplete DRAFT is
 * deleted and rebuilt; a published pack that differs is left alone and
 * reported.
 *
 * Env:
 *   STICKER_IMPORT_PREFIX  required — the staging key prefix, ending in `/`
 *   PUBLISH=1              publish each pack once its stickers are in
 *   DRY_RUN=1              plan only, no writes
 *   DATABASE_URL, S3 env   injected by ECS, as for the API itself
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { PUBLIC_KEY_PREFIX } from '../src/config/cdn';
import { stickerPacks, stickers } from '../src/db/schema/stickers';
import { s3Service } from '../src/services/s3ServiceSingleton';
import { addSticker, createPack, deleteDraftPack, publishPack } from '../src/services/stickers.service';
import type { StickerManifest } from './sticker-packs/names';

function flag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}

async function stickerCount(packId: string): Promise<number> {
  return (await getDb().select({ id: stickers.id }).from(stickers).where(eq(stickers.packId, packId))).length;
}

async function main(): Promise<void> {
  const prefix = process.env.STICKER_IMPORT_PREFIX ?? '';
  if (!prefix.endsWith('/') || prefix.startsWith('/')) {
    throw new Error('STICKER_IMPORT_PREFIX must be a relative key prefix ending in "/"');
  }
  if (prefix.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new Error(`STICKER_IMPORT_PREFIX must not be under "${PUBLIC_KEY_PREFIX}": staged art must not be CDN-reachable`);
  }
  const publish = flag('PUBLISH');
  const dryRun = flag('DRY_RUN');

  const manifest = JSON.parse((await s3Service.downloadBuffer(`${prefix}manifest.json`)).toString('utf8')) as StickerManifest;
  const total = manifest.packs.reduce((sum, pack) => sum + pack.stickers.length, 0);
  console.log(`manifest: ${manifest.packs.length} packs, ${total} stickers${dryRun ? ' (DRY_RUN)' : ''}`);

  await connectPostgres();
  let failed = 0;
  try {
    for (const pack of manifest.packs) {
      const [current] = await getDb().select().from(stickerPacks).where(eq(stickerPacks.slug, pack.slug)).limit(1);
      if (current) {
        const count = await stickerCount(current.id);
        if (count === pack.stickers.length) {
          console.log(`= ${pack.slug}: already has ${count} stickers (${current.status}), skipped`);
          if (publish && current.status === 'draft' && !dryRun) {
            await publishPack(current.id);
            console.log(`  published`);
          }
          continue;
        }
        if (current.status !== 'draft') {
          console.log(`! ${pack.slug}: ${current.status} with ${count} stickers but ${pack.stickers.length} in the manifest — left alone`);
          continue;
        }
        if (dryRun) {
          console.log(`- ${pack.slug}: incomplete draft would be rebuilt`);
          continue;
        }
        await deleteDraftPack(current.id);
        console.log(`- ${pack.slug}: incomplete draft deleted`);
      }

      if (dryRun) {
        console.log(`+ ${pack.slug}: would import ${pack.stickers.length} stickers`);
        continue;
      }

      const created = await createPack({ slug: pack.slug, title: pack.title });
      for (const sticker of pack.stickers) {
        const key = `${prefix}${pack.title}/${sticker.file}`;
        try {
          const added = await addSticker({
            packId: created.id,
            animation: await s3Service.downloadBuffer(key),
            emoji: [sticker.emoji],
            keywords: sticker.keywords,
          });
          console.log(`  ${sticker.emoji} ${sticker.file} → ${added.id}`);
        } catch (error) {
          failed += 1;
          console.log(`  ✗ ${sticker.file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const imported = await stickerCount(created.id);
      if (publish && imported === pack.stickers.length) {
        await publishPack(created.id);
      }
      console.log(
        `+ ${pack.slug}: ${imported}/${pack.stickers.length} stickers${publish && imported === pack.stickers.length ? ', published' : ' (draft)'}`
      );
    }
  } finally {
    await closePostgres();
  }

  if (failed > 0) {
    console.log(`${failed} sticker(s) failed; their packs stay drafts — fix and re-run`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
