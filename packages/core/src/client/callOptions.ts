/**
 * Per-call transport options, for any namespace call.
 *
 * `oxy.withCallOptions({ timeout: 60_000 }).assets.setVisibility(id, 'public')`
 * sends that one call with its own budget, without a second client and without
 * every method growing an options parameter of its own. The scope is a view of
 * the same client: same session, cache, service lane and namespaces' state.
 */
import { linkAbort, type RequestOptions } from '../HttpService';

/**
 * Transport options for the calls made through `withCallOptions`, overriding
 * the client's `requestTimeout` / `enableRetry` for those calls only.
 */
export interface CallOptions {
  /** Abort the call. Combined with any signal the method passes itself. */
  signal?: AbortSignal;
  /** Per-attempt timeout in ms. Replaces the method's own default. */
  timeout?: number;
  /**
   * Wall-clock budget in ms for the whole call, retries and backoff included
   * (`RequestOptions.deadline`) — "never more than 2.5 s" in one number.
   */
  deadline?: number;
  /**
   * `false` sends each request once; a transient failure is the caller's to
   * retry (an outbox). `true` allows the transport's retries where the client
   * turned them off — but never on a request the method sends once on purpose
   * (a non-idempotent write whose lost answer would duplicate it).
   */
  retry?: boolean;
}

/** Throws for a budget the transport cannot honour (0, negative, NaN, Infinity). */
export function assertCallOptions(options: CallOptions): void {
  for (const key of ['timeout', 'deadline'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new RangeError(`${key} must be a positive number of milliseconds`);
    }
  }
}

/**
 * The request options a method chose, with the scope's applied on top. The
 * signal is NOT merged here: two signals need a linked controller that lives
 * exactly as long as the request ({@link sendWithCallOptions}).
 */
export function applyCallOptions<T extends RequestOptions>(
  method: T | undefined,
  scope: CallOptions,
): T {
  const merged = { ...method } as T;
  if (scope.timeout !== undefined) merged.timeout = scope.timeout;
  if (scope.deadline !== undefined) merged.deadline = scope.deadline;
  if (scope.retry === false) merged.retry = false;
  else if (scope.retry === true && merged.retry === undefined) merged.retry = true;
  return merged;
}

/**
 * Send one request with the scope applied: `send` receives the merged
 * options, with a signal that aborts when either the method's or the scope's
 * does. The link between them is released when the request settles.
 */
export async function sendWithCallOptions<T, O extends RequestOptions>(
  method: O | undefined,
  scope: CallOptions,
  send: (options: O) => Promise<T>,
): Promise<T> {
  const merged = applyCallOptions(method, scope);
  const own = method?.signal;
  if (!scope.signal || !own || own === scope.signal) {
    const signal = scope.signal ?? own;
    if (signal) merged.signal = signal;
    return send(merged);
  }
  const controller = new AbortController();
  const unlinkOwn = linkAbort(own, controller);
  const unlinkScope = linkAbort(scope.signal, controller);
  merged.signal = controller.signal;
  try {
    return await send(merged);
  } finally {
    unlinkOwn();
    unlinkScope();
  }
}
