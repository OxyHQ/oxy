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
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { StickerPack, StickerPackSummary } from '@oxy.so/contracts';

interface Options {
  folder: string;
  api: string;
  publish: boolean;
  dryRun: boolean;
  token: string;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let api = 'https://api.oxy.so';
  let publish = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--api') {
      api = argv[index + 1] ?? api;
      index += 1;
    } else if (arg === '--publish') {
      publish = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      positional.push(arg);
    }
  }
  const folder = positional[0];
  if (!folder) throw new Error('Usage: upload-sticker-packs.ts <folder> [--api URL] [--publish] [--dry-run]');
  const token = process.env.OXY_ACCESS_TOKEN ?? '';
  if (!token && !dryRun) throw new Error('OXY_ACCESS_TOKEN (a staff account session token) is required');
  return { folder, api: api.replace(/\/+$/, ''), publish, dryRun, token };
}

/**
 * Words in a file name → the emoji they stand for. Matched as substrings of
 * the lower-cased name, first match wins, so the more specific entries come
 * first (`thumbsup` before `up`, `heartbroken` before `heart`).
 */
const EMOJI_BY_WORD: [string, string][] = [
  ['rollover', '🙃'], ['surprise', '😮'], ['suprise', '😮'],
  ['thumbsup', '👍'], ['thumbs_up', '👍'], ['fistbump', '👊'], ['fist_bump', '👊'],
  ['fingerscrossed', '🤞'], ['peace', '✌️'], ['handsup', '🙌'], ['shrug', '🤷'],
  ['wave', '👋'], ['waving', '👋'], ['hello', '👋'], ['sup', '👋'],
  ['mindblown', '🤯'], ['mind_blown', '🤯'], ['lovestruck', '😍'], ['inlove', '😍'],
  ['loving', '🥰'], ['love', '❤️'], ['heart', '❤️'], ['kiss', '😘'], ['hug', '🤗'],
  ['imissyou', '🥺'], ['missyou', '🥺'], ['grateful', '🙏'],
  ['laugh', '😂'], ['lol', '😂'], ['giggl', '🤭'], ['teeth_smile', '😁'], ['smile', '😊'],
  ['sobbing', '😭'], ['crying', '😭'], ['cry', '😢'], ['sad', '😢'], ['grief', '😢'],
  ['hurting', '😣'], ['defeated', '😞'], ['sombre', '😔'], ['somber', '😔'],
  ['angry', '😠'], ['anger', '😠'], ['mad', '😡'], ['annoyed', '😒'], ['humph', '😤'],
  ['evil', '😈'], ['mischievous', '😈'], ['sneaky', '😏'], ['smug', '😏'], ['smirk', '😏'],
  ['wink', '😉'], ['cheeky', '😜'], ['silly', '😜'], ['zany', '🤪'], ['playful', '😜'],
  ['trolling', '😜'], ['rizz', '😏'], ['wolfish', '😏'],
  ['surprise', '😮'], ['suprise', '😮'], ['gasp', '😮'], ['ohhh', '😮'], ['omg', '😱'],
  ['shocked', '😱'], ['scared', '😱'], ['awe', '😮'], ['speechless', '😶'], ['empty_face', '😶'],
  ['nervous', '😬'], ['anxious', '😰'], ['stressed', '😫'], ['overwhelmed', '😵'],
  ['dizzy', '😵‍💫'], ['dissociating', '😶‍🌫️'], ['awkward', '😬'], ['oops', '😅'],
  ['embarrass', '😳'], ['embarass', '😳'], ['shy', '😊'],
  ['confused', '😕'], ['hmm', '🤔'], ['hm_', '🤔'], ['skeptical', '🤨'], ['suspicious', '🤨'],
  ['sus', '🤨'], ['judgemental', '🧐'], ['condescending', '🧐'], ['eyeroll', '🙄'],
  ['looking', '👀'], ['watching', '👀'], ['focused', '🧐'], ['nope', '🙅'],
  ['tired', '😴'], ['sleepy', '😴'], ['goodnight', '🌙'], ['chilling', '😌'], ['relaxed', '😌'],
  ['contented', '😌'], ['satisfied', '😌'], ['zen', '🧘'], ['cosy', '☕'], ['coffee', '☕'],
  ['siptea', '🍵'], ['bloated', '🤢'], ['hungry', '🤤'], ['hayfever', '🤧'],
  ['cool', '😎'], ['confident', '😎'], ['shining', '✨'], ['thriving', '💅'], ['winning', '🏆'],
  ['celebrat', '🎉'], ['party', '🥳'], ['letsparty', '🥳'], ['yay', '🥳'], ['excited', '🤩'],
  ['delighted', '😄'], ['inspired', '💡'], ['imyourfan', '🤩'],
  ['dance', '💃'], ['vibing', '🎶'], ['fire', '🔥'], ['omw', '🏃'], ['disappear', '🫥'],
  ['hiding', '🫣'], ['fakingit', '🙃'], ['everythingisoki', '🙃'], ['rollover', '🙃'],
  ['red_card', '🟥'], ['laptop', '💻'], ['croak', '🐸'], ['petals', '🌸'], ['squeezer', '🍋'],
  ['cute', '🥰'], ['catchingfeelings', '🥰'],
];

const DEFAULT_EMOJI = '🙂';

/** The words of a file name, without the export noise authoring tools add. */
function wordsOf(fileName: string): string[] {
  return fileName
    .replace(/\.json$/i, '')
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 1)
    .filter((word) => !/^(wa|lottie|json|export|opti|optimised|optimising|assemble|pc|vxx|xx|name|packname|stickernumber|stickername)$/i.test(word))
    .filter((word) => !/^v\d*$/i.test(word));
}

/**
 * The part of a file name that names the STICKER, not the pack: exports are
 * usually `<Prefix>_<Pack>_<NN>_<Name>`, and a pack called "Dance to the Beat"
 * would otherwise make every sticker in it 💃.
 */
function stickerName(fileName: string): string {
  const withoutPrefix = fileName.replace(/^WA_/i, '');
  const numbered = withoutPrefix.match(/^[A-Za-z]+_\d+[a-z]?_(.+)$/);
  return numbered ? numbered[1] : withoutPrefix;
}

function emojiFor(fileName: string): string {
  const lower = stickerName(fileName).toLowerCase();
  return EMOJI_BY_WORD.find(([word]) => lower.includes(word))?.[1] ?? DEFAULT_EMOJI;
}

function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
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

  const existing = options.dryRun ? new Map<string, StickerPackSummary>() : await existingPacks(options);

  for (const title of packFolders) {
    const folder = path.join(options.folder, title);
    const files = readdirSync(folder)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const slug = slugify(title);

    if (options.dryRun) {
      console.log(`${slug} (${files.length})`);
      for (const file of files) console.log(`  ${emojiFor(file)}  ${file}  [${wordsOf(file).join(', ')}]`);
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
    for (const file of files) {
      const form = new FormData();
      form.append('animation', new Blob([readFileSync(path.join(folder, file))], { type: 'application/json' }), file);
      form.append('emoji', emojiFor(file));
      form.append('keywords', wordsOf(file).join(','));
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
