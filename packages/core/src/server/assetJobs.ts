/**
 * Waiting for asset work Oxy finishes in the background (ADR 0042 stage 4c):
 * an import by URL of a source over 40 MiB, and a recording target's
 * verification. Both answer `202` while running and are read back by `GET`.
 */
import type { ServiceLane } from '../client/context';
import type { FileImportState, PendingFileImport } from '../models/interfaces';
import { OxyApiError } from '../OxyServices.errors';

/** First poll after this long… */
export const ASSET_JOB_POLL_INITIAL_MS = 2_000;
/** …growing by half each time, to at most this. */
export const ASSET_JOB_POLL_MAX_MS = 10_000;
/** How long an import waits for a pending source by default. */
export const IMPORT_DEFAULT_WAIT_MS = 60 * 60_000;

/** Resolve after `ms`, or reject with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The next poll interval after `current`. */
export function nextPollInterval(current: number): number {
  return Math.min(ASSET_JOB_POLL_MAX_MS, Math.round(current * 1.5));
}

/** Whether an import answer is the `202` of a source Oxy still fetches. */
export function isPendingImport(answer: unknown): answer is PendingFileImport {
  if (typeof answer !== 'object' || answer === null) return false;
  const record = answer as Record<string, unknown>;
  return typeof record.importId === 'string' && record.file === undefined;
}

/**
 * Poll `GET <base>/<importId>` until the import completes, and resolve to the
 * ordinary import answer. A failed import rejects with the {@link OxyApiError}
 * an HTTP error of its status and code would; waiting longer than `waitMs`
 * rejects with `IMPORT_WAIT_TIMEOUT` (`details.importId` names it).
 */
export async function waitForImport<TResult>(
  service: ServiceLane,
  base: string,
  importId: string,
  headers: Record<string, string> | undefined,
  options: { waitMs?: number; signal?: AbortSignal },
): Promise<TResult> {
  const deadline = Date.now() + (options.waitMs ?? IMPORT_DEFAULT_WAIT_MS);
  const path = `${base}/${encodeURIComponent(importId)}`;
  let interval = ASSET_JOB_POLL_INITIAL_MS;
  for (;;) {
    if (Date.now() + interval > deadline) {
      throw new OxyApiError('Oxy is still importing the source; collect it later', {
        status: 0,
        code: 'IMPORT_WAIT_TIMEOUT',
        details: { importId },
        timeout: true,
      });
    }
    await sleep(interval, options.signal);
    interval = nextPollInterval(interval);
    const state = await service.request<FileImportState<unknown>>('GET', path, undefined, {
      cache: false,
      ...(headers ? { headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (state.status === 'completed' && state.file) {
      return {
        file: state.file,
        outcome: state.outcome ?? 'downloaded',
        deduplicated: state.deduplicated ?? false,
        source: state.source,
        ...(state.reference ? { reference: state.reference } : {}),
      } as TResult;
    }
    if (state.status === 'failed') {
      const error = state.error ?? {
        status: 502,
        code: 'IMPORT_FAILED',
        message: 'The import failed',
      };
      throw new OxyApiError(error.message, {
        status: error.status,
        code: error.code,
        details: { importId },
      });
    }
  }
}
