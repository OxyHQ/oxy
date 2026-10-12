/**
 * tracedFetch: one CLIENT span per call with undici's attribute set, W3C
 * propagation into the request, and nothing at all when telemetry is off.
 *
 * The SDK here is the real NodeSDK (no instrumentations, in-memory exporter), so
 * the span, the context manager and the propagator are the production ones. The
 * global `fetch` is replaced per test; tracedFetch reads it at call time.
 */

import { context, trace } from '@opentelemetry/api';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { isInsideTracedFetch, TRACED_FETCH_TRACER_NAME, tracedFetch } from '../tracedFetch';

const realFetch = globalThis.fetch;
const exporter = new tracing.InMemorySpanExporter();
let sdk: NodeSDK | null = null;

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

function stubFetch(impl: (...args: FetchArgs) => Promise<Response>): jest.Mock {
  const mock = jest.fn(impl);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function attr(span: tracing.ReadableSpan, key: string): unknown {
  return span.attributes[key];
}

afterEach(() => {
  globalThis.fetch = realFetch;
  exporter.reset();
});

afterAll(async () => {
  await sdk?.shutdown();
});

describe('tracedFetch with telemetry OFF (no SDK registered)', () => {
  it('passes the caller init through as the SAME object and adds no header', async () => {
    const mock = stubFetch(async () => new Response('ok'));
    const init = { method: 'POST', headers: { 'x-a': '1' }, body: '{}' };
    await tracedFetch('https://kaana.example/internal/v1/x', init);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][1]).toBe(init);
  });
});

describe('tracedFetch with the SDK started', () => {
  beforeAll(() => {
    sdk = new NodeSDK({
      serviceName: 'traced-fetch-test',
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
      instrumentations: [],
      // The default detectors are async, and SimpleSpanProcessor holds a span's
      // export until they settle; with none, every span is exported on end().
      resourceDetectors: [],
    });
    sdk.start();
  });

  it('records one CLIENT span with the undici attribute set and injects its traceparent', async () => {
    let insideDuringCall = false;
    const mock = stubFetch(async () => {
      insideDuringCall = isInsideTracedFetch();
      return new Response('ok', { status: 201 });
    });
    const parentTracer = trace.getTracer('test-parent');
    const parent = parentTracer.startSpan('parent');
    await context.with(trace.setSpan(context.active(), parent), () =>
      tracedFetch('https://user:pw@kaana.example:8443/internal/v1/models?x=1', {
        method: 'post',
        headers: { authorization: 'Bearer t', 'x-keep': 'yes' },
      }),
    );
    parent.end();

    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationScope.name === TRACED_FETCH_TRACER_NAME);
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span.kind).toBe(2); // CLIENT
    expect(span.name).toBe('POST');
    expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span.attributes).toMatchObject({
      'http.request.method': 'POST',
      'http.request.method_original': 'post',
      'url.full': 'https://kaana.example:8443/internal/v1/models?x=1',
      'url.path': '/internal/v1/models',
      'url.query': '?x=1',
      'url.scheme': 'https',
      'server.address': 'kaana.example',
      'server.port': 8443,
      'http.response.status_code': 201,
    });
    expect(span.status.code).toBe(0); // UNSET

    const sent = mock.mock.calls[0][1] as RequestInit;
    expect(headerOf(sent, 'traceparent')).toBe(
      `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
    );
    expect(headerOf(sent, 'authorization')).toBe('Bearer t');
    expect(headerOf(sent, 'x-keep')).toBe('yes');
    expect(insideDuringCall).toBe(true);
    expect(isInsideTracedFetch()).toBe(false);
  });

  it('replaces a stale caller traceparent instead of sending two', async () => {
    const mock = stubFetch(async () => new Response('ok'));
    await tracedFetch('https://x.example/', {
      headers: [
        ['Traceparent', '00-00000000000000000000000000000001-0000000000000001-01'],
        ['x-keep', 'yes'],
      ],
    });
    const sent = mock.mock.calls[0][1] as RequestInit;
    const names = (sent.headers as [string, string][]).map(([n]) => n.toLowerCase());
    expect(names.filter((n) => n === 'traceparent')).toHaveLength(1);
    expect(headerOf(sent, 'traceparent')).not.toContain('00000000000000000000000000000001');
    expect(headerOf(sent, 'x-keep')).toBe('yes');
  });

  it('keeps a Headers instance a Headers instance, and reads a Request input', async () => {
    const mock = stubFetch(async () => new Response('ok'));
    await tracedFetch('https://x.example/', { headers: new Headers({ 'x-a': '1' }) });
    expect((mock.mock.calls[0][1] as RequestInit).headers).toBeInstanceOf(Headers);
    expect(headerOf(mock.mock.calls[0][1], 'x-a')).toBe('1');

    await tracedFetch(
      new Request('https://y.example/p', { method: 'PUT', headers: { 'x-b': '2' } }),
    );
    const sent = mock.mock.calls[1][1] as RequestInit;
    expect(headerOf(sent, 'x-b')).toBe('2');
    expect(headerOf(sent, 'traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const putSpan = exporter.getFinishedSpans().find((s) => s.name === 'PUT');
    expect(putSpan && attr(putSpan, 'server.address')).toBe('y.example');
  });

  it('marks a >= 400 response (400 itself) as an ERROR span and still returns it', async () => {
    stubFetch(async () => new Response('nope', { status: 400 }));
    const response = await tracedFetch('https://x.example/');
    expect(response.status).toBe(400);
    const [span] = exporter.getFinishedSpans();
    expect(attr(span, 'http.response.status_code')).toBe(400);
    expect(span.status.code).toBe(2); // ERROR
  });

  it('records a network error with error.type and rethrows the same error', async () => {
    const failure = Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    stubFetch(async () => {
      throw failure;
    });
    await expect(tracedFetch('https://x.example/')).rejects.toBe(failure);
    const [span] = exporter.getFinishedSpans();
    expect(span.status).toEqual({ code: 2, message: 'fetch failed' });
    expect(attr(span, 'error.type')).toBe('ECONNREFUSED');
    expect(span.events.map((e) => e.name)).toContain('exception');
  });

  it('ends an aborted call without an error, as the undici instrumentation does', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    stubFetch(async () => {
      throw abort;
    });
    await expect(tracedFetch('https://x.example/')).rejects.toBe(abort);
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(0);
    expect(attr(span, 'error.type')).toBeUndefined();
  });

  it('names an unknown method _OTHER and the span HTTP', async () => {
    stubFetch(async () => new Response('ok'));
    await tracedFetch('https://x.example/', { method: 'PURGE' });
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('HTTP');
    expect(attr(span, 'http.request.method')).toBe('_OTHER');
    expect(attr(span, 'http.request.method_original')).toBe('PURGE');
  });
});
