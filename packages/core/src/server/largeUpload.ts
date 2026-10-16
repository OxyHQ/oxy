/**
 * The client half of the Oxy API's large uploads (ADR 0042 stage 4b), for
 * `OxyServer.assets.uploadAppFileLarge` / `uploadUserMediaLarge`.
 *
 *   hash      SHA-256 of the source, read 8 MiB at a time (never whole in memory)
 *   open      POST <base>                     → session (or the file, if already held)
 *   parts     PUT each part to its presigned URL, `partConcurrency` at a time,
 *             each retried; URLs are fetched 100 at a time, just in time
 *   complete  POST <base>/:uploadId/complete  → the file, or 202 `verifying`
 *   poll      GET  <base>/:uploadId           until `completed` or `failed`
 *
 * Resume is free: opening the same bytes again answers the open session with
 * the parts S3 already holds, so a process that crashed mid-upload sends only
 * what is missing when it calls again.
 */
import { createHash } from 'node:crypto';
import type { ServiceLane } from '../client/context';
import type { FileVisibility } from '../models/interfaces';

/** What a large upload reads from: a Blob (`fs.openAsBlob(path)` for a file), bytes, or a file path. */
export type LargeUploadSource = Blob | Uint8Array | ArrayBuffer | string;

export interface LargeUploadProgressEvent {
  /** `hash` reads the source once; `upload` sends parts; `verify` waits for Oxy to hash it. */
  phase: 'hash' | 'upload' | 'verify';
  loaded: number;
  total: number;
}

export interface LargeServiceUploadOptions {
  /** The file's type. Executables and active documents (HTML, SVG, XML, scripts) are refused (415). */
  mime: string;
  /** Stored as the original name; also how a type with no known extension gets one. */
  filename?: string;
  metadata?: Record<string, unknown>;
  /** Register this application's use of the file once it is stored (needs `files:references:write`). */
  reference?: { entityType: string; entityId: string };
  /** The source's SHA-256 (lowercase hex) when already known: skips the hashing pass. */
  sha256?: string;
  /** Parts sent at once (default 4). */
  partConcurrency?: number;
  /** Attempts per part (default 4). */
  partAttempts?: number;
  /** How long to wait for Oxy to verify a large file after completion (default 30 min). */
  verifyTimeoutMs?: number;
  onProgress?: (progress: LargeUploadProgressEvent) => void;
  /** Stops the upload; the session stays open (until it expires) so a later call resumes it. */
  signal?: AbortSignal;
}

/** One part's presigned URL: PUT exactly `size` bytes to it. */
interface PartUrl {
  partNumber: number;
  url: string;
  size: number;
}

/** The wire view of an upload session (`/assets/service/{app,user-media}/uploads`). */
export interface LargeUploadSession<TFile> {
  uploadId: string | null;
  status: 'uploading' | 'verifying' | 'completed' | 'failed' | 'aborted';
  size: number;
  partSize?: number;
  partCount?: number;
  expiresAt?: string;
  parts?: PartUrl[];
  uploadedParts?: { partNumber: number; size: number }[];
  file?: TFile;
  deduplicated?: boolean;
  reference?: { result: 'created' | 'exists' | 'not_found' };
  error?: { code: string; message: string };
}

/** A finished large upload. */
export interface LargeServiceUploadResult<TFile> {
  file: TFile;
  /** The owner already held these bytes: nothing was stored. */
  deduplicated: boolean;
  /** `null` when no upload was needed. */
  uploadId: string | null;
  reference?: { result: 'created' | 'exists' | 'not_found' };
}

/** A large upload that ended without a file (checksum mismatch, a takedown, an abort…). */
export class LargeUploadFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly uploadId: string | null,
  ) {
    super(message);
    this.name = 'LargeUploadFailedError';
  }
}

const HASH_CHUNK_BYTES = 8 * 1024 * 1024;
const PART_URL_BATCH = 100;
const POLL_INTERVAL_MS = 2_000;

async function toBlob(source: LargeUploadSource): Promise<Blob> {
  if (typeof source === 'string') {
    const fs = await import('node:fs');
    if (typeof fs.openAsBlob !== 'function') {
      throw new Error('A file path needs Node 20+ (fs.openAsBlob); pass a Blob instead');
    }
    return fs.openAsBlob(source);
  }
  if (source instanceof Blob) return source;
  // A copy into a plain ArrayBuffer: a view over a SharedArrayBuffer is not a BlobPart.
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy]);
}

async function sha256Of(
  blob: Blob,
  onProgress: LargeServiceUploadOptions['onProgress'],
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash('sha256');
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(offset + HASH_CHUNK_BYTES, blob.size);
    hash.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
    onProgress?.({ phase: 'hash', loaded: end, total: blob.size });
  }
  return hash.digest('hex');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Run one large upload against `base` (`/assets/service/app/uploads` or
 * `/assets/service/user-media/uploads`) with `headers` on every API call.
 */
export async function runLargeUpload<TFile>(
  service: ServiceLane,
  base: string,
  headers: Record<string, string>,
  visibility: FileVisibility | undefined,
  source: LargeUploadSource,
  options: LargeServiceUploadOptions,
): Promise<LargeServiceUploadResult<TFile>> {
  const { signal, onProgress } = options;
  const blob = await toBlob(source);
  if (blob.size === 0) throw new Error('Cannot upload an empty file');
  const sha256 = options.sha256?.toLowerCase() ?? (await sha256Of(blob, onProgress, signal));

  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> =>
    service.request<T>(method, path, body, {
      headers,
      cache: false,
      ...(signal ? { signal } : {}),
    });

  let session = await call<LargeUploadSession<TFile>>('POST', base, {
    sha256,
    size: blob.size,
    mime: options.mime,
    ...(visibility ? { visibility } : {}),
    ...(options.filename ? { filename: options.filename } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.reference ? { reference: options.reference } : {}),
  });

  if (session.status === 'uploading' && session.uploadId) {
    const uploadId = session.uploadId;
    const path = `${base}/${encodeURIComponent(uploadId)}`;
    const partSize = session.partSize ?? blob.size;
    const partCount = session.partCount ?? 1;
    const urls = new Map((session.parts ?? []).map((part) => [part.partNumber, part]));

    const sendParts = async (held: Set<number>): Promise<void> => {
      const pending: number[] = [];
      for (let part = 1; part <= partCount; part++) if (!held.has(part)) pending.push(part);
      let sent = [...held].reduce(
        (bytes, part) => bytes + Math.min(partSize, blob.size - (part - 1) * partSize),
        0,
      );
      onProgress?.({ phase: 'upload', loaded: sent, total: blob.size });

      const urlFor = async (partNumber: number, refresh = false): Promise<PartUrl> => {
        const known = urls.get(partNumber);
        if (known && !refresh) return known;
        const batch = pending.filter((part) => part >= partNumber).slice(0, PART_URL_BATCH);
        const answer = await call<LargeUploadSession<TFile>>('POST', `${path}/parts`, {
          partNumbers: batch.includes(partNumber) ? batch : [partNumber],
        });
        for (const part of answer.parts ?? []) urls.set(part.partNumber, part);
        const fresh = urls.get(partNumber);
        if (!fresh) throw new Error(`No upload URL for part ${partNumber}`);
        return fresh;
      };

      const attempts = Math.max(1, options.partAttempts ?? 4);
      const putPart = async (partNumber: number): Promise<void> => {
        const start = (partNumber - 1) * partSize;
        const body = blob.slice(start, Math.min(start + partSize, blob.size));
        let refresh = false;
        for (let attempt = 1; ; attempt++) {
          signal?.throwIfAborted();
          const target = await urlFor(partNumber, refresh);
          if (new URL(target.url).protocol !== 'https:') {
            throw new Error('Part uploads require HTTPS');
          }
          try {
            const response = await fetch(target.url, {
              method: 'PUT',
              body,
              credentials: 'omit',
              redirect: 'error',
              ...(signal ? { signal } : {}),
            });
            if (response.ok) return;
            // An expired or refused signature: ask for a new URL.
            refresh = response.status === 403;
            if (attempt >= attempts) {
              throw new Error(`Part ${partNumber} upload failed (${response.status})`);
            }
          } catch (error) {
            if (signal?.aborted || attempt >= attempts) throw error;
          }
          await sleep(500 * 2 ** (attempt - 1), signal);
        }
      };

      let next = 0;
      const worker = async () => {
        while (next < pending.length) {
          const partNumber = pending[next++];
          await putPart(partNumber);
          sent += Math.min(partSize, blob.size - (partNumber - 1) * partSize);
          onProgress?.({ phase: 'upload', loaded: sent, total: blob.size });
        }
      };
      const concurrency = Math.max(1, Math.min(options.partConcurrency ?? 4, pending.length));
      await Promise.all(Array.from({ length: concurrency }, worker));
    };

    await sendParts(new Set((session.uploadedParts ?? []).map((part) => part.partNumber)));
    try {
      session = await call<LargeUploadSession<TFile>>('POST', `${path}/complete`);
    } catch (error) {
      // A part S3 does not hold after all (lost, or the wrong size): send what
      // the session says is missing, once, and complete again.
      const status = (error as { status?: number; response?: { status?: number } })?.status;
      if (status !== 409) throw error;
      const state = await call<LargeUploadSession<TFile>>('GET', path);
      if (state.status !== 'uploading') throw error;
      urls.clear();
      await sendParts(new Set((state.uploadedParts ?? []).map((part) => part.partNumber)));
      session = await call<LargeUploadSession<TFile>>('POST', `${path}/complete`);
    }
  }

  if (session.status === 'verifying' && session.uploadId) {
    const path = `${base}/${encodeURIComponent(session.uploadId)}`;
    const deadline = Date.now() + (options.verifyTimeoutMs ?? 30 * 60_000);
    while (session.status === 'verifying') {
      onProgress?.({ phase: 'verify', loaded: 0, total: blob.size });
      if (Date.now() > deadline) {
        throw new LargeUploadFailedError(
          'VERIFY_TIMEOUT',
          'Oxy is still verifying the upload; call again later to collect it',
          session.uploadId,
        );
      }
      await sleep(POLL_INTERVAL_MS, signal);
      session = await call<LargeUploadSession<TFile>>('GET', path);
    }
  }

  if (session.status !== 'completed' || !session.file) {
    throw new LargeUploadFailedError(
      session.error?.code ?? 'UPLOAD_FAILED',
      session.error?.message ?? `The upload ended ${session.status}`,
      session.uploadId,
    );
  }
  onProgress?.({ phase: 'verify', loaded: blob.size, total: blob.size });
  return {
    file: session.file,
    deduplicated: session.deduplicated ?? false,
    uploadId: session.uploadId,
    ...(session.reference ? { reference: session.reference } : {}),
  };
}
