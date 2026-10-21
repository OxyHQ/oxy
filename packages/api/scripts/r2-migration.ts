/**
 * Verify and finish the copy of an S3 bucket into R2 (ADR 0047; oxy-infra
 * docs/runbooks/61-r2-object-storage.md). Run from an operator's machine: every
 * byte it reads comes out of R2 (no egress charge) and S3 is only LISTED and
 * HEADed, so nothing it does crosses an AWS NAT.
 *
 *   bun scripts/r2-migration.ts compare  --s3 <bucket> --r2 <bucket> --out <dir> [--prefix <p>]
 *   bun scripts/r2-migration.ts repair-metadata --s3 <bucket> --r2 <bucket> --out <dir> [--apply]
 *   bun scripts/r2-migration.ts verify-sha256 --r2 <bucket> --out <dir> --sample <n> [--files-db]
 *   bun scripts/r2-migration.ts remove-extra --r2 <bucket> --out <dir> --before <ISO time> [--apply]
 *   bun scripts/r2-migration.ts copy-missing --s3 <bucket> --r2 <bucket> --out <dir> [--apply]
 *   bun scripts/r2-migration.ts replay-deletions --s3 <bucket> --r2 <bucket> --out <dir> --since <ISO> --until <ISO> [--apply]
 *
 * S3 is read through the default chain (AWS_PROFILE=oxy); R2 with
 * R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (the migration token,
 * SSM /oxy/r2-migration/*). `--files-db` reads `files` through DATABASE_URL.
 *
 * `compare` lists both buckets shard by shard (the key space is cut at four
 * `/` levels, `content/2026/10/ab/`) and writes, under --out:
 *   summary.json     counts and bytes per top-level prefix, both sides, and
 *                    every class of difference
 *   missing.ndjson   in S3, not in R2
 *   extra.ndjson     in R2, not in S3 (with R2's LastModified)
 *   mismatch.ndjson  in both with a different size, or different single-part ETags
 *   multipart.ndjson in both, an ETag of either side multipart: bytes not proven
 *                    by the listing, metadata possibly dropped by Super Slurper
 * Single-part ETags are the MD5 of the bytes on both stores, so an equal pair
 * proves the copy; the multipart rest is proven by `verify-sha256`.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

type Listed = { key: string; size: number; etag: string; lastModified: string };

const args = process.argv.slice(2);
const command = args[0];
function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}
const has = (name: string) => args.includes(`--${name}`);
function required(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const CONCURRENCY = Number(flag('concurrency') ?? 32);
const SHARD_DEPTH = Number(flag('depth') ?? 4);

function s3Client(): S3Client {
  return new S3Client({
    // The default chain: AWS_PROFILE=oxy on an operator's machine.
    region: process.env.AWS_REGION || 'us-west-2',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 8,
  });
}

function r2Client(): S3Client {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
  }
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 8,
  });
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

function toListed(item: _Object): Listed {
  return {
    key: item.Key ?? '',
    size: Number(item.Size ?? 0),
    etag: (item.ETag ?? '').replaceAll('"', ''),
    lastModified: item.LastModified?.toISOString() ?? '',
  };
}

/** Every object under `prefix`; with `delimited`, only the direct ones plus the next level's prefixes. */
async function list(
  client: S3Client,
  bucket: string,
  prefix: string,
  delimited: boolean,
): Promise<{ objects: Listed[]; prefixes: string[] }> {
  const objects: Listed[] = [];
  const prefixes: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        ...(delimited ? { Delimiter: '/' } : {}),
      }),
    );
    for (const item of page.Contents ?? []) objects.push(toListed(item));
    for (const common of page.CommonPrefixes ?? []) if (common.Prefix) prefixes.push(common.Prefix);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { objects, prefixes };
}

/** A shard: either every object under a prefix, or only the objects directly at it. */
type Shard = { prefix: string; direct: boolean };

async function discoverShards(client: S3Client, bucket: string): Promise<Shard[]> {
  const shards: Shard[] = [];
  // `--prefix` limits the comparison to one subtree (the website's legacy images).
  let level: string[] = [flag('prefix') ?? ''];
  for (let depth = 0; depth < SHARD_DEPTH && level.length > 0; depth += 1) {
    const nextLevel: string[] = [];
    await pool(level, CONCURRENCY, async (prefix) => {
      const { prefixes } = await list(client, bucket, prefix, true);
      shards.push({ prefix, direct: true });
      nextLevel.push(...prefixes);
    });
    level = nextLevel;
    process.stderr.write(`shard discovery: depth ${depth + 1}, ${level.length} prefixes\n`);
  }
  for (const prefix of level) shards.push({ prefix, direct: false });
  return shards;
}

async function listShard(client: S3Client, bucket: string, shard: Shard): Promise<Listed[]> {
  const { objects } = await list(client, bucket, shard.prefix, shard.direct);
  return objects;
}

function topPrefix(key: string): string {
  const slash = key.indexOf('/');
  const first = slash === -1 ? '(root)' : key.slice(0, slash + 1);
  if (first === 'public/') {
    const second = key.indexOf('/', slash + 1);
    return second === -1 ? first : key.slice(0, second + 1);
  }
  return first;
}

const isMultipart = (etag: string) => etag.includes('-');

async function compare(): Promise<void> {
  const s3Bucket = required('s3');
  const r2Bucket = required('r2');
  const out = required('out');
  mkdirSync(out, { recursive: true });
  const s3 = s3Client();
  const r2 = r2Client();
  const open = (name: string) => createWriteStream(`${out}/${name}.ndjson`);
  const streams = {
    missing: open('missing'),
    extra: open('extra'),
    mismatch: open('mismatch'),
    multipart: open('multipart'),
  };
  type Side = { objects: number; bytes: number };
  const byPrefix: Record<string, { s3: Side; r2: Side }> = {};
  const totals = { s3: { objects: 0, bytes: 0 }, r2: { objects: 0, bytes: 0 } };
  const counts = {
    missing: 0,
    missingBytes: 0,
    extra: 0,
    extraBytes: 0,
    mismatch: 0,
    multipart: 0,
    md5Equal: 0,
    md5EqualBytes: 0,
  };
  const tally = (side: 's3' | 'r2', item: Listed) => {
    const top = topPrefix(item.key);
    byPrefix[top] ??= { s3: { objects: 0, bytes: 0 }, r2: { objects: 0, bytes: 0 } };
    byPrefix[top][side].objects += 1;
    byPrefix[top][side].bytes += item.size;
    totals[side].objects += 1;
    totals[side].bytes += item.size;
  };

  const startedAt = new Date().toISOString();
  const shards = await discoverShards(s3, s3Bucket);
  process.stderr.write(`${shards.length} shards\n`);
  let done = 0;
  await pool(shards, CONCURRENCY, async (shard) => {
    const [left, right] = await Promise.all([
      listShard(s3, s3Bucket, shard),
      listShard(r2, r2Bucket, shard),
    ]);
    const inR2 = new Map(right.map((item) => [item.key, item]));
    for (const item of left) {
      tally('s3', item);
      const other = inR2.get(item.key);
      if (!other) {
        counts.missing += 1;
        counts.missingBytes += item.size;
        streams.missing.write(`${JSON.stringify(item)}\n`);
        continue;
      }
      inR2.delete(item.key);
      if (
        other.size !== item.size ||
        (!isMultipart(item.etag) && !isMultipart(other.etag) && item.etag !== other.etag)
      ) {
        counts.mismatch += 1;
        streams.mismatch.write(`${JSON.stringify({ key: item.key, s3: item, r2: other })}\n`);
      } else if (isMultipart(item.etag) || isMultipart(other.etag)) {
        counts.multipart += 1;
        streams.multipart.write(
          `${JSON.stringify({ key: item.key, size: item.size, s3: item.etag, r2: other.etag })}\n`,
        );
      } else {
        counts.md5Equal += 1;
        counts.md5EqualBytes += item.size;
      }
    }
    for (const item of right) tally('r2', item);
    for (const item of inR2.values()) {
      counts.extra += 1;
      counts.extraBytes += item.size;
      streams.extra.write(`${JSON.stringify(item)}\n`);
    }
    done += 1;
    if (done % 500 === 0)
      process.stderr.write(`${done}/${shards.length} shards, s3 ${totals.s3.objects} objects\n`);
  });
  await Promise.all(
    Object.values(streams).map(
      (stream) => new Promise<void>((resolve) => stream.end(() => resolve())),
    ),
  );
  const summary = {
    s3Bucket,
    r2Bucket,
    startedAt,
    finishedAt: new Date().toISOString(),
    shards: shards.length,
    totals,
    counts,
    byPrefix,
  };
  writeFileSync(`${out}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ totals, counts }, null, 2));
}

async function* readNdjson<T>(path: string): AsyncGenerator<T> {
  if (!existsSync(path)) return;
  for await (const line of createInterface({ input: createReadStream(path) }))
    if (line) yield JSON.parse(line) as T;
}

/** HTTP metadata that Super Slurper drops on a multipart copy, restored from S3. */
async function repairMetadata(): Promise<void> {
  const s3Bucket = required('s3');
  const r2Bucket = required('r2');
  const out = required('out');
  const apply = has('apply');
  const s3 = s3Client();
  const r2 = r2Client();
  const keys: string[] = [];
  for await (const row of readNdjson<{ key: string }>(`${out}/multipart.ndjson`))
    keys.push(row.key);
  const report = createWriteStream(`${out}/repair-metadata${apply ? '' : '.preview'}.ndjson`);
  const counts = { checked: 0, correct: 0, repaired: 0, wouldRepair: 0, failed: 0 };
  await pool(keys, Math.min(CONCURRENCY, 16), async (key) => {
    try {
      const [source, copy] = await Promise.all([
        s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: key })),
        r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key })),
      ]);
      counts.checked += 1;
      const want = {
        ContentType: source.ContentType,
        CacheControl: source.CacheControl,
        ContentDisposition: source.ContentDisposition,
        ContentEncoding: source.ContentEncoding,
        ContentLanguage: source.ContentLanguage,
      };
      const same =
        copy.ContentType === want.ContentType &&
        copy.CacheControl === want.CacheControl &&
        copy.ContentDisposition === want.ContentDisposition &&
        copy.ContentEncoding === want.ContentEncoding &&
        JSON.stringify(copy.Metadata ?? {}) === JSON.stringify(source.Metadata ?? {});
      if (same) {
        counts.correct += 1;
        return;
      }
      const entry = {
        key,
        size: copy.ContentLength,
        had: { ContentType: copy.ContentType, CacheControl: copy.CacheControl },
        want,
      };
      if (!apply) {
        counts.wouldRepair += 1;
        report.write(`${JSON.stringify(entry)}\n`);
        return;
      }
      if (Number(copy.ContentLength ?? 0) <= 5 * 1024 ** 3) {
        await r2.send(
          new CopyObjectCommand({
            Bucket: r2Bucket,
            Key: key,
            CopySource: `${r2Bucket}/${encodeURIComponent(key).replaceAll('%2F', '/')}`,
            MetadataDirective: 'REPLACE',
            ...want,
            Metadata: source.Metadata,
          }),
        );
      } else {
        // Over a single copy's ceiling: stream the object onto itself, from R2.
        const body = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
        await new Upload({
          client: r2,
          partSize: 512 * 1024 ** 2,
          params: {
            Bucket: r2Bucket,
            Key: key,
            Body: body.Body as Readable,
            ...want,
            Metadata: source.Metadata,
          },
        }).done();
      }
      counts.repaired += 1;
      report.write(`${JSON.stringify(entry)}\n`);
    } catch (error) {
      counts.failed += 1;
      report.write(`${JSON.stringify({ key, error: String(error) })}\n`);
    }
  });
  await new Promise<void>((resolve) => report.end(() => resolve()));
  console.log(JSON.stringify({ apply, keys: keys.length, ...counts }));
}

/** The sha256 a content-addressed key names: `.../<64 hex>.<ext>`. */
function sha256OfKey(key: string): string | null {
  const match = /\/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/.exec(key);
  return match ? (match[1] as string) : null;
}

async function verifySha256(): Promise<void> {
  const r2Bucket = required('r2');
  const out = required('out');
  const sample = Number(required('sample'));
  const r2 = r2Client();
  // Every multipart object whose key names its hash, plus a uniform sample of
  // the single-part ones (whose MD5 the listing already proved).
  const multipart: string[] = [];
  for await (const row of readNdjson<{ key: string }>(`${out}/multipart.ndjson`))
    if (sha256OfKey(row.key)) multipart.push(row.key);
  const shuffled = (items: string[]) =>
    items
      .map((key) => [Math.random(), key] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, key]) => key);
  const chosen = shuffled(multipart).slice(0, Math.ceil(sample / 2));
  const shardKeys = (flag('sample-prefixes') ?? 'public/content/,content/').split(',');
  const pool2: string[] = [];
  for (const prefix of shardKeys) {
    // A random month and shard per draw, so the sample spans the whole history.
    const { prefixes: years } = await list(r2, r2Bucket, prefix, true);
    for (let draw = 0; draw < sample; draw += 1) {
      const year = years[Math.floor(Math.random() * years.length)];
      if (!year) break;
      const { prefixes: months } = await list(r2, r2Bucket, year, true);
      const month = months[Math.floor(Math.random() * months.length)];
      if (!month) continue;
      const { prefixes: shards } = await list(r2, r2Bucket, month, true);
      const shard = shards[Math.floor(Math.random() * shards.length)];
      if (!shard) continue;
      const page = await r2.send(
        new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: shard, MaxKeys: 50 }),
      );
      const items = (page.Contents ?? [])
        .map((item) => item.Key ?? '')
        .filter((key) => sha256OfKey(key));
      const pick = items[Math.floor(Math.random() * items.length)];
      if (pick) pool2.push(pick);
      if (pool2.length >= sample) break;
    }
  }
  chosen.push(...pool2.slice(0, sample - chosen.length));

  const counts = {
    checked: 0,
    match: 0,
    mismatch: 0,
    failed: 0,
    bytes: 0,
    dbChecked: 0,
    dbMatch: 0,
    dbMismatch: 0,
  };
  const report = createWriteStream(`${out}/verify-sha256.ndjson`);
  const dbSha = new Map<string, string>();
  if (has('files-db')) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.DATABASE_URL ?? '', { max: 2 });
    const rows = await sql<
      { storage_key: string; sha256: string }[]
    >`select storage_key, sha256 from files where storage_key = any(${chosen})`;
    for (const row of rows) dbSha.set(row.storage_key, row.sha256);
    await sql.end();
  }
  await pool(chosen, 8, async (key) => {
    try {
      const object = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of object.Body as Readable) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
      }
      const digest = hash.digest('hex');
      const expected = sha256OfKey(key);
      counts.checked += 1;
      counts.bytes += bytes;
      const ok = digest === expected;
      if (ok) counts.match += 1;
      else counts.mismatch += 1;
      const recorded = dbSha.get(key);
      if (recorded !== undefined) {
        counts.dbChecked += 1;
        if (recorded === digest) counts.dbMatch += 1;
        else counts.dbMismatch += 1;
      }
      report.write(
        `${JSON.stringify({ key, bytes, ok, db: recorded === undefined ? null : recorded === digest })}\n`,
      );
    } catch (error) {
      counts.failed += 1;
      report.write(`${JSON.stringify({ key, error: String(error) })}\n`);
    }
  });
  await new Promise<void>((resolve) => report.end(() => resolve()));
  console.log(
    JSON.stringify({
      sample: chosen.length,
      multipartInSample: Math.min(multipart.length, Math.ceil(sample / 2)),
      ...counts,
    }),
  );
}

/**
 * Delete R2 objects S3 no longer has, copied before `--before`: objects deleted
 * from S3 after Super Slurper or Sippy copied them. An object created in R2
 * after the cutover is newer than `--before` and is never touched.
 */
async function removeExtra(): Promise<void> {
  const r2Bucket = required('r2');
  const out = required('out');
  const before = new Date(required('before'));
  if (Number.isNaN(before.getTime())) throw new Error('--before must be an ISO time');
  const apply = has('apply');
  const r2 = r2Client();
  const targets: Listed[] = [];
  for await (const row of readNdjson<Listed>(`${out}/extra.ndjson`))
    if (new Date(row.lastModified) < before) targets.push(row);
  const report = createWriteStream(`${out}/remove-extra${apply ? '' : '.preview'}.ndjson`);
  let removed = 0;
  await pool(targets, 16, async (item) => {
    if (apply) await r2.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: item.key }));
    removed += 1;
    report.write(`${JSON.stringify(item)}\n`);
  });
  await new Promise<void>((resolve) => report.end(() => resolve()));
  console.log(
    JSON.stringify({
      apply,
      before: before.toISOString(),
      candidates: targets.length,
      removed: apply ? removed : 0,
    }),
  );
}

/** Copy what `compare` found missing, S3 → R2, through this machine. */
async function copyMissing(): Promise<void> {
  const s3Bucket = required('s3');
  const r2Bucket = required('r2');
  const out = required('out');
  const apply = has('apply');
  const s3 = s3Client();
  const r2 = r2Client();
  const missing: Listed[] = [];
  for await (const row of readNdjson<Listed>(`${out}/missing.ndjson`)) missing.push(row);
  const counts = { candidates: missing.length, copied: 0, gone: 0, failed: 0, bytes: 0 };
  const report = createWriteStream(`${out}/copy-missing${apply ? '' : '.preview'}.ndjson`);
  await pool(missing, 8, async (item) => {
    if (!apply) return;
    try {
      const source = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: item.key }));
      await new Upload({
        client: r2,
        params: {
          Bucket: r2Bucket,
          Key: item.key,
          Body: source.Body as Readable,
          ContentType: source.ContentType,
          CacheControl: source.CacheControl,
          ContentDisposition: source.ContentDisposition,
          ContentEncoding: source.ContentEncoding,
          Metadata: source.Metadata,
        },
      }).done();
      counts.copied += 1;
      counts.bytes += item.size;
      report.write(`${JSON.stringify({ key: item.key, copied: true })}\n`);
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchKey') counts.gone += 1;
      else counts.failed += 1;
      report.write(`${JSON.stringify({ key: item.key, error: String(error) })}\n`);
    }
  });
  await new Promise<void>((resolve) => report.end(() => resolve()));
  console.log(JSON.stringify({ apply, ...counts }));
}

/**
 * Replay into R2 what was deleted from S3 alone during `--since`..`--until`:
 * the window in which oxy-api still deleted only in S3 while Super Slurper and
 * Sippy were already copying (ADR 0047). From the database, not a listing, so it
 * can run before the bulk copy finishes:
 *   - every `storage_object_deletions` row completed `deleted` in the window
 *     (both spellings, `<key>` and `public/<key>`; a prefix is listed in R2);
 *   - every file that left public-and-active in the window: its `public/` copy
 *     and its renditions' `public/` copies.
 * An R2 object is deleted only when S3 no longer has it and no live file row or
 * rendition names it now; a deleted `public/` object's cloud.oxy.so URL is
 * purged (CLOUDFLARE_ZONE_ID, CLOUDFLARE_CACHE_PURGE_TOKEN).
 */
async function replayDeletions(): Promise<void> {
  const s3Bucket = required('s3');
  const r2Bucket = required('r2');
  const out = required('out');
  const since = new Date(required('since'));
  const until = new Date(required('until'));
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    throw new Error('--since and --until must be ISO times');
  }
  const apply = has('apply');
  mkdirSync(out, { recursive: true });
  const s3 = s3Client();
  const r2 = r2Client();
  const postgres = (await import('postgres')).default;
  const sql = postgres(process.env.DATABASE_URL ?? '', { max: 4 });
  const report = createWriteStream(`${out}/replay-deletions${apply ? '' : '.preview'}.ndjson`);
  const counts = { candidates: 0, inS3: 0, inUse: 0, absent: 0, deleted: 0, purged: 0 };
  try {
    const ledger = await sql<{ kind: string; target: string }[]>`
      select kind, target from storage_object_deletions
      where outcome = 'deleted' and completed_at >= ${since} and completed_at < ${until}`;
    const left = await sql<{ id: string; storage_key: string }[]>`
      select id, storage_key from files
      where updated_at >= ${since} and not (status = 'active' and visibility = 'public')`;
    const leftVariants = left.length
      ? await sql<
          { key: string }[]
        >`select key from file_variants where file_id = any(${left.map((f) => f.id)})`
      : [];
    const pub = (key: string) => (key.startsWith('public/') ? key : `public/${key}`);
    const keys = new Set<string>();
    const prefixes = new Set<string>();
    for (const row of ledger) {
      const base = row.target.replace(/^public\//, '');
      if (row.kind === 'prefix') {
        prefixes.add(base);
        prefixes.add(pub(base));
      } else {
        keys.add(base);
        keys.add(pub(base));
      }
    }
    for (const file of left) keys.add(pub(file.storage_key));
    for (const variant of leftVariants) keys.add(pub(variant.key));
    for (const prefix of prefixes) {
      for (const item of (await list(r2, r2Bucket, prefix, false)).objects) keys.add(item.key);
    }

    const exists = async (client: S3Client, bucket: string, key: string) => {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        )
          return false;
        throw error;
      }
    };
    // Listed, not HEADed: R2 answers a HEAD of an object only in S3 from S3 (Sippy).
    const inR2 = async (key: string) => {
      const page = await r2.send(
        new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: key, MaxKeys: 1 }),
      );
      return page.Contents?.[0]?.Key === key;
    };
    // Objects in R2 that S3 no longer has: the deletions S3 alone received.
    const orphans: string[] = [];
    await pool([...keys], 16, async (key) => {
      counts.candidates += 1;
      if (!(await inR2(key))) {
        counts.absent += 1;
        return;
      }
      if (await exists(s3, s3Bucket, key)) {
        counts.inS3 += 1;
        return;
      }
      orphans.push(key);
    });

    // Whether a row still names each orphan, asked once per batch rather than
    // once per key. Neither `files.storage_key` nor `file_variants.key` is
    // indexed, so the per-key form scanned both tables for EVERY candidate —
    // 16 at a time: the 2026-10-21 05:55 preview ran at 10 average active
    // sessions on the shared database, ~550k blocks read per key. A batch is
    // one hashed scan of each, and it is asked right before that batch's
    // deletes, so a key that came into use during the run is still kept.
    const USE_CHECK_BATCH = 2000;
    const toPurge: string[] = [];
    for (let offset = 0; offset < orphans.length; offset += USE_CHECK_BATCH) {
      const batch = orphans.slice(offset, offset + USE_CHECK_BATCH);
      const names = [...new Set(batch.flatMap((key) => [key, key.replace(/^public\//, '')]))];
      const usedRows = await sql<{ key: string }[]>`
        select f.storage_key as key from files f
         where f.status <> 'deleted' and f.storage_key = any(${names})
        union
        select v.key from file_variants v join files f on f.id = v.file_id
         where f.status <> 'deleted' and v.key = any(${names})`;
      const used = new Set(usedRows.map((row) => row.key));
      await pool(batch, 16, async (key) => {
        const base = key.replace(/^public\//, '');
        if (used.has(key) || used.has(base)) {
          counts.inUse += 1;
          report.write(`${JSON.stringify({ key, kept: 'in use' })}\n`);
          return;
        }
        if (apply) await r2.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: key }));
        counts.deleted += 1;
        if (key.startsWith('public/')) toPurge.push(`https://cloud.oxy.so/${base}`);
        report.write(`${JSON.stringify({ key, deleted: apply })}\n`);
      });
    }
    const zone = process.env.CLOUDFLARE_ZONE_ID;
    const token = process.env.CLOUDFLARE_CACHE_PURGE_TOKEN;
    if (apply && toPurge.length > 0 && zone && token) {
      for (let i = 0; i < toPurge.length; i += 100) {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ files: toPurge.slice(i, i + 100) }),
          },
        );
        if (!response.ok) throw new Error(`purge answered ${response.status}`);
        counts.purged += Math.min(100, toPurge.length - i);
      }
    }
    console.log(
      JSON.stringify({
        apply,
        since: since.toISOString(),
        until: until.toISOString(),
        ledgerRows: ledger.length,
        filesLeftPublic: left.length,
        ...counts,
      }),
    );
  } finally {
    await new Promise<void>((resolve) => report.end(() => resolve()));
    await sql.end();
  }
}

const commands: Record<string, () => Promise<void>> = {
  compare,
  'repair-metadata': repairMetadata,
  'verify-sha256': verifySha256,
  'remove-extra': removeExtra,
  'copy-missing': copyMissing,
  'replay-deletions': replayDeletions,
};

const run = command ? commands[command] : undefined;
if (!run) {
  console.error(`usage: bun scripts/r2-migration.ts <${Object.keys(commands).join('|')}> ...`);
  process.exit(2);
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
