/**
 * `tracedFetch` — the API's one way to call the WHATWG `fetch`.
 *
 * Every outbound `fetch` in `packages/api/src` goes through this function
 * (`scripts/check-api-raw-fetch.mjs` refuses a raw one). It wraps the call in an
 * OpenTelemetry CLIENT span carrying the attributes `@opentelemetry/
 * instrumentation-undici` records, and injects the configured propagator's
 * headers (W3C `traceparent`/`tracestate`) into the request.
 *
 * WHY IT EXISTS: the undici instrumentation does not see Bun's `fetch`. It
 * subscribes to undici's `diagnostics_channel` events, which Node's built-in
 * `fetch` (undici) publishes and Bun's native `fetch` does not — measured on
 * Bun 1.4.3: zero `undici:*` events, zero client spans, and no `traceparent` on
 * the wire, while `http.request` (safeFetch, the AWS SDK) stays traced. So this
 * span is what keeps Oxy → Kaana, Expo push, the Alia webhook and the rest
 * visible on either runtime.
 *
 * ONE SPAN PER CALL, ON BOTH RUNTIMES: the request runs inside a context marked
 * by {@link TRACED_FETCH_CONTEXT_KEY}, and `telemetry.ts` gives the undici
 * instrumentation an `ignoreRequestHook` ({@link isInsideTracedFetch}) that
 * skips such requests. On Node the undici span would otherwise duplicate this
 * one; a skipped request also gets no headers from undici, so this function's
 * injection is the only one. `fetch` from third-party code (outside this
 * wrapper) is still traced by undici on Node, as before.
 *
 * Semantics kept from the undici instrumentation: the span is named after the
 * method, `http.response.status_code` >= 400 sets ERROR status, a network error
 * is recorded as an exception with `error.type`, and an abort ends the span
 * without an error. One difference: the span ends when the response HEADERS
 * arrive (the body belongs to the caller), where undici ends it after the body.
 *
 * With telemetry disabled the tracer and propagator are no-ops: no header is
 * added and `init` is passed to `fetch` unchanged (the same object).
 */

import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

/** Marks the context of a request this module is already tracing. */
export const TRACED_FETCH_CONTEXT_KEY = createContextKey('oxy.api.traced-fetch');

/** Instrumentation scope of the spans this module creates. */
export const TRACED_FETCH_TRACER_NAME = '@oxy.so/api/traced-fetch';

const tracer = trace.getTracer(TRACED_FETCH_TRACER_NAME);

/** The methods semconv names as known; anything else is `_OTHER`, as in undici. */
const KNOWN_METHODS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
]);

/**
 * True when the active context belongs to a {@link tracedFetch} call. Used as the
 * undici instrumentation's `ignoreRequestHook`, so Node does not record a second
 * client span (or inject a second `traceparent`) for the same request.
 */
export function isInsideTracedFetch(active: Context = context.active()): boolean {
  return active.getValue(TRACED_FETCH_CONTEXT_KEY) === true;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return new URL(input.href);
    return new URL(input.url);
  } catch {
    return null;
  }
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method) return init.method;
  if (typeof input === 'object' && !(input instanceof URL) && typeof input.method === 'string') {
    return input.method;
  }
  return 'GET';
}

function startAttributes(url: URL, methodOriginal: string, method: string): Attributes {
  // `url.full` never carries credentials (semconv), and new URL() keeps any
  // userinfo the caller wrote, so drop it explicitly.
  const full = new URL(url.href);
  full.username = '';
  full.password = '';
  const scheme = url.protocol.replace(':', '');
  const port = url.port || (scheme === 'https' ? '443' : scheme === 'http' ? '80' : '');
  const attributes: Attributes = {
    'http.request.method': method,
    'http.request.method_original': methodOriginal,
    'url.full': full.toString(),
    'url.path': url.pathname,
    'url.query': url.search,
    'url.scheme': scheme,
    'server.address': url.hostname,
  };
  if (port && !Number.isNaN(Number(port))) attributes['server.port'] = Number(port);
  return attributes;
}

/**
 * Merge the propagation headers into the caller's headers without changing the
 * caller's representation more than needed. Returns `init` itself when there is
 * nothing to add (telemetry off), so a disabled SDK changes nothing at all.
 */
function withPropagationHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  carrier: Record<string, string>,
): RequestInit | undefined {
  const entries = Object.entries(carrier);
  if (entries.length === 0) return init;

  const base =
    init?.headers ??
    (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined);
  let headers: HeadersInit;
  if (base === undefined) {
    headers = { ...carrier };
  } else if (base instanceof Headers) {
    const copy = new Headers(base);
    for (const [name, value] of entries) copy.set(name, value);
    headers = copy;
  } else if (Array.isArray(base)) {
    const lower = new Set(entries.map(([name]) => name.toLowerCase()));
    headers = [...base.filter(([name]) => !lower.has(name.toLowerCase())), ...entries];
  } else {
    const lower = new Set(entries.map(([name]) => name.toLowerCase()));
    const kept = Object.fromEntries(
      Object.entries(base).filter(([name]) => !lower.has(name.toLowerCase())),
    );
    headers = { ...kept, ...carrier };
  }
  return { ...init, headers };
}

/** An intentional cancel, which undici's instrumentation ends without an error (a timeout is an error). */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * `fetch`, traced. Same signature and behaviour as the global; the global is
 * read at call time, so a test that replaces `globalThis.fetch` still sees the
 * call. An optional shared SDK transport retains tracing around its authenticated
 * request without copying its bearer or replacing its refresh/origin checks.
 */
export async function tracedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  transport?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
): Promise<Response> {
  const parent = context.active();
  const url = requestUrl(input);
  if (!url) {
    // Not a URL fetch can resolve either; let fetch produce its own error.
    return transport ? transport.fetch(input, init) : globalThis.fetch(input, init);
  }

  const methodOriginal = requestMethod(input, init);
  const upper = methodOriginal.toUpperCase();
  const method = KNOWN_METHODS.has(upper) ? upper : '_OTHER';
  const span = tracer.startSpan(
    method === '_OTHER' ? 'HTTP' : method,
    { kind: SpanKind.CLIENT, attributes: startAttributes(url, methodOriginal, method) },
    parent,
  );

  const spanContext = trace.setSpan(parent, span).setValue(TRACED_FETCH_CONTEXT_KEY, true);
  const carrier: Record<string, string> = {};
  propagation.inject(spanContext, carrier);
  const effectiveInit = withPropagationHeaders(input, init, carrier);

  try {
    const response = await context.with(spanContext, () =>
      transport ? transport.fetch(input, effectiveInit) : globalThis.fetch(input, effectiveInit),
    );
    span.setAttribute('http.response.status_code', response.status);
    if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
    return response;
  } catch (error) {
    if (!isAbort(error)) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      const code = (error as { code?: unknown }).code;
      span.setAttribute(
        'error.type',
        typeof code === 'string' && code ? code : err.name || 'Error',
      );
    }
    throw error;
  } finally {
    span.end();
  }
}
