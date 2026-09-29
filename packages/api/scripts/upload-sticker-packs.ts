#!/usr/bin/env bun
/**
 * Upload a folder of sticker packs to the catalogue, through the staff API.
 *
 * The layout is one sub-folder per pack, named as the pack should be titled,
 * holding its Lottie `.json` files:
 *
 *   STICKERS/
 *     Astro Vibes/
 *       01_Waving.json
 *       02_Heart.json
 *     Cat Duo/
 *       ...
 *
 * Stickers are added in file-name order. Each one needs at least one emoji,
 * which is guessed from the words in its file name (`Waving` → 👋) with 🙂 when
 * nothing matches; the words themselves become its search keywords. The API
 * normalizes every animation and renders its fallback image, so the files go
 * up exactly as exported.
 *
 * The art never enters this repository: the script reads it from wherever it
 * sits on disk and sends it straight to the API.
 *
 * ## Idempotent per pack
 *
 * A pack whose slug already exists with as many stickers as its folder has
 * files is skipped. A DRAFT that is incomplete (an earlier run was
 * interrupted) is deleted and rebuilt. A published pack that differs is left
 * alone and reported — its stickers may already be in people's messages.
 *
 * Run:
 *   OXY_ACCESS_TOKEN=<staff session token> \
 *     bun run packages/api/scripts/upload-sticker-packs.ts <folder> [--api https://api.oxy.so] [--publish] [--dry-run]
 *
 * Or, with no staff session at hand, write the manifest `import-sticker-packs.ts`
 * reads inside the API image, and stage the folder beside it:
 *   bun run packages/api/scripts/upload-sticker-packs.ts <folder> --manifest <folder>/manifest.json
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StickerPack, StickerPackSummary } from '@oxy.so/contracts';
import { manifestPack, type StickerManifest } from './lib/stickerNames';

interface Options {
  folder: string;
  api: string;
  publish: boolean;
  dryRun: boolean;
  /** Write the import manifest here instead of uploading (`import-sticker-packs.ts` reads it). */
  manifest: string | null;
  token: string;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let api = 'https://api.oxy.so';
  let publish = false;
  let dryRun = false;
  let manifest: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--api') {
      api = argv[index + 1] ?? api;
      index += 1;
    } else if (arg === '--publish') {
      publish = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--manifest') {
      manifest = argv[index + 1] ?? null;
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  const folder = positional[0];
  if (!folder) throw new Error('Usage: upload-sticker-packs.ts <folder> [--api URL] [--publish] [--dry-run]');
  const token = process.env.OXY_ACCESS_TOKEN ?? '';
  if (!token && !dryRun && !manifest) throw new Error('OXY_ACCESS_TOKEN (a staff account session token) is required');
  return { folder, api: api.replace(/\/+$/, ''), publish, dryRun, manifest, token };
}

async function request<T>(options: Options, method: string, pathname: string, body?: BodyInit, json?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${options.api}${pathname}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as { data?: T; message?: string };
  if (!response.ok) {
    throw new Error(`${method} ${pathname} → ${response.status}: ${payload.message ?? JSON.stringify(payload)}`);
  }
  return payload.data as T;
}

async function existingPacks(options: Options): Promise<Map<string, StickerPackSummary>> {
  const bySlug = new Map<string, StickerPackSummary>();
  for (let offset = 0; ; offset += 100) {
    const page = await request<StickerPackSummary[]>(options, 'GET', `/stickers/admin/packs?limit=100&offset=${offset}`);
    for (const pack of page) bySlug.set(pack.slug, pack);
    if (page.length < 100) return bySlug;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const packFolders = readdirSync(options.folder)
    .filter((name) => statSync(path.join(options.folder, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b));

  const packs = packFolders.map((title) =>
    manifestPack(
      title,
      readdirSync(path.join(options.folder, title)).filter((name) => name.toLowerCase().endsWith('.json'))
    )
  );

  if (options.manifest) {
    const manifest: StickerManifest = { packs };
    writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`manifest: ${packs.length} packs, ${packs.reduce((n, p) => n + p.stickers.length, 0)} stickers → ${options.manifest}`);
    return;
  }

  const existing = options.dryRun ? new Map<string, StickerPackSummary>() : await existingPacks(options);

  for (const { title, slug, stickers } of packs) {
    const folder = path.join(options.folder, title);
    const files = stickers.map((sticker) => sticker.file);

    if (options.dryRun) {
      console.log(`${slug} (${files.length})`);
      for (const sticker of stickers) console.log(`  ${sticker.emoji}  ${sticker.file}  [${sticker.keywords.join(', ')}]`);
      continue;
    }

    const current = existing.get(slug);
    if (current && current.stickerCount === files.length) {
      console.log(`= ${slug}: already has ${files.length} stickers, skipped`);
      continue;
    }
    if (current && current.status !== 'draft') {
      console.log(`! ${slug}: ${current.status} with ${current.stickerCount} stickers but ${files.length} files — left alone`);
      continue;
    }
    if (current) {
      await request(options, 'DELETE', `/stickers/admin/packs/${current.id}`);
      console.log(`- ${slug}: incomplete draft deleted`);
    }

    const pack = await request<StickerPack>(options, 'POST', '/stickers/admin/packs', undefined, { slug, title });
    for (const { file, emoji, keywords } of stickers) {
      const form = new FormData();
      form.append('animation', new Blob([readFileSync(path.join(folder, file))], { type: 'application/json' }), file);
      form.append('emoji', emoji);
      form.append('keywords', keywords.join(','));
      await request(options, 'POST', `/stickers/admin/packs/${pack.id}/stickers`, form);
      process.stdout.write('.');
    }
    if (options.publish) await request(options, 'POST', `/stickers/admin/packs/${pack.id}/publish`);
    console.log(`\n+ ${slug}: ${files.length} stickers${options.publish ? ', published' : ' (draft)'}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
