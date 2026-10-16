/**
 * Audio renditions (ADR 0042 stage 4c): the pure halves of
 * `VariantService.generateAudioVariants` — which rungs an audio file gets, the
 * profile that keeps differently-processed ladders of the same bytes apart, the
 * audio master playlist, the waveform peaks, and a bounded ffmpeg runner.
 *
 * What one audio file gets, eagerly, from the asset-variants queue:
 *
 *   hls_master   the audio-only master playlist (`CODECS="mp4a.40.2"`)
 *   hls_a64      AAC-LC 64 kb/s HLS rendition — always
 *   hls_a128     128 kb/s — unless the source is lossy and below 96 kb/s
 *   hls_a256     256 kb/s — unless the source is lossy and below 192 kb/s
 *   waveform     audiowaveform-format JSON peaks (int8, mono, ~2000 buckets)
 *   preview      a 30-second AAC 128 kb/s clip (fragmented mp4)
 *
 * The master keeps the video ladder's type name, `hls_master`, so
 * `/assets/service/by-ids`' `hlsReadyAt` reads an audio ladder the same way.
 */

import { spawn } from 'node:child_process';
import type { FileRecord } from '../types/file.types';

/** One rung of the audio ladder. */
export interface AudioRung {
  /** The variant type: `hls_a64`, `hls_a128`, `hls_a256`. */
  type: string;
  /** ffmpeg's `-b:a`. */
  bitrate: string;
  /** Nominal bits per second. */
  bitsPerSecond: number;
  /** The segment file name stem: `segment_a64_000.ts`. */
  segmentStem: string;
}

export const AUDIO_RUNGS: readonly AudioRung[] = [
  { type: 'hls_a64', bitrate: '64k', bitsPerSecond: 64_000, segmentStem: 'segment_a64' },
  { type: 'hls_a128', bitrate: '128k', bitsPerSecond: 128_000, segmentStem: 'segment_a128' },
  { type: 'hls_a256', bitrate: '256k', bitsPerSecond: 256_000, segmentStem: 'segment_a256' },
];

/** The AAC-LC codec string a master playlist names. */
export const AUDIO_HLS_CODECS = 'mp4a.40.2';
/** Every rendition is resampled to this rate. */
export const AUDIO_SAMPLE_RATE = 48_000;
/** Target segment length, seconds. */
export const AUDIO_HLS_SEGMENT_SECONDS = 6;
/** Length of the preview clip, seconds. */
export const AUDIO_PREVIEW_SECONDS = 30;
/** Fade-out at the end of a truncated preview, seconds. */
export const AUDIO_PREVIEW_FADE_SECONDS = 2;
/** EBU R128 loudness normalization: integrated −16 LUFS, true peak −1.5 dBTP. */
export const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11';
/** Waveform decode rate (mono). */
export const WAVEFORM_SAMPLE_RATE = 8000;
/** About this many peak buckets per waveform. */
export const WAVEFORM_TARGET_PEAKS = 2000;

/** Codecs whose source carries no bitrate ceiling worth respecting: every rung is made. */
const LOSSLESS_CODECS = new Set(['flac', 'alac', 'wavpack', 'tta', 'ape', 'mlp', 'truehd']);

/** The mimes an audio rendition is made for. */
export const AUDIO_RENDITION_MIMES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/m4a',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
]);

/** Whether `mime` is an audio type this pipeline renders. */
export function isRenderableAudioMime(mime: string): boolean {
  return AUDIO_RENDITION_MIMES.has(mime.split(';')[0]?.trim().toLowerCase() ?? '');
}

/** What ffprobe says about the source's first audio stream. */
export interface AudioProbe {
  duration?: number;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
}

/** True for a lossless source (or raw PCM): every rung is worth making. */
export function isLosslessCodec(codec: string | undefined): boolean {
  if (!codec) return false;
  return codec.startsWith('pcm_') || LOSSLESS_CODECS.has(codec);
}

/**
 * The rungs a source gets: always the lowest; a higher one only when the
 * source is lossless, its bitrate is unknown, or it carries at least three
 * quarters of the rung's bitrate — an upconversion adds bytes, not sound.
 */
export function selectAudioRungs(probe: AudioProbe): AudioRung[] {
  return AUDIO_RUNGS.filter(
    (rung, index) =>
      index === 0 ||
      isLosslessCodec(probe.codec) ||
      !probe.bitrate ||
      probe.bitrate >= 0.75 * rung.bitsPerSecond,
  );
}

/**
 * How an audio file's renditions are processed — what its owner asked for in
 * `files.metadata.audioOptions` (a server-owned key the upload routes set).
 * Two rows of the same bytes share a rendition set only when their profiles
 * are equal; the loudness-normalized ladder lives in its own key directory so
 * the two can never overwrite each other.
 */
export interface AudioProfile {
  normalizeLoudness: boolean;
  /** The requested preview start, seconds (clamped to the duration at render time). */
  previewStartSeconds: number;
}

export function audioProfileOf(file: Pick<FileRecord, 'metadata'>): AudioProfile {
  const options = (file.metadata?.audioOptions ?? {}) as Record<string, unknown>;
  const start = Number(options.previewStartSeconds);
  return {
    normalizeLoudness: options.normalizeLoudness === true,
    previewStartSeconds: Number.isFinite(start) && start > 0 ? Math.round(start * 1000) / 1000 : 0,
  };
}

export function sameAudioProfile(a: AudioProfile, b: AudioProfile): boolean {
  return (
    a.normalizeLoudness === b.normalizeLoudness && a.previewStartSeconds === b.previewStartSeconds
  );
}

/** The key sub-directory of a profile's ladder: `ln` when normalized, none otherwise. */
export function audioProfileSegment(profile: AudioProfile): string | undefined {
  return profile.normalizeLoudness ? 'ln' : undefined;
}

/** The preview's variant file stem: `preview`, or `preview_s12_5` for a later start. */
export function previewStem(startSeconds: number): string {
  return startSeconds > 0 ? `preview_s${String(startSeconds).replace('.', '_')}` : 'preview';
}

/**
 * Where the preview starts and how long it is: the requested start clamped so
 * a whole 30 s fits, the whole file when it is shorter than 30 s.
 */
export function previewWindow(
  durationSeconds: number | undefined,
  requestedStart: number,
): { startSeconds: number; durationSeconds: number; truncated: boolean } {
  if (!durationSeconds || durationSeconds <= 0) {
    return {
      startSeconds: requestedStart,
      durationSeconds: AUDIO_PREVIEW_SECONDS,
      truncated: true,
    };
  }
  const maxStart = Math.max(0, durationSeconds - AUDIO_PREVIEW_SECONDS);
  const startSeconds = Math.round(Math.min(Math.max(0, requestedStart), maxStart) * 1000) / 1000;
  const remaining = durationSeconds - startSeconds;
  const length = Math.min(AUDIO_PREVIEW_SECONDS, remaining);
  return {
    startSeconds,
    durationSeconds: Math.round(length * 1000) / 1000,
    truncated: remaining > AUDIO_PREVIEW_SECONDS + 0.05,
  };
}

/** `#EXTINF` durations and URIs of a media playlist, in order. */
export function mediaPlaylistSegments(source: string): Array<{ uri: string; duration: number }> {
  const segments: Array<{ uri: string; duration: number }> = [];
  let pending: number | null = null;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      pending = Number.parseFloat(line.slice('#EXTINF:'.length));
    } else if (line.length > 0 && !line.startsWith('#')) {
      segments.push({ uri: line, duration: pending && pending > 0 ? pending : 0 });
      pending = null;
    }
  }
  return segments;
}

/**
 * Peak and average bits per second of a rendition, measured from its
 * segments' sizes and durations — what `BANDWIDTH` and `AVERAGE-BANDWIDTH`
 * must say (RFC 8216 §4.3.4.2). Falls back to the nominal bitrate plus the
 * transport stream's overhead when nothing can be measured.
 */
export function measureBandwidth(
  segments: Array<{ duration: number; bytes: number }>,
  nominalBitsPerSecond: number,
): { peak: number; average: number } {
  const measurable = segments.filter((segment) => segment.duration > 0.5 && segment.bytes > 0);
  if (measurable.length === 0) {
    const estimate = Math.round(nominalBitsPerSecond * 1.15);
    return { peak: estimate, average: estimate };
  }
  const peak = Math.max(...measurable.map((segment) => (segment.bytes * 8) / segment.duration));
  const totalBits = measurable.reduce((sum, segment) => sum + segment.bytes * 8, 0);
  const totalSeconds = measurable.reduce((sum, segment) => sum + segment.duration, 0);
  return { peak: Math.ceil(peak), average: Math.ceil(totalBits / totalSeconds) };
}

/**
 * The audio master playlist. Rendition URIs are BASENAMES: they resolve
 * against the master's own URL (RFC 8216 §4.3.4.2), and every rendition
 * playlist is the master's sibling.
 */
export function audioMasterPlaylist(
  renditions: Array<{ playlistKey: string; bandwidth: number; averageBandwidth: number }>,
): string {
  let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n\n';
  for (const rendition of renditions) {
    const uri = rendition.playlistKey.slice(rendition.playlistKey.lastIndexOf('/') + 1);
    playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AVERAGE-BANDWIDTH=${rendition.averageBandwidth},CODECS="${AUDIO_HLS_CODECS}"\n${uri}\n\n`;
  }
  return playlist;
}

/** audiowaveform's JSON format (version 1, 8-bit). */
export interface WaveformJson {
  version: 1;
  channels: 1;
  sample_rate: number;
  sampleRate: number;
  samples_per_pixel: number;
  samplesPerPeak: number;
  bits: 8;
  length: number;
  data: number[];
}

/** Buckets beyond which a waveform of unknown length halves its resolution. */
const WAVEFORM_MAX_BUCKETS = WAVEFORM_TARGET_PEAKS * 2;

/**
 * Accumulates min/max peaks from a stream of mono s16le PCM without holding
 * the PCM: memory is bounded by the bucket count. With a known duration the
 * bucket size is chosen up front for about {@link WAVEFORM_TARGET_PEAKS}
 * buckets; without one it starts small and halves the resolution (merging
 * neighbours) whenever the buckets would exceed twice that.
 */
export class WaveformAccumulator {
  private samplesPerPeak: number;
  private readonly mins: number[] = [];
  private readonly maxs: number[] = [];
  private bucketMin = 0;
  private bucketMax = 0;
  private inBucket = 0;
  private carry: number | null = null;

  constructor(durationSeconds?: number) {
    const totalSamples =
      durationSeconds && durationSeconds > 0
        ? Math.ceil(durationSeconds * WAVEFORM_SAMPLE_RATE)
        : 0;
    this.samplesPerPeak =
      totalSamples > 0 ? Math.max(1, Math.ceil(totalSamples / WAVEFORM_TARGET_PEAKS)) : 64;
  }

  /** Feed raw little-endian 16-bit samples; an odd trailing byte is carried to the next chunk. */
  push(chunk: Buffer): void {
    let offset = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.addSample(Buffer.from([this.carry, chunk[0]]).readInt16LE(0));
      this.carry = null;
      offset = 1;
    }
    const end = chunk.length - ((chunk.length - offset) % 2);
    for (let index = offset; index < end; index += 2) {
      this.addSample(chunk.readInt16LE(index));
    }
    if (end < chunk.length) this.carry = chunk[chunk.length - 1];
  }

  private addSample(sample: number): void {
    if (this.inBucket === 0) {
      this.bucketMin = sample;
      this.bucketMax = sample;
    } else {
      if (sample < this.bucketMin) this.bucketMin = sample;
      if (sample > this.bucketMax) this.bucketMax = sample;
    }
    this.inBucket++;
    if (this.inBucket >= this.samplesPerPeak) this.flushBucket();
  }

  private flushBucket(): void {
    if (this.inBucket === 0) return;
    this.mins.push(this.bucketMin);
    this.maxs.push(this.bucketMax);
    this.inBucket = 0;
    if (this.mins.length >= WAVEFORM_MAX_BUCKETS) this.halveResolution();
  }

  private halveResolution(): void {
    const merged = Math.ceil(this.mins.length / 2);
    for (let index = 0; index < merged; index++) {
      const a = index * 2;
      const b = Math.min(a + 1, this.mins.length - 1);
      this.mins[index] = Math.min(this.mins[a], this.mins[b]);
      this.maxs[index] = Math.max(this.maxs[a], this.maxs[b]);
    }
    this.mins.length = merged;
    this.maxs.length = merged;
    this.samplesPerPeak *= 2;
  }

  /** The waveform, int8-scaled (−128…127), interleaved `[min, max, …]`. */
  finish(): WaveformJson {
    this.flushBucket();
    const toInt8 = (value: number) => Math.max(-128, Math.min(127, Math.round(value / 256)));
    const data: number[] = [];
    for (let index = 0; index < this.mins.length; index++) {
      data.push(toInt8(this.mins[index]), toInt8(this.maxs[index]));
    }
    return {
      version: 1,
      channels: 1,
      sample_rate: WAVEFORM_SAMPLE_RATE,
      sampleRate: WAVEFORM_SAMPLE_RATE,
      samples_per_pixel: this.samplesPerPeak,
      samplesPerPeak: this.samplesPerPeak,
      bits: 8,
      length: this.mins.length,
      data,
    };
  }
}

/**
 * The protocols ffmpeg may open for an audio decode, from the input URL's own
 * scheme — never `file`: the bytes it demuxes are user-uploaded and a crafted
 * container can name a URL (see `posterProtocolWhitelist`).
 */
export function audioProtocolWhitelist(inputUrl: string): string {
  return inputUrl.startsWith('http://') ? 'http,tcp' : 'https,tls,tcp';
}

/** Wall-clock ceiling for one ffmpeg pass over a source of `durationSeconds`. */
export function audioFfmpegTimeoutMs(durationSeconds: number | undefined): number {
  if (!durationSeconds || durationSeconds <= 0) return 30 * 60_000;
  return Math.max(120_000, Math.ceil(durationSeconds * 2 * 1000));
}

/** Bytes of ffmpeg's stderr kept for a log line: its LAST bytes hold the fatal error. */
const STDERR_TAIL_BYTES = 4096;

export interface FfmpegRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** Whether stdout passed `maxStdoutBytes` (the process was killed). */
  overflowed: boolean;
  timedOut: boolean;
}

/**
 * Run ffmpeg with a wall-clock timeout (SIGKILL on expiry), keeping only the
 * tail of stderr. `onStdout` receives output as it arrives; past
 * `maxStdoutBytes` the process is killed and `overflowed` is set.
 */
export function runFfmpeg(
  binary: string,
  args: string[],
  options: {
    timeoutMs: number;
    onStdout?: (chunk: Buffer) => void;
    maxStdoutBytes?: number;
  },
): Promise<FfmpegRun> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdoutBytes = 0;
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref?.();

    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.stdout.on('data', (data: Buffer) => {
      if (overflowed) return;
      stdoutBytes += data.length;
      if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      options.onStdout?.(data);
    });
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stderrTail: stderr, overflowed, timedOut });
    };
    child.on('close', done);
    child.on('error', (error) => {
      stderr = `${stderr}\n${error.message}`.slice(-STDERR_TAIL_BYTES);
      done(-1, null);
    });
  });
}
