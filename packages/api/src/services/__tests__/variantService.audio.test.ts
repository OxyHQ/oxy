/**
 * Audio renditions (ADR 0042 stage 4c) — REAL ffmpeg against generated audio,
 * a REAL Postgres for the file and variant rows, and an in-memory bucket served
 * over a local HTTP server so ffmpeg reads its input exactly as it reads a
 * presigned URL in production.
 *
 * Invariants:
 *  1. An audio file gets an audio-only AAC HLS ladder (`hls_a64`…), an
 *     `hls_master` naming each rung by basename with `CODECS="mp4a.40.2"`, a
 *     `waveform` and a 30-second `preview`; every segment a rung playlist lists
 *     is stored next to it.
 *  2. A lossy source gets no rung above what it carries (a 64 kb/s mp3: only
 *     `hls_a64`); a lossless one gets all three.
 *  3. The preview starts where the owner asked (clamped) and lasts 30 s.
 *  4. A loudness-normalized ladder lives under its own `/ln/` directory, and
 *     rows of the same bytes share a rendition set only with the same profile.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import { VariantService } from '../variantService';
import { findFileById } from '../fileRepository';
import type { S3Service } from '../s3Service';
import { mediaPlaylistSegments } from '../audioRenditions';

jest.setTimeout(240_000);

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const bucket = new Map<string, { bytes: Buffer; contentType?: string }>();
let server: http.Server;
let baseUrl = '';
let tempDir = '';

const s3 = {
  uploadBuffer: jest.fn(async (key: string, bytes: Buffer, options?: { contentType?: string }) => {
    bucket.set(key, { bytes, contentType: options?.contentType });
  }),
  fileExists: jest.fn(async (key: string) => bucket.has(key)),
  downloadBuffer: jest.fn(async (key: string) => {
    const object = bucket.get(key);
    if (!object) throw new Error(`NoSuchKey ${key}`);
    return object.bytes;
  }),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `${baseUrl}/${key}`),
  deleteFile: jest.fn(async (key: string) => {
    bucket.delete(key);
  }),
} as unknown as S3Service;

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function ffprobeDuration(bytes: Buffer, ext: string): number {
  const file = path.join(tempDir, `probe-${randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(file, bytes);
  const out = execFileSync('ffprobe', [
    '-v',
    'quiet',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number.parseFloat(out.toString());
}

/** Peak absolute sample in the first `seconds` of an encoded clip. */
function peakOfFirst(bytes: Buffer, ext: string, seconds: number): number {
  const file = path.join(tempDir, `peak-${randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(file, bytes);
  const pcm = execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-t',
    String(seconds),
    '-ac',
    '1',
    '-ar',
    '8000',
    '-f',
    's16le',
    'pipe:1',
  ]);
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  return peak;
}

/** 5 s of silence, then a 440 Hz tone, 40 s in all. */
let toneWav: Buffer;
/** The same, as a 64 kb/s mp3. */
let toneMp3: Buffer;

async function insertAudioRow(
  bytes: Buffer,
  mime: string,
  options: {
    sha256?: string;
    metadata?: Record<string, unknown>;
    visibility?: 'public' | 'private';
  } = {},
): Promise<string> {
  const sha256 = options.sha256 ?? randomBytes(32).toString('hex');
  const visibility = options.visibility ?? 'public';
  const storageKey = `${visibility === 'public' ? 'public/' : ''}content/2026/10/${sha256.slice(0, 2)}/${sha256}`;
  bucket.set(storageKey, { bytes, contentType: mime });
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: bytes.length,
      mime,
      ext: '',
      storageKey,
      ownerUserId: owner.id,
      visibility,
      status: 'active',
      metadata: options.metadata ?? {},
    })
    .returning({ id: files.id });
  return row.id;
}

async function variantsOf(fileId: string) {
  return getDb().select().from(fileVariants).where(eq(fileVariants.fileId, fileId));
}

/** The one variant of `type`; fails the test when it is absent. */
function variantOf<T extends { type: string }>(variants: Iterable<T>, type: string): T {
  for (const variant of variants) if (variant.type === type) return variant;
  throw new Error(`no ${type} variant`);
}

function text(key: string): string {
  const object = bucket.get(key);
  if (!object) throw new Error(`missing ${key}`);
  return object.bytes.toString('utf8');
}

beforeAll(async () => {
  await connectPostgres();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-audio-test-'));
  const wavPath = path.join(tempDir, 'tone.wav');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='if(lt(t,5),0,0.5*sin(2*PI*440*t))':s=44100:d=40",
    '-ac',
    '2',
    wavPath,
  ]);
  toneWav = fs.readFileSync(wavPath);
  const mp3Path = path.join(tempDir, 'tone.mp3');
  ffmpeg(['-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '64k', mp3Path]);
  toneMp3 = fs.readFileSync(mp3Path);

  server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]);
    const object = bucket.get(key);
    if (!object) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : object.bytes.length - 1;
      res.writeHead(206, {
        'content-type': object.contentType ?? 'application/octet-stream',
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${object.bytes.length}`,
        'accept-ranges': 'bytes',
      });
      res.end(object.bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'content-type': object.contentType ?? 'application/octet-stream',
      'content-length': object.bytes.length,
      'accept-ranges': 'bytes',
    });
    res.end(object.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
  await closePostgres();
});

describe('audio renditions', () => {
  it('gives a lossless source the full AAC ladder, a master, a waveform and a 30 s preview', async () => {
    const fileId = await insertAudioRow(toneWav, 'audio/wav');
    await new VariantService(s3).generateVariants(fileId);

    const variants = await variantsOf(fileId);
    const byType = new Map(variants.map((variant) => [variant.type, variant]));
    expect([...byType.keys()].sort()).toEqual(
      ['hls_a128', 'hls_a256', 'hls_a64', 'hls_master', 'preview', 'waveform'].sort(),
    );
    for (const variant of variants) {
      expect(variant.readyAt).not.toBeNull();
      expect(variant.key.startsWith('public/variants/')).toBe(true);
      expect(variant.key).not.toContain('/ln/');
    }

    // The master names each rung by basename, with the AAC codec string.
    const master = text(variantOf(byType.values(), 'hls_master').key);
    const masterUris = master
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(masterUris.sort()).toEqual(['hls_a128.m3u8', 'hls_a256.m3u8', 'hls_a64.m3u8']);
    expect(master.match(/CODECS="mp4a\.40\.2"/g)).toHaveLength(3);
    expect(master).not.toContain('RESOLUTION');
    const masterUrl = new URL(
      `https://cloud.example/${variantOf(byType.values(), 'hls_master').key}`,
    );
    for (const uri of masterUris) {
      const resolved = new URL(uri, masterUrl).pathname.slice(1);
      expect(bucket.has(resolved)).toBe(true);
    }

    // Every segment a rung lists is stored next to its playlist.
    for (const type of ['hls_a64', 'hls_a128', 'hls_a256']) {
      const variant = variantOf(byType.values(), type);
      expect(variant.metadata).toMatchObject({
        format: 'hls',
        kind: 'audio',
        codec: 'aac',
        loudnessNormalized: false,
      });
      const playlist = text(variant.key);
      expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
      expect(playlist).toContain('#EXT-X-ENDLIST');
      const segments = mediaPlaylistSegments(playlist);
      expect(segments.length).toBeGreaterThanOrEqual(6);
      expect(variant.metadata?.segments).toBe(segments.length);
      const directory = variant.key.slice(0, variant.key.lastIndexOf('/') + 1);
      for (const segment of segments) {
        expect(segment.uri).toMatch(new RegExp(`^segment_${type.slice(4)}_\\d{3}\\.ts$`));
        expect(bucket.get(`${directory}${segment.uri}`)?.contentType).toBe('video/mp2t');
      }
    }

    // audiowaveform-format peaks, about 2000 buckets, int8.
    const waveform = JSON.parse(text(variantOf(byType.values(), 'waveform').key));
    expect(waveform).toMatchObject({ version: 1, channels: 1, sampleRate: 8000, bits: 8 });
    expect(waveform.length).toBeGreaterThanOrEqual(1500);
    expect(waveform.length).toBeLessThanOrEqual(2100);
    expect(waveform.data).toHaveLength(waveform.length * 2);
    expect(Math.max(...waveform.data)).toBeGreaterThan(40);
    expect(Math.min(...waveform.data)).toBeGreaterThanOrEqual(-128);
    // The first five seconds are silence.
    expect(Math.max(...waveform.data.slice(0, 100).map(Math.abs))).toBeLessThanOrEqual(1);
    expect(bucket.get(variantOf(byType.values(), 'waveform').key)?.contentType).toBe(
      'application/json',
    );

    // A 30-second preview from the start: it opens on the silence.
    const preview = variantOf(byType.values(), 'preview');
    expect(preview.metadata).toMatchObject({ format: 'm4a', startSeconds: 0, durationSeconds: 30 });
    const previewBytes = bucket.get(preview.key)?.bytes ?? Buffer.alloc(0);
    expect(bucket.get(preview.key)?.contentType).toBe('audio/mp4');
    expect(ffprobeDuration(previewBytes, 'm4a')).toBeGreaterThan(29.5);
    expect(ffprobeDuration(previewBytes, 'm4a')).toBeLessThan(30.6);
    expect(peakOfFirst(previewBytes, 'm4a', 1)).toBeLessThan(200);

    // Intrinsic audio metadata and the canonical duration.
    const stored = await findFileById(fileId);
    expect(stored?.metadata).toMatchObject({
      audio: { codec: 'pcm_s16le', sampleRate: 44100, channels: 2 },
    });
    expect(stored?.metadata?.media).toMatchObject({ durationSec: expect.closeTo(40, 0) });
  });

  it('gives a 64 kb/s mp3 only the 64 kb/s rung — no upconversion', async () => {
    const fileId = await insertAudioRow(toneMp3, 'audio/mpeg');
    await new VariantService(s3).generateVariants(fileId);

    const types = (await variantsOf(fileId)).map((variant) => variant.type).sort();
    expect(types).toEqual(['hls_a64', 'hls_master', 'preview', 'waveform']);
    const master = text(variantOf(await variantsOf(fileId), 'hls_master').key);
    expect(master.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([
      'hls_a64.m3u8',
    ]);
  });

  it('starts the preview where the owner asked, clamped so 30 s fit', async () => {
    const fileId = await insertAudioRow(toneMp3, 'audio/mpeg', {
      metadata: { audioOptions: { previewStartSeconds: 5 } },
    });
    await new VariantService(s3).generateVariants(fileId);
    const preview = variantOf(await variantsOf(fileId), 'preview');
    expect(preview.metadata).toMatchObject({ startSeconds: 5, durationSeconds: 30 });
    expect(preview.key.endsWith('/preview_s5.m4a')).toBe(true);
    // From second 5 the tone plays at once.
    expect(
      peakOfFirst(bucket.get(preview.key)?.bytes ?? Buffer.alloc(0), 'm4a', 1),
    ).toBeGreaterThan(5000);

    const late = await insertAudioRow(toneMp3, 'audio/mpeg', {
      metadata: { audioOptions: { previewStartSeconds: 35 } },
    });
    await new VariantService(s3).generateVariants(late);
    expect(variantOf(await variantsOf(late), 'preview').metadata).toMatchObject({
      startSeconds: expect.closeTo(10, 0),
      durationSeconds: 30,
    });
  });

  it('keeps a loudness-normalized ladder in its own directory and shares sets only within a profile', async () => {
    const sha256 = randomBytes(32).toString('hex');
    const plain = await insertAudioRow(toneMp3, 'audio/mpeg', { sha256 });
    await new VariantService(s3).generateVariants(plain);
    const plainKeys = (await variantsOf(plain)).map((variant) => variant.key).sort();
    expect(plainKeys.every((key) => !key.includes('/ln/'))).toBe(true);

    const normalized = await insertAudioRow(toneMp3, 'audio/mpeg', {
      sha256,
      metadata: { audioOptions: { normalizeLoudness: true } },
    });
    await new VariantService(s3).generateVariants(normalized);
    const normalizedVariants = await variantsOf(normalized);
    expect(normalizedVariants.map((variant) => variant.type).sort()).toEqual([
      'hls_a64',
      'hls_master',
      'preview',
      'waveform',
    ]);
    for (const variant of normalizedVariants) {
      expect(variant.key).toContain(`/${sha256}/ln/`);
      expect(variant.metadata).toMatchObject({ loudnessNormalized: true });
      expect(plainKeys).not.toContain(variant.key);
    }
    // The plain set is untouched by the normalized encode.
    expect((await variantsOf(plain)).map((variant) => variant.key).sort()).toEqual(plainKeys);

    // A third owner of the same bytes, plain profile: the plain set is reused, nothing encoded.
    const encodesBefore = (s3.uploadBuffer as jest.Mock).mock.calls.length;
    const third = await insertAudioRow(toneMp3, 'audio/mpeg', { sha256 });
    await new VariantService(s3).generateVariants(third);
    expect((await variantsOf(third)).map((variant) => variant.key).sort()).toEqual(plainKeys);
    expect((s3.uploadBuffer as jest.Mock).mock.calls.length).toBe(encodesBefore);
  });

  it('fails the job, after committing nothing usable, when the source has no audio', async () => {
    const fileId = await insertAudioRow(Buffer.from('not audio at all'), 'audio/mpeg');
    await expect(new VariantService(s3).generateVariants(fileId)).rejects.toThrow(
      /No audio stream/,
    );
    expect(await variantsOf(fileId)).toEqual([]);
  });
});
