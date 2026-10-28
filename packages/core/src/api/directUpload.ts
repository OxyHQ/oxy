/**
 * A signed-in person's upload straight to storage: a presigned MULTIPART
 * upload through the Oxy API's upload sessions (`/assets/uploads`, ADR 0043
 * stage 4b, ADR 0047). Every byte goes from the device to the bucket; the API
 * only hands out part URLs and, at the end, verifies the assembled file's
 * SHA-256. No proxy's request-body limit ever sees the file.
 *
 *   hash      the bytes' SHA-256, read one chunk at a time (never whole)
 *   open      POST /assets/uploads              → session, first 100 part URLs
 *   parts     PUT each part (8 MiB+) to its URL, `partConcurrency` at a time,
 *             each retried with backoff; URLs fetched 100 at a time, just in time,
 *             and again when one expires
 *   complete  POST /assets/uploads/:id/complete  → the file, or 202 `verifying`
 *   poll      GET  /assets/uploads/:id           until `completed` or `failed`
 *
 * Resume: opening the same bytes again answers the open session with the parts
 * storage already holds, so after a dropped connection (or a crashed app) the
 * next call sends only what is missing. An abandoned session is aborted by the
 * API after a day idle (a week at most), and the bucket's lifecycle rule
 * discards any part left after ten days.
 */

import { isAssetFileSource, type AssetFileSource } from './assetFileSource';
import { extractErrorStatus } from '../utils/errorUtils';

/** One part's presigned URL: PUT exactly `size` bytes to it. */
export interface DirectUploadPart {
  partNumber: number;
  url: string;
  size: number;
}

/** The wire view of a session (`/assets/uploads`). */
export interface DirectUploadSession {
  uploadId: string | null;
  status: 'uploading' | 'verifying' | 'completed' | 'failed' | 'aborted';
  size: number;
  partSize?: number;
  partCount?: number;
  expiresAt?: string;
  parts?: DirectUploadPart[];
  uploadedParts?: { partNumber: number; size: number }[];
  file?: { id: string };
  deduplicated?: boolean;
  error?: { code: string; message: string };
}

export interface DirectUploadProgress {
  /** `hash` reads the bytes once; `upload` sends parts; `verify` waits for Oxy to check them. */
  phase: 'hash' | 'upload' | 'verify';
  loaded: number;
  total: number;
}

export interface DirectUploadRequest {
  sha256: string;
  size: number;
  mime: string;
  filename?: string;
  visibility?: 'private' | 'public' | 'unlisted';
  metadata?: Record<string, unknown>;
}

export interface DirectUploadTuning {
  /** Parts sent at once. Default 4. */
  partConcurrency?: number;
  /** Attempts per part before the upload stops (resumable). Default 6. */
  partAttempts?: number;
  /** Bound on one part's PUT, in ms. Default 5 minutes. */
  partTimeoutMs?: number;
  /** How long to wait for Oxy to verify the assembled file. Default 30 minutes. */
  verifyTimeoutMs?: number;
  onProgress?: (progress: DirectUploadProgress) => void;
  /**
   * Stops the upload. The session stays open (until it expires), so a later
   * call with the same bytes resumes it; `assets.abortUpload` discards it.
   */
  signal?: AbortSignal;
}

/** The Oxy API calls the upload makes, as the signed-in person. */
export interface DirectUploadApi {
  open(request: DirectUploadRequest): Promise<DirectUploadSession>;
  partUrls(uploadId: string, partNumbers: number[]): Promise<DirectUploadSession>;
  complete(uploadId: string): Promise<DirectUploadSession>;
  describe(uploadId: string): Promise<DirectUploadSession>;
}

/** Thrown when the parts could not all be sent; calling again with the same bytes resumes. */
export class DirectUploadInterruptedError extends Error {
  constructor(
    message: string,
    readonly uploadId: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DirectUploadInterruptedError';
  }
}

/** Part URLs one call asks for (the API's ceiling). */
const PART_URL_BATCH = 100;
/** Ask for a part's URL again this long before it expires (URLs live an hour). */
const PART_URL_REFRESH_MS = 50 * 60 * 1000;
const VERIFY_POLL_MS = 2_000;

function abortError(): Error {
  const error = new Error('Upload aborted');
  error.name = 'AbortError';
  return error;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A part PUT's outcome: ok, or the HTTP status that refused it (0 = no response). */
type PutOutcome = { ok: true } | { ok: false; status: number };

/**
 * PUT one part, through `XMLHttpRequest` wherever it exists — browsers and
 * React Native, whose XHR sends a native Blob slice from the native blob store
 * (Expo's `fetch` would copy it into the JS heap) and reports bytes sent — and
 * `fetch` elsewhere (Node, Bun). No headers: the URL signs exactly the part's
 * Content-Length, and nothing of the caller's (no bearer, no cookie) ever rides
 * along to storage. A redirect is a failure: the bytes go to that URL only (the
 * query is compared only when kept byte for byte; a native stack may re-encode it).
 */
function putPart(
  url: string,
  body: Blob,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onSent: (loaded: number) => void,
): Promise<PutOutcome> {
  if (typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.withCredentials = false;
      xhr.timeout = timeoutMs;
      xhr.upload.onprogress = (event) => onSent(event.loaded);
      xhr.onload = () =>
        resolve(
          xhr.status >= 200 && xhr.status < 300 ? { ok: true } : { ok: false, status: xhr.status },
        );
      xhr.onerror = () => resolve({ ok: false, status: 0 });
      xhr.ontimeout = () => resolve({ ok: false, status: 0 });
      const onAbort = () => {
        xhr.abort();
        reject(abortError());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      xhr.onloadend = () => signal?.removeEventListener('abort', onAbort);
      xhr.send(body);
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  return fetch(url, {
    method: 'PUT',
    body,
    credentials: 'omit',
    redirect: 'error',
    signal: controller.signal,
  })
    .then((response): PutOutcome => {
      if (response.ok) onSent(body.size);
      return response.ok ? { ok: true } : { ok: false, status: response.status };
    })
    .catch((error): PutOutcome => {
      if (signal?.aborted) throw abortError();
      void error;
      return { ok: false, status: 0 };
    })
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
}

/**
 * Send `blob`'s parts for an open session and complete it. Returns the
 * completed session (`file` set). Throws {@link DirectUploadInterruptedError}
 * when a part keeps failing — the session stays open for a resume.
 */
export async function runDirectUpload(
  api: DirectUploadApi,
  blob: Blob | AssetFileSource,
  opened: DirectUploadSession,
  tuning: DirectUploadTuning = {},
): Promise<DirectUploadSession> {
  const uploadId = opened.uploadId;
  if (!uploadId) return opened;
  const { signal, onProgress } = tuning;
  const concurrency = Math.max(1, tuning.partConcurrency ?? 4);
  const attempts = Math.max(1, tuning.partAttempts ?? 6);
  const partTimeoutMs = tuning.partTimeoutMs ?? 5 * 60 * 1000;
  const total = blob.size;
  const partSize = opened.partSize ?? total;
  const partCount = opened.partCount ?? 1;

  // URLs this upload holds, and when each was handed out.
  const urls = new Map<number, { url: string; at: number }>();
  const remember = (session: DirectUploadSession) => {
    for (const part of session.parts ?? [])
      urls.set(part.partNumber, { url: part.url, at: Date.now() });
  };

  let done = 0;
  const inFlight = new Map<number, number>();
  const report = () => {
    let sent = done;
    for (const loaded of inFlight.values()) sent += loaded;
    onProgress?.({ phase: 'upload', loaded: Math.min(sent, total), total });
  };

  const sendParts = async (session: DirectUploadSession) => {
    const batch = new AbortController();
    const stopBatch = () => batch.abort();
    tuning.signal?.addEventListener('abort', stopBatch, { once: true });
    if (tuning.signal?.aborted) batch.abort();
    const signal = batch.signal;
    remember(session);
    const held = new Set((session.uploadedParts ?? []).map((part) => part.partNumber));
    done = 0;
    for (const part of session.uploadedParts ?? []) done += part.size;
    const pending: number[] = [];
    for (let part = 1; part <= partCount; part++) if (!held.has(part)) pending.push(part);
    report();

    const urlFor = async (partNumber: number, force: boolean): Promise<string> => {
      const known = urls.get(partNumber);
      if (known && !force && Date.now() - known.at < PART_URL_REFRESH_MS) return known.url;
      // This part and the next ones still waiting, in one call.
      const index = pending.indexOf(partNumber);
      const batch = [partNumber, ...pending.slice(index + 1)].slice(0, PART_URL_BATCH);
      remember(await api.partUrls(uploadId, batch));
      const fresh = urls.get(partNumber);
      if (!fresh) throw new Error(`No URL for part ${partNumber}`);
      return fresh.url;
    };

    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const partNumber = pending[next++] as number;
        const start = (partNumber - 1) * partSize;
        const end = Math.min(total, start + partSize);
        const body = isAssetFileSource(blob) ? undefined : blob.slice(start, end);
        let lastStatus = 0;
        let sent = false;
        for (let attempt = 1; attempt <= attempts && !sent; attempt++) {
          if (signal?.aborted) throw abortError();
          // A 403 is an expired (or refused) URL: ask for a fresh one.
          const url = await urlFor(partNumber, lastStatus === 403);
          inFlight.set(partNumber, 0);
          const onSent = (loaded: number) => {
            inFlight.set(partNumber, loaded);
            report();
          };
          const outcome = isAssetFileSource(blob)
            ? await blob.putPart({
                url,
                start,
                end,
                timeoutMs: partTimeoutMs,
                signal,
                onProgress: onSent,
              })
            : await putPart(url, body as Blob, partTimeoutMs, signal, onSent);
          inFlight.delete(partNumber);
          if (outcome.ok) {
            sent = true;
            done += end - start;
            report();
          } else {
            lastStatus = outcome.status;
            if (attempt < attempts) await wait(Math.min(1000 * 2 ** (attempt - 1), 30_000), signal);
          }
        }
        if (!sent) {
          throw new DirectUploadInterruptedError(
            `Part ${partNumber} of ${partCount} could not be sent (status ${lastStatus || 'network'}); call again to resume`,
            uploadId,
          );
        }
      }
    };
    let failed = false;
    let firstFailure: unknown;
    try {
      // Do not leave sibling native transfers running after this call rejects.
      // Await their cancellation and temporary-file cleanup before returning.
      await Promise.all(
        Array.from({ length: Math.min(concurrency, pending.length || 1) }, async () => {
          try {
            await worker();
          } catch (error) {
            if (!failed) {
              failed = true;
              firstFailure = error;
            }
            batch.abort();
          }
        }),
      );
      if (failed) throw firstFailure;
    } finally {
      tuning.signal?.removeEventListener('abort', stopBatch);
    }
  };

  await sendParts(opened);

  // Complete; a part storage did not keep (`UPLOAD_INCOMPLETE`) is sent again, twice at most.
  for (let round = 0; ; round++) {
    if (signal?.aborted) throw abortError();
    let session: DirectUploadSession;
    try {
      session = await api.complete(uploadId);
    } catch (error) {
      if (extractErrorStatus(error) === 409 && round < 2) {
        await sendParts(await api.describe(uploadId));
        continue;
      }
      throw error;
    }
    const deadline = Date.now() + (tuning.verifyTimeoutMs ?? 30 * 60 * 1000);
    while (session.status === 'verifying') {
      onProgress?.({ phase: 'verify', loaded: 0, total });
      if (Date.now() > deadline) {
        throw new DirectUploadInterruptedError(
          'Oxy is still verifying the upload; poll it again later',
          uploadId,
        );
      }
      await wait(VERIFY_POLL_MS, signal);
      session = await api.describe(uploadId);
    }
    if (session.status !== 'completed' || !session.file) {
      const failure = session.error;
      throw new Error(
        failure
          ? `Upload ${session.status}: ${failure.code} ${failure.message}`
          : `Upload ${session.status}`,
      );
    }
    onProgress?.({ phase: 'verify', loaded: total, total });
    return session;
  }
}
