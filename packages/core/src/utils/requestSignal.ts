import { createCancelledError } from './errorUtils';

/** Cancel this wait only; the shared mint continues for other callers. */
export function awaitRequestSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(createCancelledError());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // Both handlers remain attached even after cancellation, so a late shared
    // failure is observed without reviving this request or becoming unhandled.
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
